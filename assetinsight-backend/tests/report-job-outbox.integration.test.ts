import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import {
  buildAssetPreviewFilesJobOutbox,
  buildAssetPreviewJobOutbox,
  queueAssetPreviewJob,
  queuePreviewFilesJob,
} from "../src/jobs/assetReportJob.js";
import {
  buildReportJobOutbox,
  ensureReportJobOutbox,
  startMongoReportWorker,
} from "../src/utils/reportJobMongoQueue.js";
import { buildExcelCrRegenerationJobOutbox } from "../src/jobs/excelCrRegenerationJob.js";

let mongo: MongoMemoryServer;
const originalEnvironment = {
  REPORT_QUEUE_BACKEND: process.env.REPORT_QUEUE_BACKEND,
  REPORT_JOB_CONCURRENCY: process.env.REPORT_JOB_CONCURRENCY,
  REPORT_JOB_POLL_MS: process.env.REPORT_JOB_POLL_MS,
};

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.REPORT_JOB_CONCURRENCY = "1";
  process.env.REPORT_JOB_POLL_MS = "10";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([
    AssetReport.syncIndexes(),
    LotListing.syncIndexes(),
    ReportJob.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function assetOutbox(reportId: mongoose.Types.ObjectId, token = "handoff-token") {
  return buildReportJobOutbox({
    token,
    type: "asset-preview-files",
    reportId: reportId.toString(),
    progressId: "generation-100",
    idempotencyKey: `asset-preview-files:${reportId}:generation-100`,
    payload: {
      reportId: reportId.toString(),
      generationToken: "generation-100",
      previewDataSnapshot: { lots: [] },
    },
    maxAttempts: 3,
    targetStatus: "pending_approval",
  });
}

async function createAssetWithOutbox() {
  const reportId = new mongoose.Types.ObjectId();
  const outbox = assetOutbox(reportId);
  await AssetReport.create({
    _id: reportId,
    user: new mongoose.Types.ObjectId(),
    grouping_mode: "mixed",
    imageUrls: [],
    lots: [],
    status: "preview",
    job_id: "generation-100",
    job_status: "queued",
    files_generating: true,
    report_job_outbox: outbox,
  });
  return { reportId, outbox };
}

describe.sequential("embedded report-job outbox", () => {
  it("keeps an outbox intact and never revives an idempotency collision with a different payload", async () => {
    const { reportId, outbox } = await createAssetWithOutbox();
    const conflicting = await ReportJob.create({
      type: outbox.type,
      reportId: outbox.reportId,
      progressId: outbox.progressId,
      idempotencyKey: outbox.idempotencyKey,
      targetStatus: outbox.targetStatus,
      payload: {
        ...outbox.payload,
        previewDataSnapshot: { lots: [{ title: "Conflicting snapshot" }] },
      },
      status: "failed",
      attempts: 3,
      maxAttempts: 3,
      queuedAt: new Date(),
      failedAt: new Date(),
    });

    await expect(
      ensureReportJobOutbox("asset", reportId.toString(), outbox.token),
    ).rejects.toMatchObject({ code: "REPORT_JOB_IDENTITY_CONFLICT" });

    const unchanged: any = await ReportJob.findById(conflicting._id).lean();
    expect(unchanged).toMatchObject({
      status: "failed",
      attempts: 3,
      payload: {
        previewDataSnapshot: { lots: [{ title: "Conflicting snapshot" }] },
      },
    });
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean(),
    ).toHaveProperty("report_job_outbox.token", outbox.token);
  });

  it("recovers the exact initial Asset upload payload after the report-only commit", async () => {
    const reportId = new mongoose.Types.ObjectId();
    const progressId = "asset-upload-crash-window";
    const input = {
      reportId: reportId.toString(),
      user: {
        id: new mongoose.Types.ObjectId().toString(),
        email: "asset-owner@example.test",
      },
      images: [
        {
          fieldname: "images",
          originalname: "inspection.jpg",
          encoding: "7bit",
          mimetype: "image/jpeg",
          destination: "uploads/report-jobs",
          filename: "inspection.jpg",
          path: `${process.cwd()}/uploads/report-jobs/inspection.jpg`,
          size: 42,
        } as Express.Multer.File,
      ],
      videos: [],
      details: {
        client_submission_id: "asset-client-submission-1",
        grouping_mode: "single_lot",
      },
      progressId,
    };
    const outbox = buildAssetPreviewJobOutbox(input);
    await AssetReport.create({
      _id: reportId,
      user: input.user.id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: progressId,
      job_status: "queued",
      report_job_outbox: outbox,
    });

    const job = await queueAssetPreviewJob({
      ...input,
      reportJobOutboxToken: outbox.token,
    });

    expect(job).toMatchObject({
      type: "asset-preview",
      reportId: reportId.toString(),
      progressId,
      idempotencyKey: `asset-preview:${reportId}:asset-client-submission-1`,
      payload: {
        reportId: reportId.toString(),
        progressId,
        images: [
          expect.objectContaining({
            originalname: "inspection.jpg",
            path: `${process.cwd()}/uploads/report-jobs/inspection.jpg`,
          }),
        ],
      },
    });
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean()
    ).not.toHaveProperty("report_job_outbox");
  });

  it("recovers an exact Asset file-generation snapshot after dispatch acknowledgement is lost", async () => {
    const reportId = new mongoose.Types.ObjectId();
    const generationToken = "asset-files-crash-window";
    const previewDataSnapshot = {
      contract_no: "OUTBOX-ASSET-100",
      lots: [{ lot_id: "lot-001", title: "Persisted snapshot" }],
    };
    const options = {
      previewDataSnapshot,
      targetStatus: "pending_approval" as const,
      generationToken,
    };
    const outbox = buildAssetPreviewFilesJobOutbox(
      reportId.toString(),
      options
    );
    await AssetReport.create({
      _id: reportId,
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      preview_data: previewDataSnapshot,
      status: "preview",
      job_id: generationToken,
      job_status: "queued",
      files_generating: true,
      generation_target_status: "pending_approval",
      report_job_outbox: outbox,
    });

    const job = await queuePreviewFilesJob(reportId.toString(), {
      ...options,
      reportJobOutboxToken: outbox.token,
    });

    expect(job).toMatchObject({
      type: "asset-preview-files",
      reportId: reportId.toString(),
      progressId: generationToken,
      payload: {
        generationToken,
        targetStatus: "pending_approval",
        previewDataSnapshot,
      },
    });
    expect(await ReportJob.countDocuments({ reportId: reportId.toString() })).toBe(1);
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean()
    ).not.toHaveProperty("report_job_outbox");
  });

  it("concurrently ensures exactly one durable job and token-CAS clears the handoff", async () => {
    const { reportId, outbox } = await createAssetWithOutbox();

    const [first, second] = await Promise.all([
      ensureReportJobOutbox("asset", reportId.toString(), outbox.token),
      ensureReportJobOutbox("asset", reportId.toString(), outbox.token),
    ]);

    expect(String(first?._id)).toBe(String(second?._id));
    expect(await ReportJob.countDocuments({
      idempotencyKey: outbox.idempotencyKey,
    })).toBe(1);
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean()
    ).not.toHaveProperty("report_job_outbox");
  });

  it("reconciles a report-only handoff after a worker restart", async () => {
    const { reportId, outbox } = await createAssetWithOutbox();
    const handler = vi.fn(async () => undefined);
    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      { "asset-preview-files": handler },
      { signal: abortController.signal }
    );

    try {
      await vi.waitFor(
        async () => {
          expect(handler).toHaveBeenCalledTimes(1);
          expect(
            (await ReportJob.findOne({
              idempotencyKey: outbox.idempotencyKey,
            }).lean())?.status
          ).toBe("completed");
        },
        { timeout: 5_000, interval: 20 }
      );
      expect(
        await AssetReport.findById(reportId)
          .select("+report_job_outbox")
          .lean()
      ).not.toHaveProperty("report_job_outbox");
    } finally {
      abortController.abort();
      await worker;
    }
  });

  it("reconciles an Excel/CR report-only handoff after a worker restart", async () => {
    const reportId = new mongoose.Types.ObjectId();
    const generationToken = "excel-cr-restart-handoff";
    const outbox = buildExcelCrRegenerationJobOutbox({
      kind: "asset",
      reportId: reportId.toString(),
      generationToken,
    });
    await AssetReport.create({
      _id: reportId,
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      preview_data: {},
      status: "approved",
      files_generating: true,
      files_regenerating: true,
      job_id: generationToken,
      job_status: "queued",
      excel_cr_regeneration_claim_token: generationToken,
      excel_cr_regeneration_claimed_at: new Date(),
      report_job_outbox: outbox,
    });

    const handler = vi.fn(async (job: any, context: any) => {
      await context.assertOwned();
      expect(job).toMatchObject({
        type: "asset-excel-cr-files",
        reportId: reportId.toString(),
        progressId: generationToken,
        payload: {
          reportId: reportId.toString(),
          generationToken,
          notifyOwnerOnFailure: false,
        },
      });
      await AssetReport.updateOne(
        { _id: reportId, job_id: generationToken },
        {
          $set: {
            files_generating: false,
            files_regenerating: false,
            job_status: "done",
          },
          $unset: {
            excel_cr_regeneration_claim_token: 1,
            excel_cr_regeneration_claimed_at: 1,
          },
        }
      );
    });
    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      { "asset-excel-cr-files": handler },
      { signal: abortController.signal }
    );

    try {
      await vi.waitFor(
        async () => {
          expect(handler).toHaveBeenCalledTimes(1);
          expect(
            (await ReportJob.findOne({
              idempotencyKey: outbox.idempotencyKey,
            }).lean())?.status
          ).toBe("completed");
        },
        { timeout: 5_000, interval: 20 }
      );
      const recovered: any = await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean();
      expect(recovered.report_job_outbox).toBeUndefined();
      expect(recovered.excel_cr_regeneration_claim_token).toBeUndefined();
      expect(recovered).toMatchObject({
        files_generating: false,
        files_regenerating: false,
        job_id: generationToken,
        job_status: "done",
      });
    } finally {
      abortController.abort();
      await worker;
    }
  });

  it("cannot consume or clear a newer report transition with a stale token", async () => {
    const { reportId, outbox } = await createAssetWithOutbox();
    const newer = assetOutbox(reportId, "newer-token");
    await AssetReport.updateOne(
      { _id: reportId, "report_job_outbox.token": outbox.token },
      { $set: { report_job_outbox: newer } }
    );

    await expect(
      ensureReportJobOutbox("asset", reportId.toString(), outbox.token)
    ).resolves.toBeNull();
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean()
    ).toHaveProperty("report_job_outbox.token", newer.token);
    expect(await ReportJob.countDocuments()).toBe(0);
  });
});
