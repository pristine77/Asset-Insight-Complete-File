import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import User from "../src/models/user.model.js";

const queueMocks = vi.hoisted(() => ({ ensureReportJobOutbox: vi.fn(), requiresAssetApproval: vi.fn() }));
vi.mock("../src/utils/reportJobMongoQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/reportJobMongoQueue.js")>()),
  ensureReportJobOutbox: queueMocks.ensureReportJobOutbox,
}));
vi.mock("../src/utils/assetApprovalThreshold.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/assetApprovalThreshold.js")>()),
  requiresAssetApproval: queueMocks.requiresAssetApproval,
}));

type Kind = "asset" | "lotListing";
const cases = ["asset", "lotListing"] as const;
let mongo: MongoMemoryServer;
let recovery: typeof import("../src/service/reportRestartRecoveryService.js");
let realEnsure: typeof import("../src/utils/reportJobMongoQueue.js")["ensureReportJobOutbox"];
let realRequiresApproval: typeof import("../src/utils/assetApprovalThreshold.js")["requiresAssetApproval"];
const originalQueueBackend = process.env.REPORT_QUEUE_BACKEND;
const actorId = new mongoose.Types.ObjectId();
const originalPhotos = [
  "https://assetinsight.test/retained/first.jpg",
  "https://assetinsight.test/retained/last.jpg",
];
const savedLot = {
  lot_id: "saved-lot-1",
  lot_number: "0157A",
  title: "Appraiser-corrected truck",
  description: "Appraiser correction with a reference URL.\nSecond paragraph must survive recovery.",
  estimated_value: "CA$18,500",
  image_indexes: [0, 1],
  image_urls: originalPhotos,
  serial_number: "Appraiser-corrected serial",
  condition_report_specs: { Engine: "Saved engine details" },
  condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
  cover_index: 1,
};

function modelFor(kind: Kind): any {
  return kind === "asset" ? AssetReport : LotListing;
}

async function loadReport(kind: Kind, id: unknown) {
  return modelFor(kind).findById(id).select("+report_job_outbox +job_execution_token").lean();
}

async function createReport(kind: Kind, overrides: Record<string, unknown> = {}) {
  const suffix = new mongoose.Types.ObjectId().toString();
  const canonicalPreview = {
    contract_no: `RECOVERY-${suffix}`,
    grouping_mode: "single_lot",
    sales_date: "2026-09-01T00:00:00.000Z",
    location: "Regina, SK",
    currency: "CAD",
    valuation_methods: ["FML"],
    lots: [savedLot],
  };
  return modelFor(kind).create({
    user: actorId,
    contract_no: canonicalPreview.contract_no,
    grouping_mode: "single_lot",
    sales_date: new Date(canonicalPreview.sales_date),
    location: canonicalPreview.location,
    imageUrls: originalPhotos,
    lots: [{ ...savedLot, description: "Stale root description must not win" }],
    preview_data: canonicalPreview,
    preview_submitted_at: new Date("2026-09-10T12:00:00.000Z"),
    status: "error",
    job_status: "error",
    job_id: `orphaned-${suffix}`,
    job_error: recovery.ORPHANED_REPORT_MESSAGE,
    error_message: recovery.ORPHANED_REPORT_MESSAGE,
    generation_target_status: kind === "asset" ? "pending_approval" : "approved",
    files_generating: false,
    files_regenerating: false,
    ...overrides,
  });
}

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ ensureReportJobOutbox: realEnsure } = await vi.importActual<typeof import("../src/utils/reportJobMongoQueue.js")>(
    "../src/utils/reportJobMongoQueue.js",
  ));
  ({ requiresAssetApproval: realRequiresApproval } = await vi.importActual<typeof import("../src/utils/assetApprovalThreshold.js")>(
    "../src/utils/assetApprovalThreshold.js",
  ));
  recovery = await import("../src/service/reportRestartRecoveryService.js");
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), LotListing.syncIndexes(), ReportJob.syncIndexes()]);
  queueMocks.ensureReportJobOutbox.mockReset().mockImplementation(realEnsure);
  queueMocks.requiresAssetApproval.mockReset().mockImplementation(realRequiresApproval);
  await User.collection.insertOne({
    _id: actorId,
    username: "recovery-admin",
    email: "recovery-admin@example.test",
    role: "admin",
    isVerified: true,
  } as any);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (originalQueueBackend === undefined) delete process.env.REPORT_QUEUE_BACKEND;
  else process.env.REPORT_QUEUE_BACKEND = originalQueueBackend;
});

describe.sequential("safe restart recovery and administrator saved-preview resubmission", () => {
  it("recognizes the exact existing orphan diagnostic", () => {
    expect(recovery.ORPHANED_REPORT_MESSAGE).toBe(
      "No active processing job or complete source upload was found. Reopen the saved draft and retry.",
    );
  });

  it.each(cases)("%s recovers a submitted canonical preview with one immutable files-only job", async (kind) => {
    const report = await createReport(kind);
    const before = await loadReport(kind, report._id);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("requeued");

    const persisted = await loadReport(kind, report._id);
    const jobs = await ReportJob.find({ reportId: String(report._id) }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: kind === "asset" ? "asset-preview-files" : "lot-listing-files",
      reportId: String(report._id),
      status: "queued",
      progressId: persisted.job_id,
    });
    expect(jobs[0].payload.previewDataSnapshot).toEqual(before.preview_data);
    expect(jobs[0].payload.previewDataSnapshot.lots[0]).toMatchObject(savedLot);
    expect(persisted.preview_data).toEqual(before.preview_data);
    expect(persisted.imageUrls).toEqual(originalPhotos);
    expect(persisted.files_generating).toBe(true);
    expect(persisted.job_status).toBe("queued");
    expect(persisted.status).not.toBe("approved");
    expect(persisted.release_status).not.toBe("released");
    expect(await modelFor(kind).countDocuments()).toBe(1);
    expect(jobs[0].payload).not.toHaveProperty("images");
    expect(jobs[0].payload).not.toHaveProperty("details");
    expect(persisted.report_job_outbox).toBeUndefined();
  });

  it.each(cases.flatMap((kind) => ["pending_approval", "approved"].map((target) => ({ kind, target }))))(
    "$kind leaves an unsubmitted preview byte-for-byte unchanged despite a stale $target target",
    async ({ kind, target }) => {
      const report = await createReport(kind, {
        preview_submitted_at: undefined,
        // A stale desired status is not proof that the owner submitted the preview.
        generation_target_status: target,
      });
      // Include hidden recovery receipts/history and timestamps in the equality
      // check: even a status-only restoration is an unwanted automatic mutation.
      const before = await modelFor(kind).collection.findOne({ _id: report._id });
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await recovery.recoverOrphanedReportsOnStartup();
      expect(await modelFor(kind).collection.findOne({ _id: report._id })).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
    },
  );

  it.each(cases.flatMap((kind) => ["preview", "error", "pending_approval", "approved"].map((status) => ({ kind, status }))))(
    "$kind never generates files automatically for a done $status report, even with old submission evidence",
    async ({ kind, status }) => {
      const report = await createReport(kind, { status, job_status: "done" });
      const before = await modelFor(kind).collection.findOne({ _id: report._id });
      expect(before.preview_submitted_at).toBeTruthy();
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await recovery.recoverOrphanedReportsOnStartup();
      expect(await modelFor(kind).collection.findOne({ _id: report._id })).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("%s cannot rebuild when no canonical preview or legacy root lots exist", async (kind) => {
    const report = await createReport(kind);
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $unset: { preview_data: "" }, $set: { lots: [] } });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("incomplete");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).status).toBe("error");
  });

  it.each(["absent", "defaults-only"])("retains Lot legacy compatibility for an %s canonical preview", async (shape) => {
    const report = await createReport("lotListing");
    await LotListing.collection.updateOne({ _id: report._id }, shape === "absent" ? {
      $unset: { preview_data: "" },
    } : {
      $set: { preview_data: { include_damage_analysis: true, bank_photos_enabled: false,
        valuation_methods: ["FML"], lots: [], videoUrls: [], deleted_image_indexes: [], deleted_image_urls: [] } },
    });
    const before = await loadReport("lotListing", report._id);
    expect(await recovery.recoverOrphanedReport("lotListing", String(report._id))).toBe("requeued");
    const job = await ReportJob.findOne({ reportId: String(report._id) }).lean();
    expect(job?.type).toBe("lot-listing-files");
    expect(job?.payload.previewDataSnapshot.lots).toEqual(before.lots);
    expect((await loadReport("lotListing", report._id)).imageUrls).toEqual(originalPhotos);
  });

  it.each(cases)("%s respects explicitly emptied canonical lots instead of reviving stale rows", async (kind) => {
    const report = await createReport(kind);
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: { "preview_data.lots": [] } });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("incomplete");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).preview_data.lots).toEqual([]);
  });

  it.each(cases)("%s leaves photo-only intake shells for explicit completion instead of inventing analysis", async (kind) => {
    const report = await createReport(kind);
    await modelFor(kind).collection.updateOne({ _id: report._id }, {
      $set: { "preview_data.lots": [{ lot_id: "unfinished", lot_number: "1", image_indexes: [0, 1] }] },
    });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("incomplete");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(cases)("%s never requeues an unrelated generation failure", async (kind) => {
    const report = await createReport(kind, { job_error: "Document converter failed", error_message: "Document converter failed" });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(cases.flatMap((kind) => ["declined", "preview"].map((status) => ({ kind, status }))))(
    "$kind leaves $status alone despite historical submission dates and stale orphan diagnostics",
    async ({ kind, status }) => {
      const report = await createReport(kind, { status });
      const before = await loadReport(kind, report._id);
      expect(before.preview_submitted_at).toBeTruthy();
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await recovery.recoverOrphanedReportsOnStartup();
      expect(await loadReport(kind, report._id)).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("%s coalesces concurrent recovery attempts on one report", async (kind) => {
    const report = await createReport(kind);
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      recovery.recoverOrphanedReport(kind, String(report._id)),
    ));
    expect(results.filter((result) => result === "requeued")).toHaveLength(1);
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(1);
    expect(await modelFor(kind).countDocuments()).toBe(1);
  });

  it("preserves the Asset approval gate instead of turning recovery into approval", async () => {
    const approverId = new mongoose.Types.ObjectId();
    await User.updateOne({ _id: actorId }, { $set: { reportApprover: approverId } });
    queueMocks.requiresAssetApproval.mockResolvedValueOnce(true);
    const report = await createReport("asset");
    expect(await recovery.recoverOrphanedReport("asset", String(report._id))).toBe("requeued");
    const persisted = await loadReport("asset", report._id);
    const job = await ReportJob.findOne({ reportId: String(report._id) }).lean();
    expect(persisted.generation_target_status).toBe("pending_approval");
    expect(String(persisted.approval_assigned_to)).toBe(String(approverId));
    expect(persisted.status).toBe("processing");
    expect(persisted.approval_processed_at).toBeUndefined();
    expect(persisted.released_at).toBeUndefined();
    expect(job?.targetStatus).toBe("pending_approval");
    expect(job?.payload.targetStatus).toBe("pending_approval");
  });

  it("does not treat an Asset's stale approved target and old decision timestamp as current approval", async () => {
    const approverId = new mongoose.Types.ObjectId();
    await User.updateOne({ _id: actorId }, { $set: { reportApprover: approverId } });
    queueMocks.requiresAssetApproval.mockResolvedValueOnce(true);
    const report = await createReport("asset", {
      generation_target_status: "approved",
      approval_processed_at: new Date("2026-09-01T12:00:00.000Z"),
    });
    expect(await recovery.recoverOrphanedReport("asset", String(report._id))).toBe("requeued");
    const persisted = await loadReport("asset", report._id);
    const job = await ReportJob.findOne({ reportId: String(report._id) }).lean();
    expect(persisted.status).toBe("processing");
    expect(persisted.generation_target_status).toBe("pending_approval");
    expect(persisted.approval_processed_at).toBeUndefined();
    expect(persisted.released_at).toBeUndefined();
    expect(job?.targetStatus).toBe("pending_approval");
  });

  it.each(cases)("%s retains previous artifact pointers until replacement files are published", async (kind) => {
    const files = { spec_pdf: "https://assetinsight.test/reports/previous.pdf",
      cr_docx: "https://assetinsight.test/reports/previous.docx",
      excel: "https://assetinsight.test/reports/previous.xlsx",
      images: "https://assetinsight.test/reports/previous.zip" };
    const report = await createReport(kind, { files, preview_files: files });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("requeued");
    const persisted = await loadReport(kind, report._id);
    expect(persisted.files).toMatchObject(files);
    expect(persisted.preview_files).toMatchObject(files);
    expect(persisted.files_generating).toBe(true);
    expect(persisted.job_status).toBe("queued");
  });

  it.each(cases)("%s leaves live jobs alone even when the parent diagnostic is stale", async (kind) => {
    const report = await createReport(kind);
    const job = await ReportJob.create({
      type: kind === "asset" ? "asset-preview-files" : "lot-listing-files",
      reportId: String(report._id), progressId: report.job_id, status: "processing",
      executionToken: "existing-live-execution", leaseUntil: new Date(Date.now() + 60_000), payload: {},
    });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments()).toBe(1);
    expect((await ReportJob.findById(job._id).lean())?.executionToken).toBe("existing-live-execution");
  });

  it.each(cases)("%s leaves a pending outbox to its existing durable dispatcher", async (kind) => {
    const existingOutbox = { token: "existing-handoff", type: kind === "asset" ? "asset-preview-files" : "lot-listing-files" };
    const report = await createReport(kind, { report_job_outbox: existingOutbox });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect((await loadReport(kind, report._id)).report_job_outbox).toEqual(existingOutbox);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it.each(cases.flatMap((kind) => ["excel_regenerating", "files_regeneration_pending"].map((flag) => ({ kind, flag }))))(
    "$kind does not overlap an existing $flag producer",
    async ({ kind, flag }) => {
      const report = await createReport(kind);
      await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: { [flag]: true } });
      const before = await loadReport(kind, report._id);
      const state = recovery.getReportResubmitState(kind, before);
      expect(state.resubmitEligible).toBe(false);
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await expect(recovery.resubmitSavedReportPreview({
        kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
      })).rejects.toMatchObject({ statusCode: 409 });
      expect(await loadReport(kind, report._id)).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("%s does not race an active artifact publication lease", async (kind) => {
    const report = await createReport(kind, kind === "asset" ? {
      proposal_valuation_artifact_publish_token: "live-asset-publisher",
      proposal_valuation_artifact_publish_expires_at: new Date(Date.now() + 60_000),
    } : {
      artifact_publish_token: "live-lot-publisher",
      artifact_publish_expires_at: new Date(Date.now() + 60_000),
    });
    const state = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
    expect(state.resubmitEligible).toBe(false);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    await expect(recovery.resubmitSavedReportPreview({
      kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(cases)("%s does not reverse a deliberate cancellation", async (kind) => {
    const report = await createReport(kind);
    await ReportJob.create({
      type: kind === "asset" ? "asset-preview-files" : "lot-listing-files",
      reportId: String(report._id), progressId: report.job_id, status: "cancelled", payload: {},
    });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments({ status: "queued" })).toBe(0);
  });

  it.each(cases)("%s does not automatically retry an exhausted failed job on every restart", async (kind) => {
    const report = await createReport(kind);
    const job = await ReportJob.create({
      type: kind === "asset" ? "asset-preview-files" : "lot-listing-files",
      reportId: String(report._id), progressId: report.job_id, status: "failed",
      attempts: 3, maxAttempts: 3, lastError: "Document conversion failed", payload: {},
    });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect((await ReportJob.findById(job._id).lean())?.attempts).toBe(3);
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it.each(cases)("%s repairs submitted saved data after a completed legacy job without reviving that job", async (kind) => {
    const report = await createReport(kind);
    const oldJob = await ReportJob.create({
      type: kind === "asset" ? "asset-preview" : "lot-listing-preview",
      reportId: String(report._id), progressId: report.job_id, status: "completed",
      attempts: 1, completedAt: new Date("2026-09-09T12:00:00.000Z"), payload: { legacy: true },
    });
    const before = await ReportJob.findById(oldJob._id).lean();
    const preview = (await loadReport(kind, report._id)).preview_data;
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("requeued");
    expect(await ReportJob.findById(oldJob._id).lean()).toEqual(before);
    const repair = await ReportJob.findOne({ reportId: String(report._id), status: "queued" }).lean();
    expect(repair?.type).toBe(kind === "asset" ? "asset-preview-files" : "lot-listing-files");
    expect(repair?.progressId).not.toBe(before?.progressId);
    expect(repair?.payload.previewDataSnapshot).toEqual(preview);
    expect(await ReportJob.countDocuments()).toBe(2);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments()).toBe(2);
  });

  it.each(cases)("%s leaves unsubmitted saved data and its completed legacy job entirely unchanged", async (kind) => {
    const report = await createReport(kind, { preview_submitted_at: undefined, generation_target_status: "approved" });
    const oldJob = await ReportJob.create({
      type: kind === "asset" ? "asset-preview" : "lot-listing-preview",
      reportId: String(report._id), progressId: report.job_id, status: "completed",
      attempts: 1, completedAt: new Date("2026-09-09T12:00:00.000Z"), payload: { legacy: true },
    });
    const before = await ReportJob.findById(oldJob._id).lean();
    const savedReport = await modelFor(kind).collection.findOne({ _id: report._id });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    await recovery.recoverOrphanedReportsOnStartup();
    expect(await ReportJob.findById(oldJob._id).lean()).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(1);
    expect(await modelFor(kind).collection.findOne({ _id: report._id })).toEqual(savedReport);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it.each(cases.flatMap((kind) => ["startup", "admin"].map((mode) => ({ kind, mode }))))(
    "$kind does not recursively recover a $mode receipt even if matching job history is pruned",
    async ({ kind, mode }) => {
      const report = await createReport(kind);
      if (mode === "admin") {
        const state = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
        await recovery.resubmitSavedReportPreview({
          kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
        });
      } else {
        expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("requeued");
      }
      const accepted = await modelFor(kind).findById(report._id).select("+report_recovery").lean();
      expect(accepted.report_recovery.mode).toBe(mode);
      expect(accepted.report_recovery.jobId).toBe(accepted.job_id);
      await ReportJob.deleteMany({ reportId: String(report._id) });
      await modelFor(kind).updateOne({ _id: report._id }, { $set: {
        status: "error", job_status: "error", job_error: recovery.ORPHANED_REPORT_MESSAGE,
        files_generating: false, files_regenerating: false,
      } });
      const callsBefore = queueMocks.ensureReportJobOutbox.mock.calls.length;
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await recovery.recoverOrphanedReportsOnStartup();
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).toHaveBeenCalledTimes(callsBefore);
      expect((await loadReport(kind, report._id)).job_id).toBe(accepted.job_id);
    },
  );

  it.each(cases)("%s leaves a reassigned failure for its new owner's explicit review instead of restarting files", async (kind) => {
    const report = await createReport(kind);
    const newOwner = new mongoose.Types.ObjectId();
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: {
      user: newOwner,
      report_recovery: {
        mode: "transfer", manualReviewRequired: true, jobId: report.job_id,
        actorId: String(actorId), createdAt: new Date("2026-09-13T12:00:00.000Z"),
      },
      // Even stale old-owner intent cannot override the explicit review hold.
      preview_submitted_at: new Date("2026-09-10T12:00:00.000Z"),
      generation_target_status: "approved",
    } });
    const before = await modelFor(kind).collection.findOne({ _id: report._id });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    await recovery.recoverOrphanedReportsOnStartup();
    expect(await modelFor(kind).collection.findOne({ _id: report._id })).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it.each(cases.flatMap((kind) => ["null", "missing"].map((receiptJobId) => ({ kind, receiptJobId }))))(
    "$kind preserves a transferred legacy failure with no parent job ID and a $receiptJobId receipt ID",
    async ({ kind, receiptJobId }) => {
      const report = await createReport(kind);
      await modelFor(kind).collection.updateOne({ _id: report._id }, {
        $unset: { job_id: "" },
        $set: {
          report_recovery: {
            mode: "transfer", manualReviewRequired: true,
            ...(receiptJobId === "null" ? { jobId: null } : {}),
            actorId: String(actorId), createdAt: new Date("2026-09-13T12:00:00.000Z"),
          },
          // A legacy row may retain old submitted intent and the orphan error.
          // Its missing generation ID must not weaken the explicit review hold.
          preview_submitted_at: new Date("2026-09-10T12:00:00.000Z"),
          generation_target_status: "approved",
        },
      });
      const before = await modelFor(kind).collection.findOne({ _id: report._id });
      expect(before.job_id).toBeUndefined();
      expect(before.job_error).toBe(recovery.ORPHANED_REPORT_MESSAGE);
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      await recovery.recoverOrphanedReportsOnStartup();
      expect(await modelFor(kind).collection.findOne({ _id: report._id })).toEqual(before);
      expect(await ReportJob.countDocuments()).toBe(0);
      expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("%s retains an accepted outbox when dispatch is uncertain and never claims a second recovery", async (kind) => {
    const report = await createReport(kind);
    queueMocks.ensureReportJobOutbox.mockRejectedValueOnce(new Error("Queue acknowledgement unavailable"));
    // Durable acceptance may report queued or a dispatch error, but the embedded
    // intent must survive either transport outcome and remain the only identity.
    await recovery.recoverOrphanedReport(kind, String(report._id)).catch(() => undefined);
    const accepted = await loadReport(kind, report._id);
    expect(accepted.report_job_outbox?.token).toBeTruthy();
    expect(accepted.report_job_outbox?.payload.previewDataSnapshot.lots[0].description).toBe(savedLot.description);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect((await loadReport(kind, report._id)).job_id).toBe(accepted.job_id);
    await realEnsure(kind, String(report._id), accepted.report_job_outbox.token);
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(1);
  });

  it.each(cases.flatMap((kind) => [
    { kind, label: "archived", flags: { adminArchivedAt: new Date() } },
    { kind, label: "draft preview", flags: { is_draft_preview: true } },
  ]))("$kind skips $label reports", async ({ kind, flags }) => {
    const report = await createReport(kind, flags);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(cases)("%s rejects literal draft status for both startup and manual resubmission", async (kind) => {
    const report = await createReport(kind);
    // Lot's current schema has no draft enum, but historical malformed rows must
    // not gain submission authorization merely by carrying a stale diagnostic.
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: { status: "draft" } });
    const state = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
    expect(state.resubmitEligible).toBe(false);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    await expect(recovery.resubmitSavedReportPreview({
      kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).status).toBe("draft");
  });

  it.each(cases)("%s refuses duplicate saved lot numbers without silently renumbering them", async (kind) => {
    const report = await createReport(kind);
    const duplicateLots = [savedLot, { ...savedLot, lot_id: "another-saved-lot", lot_number: "0157a" }];
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: { "preview_data.lots": duplicateLots } });
    const before = await loadReport(kind, report._id);
    const state = recovery.getReportResubmitState(kind, before);
    await expect(recovery.resubmitSavedReportPreview({
      kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("Lot numbers must be unique") });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("conflict");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).preview_data).toEqual(before.preview_data);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it.each(cases)("%s rejects more than 200 combined main/report-only photos without dropping any", async (kind) => {
    const report = await createReport(kind);
    const mainIndexes = Array.from({ length: 200 }, (_, index) => index);
    await modelFor(kind).collection.updateOne({ _id: report._id }, { $set: {
      "preview_data.lots.0.image_indexes": mainIndexes,
      "preview_data.lots.0.extra_image_indexes": [200],
    } });
    const before = await loadReport(kind, report._id);
    const state = recovery.getReportResubmitState(kind, before);
    await expect(recovery.resubmitSavedReportPreview({
      kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("maximum is 200 photos") });
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("conflict");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).preview_data).toEqual(before.preview_data);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it("rejects an oversized saved Asset signature without queueing or modifying the saved preview", async () => {
    const report = await createReport("asset");
    const signature = `data:image/png;base64,${Buffer.alloc(300 * 1024 + 1, 1).toString("base64")}`;
    await AssetReport.collection.updateOne({ _id: report._id }, {
      $set: { "preview_data.appraiser_signature_data_url": signature },
    });
    const before = await loadReport("asset", report._id);
    const state = recovery.getReportResubmitState("asset", before);
    await expect(recovery.resubmitSavedReportPreview({
      kind: "asset", reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("signature is too large") });
    expect(await recovery.recoverOrphanedReport("asset", String(report._id))).toBe("conflict");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport("asset", report._id)).preview_data).toEqual(before.preview_data);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it("repeated startup scans neither regenerate completed recovery claims nor create duplicate reports", async () => {
    await createReport("asset");
    await createReport("lotListing");
    await recovery.recoverOrphanedReportsOnStartup();
    const firstJobs = await ReportJob.find().sort({ _id: 1 }).lean();
    expect(firstJobs).toHaveLength(2);
    await recovery.recoverOrphanedReportsOnStartup();
    expect(await ReportJob.find().sort({ _id: 1 }).lean()).toEqual(firstJobs);
    expect(await AssetReport.countDocuments()).toBe(1);
    expect(await LotListing.countDocuments()).toBe(1);
  });

  it("advances bounded startup batches past incomplete rows to later recoverable reports", async () => {
    const template = await createReport("asset", { preview_data: { lots: [] }, lots: [] });
    const raw = await loadReport("asset", template._id);
    await AssetReport.collection.insertMany(Array.from({ length: 25 }, () => ({
      ...raw, _id: new mongoose.Types.ObjectId(), job_id: `incomplete-${new mongoose.Types.ObjectId()}`,
    })));
    const recoverable = await createReport("asset");
    const result = await recovery.recoverOrphanedReportsOnStartup();
    expect(result["asset:incomplete"]).toBe(26);
    expect(result["asset:requeued"]).toBe(1);
    expect(await ReportJob.countDocuments()).toBe(1);
    expect((await ReportJob.findOne().lean())?.reportId).toBe(String(recoverable._id));
  });

  it("does not schedule startup recovery when the operator disables it", async () => {
    const previousFlag = process.env.REPORT_RESTART_RECOVERY_ENABLED;
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      process.env.REPORT_RESTART_RECOVERY_ENABLED = "false";
      recovery.startReportRestartRecovery();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      if (previousFlag === undefined) delete process.env.REPORT_RESTART_RECOVERY_ENABLED;
      else process.env.REPORT_RESTART_RECOVERY_ENABLED = previousFlag;
    }
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("requires the durable Mongo queue and never starts a memory-only recovery workflow", async () => {
    const report = await createReport("asset");
    const state = recovery.getReportResubmitState("asset", await loadReport("asset", report._id));
    const previousBackend = process.env.REPORT_QUEUE_BACKEND;
    try {
      process.env.REPORT_QUEUE_BACKEND = "memory";
      const timeout = vi.spyOn(globalThis, "setTimeout");
      try {
        recovery.startReportRestartRecovery();
        expect(timeout).not.toHaveBeenCalled();
      } finally {
        timeout.mockRestore();
      }
      expect(await recovery.recoverOrphanedReport("asset", String(report._id))).toBe("skipped");
      expect(await recovery.recoverOrphanedReportsOnStartup()).toEqual({});
      await expect(recovery.resubmitSavedReportPreview({
        kind: "asset", reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
      })).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      if (previousBackend === undefined) delete process.env.REPORT_QUEUE_BACKEND;
      else process.env.REPORT_QUEUE_BACKEND = previousBackend;
    }
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it.each(cases)("%s rejects an administrator's outdated preview revision without queueing", async (kind) => {
    const report = await createReport(kind);
    const oldState = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
    expect(oldState.resubmitEligible).toBe(true);
    expect(oldState.resubmitRevision).toBeTruthy();
    await modelFor(kind).updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.description": "A newer appraiser edit" } });
    await expect(recovery.resubmitSavedReportPreview({
      kind, reportId: String(report._id), actorId: String(actorId), baseRevision: oldState.resubmitRevision!,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport(kind, report._id)).preview_data.lots[0].description).toBe("A newer appraiser edit");
  });

  it.each(cases)("%s returns the same accepted job for an exact administrator retry", async (kind) => {
    const report = await createReport(kind);
    const state = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
    const input = { kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision! };
    const accepted = await recovery.resubmitSavedReportPreview(input);
    const repeated = await recovery.resubmitSavedReportPreview(input);
    expect(accepted.reportId).toBe(String(report._id));
    expect(accepted.jobId).toBeTruthy();
    expect(repeated.jobId).toBe(accepted.jobId);
    expect(repeated.reportId).toBe(accepted.reportId);
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(1);
    expect(await modelFor(kind).countDocuments()).toBe(1);
  });

  it.each(cases)("%s exact administrator retry dispatches an ambiguous handoff using its outbox token", async (kind) => {
    const report = await createReport(kind);
    const state = recovery.getReportResubmitState(kind, await loadReport(kind, report._id));
    const input = { kind, reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision };
    queueMocks.ensureReportJobOutbox.mockRejectedValueOnce(new Error("Uncertain queue acknowledgement"));
    const accepted = await recovery.resubmitSavedReportPreview(input);
    const retained = await loadReport(kind, report._id);
    const outbox = retained.report_job_outbox;
    expect(outbox?.token).toBeTruthy();
    expect(outbox.token).not.toBe(accepted.jobId);
    expect(outbox.progressId).toBe(accepted.jobId);
    expect(await ReportJob.countDocuments()).toBe(0);

    const retry = await recovery.resubmitSavedReportPreview(input);
    expect(retry.jobId).toBe(accepted.jobId);
    expect(queueMocks.ensureReportJobOutbox).toHaveBeenLastCalledWith(kind, String(report._id), outbox.token);
    const jobs = await ReportJob.find({ reportId: String(report._id) }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].progressId).toBe(accepted.jobId);
    expect(jobs[0].payload).toEqual(outbox.payload);
    expect((await loadReport(kind, report._id)).report_job_outbox).toBeUndefined();

    expect((await recovery.resubmitSavedReportPreview(input)).jobId).toBe(accepted.jobId);
    expect(queueMocks.ensureReportJobOutbox).toHaveBeenCalledTimes(2);
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("rejects a preview edit racing the administrator's approval-route lookup", async () => {
    const report = await createReport("asset");
    const state = recovery.getReportResubmitState("asset", await loadReport("asset", report._id));
    queueMocks.requiresAssetApproval.mockImplementationOnce(async () => {
      await AssetReport.collection.updateOne({ _id: report._id }, { $set: {
        updatedAt: new Date(Date.now() + 1000),
        "preview_data.lots.0.description": "Appraiser edit won while approval settings loaded",
      } });
      return false;
    });
    await expect(recovery.resubmitSavedReportPreview({
      kind: "asset", reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await loadReport("asset", report._id)).preview_data.lots[0].description)
      .toBe("Appraiser edit won while approval settings loaded");
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it("rejects a same-millisecond Asset preview edit while resolving approval settings", async () => {
    const report = await createReport("asset");
    const before = await loadReport("asset", report._id);
    const state = recovery.getReportResubmitState("asset", before);
    queueMocks.requiresAssetApproval.mockImplementationOnce(async () => {
      // Raw collection updates intentionally retain the exact old updatedAt.
      // The saved snapshot comparison, not timestamp granularity, must win.
      await AssetReport.collection.updateOne({ _id: report._id }, { $set: {
        "preview_data.lots.0.description": "Same-timestamp Asset correction must survive",
      } });
      return false;
    });
    await expect(recovery.resubmitSavedReportPreview({
      kind: "asset", reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
    })).rejects.toMatchObject({ statusCode: 409 });
    const after = await loadReport("asset", report._id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.preview_data.lots[0].description).toBe("Same-timestamp Asset correction must survive");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });

  it("rejects a same-millisecond Lot preview edit during the final active-job check", async () => {
    const report = await createReport("lotListing");
    const before = await loadReport("lotListing", report._id);
    const state = recovery.getReportResubmitState("lotListing", before);
    const originalExists = ReportJob.exists.bind(ReportJob);
    const exists = vi.spyOn(ReportJob, "exists");
    let raced = false;
    exists.mockImplementation(((filter: any) => {
      if (!raced && filter?.reportId === String(report._id)) {
        raced = true;
        return LotListing.collection.updateOne({ _id: report._id }, { $set: {
          "preview_data.lots.0.description": "Same-timestamp Lot correction must survive",
        } }).then(() => originalExists(filter));
      }
      return originalExists(filter);
    }) as any);
    try {
      await expect(recovery.resubmitSavedReportPreview({
        kind: "lotListing", reportId: String(report._id), actorId: String(actorId), baseRevision: state.resubmitRevision,
      })).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      exists.mockRestore();
    }
    const after = await loadReport("lotListing", report._id);
    expect(raced).toBe(true);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.preview_data.lots[0].description).toBe("Same-timestamp Lot correction must survive");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(queueMocks.ensureReportJobOutbox).not.toHaveBeenCalled();
  });
});
