import { createHash, randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ head: vi.fn(), upload: vi.fn(), remove: vi.fn(), sign: vi.fn(), email: vi.fn(), push: vi.fn(), assetQueue: vi.fn(), lotQueue: vi.fn(), contracts: vi.fn(), tasks: vi.fn(), close: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", async original => ({ ...(await original<any>()), listIncomingContracts: mocks.contracts, listIncomingTasks: mocks.tasks, closeContractPartForUser: mocks.close }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendTransactionalEmail: mocks.email, sendEmail: mocks.email, sendVerificationCode: vi.fn(), sendPasswordResetCode: vi.fn(), sendPasswordResetLink: vi.fn(), sendDeviceDecisionEmail: vi.fn() }));
vi.mock("../src/utils/expoPush.js", () => ({ buildPushMessages: () => [], sendExpoPushNotifications: mocks.push }));
vi.mock("../src/utils/r2Storage/r2Upload.js", async original => ({ ...(await original<any>()), headR2Object: mocks.head, uploadFilePathToR2: mocks.upload, uploadBufferToR2: mocks.upload,
  deleteFromR2: mocks.remove, deleteFromR2Strict: mocks.remove, createR2PresignedPutUrl: mocks.sign }));
vi.mock("../src/jobs/assetReportJob.js", async original => ({ ...(await original<any>()), queueAssetPreviewJob: mocks.assetQueue }));
vi.mock("../src/jobs/lotListingJob.js", async original => ({ ...(await original<any>()), queueLotListingJob: mocks.lotQueue }));

let mongo: MongoMemoryServer, app: express.Express;
let User: any, Device: any, Session: any, Grant: any, Delivery: any, Asset: any, Lot: any, Job: any, Activity: any, Event: any, Inbox: any, Work: any;
let recover: typeof import("../src/service/reportTransferNotificationService.js")["recoverReportTransferNotifications"];
let recoverActivity: typeof import("../src/service/reportActivityService.js")["recoverReportActivity"];
let ensureOutbox: typeof import("../src/utils/reportJobMongoQueue.js")["ensureReportJobOutbox"];
let owner: any, device: any, session: any, token: string;
const proof = "report-transfer-device-proof".padEnd(64, "x");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (user = owner, registration = device) => ({ Authorization: `Bearer ${jwt.sign({ id: String(user._id), did: String(registration._id), dv: registration.sessionVersion }, process.env.JWT_SECRET!, { expiresIn: "15m" })}`, "X-Device-Key": proof });
const capability = (grant = token) => ({ "X-Report-Transfer-Grant": grant, "X-Device-Key": proof });
const path = (file = session) => `/api/report-transfers/${file.type}/${file._id}`;
const issue = (file = session, headers = auth()) => request(app).post("/api/report-transfers/grant").set(headers).send({ type: file.type, sessionId: String(file._id) });
const observe = (patch: any = {}) => request(app).post(`${path()}/events`).set(capability()).send({ eventId: "event-1", sequence: 1, action: "upload_queued", reason: "unknown", observedAt: "2026-10-08T12:00:00.000Z", appVersion: "1.0.4 (29)", ...patch });

async function createSession(user = owner, type = "asset", id = "submission-one", files = 1) {
  const _id = new mongoose.Types.ObjectId(), captureId = randomUUID();
  return Session.create({ _id, type, user: user._id, jobId: id, clientSubmissionId: id, manifestHash: `manifest-${id}`, capture_id: captureId, status: "uploading",
    details: { client_submission_id: id, capture_id: captureId, contract_no: `CONTRACT-${id}`, location: "Regina, SK", sales_date: "2026-10-08", valuation_methods: ["FML"], grouping_mode: "single_lot" },
    files: Array.from({ length: files }, (_, index) => ({ fileId: `photo-${index}`, key: `uploads/report-sessions/${type}/${_id}/photo-${index}.jpg`, fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg", size: 12, originalOrder: index, role: "main" })),
    expectedFileCount: files, expectedImageCount: files, expectedVideoCount: 0, totalBytes: files * 12,
    r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test" });
}
beforeAll(async () => {
  vi.stubEnv("REPORT_QUEUE_BACKEND", "mongo");
  vi.stubEnv("AUCTIONEER2_FEATURE_ENABLED", "true"); vi.stubEnv("AUCTIONEER2_API_KEY", "isolated-fixture");
  vi.stubEnv("AUCTIONEER2_API_BASE_URL", "https://auctioneer.example/api/external");
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Device } = await import("../src/models/deviceRegistration.model.js"));
  ({ default: Session } = await import("../src/models/reportUploadSession.model.js"));
  ({ ReportTransferGrant: Grant, ReportTransferDelivery: Delivery } = await import("../src/models/reportTransfer.model.js"));
  ({ ReportActivity: Activity, ReportActivityEvent: Event } = await import("../src/models/reportActivity.model.js"));
  ({ default: Asset } = await import("../src/models/asset.model.js")); ({ default: Lot } = await import("../src/models/lotListing.model.js"));
  ({ default: Job } = await import("../src/models/reportJob.model.js")); ({ default: Inbox } = await import("../src/models/notification.model.js"));
  ({ default: Work } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ recoverReportTransferNotifications: recover } = await import("../src/service/reportTransferNotificationService.js"));
  ({ recoverReportActivity: recoverActivity } = await import("../src/service/reportActivityService.js"));
  ({ ensureReportJobOutbox: ensureOutbox } = await import("../src/utils/reportJobMongoQueue.js"));
  const { default: router } = await import("../src/routes/reportTransfer.routes.js");
  const { protect } = await import("../src/middleware/auth.middleware.js");
  app = express(); app.use(express.json()); app.use("/api/report-transfers", router);
  app.post("/ordinary", protect, (_req, res) => res.json({ authorized: true }));
  const { default: auctionRouter } = await import("../src/routes/auctioneer2.routes.js");
  app.use("/api/auctioneer", auctionRouter);
  const { createUploadSession } = await import("../src/controller/reportUploadSession.controller.js");
  app.post("/session/asset", protect, createUploadSession("asset")); app.post("/session/lotListing", protect, createUploadSession("lotListing"));
  // Existing DeviceAccessChallenge declares both legacy and named expiry
  // indexes. Its unrelated duplicate-index diagnostic does not gate this suite.
  await Promise.allSettled(Object.values(mongoose.models).map(model => model.init()));
  await Promise.all([Grant.init(), Delivery.init(), Session.init(), Inbox.init()]);
});
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "on");
  const { waitForActivityDispatch } = await import("../src/service/reportActivityService.js"); await waitForActivityDispatch();
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  owner = { _id: new mongoose.Types.ObjectId(), username: "owner", email: "owner@gmail.com", role: "user", isVerified: true, isBlocked: false };
  await User.collection.insertOne(owner);
  device = await Device.create({ user: owner._id, installationKeyHash: hash(proof), platform: "android", formFactor: "mobile", displayName: "Approved fixture phone", status: "approved", sessionVersion: 0 });
  mocks.head.mockResolvedValue({ size: 12 }); mocks.upload.mockResolvedValue({}); mocks.remove.mockResolvedValue(undefined);
  mocks.sign.mockImplementation(async (_bucket, key) => `https://assetinsight.test/${key}?fixture=signature`);
  mocks.email.mockResolvedValue("fixture-message");
  mocks.contracts.mockResolvedValue([{ id: "contract-incoming", status: "ProposalInAssetInsight", assignedUserId: String(owner._id), eventId: "event-incoming" }]);
  mocks.tasks.mockResolvedValue([]); mocks.close.mockResolvedValue({ taskCompleted: true, userStatus: "completed" });
  mocks.assetQueue.mockImplementation((input: any) => ensureOutbox("asset", String(input.reportId), String(input.reportJobOutboxToken)));
  mocks.lotQueue.mockImplementation((input: any) => ensureOutbox("lotListing", String(input.listingId), String(input.reportJobOutboxToken)));
  session = await createSession();
  const issued = await issue(); expect(issued.status, JSON.stringify(issued.body)).toBe(200); token = issued.body.data.token;
});
afterAll(async () => { const { waitForActivityDispatch } = await import("../src/service/reportActivityService.js"); await waitForActivityDispatch(); await mongoose.disconnect(); await mongo.stop(); vi.unstubAllEnvs(); });

async function incoming(type = "asset") {
  const work = await Work.create({ cycleKey: randomUUID(), activeContractKey: randomUUID(), assignmentUserId: owner._id, claimedBy: owner._id,
    selectedReportType: type, clientSubmissionId: `incoming-${randomUUID()}`, kind: "unknown", status: "claimed",
    contract: { id: "contract-incoming", contractNo: "93530", eventId: "event-incoming", eventDate: "2026-10-08", customerName: "Frozen owner", description: "Frozen contract", location: "Regina" },
    snapshot: { contract: { id: "contract-incoming" }, event: { id: "event-incoming" }, lots: [], tasks: [], capturedAt: new Date() } });
  const payload = { details: { auctioneer_work_item_id: String(work._id), client_submission_id: work.clientSubmissionId, capture_id: randomUUID(), contract_no: "93530",
    location: "Regina", sales_date: "2026-10-08", valuation_methods: ["FML"], grouping_mode: "mixed", mixed_lots: [{ count: 1, extra_count: 0, mode: "single_lot", title: "Fixture", description: "Fixture capture" }] },
    files: [{ fileId: "photo-0", fieldname: "images", originalname: "photo-0.jpg", mimetype: "image/jpeg", size: 12, imageIndex: 0, lotIndex: 0, originalOrder: 0, role: "main" }] };
  const response = await request(app).post(`/session/${type}`).set(auth()).send(payload); expect(response.status, JSON.stringify(response.body)).toBe(201);
  session = await Session.findById(response.body.data.sessionId); token = (await issue()).body.data.token;
  return { work, payload };
}
const reserve = (work: any, extra: any = {}) => request(app).post(`/api/auctioneer/work-items/${work._id}/continue-upload`).set(auth()).send({ sessionId: String(session._id), ...extra });
const acceptedContinue = (work: any, reportId: string) => request(app).post(`/api/auctioneer/work-items/${work._id}/continue`).set(auth()).send({ reportId });

describe.sequential("durable queued Incoming continuation", () => {
  it.each(["asset", "lotListing"])("reserves empty independent %s work before acceptance and converges with accepted Continue", async type => {
    const { work } = await incoming(type), first = await reserve(work);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.reservation).toMatchObject({ status: "reserved", ownerId: String(owner._id), parentWorkItemId: String(work._id), parentSessionId: String(session._id), parentCaptureId: session.capture_id });
    expect(first.body.data.setup).toMatchObject({ status: "claimed", reportId: null, kind: "unknown", lots: [], continuationOfWorkItemId: String(work._id) });
    expect(first.body.data.setup.clientSubmissionId).not.toBe(work.clientSubmissionId); expect(first.body.data.accepted).toBeUndefined();
    expect(await Job.countDocuments()).toBe(0); expect(mocks.email).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
    expect((await Work.findById(work._id).lean()).queuedContinuation).toBeUndefined();
    const completed = await request(app).post(`${path()}/complete`).set(capability()); expect(completed.status, JSON.stringify(completed.body)).toBe(202);
    const legacy = await acceptedContinue(work, completed.body.reportId); expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(legacy.body.data.workItemId).toBe(first.body.data.setup.workItemId); expect(await Work.countDocuments()).toBe(2);
  });
  it.each(["expired", "revoked", "rotated"])("recovers the same reserved child after the native grant is %s", async mode => {
    const { work } = await incoming(), first = await reserve(work); expect(first.status).toBe(201);
    if (mode === "rotated") await issue(); else await Grant.updateMany({ sessionId: session._id }, { $set: mode === "expired" ? { expiresAt: new Date(0) } : { revokedAt: new Date() } });
    const replay = await reserve(work); expect(replay.status, JSON.stringify(replay.body)).toBe(200); expect(replay.body.data).toEqual(first.body.data);
    expect((await Session.findById(session._id).lean()).status).toBe("uploading");
  });
  it.each(["before", "during", "legacy", "released_legacy"])("keeps one successor when native completion happens %s reservation", async mode => {
    const { work } = await incoming(); let completed: any, prior: any;
    const complete = async () => { completed = await request(app).post(`${path()}/complete`).set(capability()); expect(completed.status).toBe(202); };
    if (mode === "during") mocks.contracts.mockImplementationOnce(async () => { await complete(); return [{ id: "contract-incoming", status: "ProposalInAssetInsight", assignedUserId: String(owner._id), eventId: "event-incoming" }]; });
    else await complete();
    if (mode.includes("legacy")) {
      prior = await acceptedContinue(work, completed.body.reportId); expect(prior.status).toBe(201);
      if (mode === "released_legacy") expect((await request(app).delete(`/api/auctioneer/work-items/${prior.body.data.workItemId}/claim`).set(auth())).status).toBe(200);
    }
    const reserved = await reserve(work); expect(reserved.status, JSON.stringify(reserved.body)).toBe(mode === "legacy" ? 200 : 201);
    if (prior) expect(reserved.body.data.setup.workItemId).toBe(prior.body.data.workItemId);
    expect((await acceptedContinue(work, completed.body.reportId)).body.data.workItemId).toBe(reserved.body.data.setup.workItemId);
    expect(await Work.countDocuments()).toBe(2); expect(await Job.countDocuments()).toBe(1);
  });
  it.each(["freeze", "child"])("recovers interrupted %s persistence without rotating an expired native grant", async step => {
    const { work, payload } = await incoming();
    const failure = step === "freeze" ? vi.spyOn(Session, "updateOne").mockRejectedValueOnce(new Error("fixture interruption"))
      : vi.spyOn(Work, "create").mockRejectedValueOnce(new Error("fixture interruption"));
    const interrupted = await reserve(work); failure.mockRestore(); expect(interrupted.status).toBe(500);
    const pin = (await Work.findById(work._id).select("+queuedContinuation").lean()).queuedContinuation;
    expect(pin.state).toBe("pending");
    if (step === "freeze") {
      for (const identityField of ["client_submission_id", "progress_id", "progressId", "job_id"]) {
        for (const workItemId of [undefined, String(new mongoose.Types.ObjectId())]) {
          const invalidDetails: any = { ...payload.details, auctioneer_work_item_id: workItemId };
          delete invalidDetails.client_submission_id;
          invalidDetails[identityField] = work.clientSubmissionId;
          const changedIdentity = await request(app).post("/session/asset").set(auth()).send({ ...payload, details: invalidDetails });
          expect(changedIdentity.status).toBe(409);
          expect(changedIdentity.body.code).toBe("UPLOAD_SESSION_IDENTITY_CHANGED");
          expect((await Session.findById(session._id).lean()).details.auctioneer_work_item_id).toBe(String(work._id));
        }
      }
      const changed = await request(app).post("/session/asset").set(auth()).send({ ...payload, details: { ...payload.details, location: "Cannot replace pinned details" } });
      expect(changed.body.code).toBe("UPLOAD_SESSION_CONTINUATION_FROZEN");
      expect((await request(app).post("/session/asset").set(auth()).send(payload)).status).toBe(200);
      const preservedClaim = `pending-continuation-${session._id}`;
      await Session.collection.updateOne({ _id: session._id }, { $set: { updatedAt: new Date(0), activeContractClaim: preservedClaim } });
      const { cleanupAbandonedSmartUploadSessions } = await import("../src/utils/smartUploadSessionMaintenance.js");
      await cleanupAbandonedSmartUploadSessions(); expect(mocks.remove).not.toHaveBeenCalled();
      const retained = await Session.findById(session._id).select("+activeContractClaim").lean();
      expect(retained.cleanupStartedAt).toBeUndefined();
      expect(retained.activeContractClaim).toBe(preservedClaim);
    }
    await Grant.updateMany({ sessionId: session._id }, { $set: { expiresAt: new Date(0) } });
    const recovered = await reserve(work); expect(recovered.status, JSON.stringify(recovered.body)).toBe(201);
    expect(recovered.body.data.setup.workItemId).toBe(pin.successorWorkItemId); expect(await Work.countDocuments()).toBe(2);
  });
  it("serializes simultaneous legacy and queued reservations to one successor", async () => {
    const { work } = await incoming(); const completed = await request(app).post(`${path()}/complete`).set(capability()); expect(completed.status).toBe(202);
    const [queued, legacy] = await Promise.all([reserve(work), acceptedContinue(work, completed.body.reportId)]);
    expect([queued.status, legacy.status].sort()).toEqual([200, 201]);
    expect(queued.body.data.setup.workItemId).toBe(legacy.body.data.workItemId); expect(await Work.countDocuments()).toBe(2);
  });
  it.each(["omitted", "foreign"])("fences %s Incoming identity when the wrapper misses a concurrently created session", async mode => {
    const { work, payload } = await incoming();
    const originalFindOne = Session.findOne.bind(Session);
    let initialLookupMissed = false;
    const lookup = vi.spyOn(Session, "findOne").mockImplementation((filter: any, ...args: any[]) => {
      if (!initialLookupMissed && filter?.clientSubmissionId === work.clientSubmissionId) {
        initialLookupMissed = true;
        return { select: () => Promise.resolve(null) } as any;
      }
      return originalFindOne(filter, ...args);
    });
    const changedDetails = { ...payload.details, auctioneer_work_item_id: mode === "foreign" ? String(new mongoose.Types.ObjectId()) : undefined };
    try {
      const changed = await request(app).post("/session/asset").set(auth()).send({ ...payload, details: changedDetails });
      expect(changed.status).toBe(mode === "foreign" ? 404 : 409);
      if (mode === "omitted") expect(changed.body.code).toBe("UPLOAD_SESSION_IDENTITY_CHANGED");
    } finally { lookup.mockRestore(); }
    expect(initialLookupMissed).toBe(true);
    expect((await Session.findById(session._id).lean()).details.auctioneer_work_item_id).toBe(String(work._id));
    const reserved = await reserve(work); expect(reserved.status).toBe(201);
  });
  it("serializes a late metadata edit behind reservation and rejects its changed snapshot", async () => {
    const { work, payload } = await incoming(); let changed: Promise<any> | undefined;
    mocks.contracts.mockImplementationOnce(async () => {
      changed = request(app).post("/session/asset").set(auth()).send({ ...payload, details: { ...payload.details, location: "Late edit" } }).then(response => response);
      return [{ id: "contract-incoming", status: "ProposalInAssetInsight", assignedUserId: String(owner._id), eventId: "event-incoming" }];
    });
    expect((await reserve(work)).status).toBe(201);
    expect((await changed!).body.code).toBe("UPLOAD_SESSION_CONTINUATION_FROZEN");
    expect((await Session.findById(session._id).lean()).details.location).toBe("Regina");
  });
  it.each(["initial", "replay"])("does not open editable work after a pending contract close on %s", async mode => {
    const { work } = await incoming(); if (mode === "replay") expect((await reserve(work)).status).toBe(201);
    const { beginAuctioneerContractClose } = await import("../src/service/auctioneerContractCloseService.js");
    await beginAuctioneerContractClose("contract-incoming", String(owner._id));
    expect((await reserve(work)).body.code).toBe("auctioneer_contract_close_pending_or_confirmed");
    expect(await Work.countDocuments()).toBe(mode === "initial" ? 1 : 2);
  });
  it("streams more than 100 accepted continuation receipts without inventing a permanent close limit", async () => {
    const rows = Array.from({ length: 101 }, () => ({ workId: new mongoose.Types.ObjectId(), sessionId: new mongoose.Types.ObjectId(), reportId: new mongoose.Types.ObjectId() }));
    await Work.collection.insertMany(rows.map(row => ({ _id: row.workId, cycleKey: `accepted-${row.workId}`, claimedBy: owner._id, assignmentUserId: owner._id, selectedReportType: "asset", contract: { id: "contract-incoming" }, queuedContinuation: { sessionId: String(row.sessionId) } })));
    await Asset.collection.insertMany(rows.map(row => ({ _id: row.reportId, user: owner._id })));
    await Session.collection.insertMany(rows.map(row => ({ _id: row.sessionId, user: owner._id, type: "asset", status: "queued", reportId: String(row.reportId), jobId: `accepted-${row.reportId}`, details: { auctioneer_work_item_id: String(row.workId) } })));
    const { assertNoQueuedContinuationUpload } = await import("../src/service/auctioneerContractCloseService.js");
    await expect(assertNoQueuedContinuationUpload("contract-incoming", String(owner._id))).resolves.toBeUndefined();
    await Session.collection.updateOne({ _id: rows[100].sessionId }, { $set: { status: "uploading" } });
    await expect(assertNoQueuedContinuationUpload("contract-incoming", String(owner._id))).rejects.toMatchObject({ code: "auctioneer_queued_upload_unfinished" });
  });
  it("rejects first reservation without current device grant and rejects untrusted body fields", async () => {
    const { work } = await incoming(); await Grant.updateMany({ sessionId: session._id }, { $set: { revokedAt: new Date() } });
    expect((await reserve(work)).body.code).toBe("auctioneer_upload_transfer_required");
    expect((await reserve(work, { reportId: new mongoose.Types.ObjectId() })).status).toBe(400);
    expect(await Work.countDocuments()).toBe(1);
  });
  it.each(["assignment", "event", "parent", "snapshot", "device"])("rechecks %s authority after a slow provider read", async change => {
    const { work } = await incoming();
    mocks.contracts.mockImplementationOnce(async () => {
      if (change === "parent") await Work.deleteOne({ _id: work._id });
      if (change === "snapshot") await Session.updateOne({ _id: session._id }, { $set: { "details.location": "Changed" } });
      if (change === "device") await Device.updateOne({ _id: device._id }, { $set: { status: "blocked" } });
      return change === "assignment" ? [] : [{ id: "contract-incoming", status: "ProposalInAssetInsight", assignedUserId: String(owner._id), eventId: change === "event" ? "different" : "event-incoming" }];
    });
    const response = await reserve(work); expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await Work.countDocuments({ continuationOfWorkItemId: work._id })).toBe(0);
  });
  it("requires fresh assignment for an editable replay but never turns an already-used child into a blank form", async () => {
    const { work } = await incoming(), first = await reserve(work); expect(first.status).toBe(201);
    mocks.contracts.mockResolvedValue([]); expect((await reserve(work)).body.code).toBe("auctioneer_continuation_assignment_unavailable");
    const childReportId = new mongoose.Types.ObjectId(); await Work.updateOne({ _id: first.body.data.setup.workItemId }, { $set: { status: "report_created", linkedReportId: childReportId } });
    const used = await reserve(work); expect(used.status).toBe(200); expect(used.body.data.setup).toMatchObject({ status: "report_created", reportId: String(childReportId) });
    expect(await Work.countDocuments()).toBe(2);
  });
  it("freezes exact session details while preserving identical create retries, media and parent claim", async () => {
    const { work, payload } = await incoming(), first = await reserve(work); expect(first.status).toBe(201);
    const exact = await request(app).post("/session/asset").set(auth()).send(payload); expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    const changed = await request(app).post("/session/asset").set(auth()).send({ ...payload, details: { ...payload.details, location: "Changed" } });
    expect(changed.body.code).toBe("UPLOAD_SESSION_CONTINUATION_FROZEN");
    const manifest = await request(app).post("/session/asset").set(auth()).send({ ...payload, files: [{ ...payload.files[0], size: 20 }] });
    expect(manifest.body.code).toBe("SUBMISSION_MANIFEST_CHANGED");
    expect((await request(app).delete(`/api/auctioneer/work-items/${work._id}/claim`).set(auth())).body.code).toBe("auctioneer_claim_locked");
    const close = await request(app).post("/api/auctioneer/contracts/contract-incoming/close-my-part").set(auth()); expect(close.body.code).toBe("auctioneer_queued_upload_unfinished"); expect(mocks.close).not.toHaveBeenCalled();
    const { assertNoQueuedContinuationUpload } = await import("../src/service/auctioneerContractCloseService.js");
    await expect(assertNoQueuedContinuationUpload("contract-incoming", String(owner._id))).rejects.toMatchObject({ code: "auctioneer_queued_upload_unfinished" });
    await Session.collection.updateOne({ _id: session._id }, { $set: { updatedAt: new Date(0) } });
    const { cleanupAbandonedSmartUploadSessions } = await import("../src/utils/smartUploadSessionMaintenance.js");
    await cleanupAbandonedSmartUploadSessions(); expect(await Session.findById(session._id)).not.toBeNull(); expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe.sequential("explicit background report-transfer capability", () => {
  it("stores only a seven-day token hash; cannot call ordinary APIs, other sessions or mutate a manifest", async () => {
    const saved = await Grant.findOne().select("+tokenHash").lean(); expect(saved.tokenHash).toBe(hash(token)); expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect((await request(app).post("/ordinary").set(capability())).status).toBe(401);
    expect((await request(app).post("/ordinary").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    const another = await createSession(owner, "asset", "other-submission");
    const wrongScope = await request(app).get(`${path(another)}/status`).set(capability());
    expect(wrongScope.status, JSON.stringify(wrongScope.body)).toBe(403);
    expect((await request(app).patch(`${path()}/details`).set(capability()).send({ contract_no: "changed" })).status).toBe(404);
    expect((await request(app).post("/api/report-transfers/grant").set(auth()).send({ type: "asset", sessionId: String(session._id), recipient: "elsewhere@example.test" })).status).toBe(400);
    expect(await Job.countDocuments()).toBe(0); expect(mocks.email).not.toHaveBeenCalled();
  });
  it.each(["blocked", "deleted", "revoked", "version", "expired", "grant_revoked", "wrong_proof"])("fails closed on %s", async reason => {
    if (reason === "blocked") await User.updateOne({ _id: owner._id }, { $set: { isBlocked: true } });
    if (reason === "deleted") await User.deleteOne({ _id: owner._id });
    if (reason === "revoked") await Device.updateOne({ _id: device._id }, { $set: { status: "revoked" } });
    if (reason === "version") await Device.updateOne({ _id: device._id }, { $inc: { sessionVersion: 1 } });
    if (reason === "expired") await Grant.updateOne({}, { $set: { expiresAt: new Date(0) } });
    if (reason === "grant_revoked") expect((await request(app).delete(`${path()}/grant`).set(capability())).status).toBe(200);
    const response = await request(app).get(`${path()}/status`).set({ ...capability(), ...(reason === "wrong_proof" ? { "X-Device-Key": "wrong".padEnd(64, "y") } : {}) });
    expect([401, 403]).toContain(response.status); expect(await Job.countDocuments()).toBe(0);
  });
  it("requires mobile device proof even with global enforcement off and rotates only this session's grant", async () => {
    vi.stubEnv("DEVICE_APPROVAL_ENFORCEMENT", "off");
    const missing = await issue(session, { Authorization: auth().Authorization } as any); expect(missing.status).toBe(401);
    const second = await issue(); expect(second.status).toBe(200);
    expect((await request(app).get(`${path()}/status`).set(capability())).status).toBe(401);
    token = second.body.data.token; expect((await request(app).get(`${path()}/status`).set(capability())).status).toBe(200);
    expect(await Delivery.countDocuments()).toBe(1);
  });
  it.each(["details", "manifest", "smart", "cleanup"])("rejects a changed %s snapshot", async change => {
    const update = change === "details" ? { "details.location": "New edit" } : change === "manifest" ? { manifestHash: "changed" } : change === "smart" ? { smartUpload: true } : { cleanupStartedAt: new Date() };
    await Session.updateOne({ _id: session._id }, { $set: update });
    expect((await request(app).post(`${path()}/complete`).set(capability())).status).toBe(409); expect(await Job.countDocuments()).toBe(0);
  });
  it("pages at most 100 targets and preserves existing create-only upload headers", async () => {
    session = await createSession(owner, "asset", "many", 103); token = (await issue()).body.data.token;
    expect((await request(app).get(`${path()}/targets?limit=101`).set(capability())).status).toBe(400);
    const first = await request(app).get(`${path()}/targets?cursor=0&limit=100`).set(capability());
    expect(first.status, JSON.stringify(first.body)).toBe(200); expect(first.body.data.files).toHaveLength(100); expect(first.body.data.nextCursor).toBe("100");
    expect(first.body.data.files[0].headers).toEqual({ "If-None-Match": "*" });
    const last = await request(app).get(`${path()}/targets?cursor=100&limit=100`).set(capability()); expect(last.body.data.files).toHaveLength(3); expect(last.body.data.nextCursor).toBeNull();
  });
  it("streams multipart through the original immutable fallback then verifies its exact bytes", async () => {
    const before = session.files[0].key;
    const uploaded = await request(app).post(`${path()}/files/photo-0`).set(capability()).attach("file", Buffer.alloc(12), { filename: "photo-0.jpg", contentType: "image/jpeg" });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200); expect(uploaded.body.data).toMatchObject({ fileId: "photo-0", size: 12 });
    const after = await Session.findById(session._id).lean(); expect(after.files[0].key).not.toBe(before); expect(after.files[0].verifiedSize).toBe(12);
    expect((await request(app).post(`${path()}/files/photo-0/verify`).set(capability())).body.data).toEqual({ fileId: "photo-0", verified: true, size: 12 });
    expect(await Job.countDocuments()).toBe(0);
  });
  it.each(["verify", "complete", "fallback", "verify_expired", "complete_expired", "fallback_expired"])("a grant revoked or expired during %s cannot publish a receipt or queue work", async scenario => {
    const operation = scenario.split("_")[0];
    const revoke = async () => { await Grant.updateOne({}, { $set: scenario.endsWith("_expired") ? { expiresAt: new Date(0) } : { revokedAt: new Date() } }); return { size: 12 }; };
    if (operation === "fallback") mocks.upload.mockImplementationOnce(revoke); else mocks.head.mockImplementationOnce(revoke);
    const response = operation === "fallback" ? await request(app).post(`${path()}/files/photo-0`).set(capability()).attach("file", Buffer.alloc(12), { filename: "photo-0.jpg", contentType: "image/jpeg" })
      : await request(app).post(`${path()}/${operation === "verify" ? "files/photo-0/verify" : "complete"}`).set(capability());
    expect(response.status, JSON.stringify(response.body)).toBe(401); expect(response.body.code).toBe("REPORT_TRANSFER_AUTHENTICATION_REQUIRED");
    expect(await Job.countDocuments()).toBe(0); expect(await Asset.countDocuments()).toBe(0);
    if (operation !== "complete") expect((await Session.findById(session._id).lean()).files[0].uploadedAt).toBeUndefined();
  });
  it.each(["asset", "lotListing"])("duplicate %s completion converges on one report and exact durable job", async type => {
    session = await createSession(owner, type, `complete-${type}`); token = (await issue()).body.data.token;
    const first = await request(app).post(`${path()}/complete`).set(capability()); expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({ accepted: true, reportAvailable: true, ownerId: String(owner._id), sessionId: String(session._id), type });
    const replays = await Promise.all(Array.from({ length: 4 }, () => request(app).post(`${path()}/complete`).set(capability())));
    replays.forEach(result => { expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.reportId).toBe(first.body.reportId); expect(result.body.ownerId).toBe(String(owner._id)); });
    expect(await Job.countDocuments()).toBe(1); expect(await (type === "asset" ? Asset : Lot).countDocuments()).toBe(1);
    const status = await request(app).get(`${path()}/status`).set(capability()); expect(status.body.data).toMatchObject({ accepted: true, canResumeUploads: false, ownerId: String(owner._id), sessionId: String(session._id), type, reportId: first.body.reportId });
  });
  it.each(["asset", "lotListing"])("permits same-session %s upload recovery only before any report handoff", async type => {
    session = await createSession(owner, type, `resume-${type}`); token = (await issue()).body.data.token;
    mocks.head.mockRejectedValueOnce(Object.assign(new Error("Missing fixture object"), { statusCode: 404 }));
    expect((await request(app).post(`${path()}/complete`).set(capability())).status).toBe(400);
    const failed = await request(app).get(`${path()}/status`).set(capability());
    expect(failed.body.data).toMatchObject({ status: "failed", accepted: false, canResumeUploads: true });
    expect((await request(app).post(`${path()}/files/photo-0`).set(capability()).attach("file", Buffer.alloc(12), { filename: "photo-0.jpg", contentType: "image/jpeg" })).status).toBe(200);
    expect((await request(app).post(`${path()}/complete`).set(capability())).status).toBe(202);
    expect((await request(app).get(`${path()}/status`).set(capability())).body.data.canResumeUploads).toBe(false);
  });
  it.each(["cleanup", "claim", "incoming", "completed"])("does not infer upload-resume authority from failed/preparing state for %s", async scenario => {
    const changes: any = { status: "failed" };
    if (scenario === "cleanup") changes.cleanupStartedAt = new Date();
    if (scenario === "claim") changes.finalizationClaimToken = "unconfirmed-finalization";
    if (scenario === "incoming") changes["details.auctioneer_work_item_id"] = "frozen-incoming";
    if (scenario === "completed") changes.status = "completed";
    await Session.updateOne({ _id: session._id }, { $set: changes });
    const { uploadSessionRecoveryReceipt } = await import("../src/controller/reportUploadSession.controller.js");
    const receipt = await uploadSessionRecoveryReceipt({ type: "asset", session: await Session.findById(session._id).select("+finalizationClaimToken").lean() });
    expect(receipt.accepted).toBe(false);
    expect(receipt.canResumeUploads).toBe(scenario === "incoming");
    if (scenario === "incoming") expect(receipt.canSupersede).toBe(false);
  });
});

describe.sequential("durable observations and independent owner notifications", () => {
  it("bounds a hung provider without claiming that it did not deliver, and observes a late rejection", async () => {
    const { withReportTransferDeliveryDeadline } = await import("../src/service/reportTransferNotificationService.js");
    vi.useFakeTimers();
    try {
      let rejectLate: (reason?: any) => void = () => undefined;
      const provider = new Promise<string>((_resolve, reject) => { rejectLate = reject; });
      const bounded = withReportTransferDeliveryDeadline(provider, 50);
      const assertion = expect(bounded).rejects.toThrow("could not be confirmed");
      await vi.advanceTimersByTimeAsync(50); await assertion;
      rejectLate(new Error("late provider error")); await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("records user pause separately from system interruption, dedupes IDs and rejects invented acceptance", async () => {
    expect((await observe({ action: "upload_paused", reason: "system_stop" })).status).toBe(400);
    expect((await observe({ action: "upload_accepted" })).status).toBe(400);
    expect((await observe()).body.data.acknowledgements[0].eventId).toBe("event-1");
    expect((await observe()).status).toBe(200); expect(await Event.countDocuments({ eventId: "event-1" })).toBe(1);
    expect((await observe({ reason: "system_stop" })).status).toBe(409);
    await observe({ eventId: "paused", sequence: 2, action: "upload_paused", reason: "user_pause" });
    await observe({ eventId: "interrupted", sequence: 3, action: "upload_interrupted", reason: "system_stop" });
    const row = await Event.findOne({ eventId: "interrupted" }).lean(); expect(row).toMatchObject({ authority: "device", outcome: "completed", source: "android", appVersion: "1.0.4 (29)" });
    expect(row.data).toMatchObject({ uploadReason: "system_stop", uploadCounts: { totalFiles: 1, verifiedFiles: 0 }, uploadCountAuthority: "server_verified" });
    expect(row.observedAt.toISOString()).toBe("2026-10-08T12:00:00.000Z"); expect(await Job.countDocuments()).toBe(0);
  });
  it("keeps server-confirmed workflow and removal tombstones after delayed observations", async () => {
    await observe(); const first = await Event.findOne({ eventId: "event-1" }).lean();
    await Activity.updateOne({ _id: first.activity }, { $set: { lastConfirmedAt: new Date(), latestAction: "preview_ready", latestOutcome: "completed", latestCounts: { photos: 19 } } });
    await observe({ eventId: "late", sequence: 2, action: "upload_interrupted", reason: "unknown" });
    expect(await Activity.findById(first.activity).lean()).toMatchObject({ latestAction: "preview_ready", latestCounts: { photos: 19 } });
    await Activity.updateOne({ _id: first.activity }, { $set: { removedAt: new Date() } }); await Event.deleteMany({ activity: first.activity });
    const tombstone = await observe({ eventId: "removed", sequence: 3 }); expect(tombstone.body.data.acknowledgements[0].removed).toBe(true);
    await recoverActivity(); expect(await Event.countDocuments({ activity: first.activity })).toBe(0);
  });
  it("recovers an observation after its durable outbox was saved but history dispatch failed", async () => {
    const failure = vi.spyOn(Event, "create").mockRejectedValueOnce(new Error("isolated history failure"));
    expect((await observe()).status).toBe(503); failure.mockRestore();
    expect((await Grant.findOne().select("+activity_outbox").lean()).activity_outbox).toHaveLength(1);
    await recoverActivity(); expect(await Event.countDocuments({ eventId: "event-1" })).toBe(1);
    expect((await observe()).status).toBe(200); expect((await Grant.findOne().select("+activity_outbox").lean()).activity_outbox).toHaveLength(0);
  });
  it("does not email merely queued local work; accepted receipt creates one inbox and one owner email", async () => {
    await recover(); expect(mocks.email).not.toHaveBeenCalled(); expect(await Inbox.countDocuments()).toBe(0);
    const accepted = await request(app).post(`${path()}/complete`).set(capability()); expect(accepted.status).toBe(202);
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0) } }); await recover();
    expect(mocks.email).toHaveBeenCalledTimes(1); expect(mocks.email.mock.calls[0][0]).toMatchObject({ to: "owner@gmail.com" }); expect(mocks.email.mock.calls[0][0].idempotencyKey).toMatch(/^report-transfer-accepted-/);
    expect(await Inbox.countDocuments({ user: owner._id, type: "report_upload_accepted" })).toBe(1);
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0) } }); await recover(); expect(mocks.email).toHaveBeenCalledTimes(1); expect(await Inbox.countDocuments()).toBe(1);
  });
  it.each(["asset", "lotListing"])("retains the %s acceptance notification when processing fails before its first sweep", async type => {
    if (type === "lotListing") { session = await createSession(owner, type, "failed-lot-processing"); token = (await issue()).body.data.token; }
    const accepted = await request(app).post(`${path()}/complete`).set(capability()); expect(accepted.status).toBe(202);
    await Session.updateOne({ _id: session._id }, { $set: { status: "failed" } });
    await Job.updateMany({ reportId: accepted.body.reportId }, { $set: { status: "failed" } });
    await recover();
    expect(await Inbox.countDocuments({ user: owner._id, type: "report_upload_accepted" })).toBe(1);
    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect(mocks.email.mock.calls[0][0].htmlContent).not.toContain("will be notified when the preview is ready");
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0) } }); await recover();
    expect(mocks.email).toHaveBeenCalledTimes(1);
  });
  it("prioritizes newly accepted work over more than one batch of older incomplete uploads", async () => {
    const pending = await Promise.all(Array.from({ length: 35 }, (_, index) => createSession(owner, "asset", `old-pending-${index}`)));
    for (const old of pending) expect((await issue(old)).status).toBe(200);
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0), waitingChecks: 4 } });
    const accepted = await request(app).post(`${path()}/complete`).set(capability()); expect(accepted.status).toBe(202);
    await recover();
    expect(mocks.email).toHaveBeenCalledTimes(1); expect(await Inbox.countDocuments()).toBe(1);
    expect((await Delivery.findOne({ sessionId: session._id }).lean()).state).toBe("complete");
    expect(await Delivery.countDocuments({ state: "waiting" })).toBe(35);
  });
  it("an uncertain email retains the inbox and is never blindly sent again", async () => {
    await request(app).post(`${path()}/complete`).set(capability()); mocks.email.mockRejectedValueOnce(new Error("ambiguous transport"));
    await recover(); expect(await Inbox.countDocuments()).toBe(1); expect((await Delivery.findOne().lean()).emailState).toBe("uncertain");
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0) } }); await recover(); expect(mocks.email).toHaveBeenCalledTimes(1);
  });
  it("recovers a missing inbox independently of an already sent email", async () => {
    await request(app).post(`${path()}/complete`).set(capability());
    const failure = vi.spyOn(Inbox, "updateOne").mockRejectedValueOnce(new Error("isolated inbox failure"));
    await recover(); failure.mockRestore(); expect(mocks.email).toHaveBeenCalledTimes(1); expect(await Inbox.countDocuments()).toBe(0);
    await Delivery.updateMany({}, { $set: { nextCheckAt: new Date(0) } }); await recover();
    expect(await Inbox.countDocuments()).toBe(1); expect(mocks.email).toHaveBeenCalledTimes(1);
  });
  it.each(["removed_report", "changed_owner", "deleted_account", "cleanup"])("never sends an acceptance notification after %s", async scenario => {
    const accepted = await request(app).post(`${path()}/complete`).set(capability());
    if (scenario === "removed_report") await Asset.deleteOne({ _id: accepted.body.reportId });
    if (scenario === "changed_owner") await Asset.updateOne({ _id: accepted.body.reportId }, { $set: { user: new mongoose.Types.ObjectId() } });
    if (scenario === "deleted_account") await User.deleteOne({ _id: owner._id });
    if (scenario === "cleanup") await Session.updateOne({ _id: session._id }, { $set: { cleanupStartedAt: new Date() } });
    await recover(); expect(await Inbox.countDocuments()).toBe(0); expect(mocks.email).not.toHaveBeenCalled();
  });
  it("rechecks exact report ownership between inbox delivery and email", async () => {
    const accepted = await request(app).post(`${path()}/complete`).set(capability());
    const original = Inbox.updateOne.bind(Inbox);
    const change = vi.spyOn(Inbox, "updateOne").mockImplementationOnce(async (...args: any[]) => {
      const result = await original(...args); await Asset.updateOne({ _id: accepted.body.reportId }, { $set: { user: new mongoose.Types.ObjectId() } }); return result;
    });
    await recover(); change.mockRestore(); expect(await Inbox.countDocuments()).toBe(1); expect(mocks.email).not.toHaveBeenCalled();
  });
  it("100 independent company users cannot read, verify, complete, or observe a peer session", async () => {
    const members = Array.from({ length: 100 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), username: `member-${index}`, email: `member-${index}@example.test`, role: "user", isBlocked: false }));
    await User.collection.insertMany(members);
    const fixtures = await Promise.all(members.map(async (member, index) => {
      const registration = await Device.create({ user: member._id, installationKeyHash: hash(proof), platform: "android", formFactor: "mobile", displayName: "Company fixture phone", status: "approved", sessionVersion: 0 });
      const ownSession = await createSession(member, index % 2 ? "lotListing" : "asset", `company-${index}`);
      const response = await issue(ownSession, auth(member, registration)); expect(response.status).toBe(200);
      return { member, registration, ownSession, grant: response.body.data.token };
    }));
    const results = await Promise.all(fixtures.map(async (fixture, index) => {
      const own = await request(app).get(`${path(fixture.ownSession)}/status`).set(capability(fixture.grant));
      expect(own.status, `Owner ${index}: ${JSON.stringify(own.body)}`).toBe(200);
      expect(own.body.data.ownerId).toBe(String(fixture.member._id));
      const peer = fixtures[(index + 1) % fixtures.length];
      const method = index % 4 === 0 ? "status" : index % 4 === 1 ? "files/photo-0/verify" : index % 4 === 2 ? "complete" : "events";
      return method === "status" ? request(app).get(`${path(peer.ownSession)}/${method}`).set(capability(fixture.grant)) : request(app).post(`${path(peer.ownSession)}/${method}`).set(capability(fixture.grant)).send({});
    }));
    results.forEach(result => expect(result.status).toBe(403)); expect(await Job.countDocuments()).toBe(0); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.email).not.toHaveBeenCalled();
  });
});
