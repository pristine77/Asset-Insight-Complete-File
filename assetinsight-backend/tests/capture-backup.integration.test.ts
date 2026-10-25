import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ head: vi.fn(), read: vi.fn(), sign: vi.fn(), bucket: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  headCaptureBackupObject: storage.head, streamCaptureBackupObject: storage.read, createCaptureBackupPresignedPutUrl: storage.sign,
  getCaptureBackupR2Bucket: storage.bucket,
}));

let mongo: MongoMemoryServer, app: express.Express;
let User: any, Device: any, Grant: any, Plan: any, ObjectReceipt: any, Activity: any, Event: any;
let service: typeof import("../src/service/captureBackupService.js");
let recoverActivity: typeof import("../src/service/reportActivityService.js")["recoverReportActivity"];
let owner: any, other: any, device: any, otherDevice: any, grant: string;
const proof = "backup-approved-device-proof".padEnd(64, "x");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const bytes = Buffer.from("real original bytes");
const makeToken = (user = owner, registration = device) => jwt.sign({ id: String(user._id), did: String(registration._id), dv: registration.sessionVersion }, process.env.JWT_SECRET!, { expiresIn: "15m" });
const auth = (user = owner, registration = device) => ({ Authorization: `Bearer ${makeToken(user, registration)}`, "X-Device-Key": proof });
const capability = (token = grant) => ({ "X-Capture-Backup-Grant": token, "X-Device-Key": proof, "X-App-Version": "1.2.3 (24)" });
const snapshot = (extra: any = {}) => ({ clientDraftId: "draft-one", captureId: "capture-one", type: "asset", revision: 1, contractNo: "BACKUP-1", title: "Forklift",
  formData: { client_name: "Original client", watermark_images: false }, lots: [{ id: "lot-one", lotNumber: "12", title: "Saved title", coverIndex: 0 }],
  media: [{ clientFileId: "photo-one", lotId: "lot-one", slot: "main", index: 0, name: "original.jpg", mimeType: "image/jpeg", size: bytes.length, sha256: hash(bytes) }], ...extra });
const postPlan = (body = snapshot(), token = grant) => request(app).post("/api/capture-backups/plans").set(capability(token)).send(body);
const targets = (id: string, fileIds = ["photo-one"]) => request(app).post(`/api/capture-backups/plans/${id}/targets`).set(capability()).send({ fileIds });
const confirm = (id: string, fileIds = ["photo-one"]) => request(app).post(`/api/capture-backups/plans/${id}/confirm`).set(capability()).send({ fileIds });
const event = (id: string, extra: any = {}) => request(app).post(`/api/capture-backups/plans/${id}/events`).set(capability()).send({ eventId: "event-one", sequence: 1, action: "backup_started", reason: "unknown", ...extra });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Device } = await import("../src/models/deviceRegistration.model.js"));
  ({ CaptureBackupGrant: Grant, CaptureBackupPlan: Plan, CaptureBackupObject: ObjectReceipt } = await import("../src/models/captureBackup.model.js"));
  ({ ReportActivity: Activity, ReportActivityEvent: Event } = await import("../src/models/reportActivity.model.js"));
  service = await import("../src/service/captureBackupService.js");
  ({ recoverReportActivity: recoverActivity } = await import("../src/service/reportActivityService.js"));
  const { default: router } = await import("../src/routes/captureBackup.routes.js");
  const { protect } = await import("../src/middleware/auth.middleware.js");
  app = express(); app.use(express.json({ limit: "3mb" })); app.use("/api/capture-backups", router);
  app.post("/ordinary-protected-report", protect, (_req, res) => res.json({ shouldNeverBeReachedByGrant: true }));
  await Promise.allSettled(Object.values(mongoose.models).map(model => model.init()));
});
beforeEach(async () => {
  vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
  vi.clearAllMocks();
  storage.bucket.mockReturnValue("asset-insight-private-backups-test");
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  const users = ["owner", "other"].map(name => ({ _id: new mongoose.Types.ObjectId(), username: name, email: `${name}@example.test`, role: "user", isBlocked: false }));
  await User.collection.insertMany(users); [owner, other] = users;
  device = await Device.create({ user: owner._id, installationKeyHash: hash(proof), platform: "android", formFactor: "mobile", displayName: "Approved phone", status: "approved", sessionVersion: 0 });
  otherDevice = await Device.create({ user: other._id, installationKeyHash: hash(proof), platform: "android", formFactor: "mobile", displayName: "Other phone", status: "approved", sessionVersion: 0 });
  storage.head.mockResolvedValue({ size: bytes.length, etag: '"object-etag"' });
  storage.read.mockImplementation(async () => ({ stream: Readable.from([bytes]), contentLength: bytes.length, etag: '"object-etag"' }));
  storage.sign.mockImplementation(async (_bucket, key) => `https://example.test/scoped/${key}?signed=fixture`);
  const issued = await request(app).post("/api/capture-backups/grant").set(auth()).send({});
  expect(issued.status, JSON.stringify(issued.body)).toBe(200); grant = issued.body.data.token;
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); vi.unstubAllEnvs(); });

describe.sequential("isolated capture backup authority and immutable receipts", () => {
  it("issues only a hashed seven-day capability that cannot authenticate ordinary APIs", async () => {
    const saved = await Grant.findOne().select("+tokenHash").lean();
    expect(saved.tokenHash).toBe(hash(grant)); expect(JSON.stringify(saved)).not.toContain(grant);
    expect(saved.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect((await request(app).post("/ordinary-protected-report").set("Authorization", `Bearer ${grant}`)).status).toBe(401);
    expect((await request(app).post("/ordinary-protected-report").set(capability())).status).toBe(401);
    expect((await request(app).post("/api/capture-backups/plans").set(auth()).send(snapshot())).status).toBe(401);
    expect((await request(app).post("/api/capture-backups/plans").set("X-Capture-Backup-Grant", grant).send(snapshot())).status).toBe(401);
  });
  it("requires approved native device proof even when general enforcement is disabled", async () => {
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    const missingProof = await request(app).post("/api/capture-backups/grant").set("Authorization", `Bearer ${makeToken()}`).send({});
    expect(missingProof.status).toBe(401);
    expect(missingProof.body.code).toBe("BACKUP_AUTHENTICATION_REQUIRED");
    await Device.updateOne({ _id: device._id }, { $set: { status: "revoked" } });
    expect((await postPlan()).status).toBe(403);
  });
  it.each(["blocked", "deleted", "revoked", "session_version", "expired", "revoked_grant", "wrong_proof"])("stops background authorization on %s", async reason => {
    if (reason === "blocked") await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true } });
    if (reason === "deleted") await User.deleteOne({ _id: owner._id });
    if (reason === "revoked") await Device.updateOne({ _id: device._id }, { $set: { status: "revoked" } });
    if (reason === "session_version") await Device.updateOne({ _id: device._id }, { $inc: { sessionVersion: 1 } });
    if (reason === "expired") await Grant.updateOne({}, { $set: { expiresAt: new Date(0) } });
    if (reason === "revoked_grant") expect((await request(app).delete("/api/capture-backups/grant").set(capability())).status).toBe(200);
    const response = await request(app).post("/api/capture-backups/plans").set({ ...capability(), ...(reason === "wrong_proof" ? { "X-Device-Key": "wrong-proof".padEnd(64, "y") } : {}) }).send(snapshot());
    expect([401, 403]).toContain(response.status); expect(await Plan.countDocuments()).toBe(0);
  });
  it("new grant rotation revokes the previous grant without changing snapshots", async () => {
    const created = await postPlan();
    const next = await request(app).post("/api/capture-backups/grant").set(auth()).send({});
    expect((await postPlan()).status).toBe(401);
    grant = next.body.data.token;
    expect((await postPlan()).body.data.id).toBe(created.body.data.id);
    expect(await Grant.countDocuments()).toBe(1);
  });
  it("deduplicates concurrent same-revision registrations and rejects conflicting content", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => postPlan()));
    results.forEach(result => expect(result.status, JSON.stringify(result.body)).toBe(200));
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(1);
    expect(await Plan.countDocuments()).toBe(1); expect(await ObjectReceipt.countDocuments()).toBe(1);
    const conflict = await postPlan(snapshot({ title: "Different edit" }));
    expect(conflict.status).toBe(409); expect(conflict.body.code).toBe("BACKUP_REVISION_CONFLICT");
    expect((await Plan.findOne().lean()).title).toBe("Forklift");
  });
  it("keeps newer and shorter revisions independent and reuses verified bytes across metadata changes", async () => {
    const first = (await postPlan()).body.data;
    expect((await confirm(first.id)).body.data).toMatchObject({ status: "complete", total: 1, verified: 1 });
    const key = (await ObjectReceipt.findOne().lean()).r2Key;
    const next = await postPlan(snapshot({ revision: 2, title: "Edited title" }));
    expect(next.body.data).toMatchObject({ status: "complete", verified: 1, revision: 2 });
    expect(await ObjectReceipt.countDocuments()).toBe(1);
    expect((await ObjectReceipt.findOne().lean()).r2Key).toBe(key);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect((await targets(next.body.data.id)).body.data.targets).toEqual([{ clientFileId: "photo-one", alreadyUploaded: true }]);
    const empty = await postPlan(snapshot({ revision: 3, media: [] }));
    expect(empty.body.data).toMatchObject({ total: 0, status: "complete" });
    const old = await request(app).get(`/api/capture-backups/plans/${first.id}`).set(auth());
    expect(old.body.data.media).toHaveLength(1); expect(old.body.data.title).toBe("Forklift");
  });
  it("changed bytes with the same file ID/name/size receive a different immutable object", async () => {
    const first = (await postPlan()).body.data;
    await confirm(first.id);
    const different = Buffer.from("fake original bytes"); expect(different.length).toBe(bytes.length);
    const next = await postPlan(snapshot({ revision: 2, media: [{ ...snapshot().media[0], sha256: hash(different) }] }));
    expect(next.body.data).toMatchObject({ status: "pending", verified: 0 });
    expect(await ObjectReceipt.countDocuments()).toBe(2);
    expect(new Set((await ObjectReceipt.find().lean()).map((row: any) => row.r2Key)).size).toBe(2);
  });
  it("returns bounded create-only direct targets without requiring the browser CORS flag", async () => {
    const plan = (await postPlan()).body.data;
    const first = await targets(plan.id), again = await targets(plan.id);
    expect(first.status).toBe(200);
    expect(first.body.data.targets[0]).toMatchObject({ clientFileId: "photo-one", alreadyUploaded: false, headers: { "Content-Type": "image/jpeg", "If-None-Match": "*" } });
    expect(again.body.data.targets[0].uploadUrl).toBe(first.body.data.targets[0].uploadUrl);
    expect(storage.sign.mock.calls[0][0]).toBe("asset-insight-private-backups-test");
    expect(storage.sign.mock.calls[0][3]).toBe(bytes.length);
    expect(storage.sign.mock.calls[0][4]).toBeLessThanOrEqual(900);
    expect((await targets(plan.id, ["unrelated"])).status).toBe(409);
    expect((await targets(plan.id, ["photo-one", "photo-one"])).status).toBe(400);
  });
  it("never calls report/draft/job production or deletion paths on backup, completion or observation", async () => {
    const plan = (await postPlan()).body.data; await targets(plan.id); await event(plan.id); await confirm(plan.id);
    for (const collection of ["assetreports", "lotlistings", "reportjobs", "reportdrafts", "reportuploadsessions"]) expect(await mongoose.connection.collection(collection).countDocuments()).toBe(0);
    expect(await ObjectReceipt.countDocuments()).toBe(1);
    expect(await Event.countDocuments({ action: "backup_completed", authority: "server" })).toBe(1);
  });
  it("fails closed for absent/changed private storage and never reinterprets old receipts in the report bucket", async () => {
    const plan = (await postPlan()).body.data; await confirm(plan.id);
    storage.bucket.mockImplementation(() => { throw new Error("private storage not configured"); });
    const missing = await request(app).post("/api/capture-backups/grant").set(auth()).send({});
    expect(missing.status).toBe(503); expect(missing.body.code).toBe("BACKUP_STORAGE_NOT_CONFIGURED");
    expect((await targets(plan.id)).body.code).toBe("BACKUP_STORAGE_NOT_CONFIGURED");
    storage.bucket.mockReturnValue("different-private-bucket");
    expect((await targets(plan.id)).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await confirm(plan.id)).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}/status`).set(capability())).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await postPlan(snapshot({ revision: 2 }))).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}/media/photo-one/content`).set(auth())).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await ObjectReceipt.findOne().lean()).r2PublicBaseUrl).toBeUndefined();
  });
  it("rejects persisted key mismatches before reusing an already verified original", async () => {
    const plan = (await postPlan()).body.data; await confirm(plan.id);
    await ObjectReceipt.updateOne({}, { $set: { r2Key: `capture-backups/${other._id}/${device._id}/${"f".repeat(64)}` } });
    expect((await targets(plan.id)).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await confirm(plan.id)).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}/status`).set(capability())).body.code).toBe("BACKUP_STORAGE_CONFIGURATION_CHANGED");
    expect(storage.sign).not.toHaveBeenCalled();
    expect(storage.read).toHaveBeenCalledTimes(1);
  });
  it("owner-scopes reads and denies grant-only original downloads", async () => {
    const plan = (await postPlan()).body.data; await confirm(plan.id);
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}`).set(auth(other, otherDevice))).status).toBe(404);
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}/media/photo-one/content`).set(capability())).status).toBe(401);
    const detail = await request(app).get(`/api/capture-backups/plans/${plan.id}`).set(auth());
    expect(detail.body.data.media[0]).toMatchObject({ verifiedSize: bytes.length, contentPath: `/capture-backups/plans/${plan.id}/media/photo-one/content` });
    expect(JSON.stringify(detail.body)).not.toMatch(/r2Key|r2Bucket|objectId|contentHash|tokenHash/);
    const download = await request(app).get(`/api/capture-backups/plans/${plan.id}/media/photo-one/content`).set(auth());
    expect(download.status).toBe(200); expect(download.body).toEqual(bytes);
  });
  it("does not expose restore originals or completion on partial manifests", async () => {
    const plan = (await postPlan(snapshot({ media: [...snapshot().media, { ...snapshot().media[0], clientFileId: "photo-two", index: 1, sha256: hash("different original") }] }))).body.data;
    const partial = await confirm(plan.id);
    expect(partial.body.data).toMatchObject({ status: "pending", total: 2, verified: 1 });
    const detail = await request(app).get(`/api/capture-backups/plans/${plan.id}`).set(auth());
    expect(detail.body.data.media.every((file: any) => !file.contentPath)).toBe(true);
    expect((await request(app).get(`/api/capture-backups/plans/${plan.id}/media/photo-one/content`).set(auth())).status).toBe(409);
    expect(await Event.countDocuments({ action: "backup_completed" })).toBe(0);
  });
  it("reuses lost-response confirmations and immutable completion audit without another byte read", async () => {
    const plan = (await postPlan()).body.data;
    const first = await confirm(plan.id), retry = await confirm(plan.id);
    expect(retry.body.data).toEqual(first.body.data);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(await Event.countDocuments({ action: "backup_completed" })).toBe(1);
    const status = await request(app).get(`/api/capture-backups/plans/${plan.id}/status`).set(capability());
    expect(status.body.data).toMatchObject({ status: "complete", verified: 1 });
  });
  it("does not call missing verification metadata complete merely because completion was previously recorded", async () => {
    const plan = (await postPlan()).body.data; await confirm(plan.id);
    await ObjectReceipt.deleteMany({});
    const result = await request(app).get(`/api/capture-backups/plans/${plan.id}/status`).set(capability());
    expect(result.body.data).toMatchObject({ status: "pending", total: 1, verified: 0 });
    expect((await confirm(plan.id)).status).toBe(409);
  });
  it.each(["size", "digest", "stream_size", "changed_etag", "missing"])("rejects %s mismatch without losing local/server identities or claiming completion", async failure => {
    const plan = (await postPlan()).body.data;
    if (failure === "size") storage.head.mockResolvedValue({ size: 99, etag: '"object-etag"' });
    if (failure === "digest") storage.read.mockImplementation(async () => ({ stream: Readable.from([Buffer.from("fake original bytes")]), contentLength: bytes.length, etag: '"object-etag"' }));
    if (failure === "stream_size") storage.read.mockImplementation(async () => ({ stream: Readable.from([bytes.subarray(0, 2)]), contentLength: bytes.length, etag: '"object-etag"' }));
    if (failure === "changed_etag") storage.read.mockImplementation(async () => ({ stream: Readable.from([bytes]), contentLength: bytes.length, etag: '"changed"' }));
    if (failure === "missing") storage.head.mockRejectedValue(new Error("provider diagnostic signed-private-url"));
    const result = await confirm(plan.id);
    expect([409, 503]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain("provider diagnostic");
    expect((await Plan.findById(plan.id).lean()).completedAt).toBeUndefined();
    expect(await ObjectReceipt.countDocuments({ verifiedAt: { $exists: true } })).toBe(0);
    expect(await ObjectReceipt.countDocuments()).toBe(1);
  });
  it("rechecks grant revocation after a slow object verification before recording success", async () => {
    const plan = (await postPlan()).body.data;
    storage.read.mockImplementation(async () => {
      await Grant.updateOne({}, { $set: { revokedAt: new Date() } });
      return { stream: Readable.from([bytes]), contentLength: bytes.length, etag: '"object-etag"' };
    });
    expect((await confirm(plan.id)).status).toBe(401);
    expect(await ObjectReceipt.countDocuments({ verifiedAt: { $exists: true } })).toBe(0);
    expect(await Event.countDocuments()).toBe(0);
  });
  it("retains completion outbox through a failed Activity write and drains it on recovery", async () => {
    const plan = (await postPlan()).body.data;
    const failed = vi.spyOn(Event, "create").mockRejectedValueOnce(new Error("isolated audit outage"));
    const completed = await confirm(plan.id);
    expect(completed.body.data.status).toBe("complete");
    expect((await Plan.findById(plan.id).select("+activity_outbox").lean()).activity_outbox).toHaveLength(1);
    failed.mockRestore(); await recoverActivity();
    expect(await Event.countDocuments({ action: "backup_completed" })).toBe(1);
    expect((await Plan.findById(plan.id).select("+activity_outbox").lean()).activity_outbox).toHaveLength(0);
  });
  it("records device interruptions separately from user pauses and idempotently retains first verified counts", async () => {
    const plan = (await postPlan()).body.data;
    const observation = { action: "backup_interrupted", reason: "system_interruption", observedAt: "2026-10-06T11:00:00Z" };
    expect((await event(plan.id, observation)).status).toBe(200);
    await confirm(plan.id);
    expect((await event(plan.id, observation)).status).toBe(200);
    const saved = await Event.findOne({ action: "backup_interrupted" }).lean();
    expect(saved).toMatchObject({ authority: "device", actorRole: "user", data: { backupReason: "system_interruption", backupCounts: { totalFiles: 1, verifiedFiles: 0, totalPhotos: 1, verifiedPhotos: 0 }, backupCountAuthority: "server_verified" } });
    expect(await Event.countDocuments({ action: "backup_interrupted" })).toBe(1);
    expect((await event(plan.id, { action: "backup_interrupted", reason: "user_pause" })).status).toBe(400);
    expect((await event(plan.id, { action: "backup_paused", reason: "unknown" })).status).toBe(400);
    expect((await event(plan.id, { eventId: "pause", sequence: 2, action: "backup_paused", reason: "user_pause" })).status).toBe(200);
    expect((await event(plan.id, { eventId: "delete", sequence: 3, action: "backup_paused", reason: "draft_deleted" })).status).toBe(200);
    expect((await event(plan.id, { eventId: "resume", sequence: 4, action: "backup_resumed", reason: "unknown" })).status).toBe(200);
    expect((await event(plan.id, { action: "backup_completed", reason: "unknown" })).status).toBe(400);
  });
  it("rejects event-ID reuse with altered observations and respects permanent Activity deletion", async () => {
    const plan = (await postPlan()).body.data;
    expect((await event(plan.id)).status).toBe(200);
    expect((await event(plan.id, { reason: "network_unavailable" })).status).toBe(409);
    await Activity.updateOne({}, { $set: { removedAt: new Date() } }); await Event.deleteMany({});
    expect((await event(plan.id, { eventId: "later", sequence: 2 })).status).toBe(200);
    await confirm(plan.id); expect(await Event.countDocuments()).toBe(0);
  });
  it("records pauses before registration without inventing verified counts and reconciles cross-route retries", async () => {
    const body = { clientDraftId: "draft-one", captureId: "capture-one", type: "asset", revision: 1, contractNo: "BACKUP-1", eventId: "before-plan", sequence: 1,
      action: "backup_paused", reason: "user_pause", observedAt: "2026-10-06T11:00:00Z" };
    const early = await request(app).post("/api/capture-backups/events").set(capability()).send(body);
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(await Plan.countDocuments()).toBe(0); expect(await ObjectReceipt.countDocuments()).toBe(0);
    expect(await Event.findOne().lean()).toMatchObject({ authority: "device", data: { backupPlanId: null, backupCounts: null, backupCountAuthority: null, backupReason: "user_pause" } });
    const plan = (await postPlan()).body.data;
    expect((await event(plan.id, { eventId: body.eventId, sequence: 1, action: body.action, reason: body.reason, observedAt: body.observedAt })).status).toBe(200);
    expect(await Event.countDocuments()).toBe(1);
    expect((await request(app).post("/api/capture-backups/events").set(capability()).send({ ...body, eventId: "spoof", counts: { verified: 999 } })).status).toBe(400);
  });
  it("backup completion cannot overwrite an already confirmed report's state or captured counts", async () => {
    const plan = (await postPlan()).body.data;
    const id = hash(`${owner._id}\0asset\0capture-one`);
    await Activity.create({ _id: id, activityId: "capture-one", owner: owner._id, reportType: "asset", contract: "Confirmed contract", reportId: "accepted-report", latestAction: "preview_submitted", latestOutcome: "accepted", latestCounts: { lots: 8, photos: 240, mainPhotos: 240, extraPhotos: 0 }, lastConfirmedAt: new Date(), lastReceivedAt: new Date() });
    await event(plan.id); await confirm(plan.id);
    expect(await Activity.findById(id).lean()).toMatchObject({ reportId: "accepted-report", contract: "Confirmed contract", latestAction: "preview_submitted", latestCounts: { photos: 240 } });
  });
  it("list is bounded and owner-only with explicit revision counts", async () => {
    await postPlan(); await postPlan(snapshot({ revision: 2 }));
    const listed = await request(app).get("/api/capture-backups/plans?limit=1").set(auth());
    expect(listed.body.data).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(listed.body.data.items).toHaveLength(1);
    expect((await request(app).get("/api/capture-backups/plans").set(auth(other, otherDevice))).body.data.items).toEqual([]);
    expect((await request(app).get("/api/capture-backups/plans?limit=5000").set(auth())).status).toBe(400);
  });
  it("preserves ordinary labels that resemble URI scheme names", async () => {
    const formData = { notes: "Data: 2026", inspection: "File: inspected", description: "Asset: tractor", details: ["Content: complete", "PH: neutral", "file:inspection"] };
    const lots = [{ id: "lot-one", title: "Asset: tractor", notes: "Data: 2026" }];
    const created = await postPlan(snapshot({ formData, lots }));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const stored = await Plan.findById(created.body.data.id).lean();
    expect(stored.formData).toEqual(formData); expect(stored.lots).toEqual(lots);
  });
  it("rejects genuine local and embedded-data URI metadata", () => {
    for (const uri of ["file:///private/original.jpg", "file:/data/original.jpg", "content://media/123", "ph://original", "assets-library://original", "asset://original", "data:image/jpeg;base64,aGVsbG8=", "data:,embedded", "/storage/emulated/0/original.jpg"]) {
      expect(() => service.normalizeBackupSnapshot(snapshot({ formData: { original: uri } })), uri).toThrow(/local media paths|embedded bytes/);
    }
  });
  it.each([
    { formData: { image: "file:///private/original.jpg" } }, { lots: [{ id: "lot-one", uri: "content://media/123" }] },
    { media: [{ ...snapshot().media[0], size: 0 }] }, { media: [{ ...snapshot().media[0], sha256: undefined }] },
    { media: [{ ...snapshot().media[0], lotId: "missing" }] }, { media: [snapshot().media[0], snapshot().media[0]] },
    { revision: -1 }, { unknownField: true }, { media: [{ ...snapshot().media[0], r2Key: "caller-controlled" }] },
  ])("rejects incomplete, unsafe or unbounded snapshot input %#", async invalid => {
    expect((await postPlan(snapshot(invalid))).status).toBe(400); expect(await Plan.countDocuments()).toBe(0);
  });
  it("accepts 5,000 complete descriptors without byte reads and rejects count/total-byte overflow", () => {
    const media = Array.from({ length: 5000 }, (_, index) => ({ ...snapshot().media[0], clientFileId: `photo-${index}`, index }));
    expect(service.normalizeBackupSnapshot(snapshot({ media })).snapshot.media).toHaveLength(5000);
    const clip = { ...snapshot().media[0], clientFileId: "video-1", name: "clip.mp4", mimeType: "video/mp4", slot: "video" };
    expect(service.normalizeBackupSnapshot(snapshot({ media: [...media, clip] })).snapshot.media).toHaveLength(5001);
    expect(() => service.normalizeBackupSnapshot(snapshot({ media: Array.from({ length: 1001 }, (_, index) => ({ ...clip, clientFileId: `video-${index}`, index })) }))).toThrow(/1,000-video/);
    expect(() => service.normalizeBackupSnapshot(snapshot({ media: [...media, { ...media[0], clientFileId: "excess" }] }))).toThrow(/limit|2 MiB/);
    expect(() => service.normalizeBackupSnapshot(snapshot({ media: media.map(file => ({ ...file, size: 50 * 1024 ** 2 })) }))).toThrow(/20 GiB/);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
