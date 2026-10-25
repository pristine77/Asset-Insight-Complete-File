import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({ notify: vi.fn(async () => undefined), email: vi.fn(async () => undefined),
  head: vi.fn(async () => ({ size: 12 })), remove: vi.fn(async () => undefined) }));
vi.mock("../src/service/notificationService.js", async (original) => ({
  ...await original<typeof import("../src/service/notificationService.js")>(), notifyUser: delivery.notify,
}));
vi.mock("../src/utils/sendVerificationEmail.js", async (original) => ({
  ...await original<typeof import("../src/utils/sendVerificationEmail.js")>(), sendEmail: delivery.email,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(), headR2Object: delivery.head, deleteFromR2: delivery.remove,
}));

type Kind = "asset" | "lotListing";
const kinds = ["asset", "lotListing"] as const;
let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let ReportUploadSession: typeof import("../src/models/reportUploadSession.model.js")["default"];
let recovery: typeof import("../src/service/reportRestartRecoveryService.js");
let actors: { owner: any; target: any; admin: any; superadmin: any };
const devices = new Map<string, { id: string; key: string }>();
const oldQueue = process.env.REPORT_QUEUE_BACKEND;
const images = ["https://assetinsight.test/transfer/first.jpg", "https://assetinsight.test/transfer/last.jpg"];
const modelFor = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const headers = (actor = actors.superadmin) => {
  const device = devices.get(String(actor._id));
  return { Authorization: `Bearer ${jwt.sign({ id: String(actor._id), role: actor.role, ...(device ? { did: device.id, dv: 0 } : {}) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`,
    ...(device ? { "X-Device-Key": device.key } : {}) };
};

async function fixture(kind: Kind, extra: Record<string, unknown> = {}) {
  const lot = { lot_id: "saved-lot", lot_number: "0157A", title: "Reviewed truck", description: "First paragraph.\nSecond saved paragraph.\nhttps://example.test/evidence",
    image_urls: images, image_indexes: [0, 1], estimated_value: "CA$18,500",
    condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } };
  return modelFor(kind).create({ user: actors.owner._id, contract_no: "TRANSFER-93530", grouping_mode: "single_lot",
    sales_date: new Date("2026-09-01"), location: "Regina, SK", currency: "CAD", imageUrls: images, lots: [lot],
    preview_data: { contract_no: "TRANSFER-93530", currency: "CAD", valuation_methods: ["FML"], lots: [lot] },
    status: "error", job_status: "error", job_id: `failed-${new mongoose.Types.ObjectId()}`, job_execution_token: "previous-execution",
    job_error: recovery.ORPHANED_REPORT_MESSAGE, files_generating: false, files_regenerating: false,
    preview_submitted_at: new Date("2026-09-02"), approval_requested_at: new Date("2026-09-02"),
    approval_assigned_to: actors.admin._id, generation_target_status: "approved", ...extra });
}

function transfer(id: unknown, actor = actors.superadmin, target = actors.target) {
  return request(app).post(`/api/admin/preview-reports/${id}/transfer`).set(headers(actor)).send({ targetUserId: String(target._id) });
}

async function snapshot(kind: Kind, id: unknown) {
  return modelFor(kind).findById(id).select("+report_recovery +report_recovery_history +report_job_outbox +job_execution_token").lean();
}

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ default: ReportUploadSession } = await import("../src/models/reportUploadSession.model.js"));
  recovery = await import("../src/service/reportRestartRecoveryService.js");
  const create = (name: string, role: string) => User.create({ email: `${name}@example.test`, username: name, companyName: "Isolated reassignment QA",
    password: "Password123!", authProvider: "email", isVerified: true, role });
  const [owner, target, admin, superadmin] = await Promise.all([create("old-owner", "user"), create("new-owner", "user"), create("admin", "admin"), create("superadmin", "superadmin")]);
  actors = { owner, target, admin, superadmin };
  const { default: DeviceRegistration } = await import("../src/models/deviceRegistration.model.js");
  for (const actor of [owner, target]) {
    const key = `isolated-transfer-device-${actor._id}`;
    const device = await DeviceRegistration.create({ user: actor._id, installationKeyHash: createHash("sha256").update(key).digest("hex"),
      platform: "web", formFactor: "desktop", displayName: "Isolated approved test device", status: "approved", sessionVersion: 0 });
    devices.set(String(actor._id), { id: String(device._id), key });
  }
  await Promise.all([AssetReport.syncIndexes(), LotListing.syncIndexes(), ReportJob.syncIndexes()]);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  delivery.email.mockClear(); delivery.notify.mockClear(); delivery.head.mockClear(); delivery.remove.mockClear();
  await Promise.all([AssetReport.deleteMany({}), LotListing.deleteMany({}), ReportJob.deleteMany({}), ReportUploadSession.deleteMany({})]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect(); await mongo.stop();
  if (oldQueue === undefined) delete process.env.REPORT_QUEUE_BACKEND; else process.env.REPORT_QUEUE_BACKEND = oldQueue;
});

describe.sequential("failed submitted preview reassignment", () => {
  it.each(kinds)("%s cannot cross the review-account ownership boundary", async (kind) => {
    const reviewer = await User.create({ email: `review-${new mongoose.Types.ObjectId()}@example.test`, username: "Review", password: "Password123!", authProvider: "email", isVerified: true, isReviewAccount: true });
    const real = await fixture(kind);
    const own = await fixture(kind, { user: reviewer._id });
    expect((await transfer(real._id, actors.superadmin, reviewer)).status).toBe(404);
    const out = await transfer(own._id, actors.superadmin, actors.target);
    expect(out.status).toBe(400);
    expect(out.body.message).toContain("Review reports");
    expect(String((await snapshot(kind, real._id)).user)).toBe(String(actors.owner._id));
    expect(String((await snapshot(kind, own._id)).user)).toBe(String(reviewer._id));
    const directory = await request(app).get("/api/admin/preview-reports/transfer-users").set(headers());
    expect(directory.status).toBe(200);
    expect(directory.body.users.some((row: any) => row.id === String(reviewer._id))).toBe(false);
    expect(delivery.email).not.toHaveBeenCalled();
    expect(delivery.notify).not.toHaveBeenCalled();
    const { default: Boundary } = await import("../src/models/reviewAccountBoundary.model.js");
    await Boundary.create({ _id: reviewer._id, enrollmentAudit: new mongoose.Types.ObjectId() });
    await User.deleteOne({ _id: reviewer._id });
    const afterDeletion = await transfer(own._id, actors.superadmin, actors.target);
    expect(afterDeletion.status).toBe(400);
    expect(afterDeletion.body.message).toContain("Review reports");
    expect(String((await snapshot(kind, own._id)).user)).toBe(String(reviewer._id));
  });

  it("retains authentication and the existing superadmin boundary", async () => {
    const report = await fixture("asset");
    const url = `/api/admin/preview-reports/${report._id}/transfer`;
    expect((await request(app).post(url).send({ targetUserId: String(actors.target._id) })).status).toBe(401);
    expect((await transfer(report._id, actors.owner)).status).toBe(403);
    expect((await transfer(report._id, actors.admin)).status).toBe(403);
    expect(String((await snapshot("asset", report._id)).user)).toBe(String(actors.owner._id));
    expect(delivery.notify).not.toHaveBeenCalled();
  });

  it.each(kinds)("%s exposes failed submitted rows in the queue and detail as reassignable", async (kind) => {
    const report = await fixture(kind, { status: "approved", release_status: "released" });
    const list = await request(app).get("/api/admin/preview-reports?workflowStage=error").set(headers());
    expect(list.status).toBe(200);
    expect(list.body.items.find((item: any) => item.id === String(report._id))).toMatchObject({ transferEligible: true, transferRequiresReview: true });
    const detail = await request(app).get(`/api/admin/preview-reports/${report._id}`).set(headers());
    expect(detail.status).toBe(200);
    expect(detail.body.report).toMatchObject({ transferEligible: true, transferRequiresReview: true });
    expect(detail.body.report).not.toHaveProperty("report_job_outbox");
    expect(detail.body.report).not.toHaveProperty("job_execution_token");
  });

  for (const kind of kinds) {
    it.each(["error", "processing", "pending_approval", "approved"])(`${kind} returns failed %s work to owner review without queuing`, async (status) => {
      const report = await fixture(kind, { status, release_status: "released", released_at: new Date("2026-09-02"), approval_processed_at: new Date("2026-09-02"),
        preview_files: { docx: "https://assetinsight.test/old.docx", excel: "https://assetinsight.test/old.xlsx", images: "https://assetinsight.test/old.zip" } });
      const original = await snapshot(kind, report._id);
      const oldJob = await ReportJob.create({ type: kind === "asset" ? "asset-preview-files" : "lot-listing-files", status: "failed", reportId: String(report._id), progressId: report.job_id,
        payload: { userId: String(actors.owner._id), user: { id: String(actors.owner._id) }, previewDataSnapshot: original.preview_data } });
      const failedSession = await ReportUploadSession.create({ type: kind, status: "failed", user: actors.owner._id, reportId: String(report._id), jobId: report.job_id });
      const liveSession = await ReportUploadSession.create({ type: kind, status: "uploading", user: actors.owner._id, reportId: String(report._id), jobId: "later-upload" });
      const result = await transfer(report._id);
      expect(result.status).toBe(200);
      expect(result.body.message).toContain("must review and resubmit");
      const saved = await snapshot(kind, report._id);
      expect(String(saved.user)).toBe(String(actors.target._id));
      expect(saved).toMatchObject({ status: "error", job_status: "error", job_error: original.job_error });
      expect(saved.job_id).toMatch(/^transfer-/);
      expect(saved.job_id).not.toBe(original.job_id);
      expect(saved.preview_data).toEqual(original.preview_data);
      expect(saved.lots).toEqual(original.lots);
      expect(saved.imageUrls).toEqual(original.imageUrls);
      expect(saved.preview_files).toEqual(original.preview_files);
      for (const key of ["preview_submitted_at", "approval_requested_at", "approval_processed_at", "generation_target_status", "release_status", "released_at"]) expect(saved[key]).toBeUndefined();
      expect(saved.job_execution_token).toMatch(/^transfer-/);
      expect(saved.report_recovery).toMatchObject({ mode: "transfer", manualReviewRequired: true, jobId: saved.job_id, previousJobId: original.job_id,
        fromOwnerId: String(actors.owner._id), toOwnerId: String(actors.target._id), actorId: String(actors.superadmin._id), previousStatus: status });
      expect(saved.preview_transfer_history).toHaveLength(1);
      expect(saved.report_recovery_history).toHaveLength(1);
      expect(await ReportJob.countDocuments()).toBe(1);
      expect((await ReportJob.findById(oldJob._id).lean())!.payload).toEqual(oldJob.payload);
      expect(String((await ReportUploadSession.findById(failedSession._id).lean())!.user)).toBe(String(actors.target._id));
      expect(String((await ReportUploadSession.findById(liveSession._id).lean())!.user)).toBe(String(actors.owner._id));
      expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
      expect(await ReportJob.countDocuments()).toBe(1);
      expect(delivery.notify).toHaveBeenCalledTimes(2);
      expect(delivery.email).toHaveBeenCalledTimes(2);
    });
  }

  it.each(kinds)("%s still transfers an ordinary saved preview without submitting it", async (kind) => {
    const report = await fixture(kind, { status: "preview", job_status: "done", preview_submitted_at: undefined, approval_requested_at: undefined });
    expect((await transfer(report._id)).status).toBe(200);
    const saved = await snapshot(kind, report._id);
    expect(saved).toMatchObject({ status: "preview", job_status: "done" });
    expect(saved.preview_submitted_at).toBeUndefined();
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  const blocked = [
    ["successful release", { status: "approved", job_status: "done", release_status: "released" }],
    ["unfailed approval", { status: "pending_approval", job_status: "done" }],
    ["files", { files_generating: true }], ["regeneration", { files_regenerating: true }],
    ["Excel", { excel_regenerating: true }], ["active status", { job_status: "queued" }],
    ["outbox", { report_job_outbox: { token: "durably-accepted" } }],
    ["hidden draft", { is_draft_preview: true }], ["archive", { adminArchivedAt: new Date() }],
    ["empty canonical preview", { preview_data: { contract_no: "EXPLICITLY-CLEARED", lots: [] } }],
  ] as const;
  for (const kind of kinds) {
    it.each(blocked)(`${kind} blocks %s`, async (_label, patch) => {
      const report = await fixture(kind, patch);
      const original = await snapshot(kind, report._id);
      expect((await transfer(report._id)).status).toBe(409);
      expect(await snapshot(kind, report._id)).toEqual(original);
      expect(delivery.notify).not.toHaveBeenCalled();
    });
  }

  it.each(kinds)("%s blocks a real active job even if its parent reports an error", async (kind) => {
    const report = await fixture(kind);
    await ReportJob.create({ type: kind === "asset" ? "asset-preview-files" : "lot-listing-files", status: "processing", reportId: String(report._id), progressId: "different-run", payload: {} });
    expect((await transfer(report._id)).status).toBe(409);
    const response = await request(app).get("/api/admin/preview-reports").set(headers());
    expect(response.body.items[0].transferEligible).toBe(false);
  });

  it.each(kinds)("%s preserves incomplete saved rows for the new owner to finish", async (kind) => {
    const report = await fixture(kind, { status: "preview", job_status: "done", preview_submitted_at: undefined,
      approval_requested_at: undefined, preview_data: { lots: [{ lot_id: "unfinished", lot_number: "1", image_urls: images }] } });
    const original = await snapshot(kind, report._id);
    expect((await transfer(report._id)).status).toBe(200);
    const saved = await snapshot(kind, report._id);
    expect(saved.preview_data).toEqual(original.preview_data);
    expect(recovery.getReportResubmitState(kind, saved).resubmitEligible).toBe(false);
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("allows the known failed Lot defaults shell to use saved root rows", async () => {
    const report = await fixture("lotListing", { preview_data: { lots: [] } });
    const response = await request(app).get("/api/admin/preview-reports").set(headers());
    expect(response.body.items[0]).toMatchObject({ transferEligible: true, transferRequiresReview: true });
    expect((await transfer(report._id)).status).toBe(200);
  });

  it("does not substitute stale Lot root rows for an explicit raw empty canonical preview", async () => {
    const report = await fixture("lotListing");
    await LotListing.collection.updateOne({ _id: report._id }, { $set: { preview_data: { lots: [] } } });
    const response = await request(app).get("/api/admin/preview-reports").set(headers());
    expect(response.body.items[0].transferEligible).toBe(false);
    expect((await transfer(report._id)).status).toBe(409);
  });

  it.each(kinds)("%s blocks a live publication lease", async (kind) => {
    const patch = kind === "asset" ? { proposal_valuation_artifact_publish_token: "publisher", proposal_valuation_artifact_publish_expires_at: new Date(Date.now() + 60_000) }
      : { artifact_publish_token: "publisher", artifact_publish_expires_at: new Date(Date.now() + 60_000) };
    const report = await fixture(kind, patch);
    expect((await transfer(report._id)).status).toBe(409);
  });

  it.each(kinds)("%s CAS rejects a same-millisecond saved-preview edit", async (kind) => {
    const report = await fixture(kind);
    const model = modelFor(kind);
    const originalUpdate = model.findOneAndUpdate.bind(model);
    vi.spyOn(model, "findOneAndUpdate").mockImplementationOnce((...args: any[]) => ({
      select() { return this; },
      async lean() {
        await model.collection.updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.description": "Newer owner edit" } });
        return originalUpdate(...args).lean();
      },
    }));
    const result = await transfer(report._id);
    expect(result.status).toBe(409);
    const saved = await snapshot(kind, report._id);
    expect(saved.preview_data.lots[0].description).toBe("Newer owner edit");
    expect(String(saved.user)).toBe(String(actors.owner._id));
    expect(delivery.notify).not.toHaveBeenCalled();
  });

  it.each(kinds)("%s loses safely when restart recovery claims the report first", async (kind) => {
    const report = await fixture(kind);
    const model = modelFor(kind);
    const originalUpdate = model.findOneAndUpdate.bind(model);
    vi.spyOn(model, "findOneAndUpdate").mockImplementationOnce((...args: any[]) => ({
      select() { return this; },
      async lean() {
        expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("requeued");
        return originalUpdate(...args).lean();
      },
    }));
    const result = await transfer(report._id);
    expect(result.status).toBe(409);
    expect(String((await snapshot(kind, report._id)).user)).toBe(String(actors.owner._id));
    expect(await ReportJob.countDocuments()).toBe(1);
    expect(delivery.notify).not.toHaveBeenCalled();
  });

  it.each(kinds)("%s remains manual review after transfer wins and queue history disappears", async (kind) => {
    const report = await fixture(kind);
    expect((await transfer(report._id)).status).toBe(200);
    expect(await recovery.recoverOrphanedReport(kind, String(report._id))).toBe("skipped");
    expect(await ReportJob.countDocuments()).toBe(0);
    // A subsequent explicit resubmit is a new, owner-bound logical generation.
    const saved = await snapshot(kind, report._id);
    const state = recovery.getReportResubmitState(kind, saved);
    const result = await recovery.resubmitSavedReportPreview({ kind, reportId: String(report._id), baseRevision: state.resubmitRevision, actorId: String(actors.superadmin._id) });
    const queued = await ReportJob.findOne({ reportId: String(report._id) }).lean();
    expect(result.jobId).not.toBe(saved.job_id);
    expect(String((await snapshot(kind, report._id)).user)).toBe(String(actors.target._id));
    expect(queued?.payload.previewDataSnapshot).toEqual(saved.preview_data);
    if (kind === "lotListing") expect(queued?.payload.user.id).toBe(String(actors.target._id));
  });

  it.each(kinds)("%s rejects the old source upload completion after reassignment", async (kind) => {
    const report = await fixture(kind);
    const original = await snapshot(kind, report._id);
    const session = await ReportUploadSession.create({ type: kind, status: "completed", user: actors.owner._id,
      reportId: String(report._id), jobId: original.job_id, clientSubmissionId: `old-${kind}`, manifestHash: "old-upload", manifestVersion: 2,
      smartUpload: false, details: { contract_no: report.contract_no, sales_date: "2026-09-01", location: "Regina, SK", valuation_methods: ["FML"],
        mixed_lots: [{ count: 1, extra_count: 0, mode: "single_lot" }] },
      r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test",
      files: [{ fileId: "old-photo", key: "uploads/report-sessions/old/photo.jpg", fieldname: "images", originalname: "photo.jpg",
        mimetype: "image/jpeg", size: 12, verifiedSize: 12, uploadedAt: new Date(), lotIndex: 0, imageIndex: 0, originalOrder: 0, role: "main" }],
      expectedFileCount: 1, expectedImageCount: 1, expectedVideoCount: 0, totalBytes: 12, uploadCompletedAt: new Date() });
    expect((await transfer(report._id)).status).toBe(200);
    const saved = await snapshot(kind, report._id);
    const endpoint = kind === "asset" ? "asset" : "lot-listing";
    const retry = await request(app).post(`/api/${endpoint}/upload-session/${session._id}/complete`).set(headers(actors.target)).send({});
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe("UPLOAD_SESSION_REPORT_CHANGED");
    expect(await snapshot(kind, report._id)).toEqual(saved);
    expect(await ReportJob.countDocuments()).toBe(0);
    // The photo was verified moments ago (uploadedAt/verifiedSize match the
    // manifest), so completion reuses that verification instead of reading
    // storage again (2026-10-01, reportUploadSession.controller.ts). Either way
    // nothing is written, queued or removed before the parent claim refuses.
    expect(delivery.head).not.toHaveBeenCalled();
    expect(delivery.remove).not.toHaveBeenCalled();
  });

  it.each(kinds)("%s lets the new owner explicitly review and resubmit through the ordinary endpoint", async (kind) => {
    const report = await fixture(kind);
    expect((await transfer(report._id)).status).toBe(200);
    const saved = await snapshot(kind, report._id);
    const endpoint = kind === "asset" ? "asset" : "lot-listing";
    expect((await request(app).get(`/api/${endpoint}/${report._id}/preview`).set(headers(actors.owner))).status).toBe(404);
    const preview = await request(app).get(`/api/${endpoint}/${report._id}/preview`).set(headers(actors.target));
    expect(preview.status).toBe(200);
    expect(await ReportJob.countDocuments()).toBe(0);
    const result = await request(app).post(`/api/${endpoint}/${report._id}/resubmit`).set(headers(actors.target)).send({ preview_data: saved.preview_data });
    expect(result.status).toBe(202);
    const queued = await snapshot(kind, report._id);
    expect(queued.job_id).not.toBe(saved.job_id);
    expect(queued.job_status).toBe("queued");
    expect(String(queued.user)).toBe(String(actors.target._id));
    expect(await ReportJob.countDocuments()).toBe(1);
    expect(queued.preview_data.lots[0].description).toBe(saved.preview_data.lots[0].description);
    expect(queued.imageUrls).toEqual(saved.imageUrls);
  });
});
