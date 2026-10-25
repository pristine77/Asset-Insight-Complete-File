import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { queuePreviewFilesJob } = vi.hoisted(() => ({
  queuePreviewFilesJob: vi.fn(),
}));
vi.mock("../src/jobs/assetReportJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/assetReportJob.js")>()),
  queuePreviewFilesJob,
}));

let mongo: MongoMemoryServer;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let queueAssetScheduleSheetRegeneration: typeof import("../src/service/assetScheduleSheetRegenerationService.js")["queueAssetScheduleSheetRegeneration"];
let persistAssetGeneratedLots: typeof import("../src/service/assetGeneratedLotsPersistenceService.js")["persistAssetGeneratedLots"];
let publishProposalValuationArtifactsForRevision: typeof import("../src/service/proposalValuationArtifactPublicationService.js")["publishProposalValuationArtifactsForRevision"];
let proposalValuationWritableRevisionCondition: typeof import("../src/service/proposalValuationArtifactPublicationService.js")["proposalValuationWritableRevisionCondition"];
let persistAssetPreviewDataPreservingProposalValuation: typeof import("../src/service/assetPreviewDataPersistenceService.js")["persistAssetPreviewDataPreservingProposalValuation"];
let saveAssetReportWithProtectedPreviewData: typeof import("../src/service/assetPreviewDataPersistenceService.js")["saveAssetReportWithProtectedPreviewData"];
let getPreviewDataForJob: typeof import("../src/jobs/assetReportJob/previewFilesJob.js")["getPreviewDataForJob"];
let waitForAssetArtifactPublication: typeof import("../src/service/assetArtifactBufferPublicationService.js")["waitForAssetArtifactPublication"];
let queueExcelCrRegenerationJob: typeof import("../src/jobs/excelCrRegenerationJob.js")["queueExcelCrRegenerationJob"];
let runReportImageDeletionJob: typeof import("../src/utils/reportImageDeletion.js")["runReportImageDeletionJob"];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ queueAssetScheduleSheetRegeneration } = await import(
    "../src/service/assetScheduleSheetRegenerationService.js"
  ));
  ({ persistAssetGeneratedLots } = await import(
    "../src/service/assetGeneratedLotsPersistenceService.js"
  ));
  ({
    publishProposalValuationArtifactsForRevision,
    proposalValuationWritableRevisionCondition,
  } = await import(
    "../src/service/proposalValuationArtifactPublicationService.js"
  ));
  ({
    persistAssetPreviewDataPreservingProposalValuation,
    saveAssetReportWithProtectedPreviewData,
  } = await import("../src/service/assetPreviewDataPersistenceService.js"));
  ({ getPreviewDataForJob } = await import(
    "../src/jobs/assetReportJob/previewFilesJob.js"
  ));
  ({ waitForAssetArtifactPublication } = await import(
    "../src/service/assetArtifactBufferPublicationService.js"
  ));
  ({ queueExcelCrRegenerationJob } = await import(
    "../src/jobs/excelCrRegenerationJob.js"
  ));
  ({ runReportImageDeletionJob } = await import(
    "../src/utils/reportImageDeletion.js"
  ));
});

beforeEach(async () => {
  queuePreviewFilesJob.mockReset();
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("Proposal Valuation regeneration queue", () => {
  it("retains a tagged durable outbox and reports a warning when enqueue fails", async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const completedAt = new Date("2026-08-29T12:00:00.000Z");
    const report = await AssetReport.create({
      user: ownerId,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 3,
      files_generating: false,
      files_regenerating: false,
      files_regeneration_pending: true,
      job_status: "done",
      processing_completed_at: completedAt,
    });
    queuePreviewFilesJob.mockRejectedValueOnce(new Error("queue unavailable"));

    const result = await queueAssetScheduleSheetRegeneration(
      String(report._id),
      3
    );

    expect(result).toMatchObject({
      queued: false,
      coalesced: false,
      warning: expect.stringContaining("was saved"),
    });
    const stored = await AssetReport.findById(report._id).lean();
    expect(stored).toMatchObject({
      files_generating: true,
      files_regenerating: true,
      files_regeneration_pending: false,
      job_status: "queued",
      processing_completed_at: completedAt,
      proposal_valuation_revision: 3,
      proposal_valuation_generation_revision: 3,
    });
    expect(
      (stored as any)?.proposal_valuation_regeneration_claim_token
    ).toBeTruthy();
    expect((stored as any)?.job_error).toBeUndefined();
  });

  it("coalesces behind a live Excel owner and recovers an expired Excel lock", async () => {
    const live = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 2,
      excel_regenerating: true,
      excel_regeneration_token: "live-owner",
      excel_regeneration_expires_at: new Date(Date.now() + 60_000),
    });

    await expect(
      queueAssetScheduleSheetRegeneration(String(live._id), 2)
    ).resolves.toEqual({ queued: true, coalesced: true });
    expect(queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(
      (await AssetReport.findById(live._id).lean() as any)
        ?.files_regeneration_pending
    ).toBe(true);

    const expired = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 5,
      excel_regenerating: true,
      excel_regeneration_token: "crashed-owner",
      excel_regeneration_expires_at: new Date(Date.now() - 1_000),
    });
    queuePreviewFilesJob.mockResolvedValueOnce(undefined);

    await expect(
      queueAssetScheduleSheetRegeneration(String(expired._id), 5)
    ).resolves.toEqual({ queued: true, coalesced: false });
    expect(queuePreviewFilesJob).toHaveBeenCalledWith(
      String(expired._id),
      expect.objectContaining({
        jobId: expect.any(String),
        generationToken: expect.any(String),
      })
    );
    const recovered = await AssetReport.findById(expired._id).lean();
    expect(recovered).toMatchObject({
      excel_regenerating: false,
      files_generating: true,
      files_regenerating: true,
      proposal_valuation_generation_revision: 5,
    });
    expect((recovered as any)?.excel_regeneration_token).toBeUndefined();
  });

  it("immediately reconciles a queued report claim when no durable ReportJob exists", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        proposal_valuation_revision: 8,
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: new Date(),
        proposal_valuation_regeneration_claim_token: "pv-claim-without-job",
        proposal_valuation_regeneration_claimed_at: new Date(),
      });
      queuePreviewFilesJob.mockResolvedValueOnce(undefined);

      await expect(
        queueAssetScheduleSheetRegeneration(String(report._id), 8)
      ).resolves.toEqual({ queued: true, coalesced: false });
      expect(queuePreviewFilesJob).toHaveBeenCalledWith(
        String(report._id),
        expect.objectContaining({
          jobId: "pv-claim-without-job",
          generationToken: "pv-claim-without-job",
        })
      );
      const stored = await AssetReport.findById(report._id).lean();
      expect(stored).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        proposal_valuation_generation_revision: 8,
      });
      expect(
        (stored as any)?.proposal_valuation_regeneration_claim_token
      ).toBeUndefined();
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("coalesces behind an active durable file job without clearing its claim", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        proposal_valuation_revision: 9,
        proposal_valuation_generation_revision: 9,
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: new Date(),
        proposal_valuation_regeneration_claim_token: "pv-claim-with-job",
        proposal_valuation_regeneration_claimed_at: new Date(),
      });
      await ReportJob.create({
        type: "asset-preview-files",
        reportId: String(report._id),
        status: "queued",
        payload: { reportId: String(report._id) },
      });

      await expect(
        queueAssetScheduleSheetRegeneration(String(report._id), 9)
      ).resolves.toEqual({ queued: true, coalesced: true });
      expect(queuePreviewFilesJob).not.toHaveBeenCalled();
      const stored = await AssetReport.findById(report._id).lean();
      expect(stored).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        files_regeneration_pending: false,
        job_status: "queued",
      });
      expect(
        (stored as any)?.proposal_valuation_regeneration_claim_token
      ).toBeUndefined();
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("does not steal a fresh untagged claim owned by another file producer", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const queuedAt = new Date();
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        proposal_valuation_revision: 10,
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: queuedAt,
      });

      await expect(
        queueAssetScheduleSheetRegeneration(String(report._id), 10)
      ).resolves.toEqual({ queued: true, coalesced: true });
      expect(queuePreviewFilesJob).not.toHaveBeenCalled();
      const stored = await AssetReport.findById(report._id).lean();
      expect(stored).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        files_regeneration_pending: true,
        job_status: "queued",
        queued_at: queuedAt,
      });
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("repairs a concurrent tagged claim without reopening flags to Excel", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    let resolveOriginal!: () => void;
    queuePreviewFilesJob
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOriginal = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);
    try {
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        proposal_valuation_revision: 12,
      });

      const original = queueAssetScheduleSheetRegeneration(
        String(report._id),
        12
      );
      await vi.waitFor(() =>
        expect(queuePreviewFilesJob).toHaveBeenCalledTimes(1)
      );
      const held = await AssetReport.findById(report._id).lean();
      const heldToken = String(
        (held as any)?.proposal_valuation_regeneration_claim_token || ""
      );
      expect(heldToken).toBeTruthy();
      expect(held).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        proposal_valuation_generation_revision: 12,
      });

      const retry = queueAssetScheduleSheetRegeneration(
        String(report._id),
        12
      );
      await expect(retry).resolves.toEqual({
        queued: true,
        coalesced: false,
      });
      const excelClaim = await AssetReport.findOneAndUpdate(
        {
          _id: report._id,
          files_generating: { $ne: true },
          files_regenerating: { $ne: true },
          job_status: { $nin: ["queued", "processing"] },
        },
        { $set: { job_id: "should-not-claim" } },
        { new: true }
      );
      expect(excelClaim).toBeNull();
      const afterRetry = await AssetReport.findById(report._id).lean();
      expect(afterRetry).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
      });
      expect(
        (afterRetry as any)?.proposal_valuation_regeneration_claim_token
      ).toBeUndefined();

      resolveOriginal();
      await expect(original).resolves.toEqual({
        queued: true,
        coalesced: false,
      });
      expect(queuePreviewFilesJob).toHaveBeenCalledTimes(2);
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("prevents Excel stale recovery from stealing an aged tagged PV outbox", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const queuedAt = new Date(Date.now() - 2 * 60_000);
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        proposal_valuation_revision: 13,
        proposal_valuation_generation_revision: 13,
        proposal_valuation_regeneration_claim_token: "aged-pv-outbox",
        proposal_valuation_regeneration_claimed_at: queuedAt,
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: queuedAt,
      });

      await expect(
        queueExcelCrRegenerationJob({
          kind: "asset",
          reportId: String(report._id),
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "EXCEL_CR_REGENERATION_IN_PROGRESS",
      });
      const afterExcel = await AssetReport.findById(report._id).lean();
      expect(afterExcel).toMatchObject({
        proposal_valuation_regeneration_claim_token: "aged-pv-outbox",
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: queuedAt,
      });

      queuePreviewFilesJob.mockResolvedValueOnce(undefined);
      await expect(
        queueAssetScheduleSheetRegeneration(String(report._id), 13)
      ).resolves.toEqual({ queued: true, coalesced: false });
      const afterPvResume = await AssetReport.findById(report._id).lean();
      expect(afterPvResume).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        proposal_valuation_generation_revision: 13,
      });
      expect(
        (afterPvResume as any)?.proposal_valuation_regeneration_claim_token
      ).toBeUndefined();
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("does not let Excel steal an aged untagged generic preview claim", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const queuedAt = new Date(Date.now() - 10 * 60_000);
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: queuedAt,
      });

      await expect(
        queueExcelCrRegenerationJob({
          kind: "asset",
          reportId: String(report._id),
        })
      ).rejects.toMatchObject({
        code: "EXCEL_CR_REGENERATION_IN_PROGRESS",
      });
      expect(await AssetReport.findById(report._id).lean()).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        queued_at: queuedAt,
      });
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("repairs a typed Excel outbox without reopening shared file flags", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const queuedAt = new Date(Date.now() - 10 * 60_000);
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        files_generating: true,
        files_regenerating: true,
        job_id: "excel-outbox-token",
        job_status: "queued",
        queued_at: queuedAt,
        excel_cr_regeneration_claim_token: "excel-outbox-token",
        excel_cr_regeneration_claimed_at: queuedAt,
      });

      await expect(
        queueExcelCrRegenerationJob({
          kind: "asset",
          reportId: String(report._id),
        })
      ).resolves.toMatchObject({ progressId: "excel-outbox-token" });
      const [stored, jobs] = await Promise.all([
        AssetReport.findById(report._id).lean(),
        ReportJob.find({
          reportId: String(report._id),
          type: "asset-excel-cr-files",
        }).lean(),
      ]);
      expect(stored).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_status: "queued",
        job_id: "excel-outbox-token",
      });
      expect(
        (stored as any)?.excel_cr_regeneration_claim_token
      ).toBeUndefined();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: "queued",
        progressId: "excel-outbox-token",
      });
    } finally {
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("retains an embedded Excel/CR outbox when the durable insert fails and recovers it on retry", async () => {
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    const insertSpy = vi
      .spyOn(ReportJob, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("queue insert unavailable"));
    try {
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "approved",
        preview_data: {},
        files_generating: false,
        files_regenerating: false,
        job_status: "done",
      });

      await expect(
        queueExcelCrRegenerationJob({
          kind: "asset",
          reportId: String(report._id),
        })
      ).rejects.toThrow("queue insert unavailable");

      const pending: any = await AssetReport.findById(report._id)
        .select("+report_job_outbox")
        .lean();
      const generationToken = String(
        pending?.excel_cr_regeneration_claim_token || ""
      );
      expect(generationToken).toBeTruthy();
      expect(pending).toMatchObject({
        files_generating: true,
        files_regenerating: true,
        job_id: generationToken,
        job_status: "queued",
        report_job_outbox: {
          type: "asset-excel-cr-files",
          reportId: String(report._id),
          progressId: generationToken,
          idempotencyKey: `asset-excel-cr-files:${String(report._id)}:${generationToken}`,
          payload: {
            reportId: String(report._id),
            generationToken,
            notifyOwnerOnFailure: false,
          },
        },
      });
      expect(await ReportJob.countDocuments()).toBe(0);

      insertSpy.mockRestore();
      await expect(
        queueExcelCrRegenerationJob({
          kind: "asset",
          reportId: String(report._id),
        })
      ).resolves.toMatchObject({ progressId: generationToken });

      const recovered: any = await AssetReport.findById(report._id)
        .select("+report_job_outbox")
        .lean();
      expect(recovered.report_job_outbox).toBeUndefined();
      expect(recovered.excel_cr_regeneration_claim_token).toBeUndefined();
      expect(
        await ReportJob.countDocuments({
          type: "asset-excel-cr-files",
          reportId: String(report._id),
          progressId: generationToken,
        })
      ).toBe(1);
    } finally {
      insertSpy.mockRestore();
      if (previousBackend === undefined) {
        delete process.env.REPORT_QUEUE_BACKEND;
      } else {
        process.env.REPORT_QUEUE_BACKEND = previousBackend;
      }
    }
  });

  it("does not roll back a newer PV queue claim after an older enqueue fails", async () => {
    let rejectEnqueue!: (error: Error) => void;
    queuePreviewFilesJob.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEnqueue = reject;
        })
    );
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 11,
    });

    const queueing = queueAssetScheduleSheetRegeneration(
      String(report._id),
      11
    );
    await vi.waitFor(() => expect(queuePreviewFilesJob).toHaveBeenCalled());
    const firstClaim = await AssetReport.findById(report._id).lean();
    expect(
      (firstClaim as any)?.proposal_valuation_regeneration_claim_token
    ).toBeTruthy();
    const newerQueuedAt = new Date(Date.now() + 1_000);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          proposal_valuation_regeneration_claim_token: "newer-pv-claim",
          proposal_valuation_regeneration_claimed_at: newerQueuedAt,
          queued_at: newerQueuedAt,
          files_generating: true,
          files_regenerating: true,
          job_status: "queued",
        },
      }
    );
    rejectEnqueue(new Error("ambiguous enqueue failure"));

    await expect(queueing).resolves.toMatchObject({ queued: false });
    const stored = await AssetReport.findById(report._id).lean();
    expect(stored).toMatchObject({
      proposal_valuation_regeneration_claim_token: "newer-pv-claim",
      queued_at: newerQueuedAt,
      files_generating: true,
      files_regenerating: true,
      job_status: "queued",
    });
  });

  it("persists generated lots without overwriting a newer Proposal Valuation sheet", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      proposal_valuation_revision: 4,
      preview_data: {
        contract_no: "CONCURRENT-PV",
        lots: [],
        total_value: 1,
        total_appraised_value: 2,
        valuation_data: {
          baseFMV: 3,
          methods: [{ method: "Old", percentage: 100, value: 3 }],
          narrative: "preserve this sibling",
        },
        admin_schedule_sheet: {
          evaluator_columns: [{ id: "legacy", name: "Before" }],
          rows: [],
          file_summary: {},
        },
      },
    });
    const latestSheet = {
      evaluator_columns: [{ id: "legacy", name: "After live edit" }],
      rows: [{ lot_id: "lot-1", evaluator_values: { legacy: 9_999 } }],
      file_summary: { buyers_premium_basis: "capped" },
    };
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          "preview_data.admin_schedule_sheet": latestSheet,
          proposal_valuation_revision: 5,
        },
      }
    );

    await persistAssetGeneratedLots({
      reportId: String(report._id),
      lots: [
        {
          lot_id: "lot-1",
          title: "Generated lot",
          description: "Generated description",
          image_indexes: [],
        },
      ],
      analysis: { auctioneer_import_enrichment: [{ lot_id: "lot-1" }] },
      derivedPreviewData: {
        total_value: 10_000,
        total_appraised_value: 10_000,
        valuation_data: {
          baseFMV: 10_000,
          methods: [
            { method: "Market", percentage: 80, value: 8_000 },
            { method: "Cost", percentage: 20, value: 2_000 },
          ],
        },
      },
    });

    const stored = await AssetReport.findById(report._id).lean();
    expect((stored as any)?.proposal_valuation_revision).toBe(5);
    expect((stored as any)?.preview_data?.admin_schedule_sheet).toEqual(
      latestSheet
    );
    expect((stored as any)?.preview_data?.lots[0]).toMatchObject({
      lot_id: "lot-1",
      title: "Generated lot",
    });
    expect((stored as any)?.preview_data).toMatchObject({
      total_value: 10_000,
      total_appraised_value: 10_000,
      valuation_data: {
        baseFMV: 10_000,
        methods: [
          { method: "Market", percentage: 80, value: 8_000 },
          { method: "Cost", percentage: 20, value: 2_000 },
        ],
        narrative: "preserve this sibling",
      },
    });
  });

  it("serializes canonical artifact publication by revision and atomically publishes its URL map", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 7,
      preview_files: { docx: "https://files.test/old.docx?v=1" },
    });

    let markStarted!: () => void;
    let releasePublish!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let canonicalValue = "old";
    const firstPublication = publishProposalValuationArtifactsForRevision({
      reportId: String(report._id),
      revision: 7,
      previewFiles: { docx: "https://files.test/revision-7.docx?v=7" },
      publish: async ({ renew }) => {
        markStarted();
        await gate;
        await renew();
        canonicalValue = "revision-7";
      },
    });
    await started;

    const blockedMutation = await AssetReport.updateOne(
      {
        _id: report._id,
        ...proposalValuationWritableRevisionCondition(7),
      },
      { $inc: { proposal_valuation_revision: 1 } }
    );
    expect(blockedMutation.matchedCount).toBe(0);

    releasePublish();
    await expect(firstPublication).resolves.toMatchObject({ published: true });
    const published = await AssetReport.findById(report._id).lean();
    expect(published).toMatchObject({
      proposal_valuation_revision: 7,
      proposal_valuation_published_revision: 7,
      preview_files: { docx: "https://files.test/revision-7.docx?v=7" },
    });
    expect((published as any)?.proposal_valuation_artifact_publish_token).toBeUndefined();

    const committedMutation = await AssetReport.updateOne(
      {
        _id: report._id,
        ...proposalValuationWritableRevisionCondition(7),
      },
      { $inc: { proposal_valuation_revision: 1 } }
    );
    expect(committedMutation.matchedCount).toBe(1);

    const stalePublish = vi.fn(async () => {
      canonicalValue = "stale-revision-7";
    });
    await expect(
      publishProposalValuationArtifactsForRevision({
        reportId: String(report._id),
        revision: 7,
        publish: stalePublish,
      })
    ).resolves.toMatchObject({
      published: false,
      reason: "revision-changed",
      currentRevision: 8,
    });
    expect(stalePublish).not.toHaveBeenCalled();

    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          proposal_valuation_artifact_publish_token: "crashed-worker",
          proposal_valuation_artifact_publish_revision: 8,
          proposal_valuation_artifact_publish_expires_at: new Date(
            Date.now() - 1_000
          ),
        },
      }
    );
    await expect(
      publishProposalValuationArtifactsForRevision({
        reportId: String(report._id),
        revision: 8,
        previewFiles: { docx: "https://files.test/revision-8.docx?v=8" },
        publish: async () => {
          canonicalValue = "revision-8";
        },
      })
    ).resolves.toMatchObject({ published: true });
    expect(canonicalValue).toBe("revision-8");
  });

  it("waits through a crashed publish lease inside one worker attempt", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      proposal_valuation_revision: 6,
      proposal_valuation_artifact_publish_token: "crashed-publisher",
      proposal_valuation_artifact_publish_revision: 6,
      proposal_valuation_artifact_publish_expires_at: new Date(
        Date.now() + 60_000
      ),
    });
    let attempts = 0;
    const publish = vi.fn(async () => undefined);

    const result = await waitForAssetArtifactPublication({
      maxWaitMs: 500,
      attempt: () => {
        attempts += 1;
        return publishProposalValuationArtifactsForRevision({
          reportId: String(report._id),
          revision: 6,
          publish,
        });
      },
      sleep: async () => {
        await AssetReport.updateOne(
          { _id: report._id },
          {
            $set: {
              proposal_valuation_artifact_publish_expires_at: new Date(
                Date.now() - 1
              ),
            },
          }
        );
      },
    });

    expect(result).toMatchObject({ published: true });
    expect(attempts).toBeGreaterThan(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("keeps prior immutable artifact pointers and leaves PV editable after publication fails", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: {},
      preview_files: { excel: "https://files.example/previous.xlsx" },
      proposal_valuation_revision: 11,
    });

    await expect(
      publishProposalValuationArtifactsForRevision({
        reportId: String(report._id),
        revision: 11,
        publish: async () => {
          throw new Error("simulated publication interruption");
        },
      })
    ).rejects.toThrow("simulated publication interruption");

    const interrupted = await AssetReport.findById(report._id).lean();
    expect(interrupted).toMatchObject({
      proposal_valuation_revision: 11,
      preview_files: { excel: "https://files.example/previous.xlsx" },
    });
    expect(
      (interrupted as any)?.proposal_valuation_artifact_repair_required
    ).not.toBe(true);
    const editable = await AssetReport.updateOne(
      {
        _id: report._id,
        ...proposalValuationWritableRevisionCondition(11),
      },
      { $inc: { proposal_valuation_revision: 1 } }
    );
    expect(editable.matchedCount).toBe(1);
  });

  it("persists stale generic preview edits without touching the latest PV sheet or revision", async () => {
    const latestSheet = {
      evaluator_columns: [{ id: "linked", name: "Latest evaluator" }],
      rows: [{ lot_id: "lot-1", evaluator_values: { linked: 7_500 } }],
      file_summary: { buyers_premium_basis: "capped" },
    };
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      proposal_valuation_revision: 9,
      preview_data: {
        client_name: "Before",
        obsolete_generic_field: "remove me",
        admin_schedule_sheet: latestSheet,
      },
    });

    await persistAssetPreviewDataPreservingProposalValuation({
      reportId: String(report._id),
      previewData: {
        client_name: "Updated in stale preview tab",
        admin_schedule_sheet: {
          evaluator_columns: [],
          rows: [],
          file_summary: {},
        },
      },
      previousPreviewData: {
        client_name: "Before",
        obsolete_generic_field: "remove me",
        admin_schedule_sheet: { rows: [{ lot_id: "stale" }] },
      },
    });

    const stored = await AssetReport.findById(report._id).lean();
    expect((stored as any)?.proposal_valuation_revision).toBe(9);
    expect((stored as any)?.preview_data?.admin_schedule_sheet).toEqual(
      latestSheet
    );
    expect((stored as any)?.preview_data?.client_name).toBe(
      "Updated in stale preview tab"
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        (stored as any)?.preview_data || {},
        "obsolete_generic_field"
      )
    ).toBe(false);
  });

  it("atomically rejects a stale generic preview save without committing workflow flags", async () => {
    const originalSheet = {
      evaluator_columns: [],
      rows: [{ lot_id: "lot-1", title: "Original" }],
      file_summary: {},
    };
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      proposal_valuation_revision: 3,
      preview_data: {
        client_name: "Original client",
        admin_schedule_sheet: originalSheet,
      },
      files_generating: false,
      files_regenerating: false,
      job_status: "done",
    });
    const stale = await AssetReport.findById(report._id);
    const previousPreviewData = JSON.parse(
      JSON.stringify((stale as any).preview_data)
    );
    (stale as any).preview_data = {
      ...previousPreviewData,
      client_name: "Stale generic edit",
    };
    (stale as any).files_generating = true;
    (stale as any).files_regenerating = true;
    (stale as any).job_status = "queued";

    const latestSheet = {
      evaluator_columns: [{ id: "linked", name: "Latest" }],
      rows: [{ lot_id: "lot-1", evaluator_values: { linked: 99 } }],
      file_summary: {},
    };
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: { "preview_data.admin_schedule_sheet": latestSheet },
        $inc: { proposal_valuation_revision: 1 },
      }
    );

    await expect(
      saveAssetReportWithProtectedPreviewData({
        report: stale,
        previousPreviewData,
      })
    ).rejects.toMatchObject({ code: "PV_PREVIEW_WRITE_CONFLICT" });

    const stored = await AssetReport.findById(report._id).lean();
    expect(stored).toMatchObject({
      status: "approved",
      proposal_valuation_revision: 4,
      files_generating: false,
      files_regenerating: false,
      job_status: "done",
    });
    expect((stored as any)?.preview_data?.client_name).toBe("Original client");
    expect((stored as any)?.preview_data?.admin_schedule_sheet).toEqual(
      latestSheet
    );
  });

  it("persists only an ordered unique set of owned Asset cover images", async () => {
    const imageUrls = Array.from(
      { length: 6 },
      (_, index) => `https://assetinsight.test/uploads/asset/cover-${index + 1}.jpg`
    );
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls,
      lots: [],
      status: "preview",
      preview_data: { client_name: "Cover selection" },
    });
    const previousPreviewData = JSON.parse(
      JSON.stringify((report as any).preview_data)
    );
    (report as any).preview_data = {
      ...previousPreviewData,
      cover_image_urls: [
        imageUrls[4],
        "https://untrusted.example/outsider.jpg",
        imageUrls[1],
        imageUrls[4],
        imageUrls[5],
        imageUrls[0],
        imageUrls[2],
      ],
    };

    await saveAssetReportWithProtectedPreviewData({
      report,
      previousPreviewData,
    });

    const stored = await AssetReport.findById(report._id).lean();
    expect((stored as any)?.preview_data?.cover_image_urls).toEqual([
      imageUrls[4],
      imageUrls[1],
      imageUrls[5],
      imageUrls[0],
    ]);

    const legacyClientReport = await AssetReport.findById(report._id);
    const currentPreviewData = JSON.parse(
      JSON.stringify((legacyClientReport as any).preview_data)
    );
    (legacyClientReport as any).preview_data = {
      client_name: "Saved by an older client",
    };
    await saveAssetReportWithProtectedPreviewData({
      report: legacyClientReport,
      previousPreviewData: currentPreviewData,
    });
    expect(
      (await AssetReport.findById(report._id).lean() as any)?.preview_data
        ?.cover_image_urls
    ).toEqual([imageUrls[4], imageUrls[1], imageUrls[5], imageUrls[0]]);

    const resetReport = await AssetReport.findById(report._id);
    const previewBeforeReset = JSON.parse(
      JSON.stringify((resetReport as any).preview_data)
    );
    (resetReport as any).preview_data = {
      ...previewBeforeReset,
      cover_image_urls: [],
    };
    await saveAssetReportWithProtectedPreviewData({
      report: resetReport,
      previousPreviewData: previewBeforeReset,
    });
    expect(
      (await AssetReport.findById(report._id).lean() as any)?.preview_data
        ?.cover_image_urls
    ).toEqual([]);
  });

  it("treats a cover selection in another report as a live media reference", async () => {
    const selectedUrl =
      "https://assetinsight.test/uploads/asset/shared-cover-reference.jpg";
    await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "preview",
      preview_data: { cover_image_urls: [selectedUrl] },
    });

    await expect(
      runReportImageDeletionJob({
        payload: {
          url: selectedUrl,
          key: "uploads/asset/shared-cover-reference.jpg",
        },
      } as any)
    ).resolves.toBeUndefined();
  });

  it("overlays the latest database PV sheet onto a queued generic preview snapshot", () => {
    const latestSheet = {
      evaluator_columns: [{ id: "linked", name: "Latest" }],
      rows: [{ lot_id: "lot-1", evaluator_values: { linked: 12_000 } }],
      file_summary: {},
    };
    const staleSnapshot = {
      client_name: "Queued generic edit",
      admin_schedule_sheet: {
        evaluator_columns: [],
        rows: [{ lot_id: "stale" }],
        file_summary: {},
      },
    };

    const resolved = getPreviewDataForJob(
      { preview_data: { admin_schedule_sheet: latestSheet } },
      staleSnapshot
    );

    expect(resolved.client_name).toBe("Queued generic edit");
    expect(resolved.admin_schedule_sheet).toEqual(latestSheet);
    expect(staleSnapshot.admin_schedule_sheet.rows[0].lot_id).toBe("stale");
  });
});
