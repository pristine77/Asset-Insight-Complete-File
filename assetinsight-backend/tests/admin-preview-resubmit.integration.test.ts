import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Kind = "asset" | "lotListing";
type Role = "user" | "admin" | "superadmin";
const kinds = ["asset", "lotListing"] as const;
let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let recovery: typeof import("../src/service/reportRestartRecoveryService.js");
let activity: typeof import("../src/service/reportActivityService.js");
let ReportActivityEvent: typeof import("../src/models/reportActivity.model.js")["ReportActivityEvent"];
const originalQueueBackend = process.env.REPORT_QUEUE_BACKEND;
const photos = ["https://assetinsight.test/admin-recovery/first.jpg", "https://assetinsight.test/admin-recovery/last.jpg"];

function headers(userId: unknown, role: Role = "superadmin") {
  return { Authorization: `Bearer ${jwt.sign({ id: String(userId), role }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` };
}

async function createUser(role: Role) {
  const suffix = new mongoose.Types.ObjectId().toString();
  return User.create({
    email: `${role}-${suffix}@example.test`, username: `${role}-${suffix}`,
    companyName: "Isolated report recovery test", password: "Password123!",
    authProvider: "email", isVerified: true, role,
  });
}

function modelFor(kind: Kind): any { return kind === "asset" ? AssetReport : LotListing; }

async function createReport(kind: Kind, userId: unknown, overrides: Record<string, unknown> = {}) {
  const contractNo = `ADMIN-RECOVERY-${new mongoose.Types.ObjectId()}`;
  const lot = {
    lot_id: "reviewed-lot", lot_number: "0157A", title: "Saved corrected truck",
    description: "Saved appraiser narrative.\nSecond paragraph and reference https://example.test/evidence must survive.",
    estimated_value: "CA$18,500", image_indexes: [0, 1], image_urls: photos,
    condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
  };
  return modelFor(kind).create({
    user: userId, contract_no: contractNo, grouping_mode: "single_lot",
    sales_date: new Date("2026-09-01T00:00:00.000Z"), location: "Regina, SK",
    currency: "CAD", imageUrls: photos, lots: [lot],
    preview_data: { contract_no: contractNo, currency: "CAD", valuation_methods: ["FML"], lots: [lot] },
    status: "error", job_status: "error", job_id: `orphan-${new mongoose.Types.ObjectId()}`,
    job_error: recovery.ORPHANED_REPORT_MESSAGE, files_generating: false, files_regenerating: false,
    ...overrides,
  });
}

async function detail(id: unknown, actorId: unknown) {
  return request(app).get(`/api/admin/preview-reports/${id}`).set(headers(actorId));
}

async function currentRevision(id: unknown, actorId: unknown) {
  const response = await detail(id, actorId);
  expect(response.status).toBe(200);
  expect(response.body.report.resubmitRevision).toMatch(/^[a-f0-9]{64}$/);
  return response.body.report.resubmitRevision as string;
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
  recovery = await import("../src/service/reportRestartRecoveryService.js");
  activity = await import("../src/service/reportActivityService.js");
  ({ ReportActivityEvent } = await import("../src/models/reportActivity.model.js"));
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), LotListing.syncIndexes(), ReportJob.syncIndexes()]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await mongo.stop();
  if (originalQueueBackend === undefined) delete process.env.REPORT_QUEUE_BACKEND;
  else process.env.REPORT_QUEUE_BACKEND = originalQueueBackend;
});

describe.sequential("administrator saved-preview resubmission HTTP boundary", () => {
  it("accepts admin generation without FMV or appraisal selections and retains saved originals", async () => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    const report = await createReport("lotListing", owner._id, { preview_submitted_at: new Date(), total_value: 0 });
    await LotListing.updateOne({ _id: report._id }, { $set: {
      "preview_data.lots.0.estimated_value": "", "preview_data.total_value": 0,
    }, $unset: { "preview_data.lots.0.condition_report_selections": 1 } });
    const before = await LotListing.findById(report._id).lean();
    const response = await detail(report._id, superadmin._id);
    expect(response.body.report.resubmitEligible).toBe(true);
    const accepted = await request(app).post(`/api/admin/preview-reports/${report._id}/resubmit`)
      .set(headers(superadmin._id)).send({ baseRevision: response.body.report.resubmitRevision });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(await ReportJob.countDocuments()).toBe(1);
    const after = await LotListing.findById(report._id).lean();
    expect(after?.preview_data).toEqual(before?.preview_data);
    expect(after?.imageUrls).toEqual(photos);
  });

  it.each([["preview", "submit-approval"], ["error", "resubmit"], ["error", "retry-processing"]])(
    "owner %s/%s accepts empty optional FMV and selections without changing lot identity/media", async (status, action) => {
      const owner = await createUser("admin");
      const report = await createReport("lotListing", owner._id, { status, total_value: 0 });
      await LotListing.updateOne({ _id: report._id }, { $set: {
        "preview_data.lots.0.estimated_value": "", "preview_data.lots.0.condition_report_selections": {}, "preview_data.total_value": 0,
      } });
      const accepted = await request(app).post(`/api/lot-listing/${report._id}/${action}`)
        .set(headers(owner._id, "admin")).send({});
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(await ReportJob.countDocuments()).toBe(1);
      const after = await LotListing.findById(report._id).lean();
      expect((after?.preview_data as any).lots[0]).toMatchObject({
        lot_id: "reviewed-lot", lot_number: "0157A", estimated_value: "", image_urls: photos, image_indexes: [0, 1],
      });
      expect(after?.imageUrls).toEqual(photos);
      await activity.waitForActivityDispatch();
      expect(await ReportActivityEvent.countDocuments({ owner: owner._id, outcome: "failed" })).toBe(0);
    });

  it("requires authentication and the existing database-backed superadmin role", async () => {
    const [owner, admin, superadmin] = await Promise.all([createUser("user"), createUser("admin"), createUser("superadmin")]);
    const report = await createReport("asset", owner._id);
    const baseRevision = await currentRevision(report._id, superadmin._id);
    const url = `/api/admin/preview-reports/${report._id}/resubmit`;

    expect((await request(app).post(url).send({ baseRevision })).status).toBe(401);
    const ownerDenied = await request(app).post(url).set(headers(owner._id)).send({ baseRevision });
    expect(ownerDenied.status).toBe(403);
    expect(ownerDenied.body.message).toBe("Admin privileges required");
    // Even a privileged role claim cannot elevate the current database role.
    const adminDenied = await request(app).post(url).set(headers(admin._id)).send({ baseRevision });
    expect(adminDenied.status).toBe(403);
    expect(adminDenied.body.message).toBe("Superadmin privileges required");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await AssetReport.findById(report._id).lean())?.job_status).toBe("error");
  });

  it.each(kinds)("%s exposes review-bound eligibility without leaking recovery internals", async (kind) => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    const report = await createReport(kind, owner._id);
    const response = await detail(report._id, superadmin._id);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.report).toMatchObject({
      id: String(report._id), resubmitEligible: true, resubmitIneligibleReason: null,
      creator: { id: String(owner._id) },
    });
    expect(response.body.report.resubmitRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.report).not.toHaveProperty("report_job_outbox");
    expect(response.body.report).not.toHaveProperty("job_execution_token");
    expect(response.body.report).not.toHaveProperty("report_recovery_history");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(kinds)("%s queues the saved preview once, retains its owner and ignores spoofed actor headers", async (kind) => {
    const [owner, superadmin, otherAdmin] = await Promise.all([createUser("user"), createUser("superadmin"), createUser("superadmin")]);
    const report = await createReport(kind, owner._id);
    const original = await modelFor(kind).findById(report._id).lean();
    const baseRevision = await currentRevision(report._id, superadmin._id);
    const url = `/api/admin/preview-reports/${report._id}/resubmit`;
    const submit = () => request(app).post(url).set(headers(superadmin._id))
      .set("x-user-id", String(otherAdmin._id)).set("x-actor-id", String(owner._id)).send({ baseRevision });
    const first = await submit();
    expect(first.status).toBe(202);
    const repeated = await submit();
    expect(repeated.status).toBe(202);
    const accepted = first.body;
    expect(accepted.reportId).toBe(String(report._id));
    expect(accepted.jobId).toBeTruthy();
    expect(repeated.body.jobId).toBe(accepted.jobId);

    const persisted = await modelFor(kind).findById(report._id).select("+report_recovery +report_recovery_history").lean();
    expect(String(persisted.user)).toBe(String(owner._id));
    expect(persisted.preview_data).toEqual(original.preview_data);
    expect(persisted.imageUrls).toEqual(photos);
    expect(persisted.report_recovery.actorId).toBe(String(superadmin._id));
    expect(persisted.report_recovery_history).toHaveLength(1);
    expect(persisted.report_recovery_history[0].actorId).toBe(String(superadmin._id));
    expect(persisted.job_id).toBe(accepted.jobId);
    expect(persisted.job_status).toBe("queued");
    expect(persisted.status).not.toBe("approved");
    expect(persisted.release_status).not.toBe("released");
    expect(await modelFor(kind).countDocuments()).toBe(1);
    const jobs = await ReportJob.find({ reportId: String(report._id) }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.previewDataSnapshot).toEqual(original.preview_data);
    expect(jobs[0].type).toBe(kind === "asset" ? "asset-preview-files" : "lot-listing-files");
    if (kind === "lotListing") expect(jobs[0].payload.user.id).toBe(String(owner._id));

    const activeDetail = await detail(report._id, superadmin._id);
    expect(activeDetail.body.report.resubmitEligible).toBe(false);
    expect(activeDetail.body.report.resubmitIneligibleReason).toMatch(/processing|generation/i);
  });

  it.each(kinds)("%s rejects a stale viewed revision without replacing newer appraiser edits", async (kind) => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    const report = await createReport(kind, owner._id);
    const baseRevision = await currentRevision(report._id, superadmin._id);
    await modelFor(kind).updateOne({ _id: report._id }, { $set: { "preview_data.lots.0.description": "Newer owner correction" } });
    const response = await request(app).post(`/api/admin/preview-reports/${report._id}/resubmit`).set(headers(superadmin._id)).send({ baseRevision });
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/changed|refresh/i);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await modelFor(kind).findById(report._id).lean()).preview_data.lots[0].description).toBe("Newer owner correction");
  });

  it("rejects malformed revisions and all unsupported write inputs", async () => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    const report = await createReport("asset", owner._id);
    const baseRevision = await currentRevision(report._id, superadmin._id);
    const url = `/api/admin/preview-reports/${report._id}/resubmit`;
    const bodies = [
      {}, { baseRevision: null }, { baseRevision: 123 }, { baseRevision: "old" },
      { baseRevision: "g".repeat(64) }, { baseRevision: "a".repeat(65) },
      { baseRevision, preview_data: { lots: [] } },
      { baseRevision, actorId: String(owner._id) }, { baseRevision, user: String(superadmin._id) },
      { baseRevision, targetStatus: "approved" },
    ];
    for (const body of bodies) {
      expect((await request(app).post(url).set(headers(superadmin._id)).send(body)).status).toBe(400);
    }
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(String((await AssetReport.findById(report._id).lean())?.user)).toBe(String(owner._id));
  });

  it.each(kinds)("%s prevents hidden draft promotion and archived report resubmission", async (kind) => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    for (const extra of [{ is_draft_preview: true }, { adminArchivedAt: new Date() }]) {
      const report = await createReport(kind, owner._id, extra);
      const response = await detail(report._id, superadmin._id);
      expect(response.status).toBe(200);
      expect(response.body.report.resubmitEligible).toBe(false);
      const submitted = await request(app).post(`/api/admin/preview-reports/${report._id}/resubmit`)
        .set(headers(superadmin._id)).send({ baseRevision: response.body.report.resubmitRevision });
      expect(submitted.status).toBe(409);
      expect(submitted.body.message).toMatch(/draft|archived/i);
      const persisted = await modelFor(kind).findById(report._id).lean();
      expect(persisted.job_status).toBe("error");
      expect(String(persisted.user)).toBe(String(owner._id));
    }
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("returns a safe error without internal exception, stack or database details", async () => {
    const [owner, superadmin] = await Promise.all([createUser("user"), createUser("superadmin")]);
    const report = await createReport("asset", owner._id);
    const baseRevision = await currentRevision(report._id, superadmin._id);
    const spy = vi.spyOn(recovery, "resubmitSavedReportPreview").mockRejectedValueOnce(
      new Error("PRIVATE_DATABASE_DIAGNOSTIC mongodb://user:secret@example.invalid/internal"),
    );
    try {
      const response = await request(app).post(`/api/admin/preview-reports/${report._id}/resubmit`)
        .set(headers(superadmin._id)).send({ baseRevision });
      expect(response.status).toBe(500);
      expect(response.body.message).toBeTruthy();
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_DATABASE_DIAGNOSTIC|mongodb:|secret|stack|cause/);
      expect(await ReportJob.countDocuments()).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
