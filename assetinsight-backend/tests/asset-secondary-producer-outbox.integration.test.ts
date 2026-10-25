import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import AssetReport from "../src/models/asset.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import { buildAssetPreviewFilesJobOutbox } from "../src/jobs/assetReportJob.js";
import { mergeAssetReports } from "../src/service/assetReportMergeService.js";
import { queueAssetScheduleSheetRegeneration } from "../src/service/assetScheduleSheetRegenerationService.js";
import { ensureReportJobOutbox } from "../src/utils/reportJobMongoQueue.js";

let mongo: MongoMemoryServer;
let previousQueueBackend: string | undefined;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  previousQueueBackend = process.env.REPORT_QUEUE_BACKEND;
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), ReportJob.syncIndexes()]);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousQueueBackend === undefined) {
    delete process.env.REPORT_QUEUE_BACKEND;
  } else {
    process.env.REPORT_QUEUE_BACKEND = previousQueueBackend;
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function sourceLot(number: string) {
  return {
    lot_id: `source-${number}`,
    lot_number: number,
    title: `Asset ${number}`,
    description: `Source asset ${number}`,
    estimated_value: "CA$1,000",
    image_indexes: [],
    image_urls: [],
  };
}

async function makeMergeSource(input: {
  ownerId: mongoose.Types.ObjectId;
  contractNo: string;
  lotNumber: string;
}) {
  const lot = sourceLot(input.lotNumber);
  return AssetReport.create({
    user: input.ownerId,
    grouping_mode: "mixed",
    imageUrls: [],
    lots: [lot],
    status: "preview",
    job_status: "done",
    contract_no: input.contractNo,
    contract_key: input.contractNo.toLowerCase(),
    preview_data: {
      contract_no: input.contractNo,
      lots: [lot],
      currency: "CAD",
    },
  });
}

describe.sequential("secondary Asset report-job producers", () => {
  it("coalesces concurrent identical merges into one report and one file job", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const [first, second] = await Promise.all([
      makeMergeSource({
        ownerId,
        contractNo: "MERGE-CONCURRENT-50",
        lotNumber: "2",
      }),
      makeMergeSource({
        ownerId,
        contractNo: "MERGE-CONCURRENT-50",
        lotNumber: "6",
      }),
    ]);
    const input = {
      userId: String(ownerId),
      sourceReportIds: [String(first._id), String(second._id)],
      primaryReportId: String(first._id),
      mergeRequestId: "merge-concurrent-request",
    };

    const [left, right] = await Promise.all([
      mergeAssetReports(input),
      mergeAssetReports(input),
    ]);

    expect(String(left.report._id)).toBe(String(right.report._id));
    expect([left.resumed, right.resumed].sort()).toEqual([false, true]);
    const mergedReports = await AssetReport.find({
      user: ownerId,
      merge_request_id: input.mergeRequestId,
    }).lean();
    expect(mergedReports).toHaveLength(1);
    expect(
      await ReportJob.countDocuments({
        reportId: String(left.report._id),
        type: "asset-preview-files",
      })
    ).toBe(1);
  });

  it("recovers a merged-report handoff after the report commit and creates one job", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const [first, second] = await Promise.all([
      makeMergeSource({
        ownerId,
        contractNo: "MERGE-OUTBOX-100",
        lotNumber: "4",
      }),
      makeMergeSource({
        ownerId,
        contractNo: "MERGE-OUTBOX-100",
        lotNumber: "8",
      }),
    ]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ReportJob as any, "findOne").mockRejectedValueOnce(
      new Error("simulated queue outage after report commit")
    );

    const firstResult = await mergeAssetReports({
      userId: String(ownerId),
      sourceReportIds: [String(first._id), String(second._id)],
      primaryReportId: String(first._id),
      mergeRequestId: "merge-outbox-retry-1",
    });

    expect(firstResult.resumed).toBe(false);
    expect(firstResult.report).not.toHaveProperty("report_job_outbox");
    const reportId = String(firstResult.report._id);
    const persisted = await AssetReport.findById(reportId)
      .select("+report_job_outbox")
      .lean<any>();
    expect(persisted).toMatchObject({
      status: "processing",
      job_status: "queued",
      files_generating: true,
      report_job_outbox: {
        type: "asset-preview-files",
        reportId,
        progressId: persisted.job_id,
        idempotencyKey: `asset-preview-files:${reportId}:${persisted.job_id}`,
      },
    });
    expect(persisted.report_job_outbox.payload).not.toHaveProperty(
      "previewDataSnapshot"
    );
    expect(await ReportJob.countDocuments({ reportId })).toBe(0);

    const outboxToken = String(persisted.report_job_outbox.token);
    await Promise.all([
      ensureReportJobOutbox("asset", reportId, outboxToken),
      ensureReportJobOutbox("asset", reportId, outboxToken),
    ]);
    expect(
      await ReportJob.countDocuments({
        reportId,
        type: "asset-preview-files",
      })
    ).toBe(1);
    expect(
      await AssetReport.findById(reportId)
        .select("+report_job_outbox")
        .lean<any>()
    ).not.toHaveProperty("report_job_outbox");

    const retried = await mergeAssetReports({
      userId: String(ownerId),
      sourceReportIds: [String(first._id), String(second._id)],
      primaryReportId: String(first._id),
      mergeRequestId: "merge-outbox-retry-1",
    });
    expect(retried).toMatchObject({
      resumed: true,
      report: { _id: expect.anything() },
    });
    expect(String(retried.report._id)).toBe(reportId);
    expect(await ReportJob.countDocuments({ reportId })).toBe(1);
  });

  it("recovers a Proposal Valuation handoff after its claim and coalesces retries", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [sourceLot("1")],
      status: "approved",
      job_status: "done",
      preview_data: {
        contract_no: "PV-OUTBOX-200",
        lots: [sourceLot("1")],
      },
      proposal_valuation_revision: 7,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ReportJob as any, "findOne").mockRejectedValueOnce(
      new Error("simulated queue outage after PV claim")
    );

    await expect(
      queueAssetScheduleSheetRegeneration(String(report._id), 7)
    ).resolves.toMatchObject({
      queued: false,
      coalesced: false,
      warning: expect.stringContaining("was saved"),
    });

    const persisted = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean<any>();
    const generationToken = String(persisted.job_id);
    const outboxToken = String(persisted.report_job_outbox?.token || "");
    expect(outboxToken).toBeTruthy();
    expect(persisted).toMatchObject({
      files_generating: true,
      files_regenerating: true,
      job_status: "queued",
      proposal_valuation_generation_revision: 7,
      proposal_valuation_regeneration_claim_token: generationToken,
      report_job_outbox: {
        type: "asset-preview-files",
        reportId: String(report._id),
        progressId: generationToken,
        idempotencyKey: `asset-preview-files:${String(report._id)}:${generationToken}`,
      },
    });
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(
      0
    );

    await Promise.all([
      ensureReportJobOutbox("asset", String(report._id), outboxToken),
      ensureReportJobOutbox("asset", String(report._id), outboxToken),
    ]);
    expect(
      await ReportJob.countDocuments({
        reportId: String(report._id),
        type: "asset-preview-files",
      })
    ).toBe(1);

    await expect(
      queueAssetScheduleSheetRegeneration(String(report._id), 7)
    ).resolves.toEqual({ queued: true, coalesced: true });
    const recovered = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean<any>();
    expect(recovered).not.toHaveProperty("report_job_outbox");
    expect(
      recovered.proposal_valuation_regeneration_claim_token
    ).toBeUndefined();
    expect(
      await ReportJob.countDocuments({ reportId: String(report._id) })
    ).toBe(1);
  });

  it("clears a reconciled PV outbox without reopening a live worker lease", async () => {
    const reportId = new mongoose.Types.ObjectId();
    const generationToken = "asset-files-live-pv-worker";
    const executionToken = "live-worker-execution";
    const outbox = buildAssetPreviewFilesJobOutbox(String(reportId), {
      jobId: generationToken,
      generationToken,
    });
    await AssetReport.create({
      _id: reportId,
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [sourceLot("1")],
      status: "approved",
      preview_data: { lots: [sourceLot("1")] },
      proposal_valuation_revision: 3,
      proposal_valuation_generation_revision: 3,
      proposal_valuation_regeneration_claim_token: generationToken,
      proposal_valuation_regeneration_claimed_at: new Date(),
      files_generating: true,
      files_regenerating: true,
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: "processing",
      report_job_outbox: outbox,
    });
    await ReportJob.create({
      type: "asset-preview-files",
      reportId: String(reportId),
      progressId: generationToken,
      dedupeKey: `asset-preview-files:${String(reportId)}`,
      idempotencyKey: `asset-preview-files:${String(reportId)}:${generationToken}`,
      payload: outbox.payload,
      status: "processing",
      attempts: 1,
      maxAttempts: 3,
      executionToken,
      leaseUntil: new Date(Date.now() + 60_000),
    });

    await expect(
      queueAssetScheduleSheetRegeneration(String(reportId), 3)
    ).resolves.toEqual({ queued: true, coalesced: true });

    const recovered = await AssetReport.findById(reportId)
      .select("+report_job_outbox")
      .lean<any>();
    expect(recovered).toMatchObject({
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: "processing",
      files_generating: true,
      files_regenerating: true,
    });
    expect(recovered).not.toHaveProperty("report_job_outbox");
    expect(
      recovered.proposal_valuation_regeneration_claim_token
    ).toBeUndefined();
    expect(await ReportJob.countDocuments({ reportId: String(reportId) })).toBe(
      1
    );
  });

  it("coalesces a stale PV outbox behind a live Excel/CR worker without stealing ownership", async () => {
    const reportId = new mongoose.Types.ObjectId();
    const excelGenerationToken = "asset-excel-live-generation";
    const excelExecutionToken = "asset-excel-live-execution";
    const stalePvToken = "asset-files-stale-pv-generation";
    const stalePvOutbox = buildAssetPreviewFilesJobOutbox(String(reportId), {
      jobId: stalePvToken,
      generationToken: stalePvToken,
    });
    await AssetReport.create({
      _id: reportId,
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [sourceLot("1")],
      status: "approved",
      preview_data: { lots: [sourceLot("1")] },
      proposal_valuation_revision: 9,
      proposal_valuation_generation_revision: 8,
      proposal_valuation_regeneration_claim_token: stalePvToken,
      proposal_valuation_regeneration_claimed_at: new Date(),
      files_generating: true,
      files_regenerating: true,
      job_id: excelGenerationToken,
      job_execution_token: excelExecutionToken,
      job_status: "processing",
      report_job_outbox: stalePvOutbox,
    });
    await ReportJob.create({
      type: "asset-excel-cr-files",
      reportId: String(reportId),
      progressId: excelGenerationToken,
      dedupeKey: `asset-excel-cr-files:${String(reportId)}`,
      idempotencyKey: `asset-excel-cr-files:${String(reportId)}:${excelGenerationToken}`,
      payload: {
        kind: "asset",
        reportId: String(reportId),
        generationToken: excelGenerationToken,
      },
      status: "processing",
      attempts: 1,
      maxAttempts: 3,
      lockedBy: "excel-worker",
      executionToken: excelExecutionToken,
      leaseUntil: new Date(Date.now() + 60_000),
    });

    await expect(
      queueAssetScheduleSheetRegeneration(String(reportId), 9)
    ).resolves.toEqual({ queued: true, coalesced: true });

    const coalesced = await AssetReport.findById(reportId)
      .select(
        "+report_job_outbox +job_execution_token +proposal_valuation_regeneration_claim_token"
      )
      .lean<any>();
    expect(coalesced).toMatchObject({
      job_id: excelGenerationToken,
      job_execution_token: excelExecutionToken,
      job_status: "processing",
      files_generating: true,
      files_regenerating: true,
      files_regeneration_pending: true,
    });
    expect(coalesced).not.toHaveProperty("report_job_outbox");
    expect(
      coalesced.proposal_valuation_regeneration_claim_token
    ).toBeUndefined();
    expect(
      await ReportJob.countDocuments({
        reportId: String(reportId),
        type: "asset-preview-files",
      })
    ).toBe(0);
    expect(
      await ReportJob.countDocuments({
        reportId: String(reportId),
        type: "asset-excel-cr-files",
        progressId: excelGenerationToken,
        executionToken: excelExecutionToken,
        status: "processing",
      })
    ).toBe(1);
  });
});
