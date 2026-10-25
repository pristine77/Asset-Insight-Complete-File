import { createHash, randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));

let mongo: MongoMemoryServer;
let app: express.Express;
let Inventory: any;
let Asset: any;
let Listing: any;
let Session: any;
let Job: any;
let User: any;
let Device: any;
let normalize: typeof import("../src/service/captureInventoryService.js")["normalizeCaptureSnapshot"];
let owner: any;
let other: any;
let admin: any;
let superadmin: any;
let device: any;
let captureId: string;
const key = "capture-device-proof-".padEnd(64, "x");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (user: any, extra: Record<string, unknown> = {}) => `Bearer ${jwt.sign({ id: String(user._id), ...extra }, process.env.JWT_SECRET!, { expiresIn: "30m" })}`;
const ownerHeaders = () => ({ Authorization: token(owner, { did: String(device._id), dv: 0 }), "X-Device-Key": key });
const payload = (extra: Record<string, any> = {}) => ({
  schemaVersion: 1, revision: 1, reportType: "asset", clientSubmissionId: "capture-submission-1", contractNo: "93530",
  device: { installationId: "installation-one", appVersion: "1.2.3", platform: "android" },
  localStatus: "saved", deviceCreatedAt: "2026-09-10T10:00:00.000Z", deviceSavedAt: "2026-09-10T11:00:00.000Z",
  firstCapturedAt: "2026-09-10T10:01:00.000Z", lastCapturedAt: "2026-09-10T10:45:00.000Z",
  lots: [{ id: "local-lot-1", lotNumber: "12", title: "Local equipment", mainPhotoCount: 3, extraPhotoCount: 1, availablePhotoCount: 3, missingPhotoCount: 1 }],
  ...extra,
});
const put = (body = payload(), id = captureId) => request(app).put(`/api/capture-inventory/${id}`).set(ownerHeaders()).send(body);
const detail = (id: string, query = "") => request(app).get(`/api/admin/capture-inventory/${id}${query}`).set("Authorization", token(admin));

beforeAll(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_capture_test_only");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: Inventory } = await import("../src/models/captureInventory.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  ({ default: Listing } = await import("../src/models/lotListing.model.js"));
  ({ default: Session } = await import("../src/models/reportUploadSession.model.js"));
  ({ default: Job } = await import("../src/models/reportJob.model.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Device } = await import("../src/models/deviceRegistration.model.js"));
  ({ normalizeCaptureSnapshot: normalize } = await import("../src/service/captureInventoryService.js"));
  const { default: router } = await import("../src/routes/captureInventory.routes.js");
  const controller = await import("../src/controller/captureInventory.controller.js");
  const { adminProtect } = await import("../src/middleware/admin.middleware.js");
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/capture-inventory", router);
  app.get("/api/admin/capture-inventory/users", adminProtect, controller.getAdminCaptureUsers);
  app.get("/api/admin/capture-inventory", adminProtect, controller.getAdminCaptureInventories);
  app.get("/api/admin/capture-inventory/:id", adminProtect, controller.getAdminCaptureDetail);
  app.delete("/api/admin/capture-inventory/:id", adminProtect, controller.deleteAdminCaptureHistory);
  // Let unrelated legacy auto-index attempts settle before isolated fixtures.
  // Some pre-existing security schemas declare the same TTL path twice.
  await Promise.allSettled(Object.values(mongoose.models).map((model) => model.init()));
  await Inventory.init();
});

beforeEach(async () => {
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
  const users = ["owner", "other", "admin", "superadmin"].map((role) => ({
    _id: new mongoose.Types.ObjectId(), username: role, email: `${role}@example.test`,
    role: role === "owner" || role === "other" ? "user" : role, isBlocked: false,
  }));
  await User.collection.insertMany(users);
  [owner, other, admin, superadmin] = users;
  device = await Device.create({ user: owner._id, installationKeyHash: hash(key), platform: "android", formFactor: "mobile", displayName: "Test phone", status: "approved", sessionVersion: 0 });
  captureId = randomUUID();
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); vi.unstubAllEnvs(); });

async function reportFixture(type: "asset" | "lotListing" = "asset", overrides: Record<string, any> = {}) {
  const model = type === "asset" ? Asset : Listing;
  const _id = new mongoose.Types.ObjectId();
  const report = { _id, user: owner._id, client_submission_id: "capture-submission-1", capture_id: captureId,
    job_id: `job-${_id}`, status: "processing", job_status: "uploading", contract_no: "93530", ...overrides };
  await model.collection.insertOne(report);
  return report;
}
async function sessionFixture(report?: any, overrides: Record<string, any> = {}) {
  const session = { _id: new mongoose.Types.ObjectId(), type: "asset", user: owner._id, clientSubmissionId: "capture-submission-1", capture_id: captureId,
    reportId: report ? String(report._id) : undefined, jobId: report?.job_id || "not-queued", status: "uploading", expectedImageCount: 4,
    uploadStartedAt: new Date("2026-09-11T10:00:00Z"),
    files: [{ fileId: "one", fieldname: "images", uploadedAt: new Date(), key: "private-object" }, { fileId: "two", fieldname: "images" }, { fileId: "video", fieldname: "videos", uploadedAt: new Date() }],
    ...overrides };
  await Session.collection.insertOne(session);
  return session;
}

describe.sequential("capture inventory ownership, idempotency and safety", () => {
  it("synchronizes only metadata and separates device clocks from server receipt", async () => {
    const response = await put();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ captureId, revision: 1, acknowledgedRevision: 1, removed: false });
    expect(response.headers["cache-control"]).toContain("no-store");
    const result = await detail(response.body.data.id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({
      counts: { lotCount: 1, photoCount: 4, mainPhotoCount: 3, extraPhotoCount: 1, availablePhotoCount: 3, missingPhotoCount: 1 },
      device: { platform: "android", appVersion: "1.2.3", registrationId: String(device._id), verified: true },
      server: { stage: "not_uploaded", uploadedPhotoCount: null, expectedPhotoCount: null, filesReady: false, previewAvailable: false },
      firstCapturedAt: payload().firstCapturedAt,
    });
    expect(result.body.data.lastReceivedAt).not.toBe(payload().deviceSavedAt);
    const serialized = JSON.stringify(result.body);
    for (const secret of [key, "installation-one", "installationHash", "contentHash", "private-object"]) expect(serialized).not.toContain(secret);
    expect(await Asset.countDocuments()).toBe(0);
    expect(await Listing.countDocuments()).toBe(0);
    expect(await Session.countDocuments()).toBe(0);
    expect(await Job.countDocuments()).toBe(0);
    expect(await mongoose.connection.collection("reportdrafts").countDocuments()).toBe(0);
  });
  it("coalesces concurrent first saves and exact retries without advancing receipt time", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => put()));
    responses.forEach((res) => expect(res.status, JSON.stringify(res.body)).toBe(200));
    expect(await Inventory.countDocuments()).toBe(1);
    const before = await Inventory.findOne().lean();
    const retry = await put();
    expect(retry.body.idempotent).toBe(true);
    expect((await Inventory.findOne().lean()).lastReceivedAt).toEqual(before.lastReceivedAt);
  });
  it("rejects differing same revisions and stale revisions with acknowledgement", async () => {
    await put(payload({ revision: 2 }));
    const stale = await put();
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "STALE_CAPTURE_REVISION", data: { acknowledgedRevision: 2 } });
    const collision = await put(payload({ revision: 2, contractNo: "changed" }));
    expect(collision.status).toBe(409);
    expect(collision.body.code).toBe("CAPTURE_REVISION_CONFLICT");
  });
  it("allows only one of competing next-revision snapshots", async () => {
    await put();
    const results = await Promise.all([put(payload({ revision: 2, contractNo: "A" })), put(payload({ revision: 2, contractNo: "B" }))]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  });
  it("allows a late submission binding once, but never changing report identity", async () => {
    await put(payload({ clientSubmissionId: "" }));
    expect((await put(payload({ revision: 2 }))).status).toBe(200);
    expect((await put(payload({ revision: 3, clientSubmissionId: "other" }))).body.code).toBe("CAPTURE_IDENTITY_CONFLICT");
    expect((await put(payload({ revision: 3, reportType: "lotListing" }))).body.code).toBe("CAPTURE_IDENTITY_CONFLICT");
  });
  it("keeps same contracts distinct and same capture UUID owner-scoped", async () => {
    const a = await put();
    const b = await put(payload(), randomUUID());
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    const c = await request(app).put(`/api/capture-inventory/${captureId}`).set("Authorization", token(other)).send(payload());
    expect(c.status).toBe(200);
    expect(new Set([a.body.data.id, b.body.data.id, c.body.data.id]).size).toBe(3);
    expect(await Inventory.countDocuments()).toBe(3);
  });
  it("enforces authentication, approved-device proof, blocked accounts and foreign reads", async () => {
    expect((await request(app).put(`/api/capture-inventory/${captureId}`).send(payload())).status).toBe(401);
    expect((await request(app).put(`/api/capture-inventory/${captureId}`).set("Authorization", token(owner)).send(payload())).status).toBe(401);
    await put();
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    expect((await request(app).get(`/api/capture-inventory/${captureId}`).set("Authorization", token(other))).status).toBe(404);
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
    await Device.updateOne({ _id: device._id }, { $set: { status: "revoked" } });
    expect((await put(payload({ revision: 2 }))).status).toBe(403);
    await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true } });
    expect((await request(app).get(`/api/capture-inventory/${captureId}`).set(ownerHeaders())).status).toBe(403);
  });
  it("binds the originating installation and labels enforcement-off observations unverified", async () => {
    await put();
    const changed = await put(payload({ revision: 2, device: { ...payload().device, installationId: "another" } }));
    expect(changed.body.code).toBe("CAPTURE_DEVICE_CONFLICT");
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    const unverified = await request(app).put(`/api/capture-inventory/${randomUUID()}`).set("Authorization", token(other)).send(payload());
    expect((await detail(unverified.body.data.id)).body.data.device.verified).toBe(false);
  });
  it.each([0, 1, 49, 50, 100, 5000])("accepts %i counted photos without media bytes", async (n) => {
    const body = payload({ lots: [{ ...payload().lots[0], mainPhotoCount: n, extraPhotoCount: 0, availablePhotoCount: n, missingPhotoCount: 0 }] });
    expect((await put(body)).status).toBe(200);
  });
  it.each([
    { schemaVersion: 2 }, { revision: 0 }, { revision: 1.1 }, { revision: "1" }, { reportType: "salvage" },
    { localStatus: "submitted" }, { user: "forged-owner" }, { server: { filesReady: true } },
    { image: "data:image/jpeg;base64,secret" }, { deviceSavedAt: "yesterday" }, { deviceCreatedAt: "2026-09-10" },
    { device: { ...payload().device, localPath: "file:///private" } },
    { lots: [{ ...payload().lots[0], title: "Notes file:///private/photo.jpg" }] },
    { lots: [{ ...payload().lots[0], title: "/storage/emulated/0/photo.jpg" }] },
    { lots: [{ ...payload().lots[0], mainPhotoCount: -1 }] },
    { lots: [{ ...payload().lots[0], availablePhotoCount: 99 }] },
    { lots: [payload().lots[0], payload().lots[0]] },
    { lots: [{ ...payload().lots[0], mainPhotoCount: 5000, extraPhotoCount: 1, availablePhotoCount: 5000, missingPhotoCount: 1 }] },
  ])("rejects unsupported or invalid metadata %j", async (extra) => {
    const res = await put(payload(extra));
    expect(res.status).toBe(400);
    expect(await Inventory.countDocuments()).toBe(0);
  });
  it("caps request bytes and lots, permits nullable capture times and never infers missing clocks", () => {
    expect(() => normalize(payload({ contractNo: "x".repeat(600_000) }))).toThrow("512 KiB");
    expect(() => normalize(payload({ lots: Array.from({ length: 1001 }, (_, i) => ({ ...payload().lots[0], id: `lot-${i}` })) }))).toThrow("1000");
    expect(normalize(payload({ firstCapturedAt: null, lastCapturedAt: null })).firstCapturedAt).toBeNull();
  });
});

describe.sequential("capture inventory administrative reads and tombstones", () => {
  it("allows admin and superadmin, rejects ordinary users, paginates lots and filters exact owner", async () => {
    const res = await put(payload({ lots: Array.from({ length: 60 }, (_, i) => ({ ...payload().lots[0], id: `lot-${i}` })) }));
    expect((await request(app).get("/api/admin/capture-inventory").set(ownerHeaders())).status).toBe(403);
    for (const actor of [admin, superadmin]) {
      const listed = await request(app).get(`/api/admin/capture-inventory?userId=${owner._id}&limit=1`).set("Authorization", token(actor));
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body.data.total).toBe(1);
      expect(listed.body.data.items[0]).not.toHaveProperty("lots");
    }
    const result = await detail(res.body.data.id, "?lotsPage=2&lotsLimit=25");
    expect(result.body.data).toMatchObject({ lotsTotal: 60, lotsPage: 2, lotsPages: 3 });
    expect(result.body.data.lots).toHaveLength(25);
    expect(result.body.data.lots[0].id).toBe("lot-25");
    const noOther = await request(app).get(`/api/admin/capture-inventory?userId=${other._id}`).set("Authorization", token(admin));
    expect(noOther.body.data.total).toBe(0);
  });
  it("uses inclusive server-receipt UTC dates, escaped search and validates filters", async () => {
    const res = await put(payload({ contractNo: "Contract [12]" }));
    await Inventory.updateOne({ _id: res.body.data.id }, { $set: { lastReceivedAt: new Date("2026-09-12T23:59:59.999Z") } });
    const list = (query: string) => request(app).get(`/api/admin/capture-inventory?${query}`).set("Authorization", token(admin));
    expect((await list("receivedFrom=2026-09-12&receivedTo=2026-09-12")).body.data.total).toBe(1);
    expect((await list("receivedFrom=2026-09-13")).body.data.total).toBe(0);
    expect((await list("search=%5B12%5D")).body.data.total).toBe(1);
    for (const query of ["receivedFrom=2026-02-30", "receivedFrom=2026-09-13&receivedTo=2026-09-12", "page=0", "limit=101", "userId=invalid", "localStatus=all", "reportType=salvage"]) expect((await list(query)).status).toBe(400);
  });
  it("includes blocked users in a small safe directory and tolerates deleted owners", async () => {
    const res = await put();
    await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true, password: "never-return" } });
    const users = await request(app).get("/api/admin/capture-inventory/users?search=owner&limit=1").set("Authorization", token(admin));
    expect(users.body.data.items[0]).toMatchObject({ id: String(owner._id), isBlocked: true });
    expect(JSON.stringify(users.body)).not.toContain("password");
    await User.deleteOne({ _id: owner._id });
    expect((await detail(res.body.data.id)).body.data.creator).toMatchObject({ id: String(owner._id), username: "", email: "" });
  });
  it("removes only explicitly discarded metadata and rejects delayed resurrection", async () => {
    const first = await put();
    const remove = (revision: number) => request(app).delete(`/api/admin/capture-inventory/${first.body.data.id}`).set("Authorization", token(admin)).send({ revision });
    expect((await remove(1)).body.code).toBe("CAPTURE_NOT_DISCARDED");
    await put(payload({ revision: 2, localStatus: "discarded" }));
    expect((await put(payload({ revision: 3 }))).body.code).toBe("CAPTURE_DISCARDED");
    expect((await remove(1)).body.code).toBe("STALE_CAPTURE_REVISION");
    expect((await remove(2)).status).toBe(200);
    expect((await remove(2)).body.idempotent).toBe(true);
    expect((await put(payload({ revision: 9 }))).status).toBe(410);
    expect((await request(app).get(`/api/capture-inventory/${captureId}`).set(ownerHeaders())).body.code).toBe("CAPTURE_REMOVED");
    expect((await detail(first.body.data.id)).status).toBe(404);
    const removed = await Inventory.findOne().select("+installationHash +contentHash").lean();
    expect(removed).not.toHaveProperty("contractNo");
    expect(removed).not.toHaveProperty("installationHash");
    expect(removed.lots).toEqual([]);
  });
  it("never deletes linked report, session, photos or jobs when removing discarded history", async () => {
    const response = await put(payload({ localStatus: "discarded" }));
    const report = await reportFixture("asset", { preview_data: { lots: [{ lot_number: "12", imageUrls: ["https://assetinsight.test/keep.jpg"] }] } });
    await sessionFixture(report);
    const beforeReport = await Asset.collection.findOne({ _id: report._id });
    const beforeSession = await Session.findOne().lean();
    expect((await request(app).delete(`/api/admin/capture-inventory/${response.body.data.id}`).set("Authorization", token(superadmin)).send({ revision: 1 })).status).toBe(200);
    expect(await Asset.collection.findOne({ _id: report._id })).toEqual(beforeReport);
    expect(await Session.findOne().lean()).toEqual(beforeSession);
  });
  it("fences concurrent discarded-history removal and a higher device revision", async () => {
    const res = await put(payload({ localStatus: "discarded" }));
    const [remove, lateSync] = await Promise.all([
      request(app).delete(`/api/admin/capture-inventory/${res.body.data.id}`).set("Authorization", token(admin)).send({ revision: 1 }),
      put(payload({ revision: 2, localStatus: "discarded", contractNo: "Changed before removal" })),
    ]);
    const row = await Inventory.findOne().lean();
    if (remove.status === 200) {
      expect(lateSync.status).toBe(410);
      expect(row.removedAt).not.toBeNull();
      expect(row).not.toHaveProperty("contractNo");
    } else {
      expect(remove.status).toBe(409);
      expect(lateSync.status).toBe(200);
      expect(row.revision).toBe(2);
      expect(row.removedAt).toBeNull();
    }
  });
});

describe.sequential("server-confirmed linkage, not client claims", () => {
  it("projects verified photo uploads without mistaking a placeholder or classifier for submission", async () => {
    const response = await put();
    const report = await reportFixture();
    const session = await sessionFixture(report);
    await Job.collection.insertOne({ reportId: String(report._id), progressId: report.job_id, type: "smart-upload-classify", status: "completed" });
    const result = await detail(response.body.data.id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.server).toMatchObject({ stage: "uploading", uploadedPhotoCount: 1, expectedPhotoCount: 4, reportId: String(report._id), uploadSessionId: String(session._id), acceptedAt: null, filesReady: false });
    expect(JSON.stringify(result.body)).not.toContain("private-object");
  });
  it.each(["asset", "lotListing"] as const)("follows exact %s outbox, saved preview, file generation and complete artifact states", async (type) => {
    const response = await put(payload({ reportType: type }));
    const report = await reportFixture(type, { job_status: "queued", queued_at: new Date(), report_job_outbox: { token: "private-outbox-token", type: type === "asset" ? "asset-preview" : "lot-listing-preview", reportId: "placeholder", progressId: "placeholder" } });
    const model = type === "asset" ? Asset : Listing;
    await model.collection.updateOne({ _id: report._id }, { $set: { "report_job_outbox.reportId": String(report._id), "report_job_outbox.progressId": report.job_id } });
    let result = await detail(response.body.data.id);
    expect(result.body.data.server.stage).toBe("processing");
    expect(result.body.data.server.acceptedAt).not.toBeNull();
    expect(JSON.stringify(result.body)).not.toContain("private-outbox-token");
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "preview", job_status: "done", preview_data: { lots: [{ lot_number: "12", imageUrls: ["private-photo-url"] }] } }, $unset: { report_job_outbox: "" } });
    result = await detail(response.body.data.id);
    expect(result.body.data.server).toMatchObject({ stage: "preview_ready", previewAvailable: true, filesReady: false });
    await model.collection.updateOne({ _id: report._id }, { $set: { job_status: "processing", files_generating: true, preview_submitted_at: new Date() } });
    expect((await detail(response.body.data.id)).body.data.server.stage).toBe("generating_files");
    await model.collection.updateOne({ _id: report._id }, { $set: { status: "approved", job_status: "done", files_generating: false, processing_completed_at: new Date(), files: { excel: "private.xlsx", images: "private.zip", docx: "private.docx" } } });
    result = await detail(response.body.data.id);
    expect(result.body.data.server).toMatchObject({ stage: "completed", filesReady: true });
    expect(JSON.stringify(result.body)).not.toContain("private.");
  });
  it("accepts exact preview job receipts but not mismatched progress or foreign reports", async () => {
    const response = await put();
    const report = await reportFixture("asset", { job_status: "queued", queued_at: new Date() });
    await Job.collection.insertOne({ reportId: String(report._id), progressId: "other-job", type: "asset-preview", status: "queued" });
    expect((await detail(response.body.data.id)).body.data.server.acceptedAt).toBeNull();
    await Job.collection.insertOne({ reportId: String(report._id), progressId: report.job_id, type: "asset-preview", status: "queued", createdAt: new Date() });
    expect((await detail(response.body.data.id)).body.data.server.stage).toBe("processing");
    await Asset.collection.updateOne({ _id: report._id }, { $set: { user: other._id } });
    expect((await detail(response.body.data.id)).body.data.server.reportId).toBeNull();
  });
  it("does not link an explicitly different capture ID or expose raw processing errors", async () => {
    const response = await put();
    const report = await reportFixture("asset", { capture_id: randomUUID(), status: "error", job_status: "error", preview_data: { lots: [{ title: "saved" }] }, job_error: "provider secret: sk-test-private\nfile:///private" });
    expect((await detail(response.body.data.id)).body.data.server.reportId).toBeNull();
    await Asset.collection.updateOne({ _id: report._id }, { $set: { capture_id: captureId } });
    const result = await detail(response.body.data.id);
    expect(result.body.data.server.stage).toBe("error");
    expect(result.body.data.server.issue).toContain("saved preview");
    expect(JSON.stringify(result.body)).not.toContain("sk-test-private");
  });
  it.each(["failed", "cancelled"])("shows an exact %s initial worker receipt as stopped, never completed", async (status) => {
    const response = await put();
    const report = await reportFixture("asset", { status: "approved", job_status: "done", files: { docx: "old.docx", excel: "old.xlsx", images: "old.zip" } });
    await Job.collection.insertOne({ reportId: String(report._id), progressId: report.job_id, type: "asset-preview", status, createdAt: new Date() });
    expect((await detail(response.body.data.id)).body.data.server).toMatchObject({ stage: "error", filesReady: false });
  });
  it("keeps report acceptance after delayed local paused metadata without altering server state", async () => {
    const response = await put();
    const report = await reportFixture("asset", { status: "preview", job_status: "done", preview_data: { lots: [{ title: "Ready" }] } });
    const before = await Asset.collection.findOne({ _id: report._id });
    expect((await put(payload({ revision: 2, localStatus: "paused" }))).status).toBe(200);
    expect((await detail(response.body.data.id)).body.data.server.stage).toBe("preview_ready");
    expect(await Asset.collection.findOne({ _id: report._id })).toEqual(before);
  });
});
