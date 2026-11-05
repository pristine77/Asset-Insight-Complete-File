import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn() }));
const mocks = vi.hoisted(() => ({ head: vi.fn(), ensure: vi.fn(), queue: vi.fn(), realEnsure: undefined as any }));
vi.mock("../src/service/auctioneerEventResolutionService.js", () => ({ AUCTIONEER_EVENT_REQUIRED_MESSAGE: "event missing", recoverInitialAuctioneerEventIdentity: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ headR2Object: mocks.head,
  resolveR2ObjectLocationFromUrl: (value: string) => value.startsWith("https://fixture.test/") ? { bucketName: "fixture", key: value.slice("https://fixture.test/".length) } : null,
  resolvePersistedR2StorageTarget: ({ r2Bucket }: any) => { if (r2Bucket !== "fixture") throw new Error("Unknown storage generation"); return { bucketName: r2Bucket }; } }));
vi.mock("../src/utils/reportJobMongoQueue.js", async (original) => {
  const actual: any = await original(); mocks.realEnsure = actual.ensureReportJobOutbox;
  return { ...actual, ensureReportJobOutbox: mocks.ensure, shouldUseMongoReportQueue: mocks.queue };
});
import Asset from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import UploadSession from "../src/models/reportUploadSession.model.js";
import User from "../src/models/user.model.js";
import { getInitialPreviewRetryState as state, retryRetainedInitialPreview as retry, verifyRetainedPreviewRetrySources as verify } from "../src/service/initialPreviewRetryService.js";
import { initialPreviewRetryController } from "../src/controller/initialPreviewRetry.controller.js";
import { createMongoReportJob } from "../src/utils/reportJobMongoQueue.js";

type Kind = "asset" | "lotListing";
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); await ReportJob.createIndexes(); vi.clearAllMocks();
  mocks.head.mockResolvedValue({ size: 100 }); mocks.queue.mockReturnValue(true); mocks.ensure.mockImplementation(mocks.realEnsure);
});

async function seed(kind: Kind = "asset", overrides: any = {}, count = 2) {
  const Model: any = kind === "asset" ? Asset : LotListing;
  const reportId = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId(), sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, role: "user", isBlocked: false, email: "owner@example.test" });
  const originals = Array.from({ length: count }, (_, i) => ({ fieldname: "images", r2Key: `sessions/${sessionId}/${i}.jpg`, r2Bucket: "fixture",
    r2PublicUrl: `https://fixture.test/sessions/${sessionId}/${i}.jpg`, size: 100, lotIndex: 0, imageIndex: i, captureOrder: i, originalOrder: i, role: i ? "extra" : "main" }));
  const progressId = `initial-${reportId}`;
  const details = { upload_session_id: String(sessionId), contract_no: "fixture", client_submission_id: "submission", watermark_images: false,
    mixed_lots: [{ mode: "single_lot", count: 1, extra_count: count - 1, capture_lot_id: "capture", capture_lot_number: "27" }] };
  const payload = { [kind === "asset" ? "reportId" : "listingId"]: String(reportId), user: { id: String(userId), email: "owner@example.test" },
    images: originals, videos: [], details, progressId };
  await Model.collection.insertOne({ _id: reportId, user: userId, status: "error", job_status: "error", job_error: "Duplicate lot number 1",
    job_id: progressId, contract_no: "fixture", preview_data: null, lots: [{ lot_id: "intake", image_indexes: [0, 1] }],
    imageUrls: originals.map(file => file.r2PublicUrl), videoUrls: [], updatedAt: new Date(), ...overrides });
  await UploadSession.collection.insertOne({ _id: sessionId, type: kind, user: userId, reportId: String(reportId), jobId: progressId,
    status: "failed", details, r2Bucket: "fixture", expectedFileCount: count, expectedImageCount: count, expectedVideoCount: 0,
    totalBytes: count * 100, files: originals.map(({ r2Key, r2Bucket, r2PublicUrl, ...file }) => ({ ...file, key: r2Key, fileId: r2Key, verifiedSize: 100 })) });
  const oldJob = await ReportJob.create({ type: kind === "asset" ? "asset-preview" : "lot-listing-preview", targetStatus: "preview", status: "failed",
    reportId: String(reportId), progressId, payload, attempts: 3, maxAttempts: 3, lastError: "Duplicate lot number 1" });
  const input = { reportType: kind, reportId: String(reportId), actorId: String(userId), scope: "owner" as const };
  return { Model, kind, reportId, userId, sessionId, oldJob, payload, input };
}
const read = (f: Awaited<ReturnType<typeof seed>>) => f.Model.findById(f.reportId).select("+report_job_outbox +report_recovery +report_recovery_history").lean();
const prepare = async (f: Awaited<ReturnType<typeof seed>>) => ({ ...f.input, baseRevision: (await state(f.input)).initialPreviewRetryRevision! });
const queued = async (f: Awaited<ReturnType<typeof seed>>) => ReportJob.findOne({ reportId: String(f.reportId), status: "queued" }).lean();
const context = () => ({ assertOwned: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal } as any);

describe.sequential("explicit retained initial preview recovery", () => {
  it.each(["asset", "lotListing"] as const)("queues one same-report %s preview and leaves every original/source/prior job untouched", async kind => {
    const f = await seed(kind), before = await read(f), input = await prepare(f);
    expect(await state(f.input)).toMatchObject({ initialPreviewRetryEligible: true, initialPreviewRetryRevision: input.baseRevision });
    const result = await retry(input); expect(result.data).toMatchObject({ reportId: String(f.reportId), retry_stage: "initial_preview", job_status: "queued", downloadable: false });
    const after = await read(f), job = await queued(f);
    for (const key of ["user", "contract_no", "preview_data", "lots", "imageUrls", "videoUrls"]) expect(after[key]).toEqual(before[key]);
    expect(after.preview_submitted_at).toBeUndefined(); expect(after.approval_requested_at).toBeUndefined();
    expect(job?.payload.images).toEqual(f.payload.images); expect(job?.payload.details).toEqual(f.payload.details);
    expect((await ReportJob.findById(f.oldJob._id).lean())?.payload).toEqual(f.payload);
    expect(job?.targetStatus).toBe("preview"); expect(job?.maxAttempts).toBe(1); expect(await f.Model.countDocuments()).toBe(1);
    expect(mocks.head).not.toHaveBeenCalled(); await verify(job as any, context()); expect(mocks.head).toHaveBeenCalledTimes(2);
  });
  it("supports the known Lot defaults-only intake shell after the processing transition", async () => {
    const f = await seed("lotListing", { preview_data: { include_damage_analysis: true, bank_photos_enabled: false, valuation_methods: ["FML"], lots: [] } });
    await retry(await prepare(f)); await expect(verify(await queued(f) as any, context())).resolves.toBeUndefined();
  });
  it("joins concurrent and lost-response clicks without a second attempt", async () => {
    const f = await seed(), input = await prepare(f);
    mocks.ensure.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const results = await Promise.allSettled([retry(input), retry(input)]);
    const result = await retry(input);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect(result.data.job_id).toBe((await read(f)).job_id); expect(await ReportJob.countDocuments()).toBe(2);
    expect((await read(f)).report_recovery_history).toHaveLength(1);
  });
  it("a delayed successful retry returns ready without submitting or regenerating files", async () => {
    const f = await seed(), input = await prepare(f); await retry(input);
    await f.Model.updateOne({ _id: f.reportId }, { $set: { status: "preview", job_status: "done", preview_data: { lots: [{ title: "Saved analysis" }] } } });
    expect((await retry(input)).data).toMatchObject({ preview_available: true, job_status: "done" });
    expect(await ReportJob.countDocuments()).toBe(2); expect((await read(f)).preview_submitted_at).toBeUndefined();
  });
  it("does not revive a failed manual attempt through a delayed outbox sweep", async () => {
    const f = await seed(); mocks.ensure.mockImplementationOnce(async () => {
      const report = await read(f); await createMongoReportJob(report.report_job_outbox); throw new Error("uncertain acknowledgement");
    });
    const input = await prepare(f); await retry(input); const job = await queued(f);
    await ReportJob.updateOne({ _id: job!._id }, { $set: { status: "failed", attempts: 1, lastError: "missing photo" }, $unset: { dedupeKey: 1 } });
    await f.Model.updateOne({ _id: f.reportId }, { $set: { status: "error", job_status: "error", job_error: "missing photo" } });
    await mocks.realEnsure(f.kind, String(f.reportId), job!.progressId);
    expect((await ReportJob.findById(job!._id).lean())?.status).toBe("failed");
    expect((await ReportJob.findById(job!._id).lean())?.attempts).toBe(1);
    await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 }); expect(await ReportJob.countDocuments()).toBe(2);
  });
  it.each([
    { preview_data: { lots: [{ title: "Reviewed" }] } }, { preview_data: {} }, { preview_submitted_at: new Date() },
    { approval_requested_at: new Date() }, { released_at: new Date() }, { adminArchivedAt: new Date() }, { is_draft_preview: true },
    { auctioneerWorkItem: new mongoose.Types.ObjectId() }, { files: { word: "saved.docx" } }, { files_generating: true },
    { report_recovery: { manualReviewRequired: true } }, { job_status: "processing" },
  ])("rejects reviewed/protected/integration state %j", async change => {
    const f = await seed("asset", change); expect((await state(f.input)).initialPreviewRetryEligible).toBe(false);
    await expect(retry({ ...f.input, baseRevision: "a".repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(1); expect(mocks.head).not.toHaveBeenCalled();
  });
  it("rejects foreign-owner and revoked-admin requests from fresh account data", async () => {
    const f = await seed(), input = await prepare(f), other = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: other, role: "user", isBlocked: false });
    await expect(state({ ...f.input, actorId: String(other) })).rejects.toMatchObject({ statusCode: 404 });
    await expect(retry({ ...input, actorId: String(other) })).rejects.toMatchObject({ statusCode: 404 });
    await User.updateOne({ _id: other }, { $set: { role: "superadmin" } });
    const admin = { ...f.input, actorId: String(other), scope: "admin" as const };
    const adminState = await state(admin); expect(adminState.initialPreviewRetryEligible).toBe(true);
    await User.updateOne({ _id: other }, { $set: { role: "admin" } });
    await expect(retry({ ...admin, baseRevision: adminState.initialPreviewRetryRevision! })).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each(["report", "report-details", "payload", "payload-details", "session-details", "legacy-task-id"])("excludes Auctionsoft %s before queueing or reading originals", async location => {
    const f = await seed("lotListing"), input = await prepare(f), binding = { taskId: "incoming-task" };
    if (location === "report") await f.Model.updateOne({ _id: f.reportId }, { $set: { auctionsoft: binding } });
    if (location === "report-details") await f.Model.collection.updateOne({ _id: f.reportId }, { $set: { "details.auctionsoft": binding } });
    if (location === "payload") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.auctionsoft": binding } });
    if (location === "payload-details") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.details.auctionsoft": binding } });
    if (location === "session-details") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { "details.auctionsoft": binding } });
    if (location === "legacy-task-id") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.details.auctionsoft_task_id": "incoming-task" } });
    expect((await state(f.input)).initialPreviewRetryEligible).toBe(false);
    await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(await ReportJob.countDocuments()).toBe(1); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled(); expect((await read(f)).preview_data).toBeNull();
  });
  it("refuses an Auctionsoft binding added during the queue CAS even without updatedAt changing", async () => {
    const f = await seed("lotListing"), input = await prepare(f);
    const original = f.Model.findOneAndUpdate.bind(f.Model);
    const spy = vi.spyOn(f.Model, "findOneAndUpdate").mockImplementationOnce((...args: any[]) => {
      const query = original(...args);
      const lean = query.lean.bind(query);
      query.lean = async () => {
        await f.Model.collection.updateOne({ _id: f.reportId }, { $set: { auctionsoft: { taskId: "new-binding" } } });
        return lean();
      };
      return query;
    });
    try { await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 }); } finally { spy.mockRestore(); }
    expect(await ReportJob.countDocuments()).toBe(1); expect(mocks.head).not.toHaveBeenCalled();
  });
  it("rejects stale revisions including same-millisecond source edits and owner ABA transitions", async () => {
    const f = await seed(), input = await prepare(f), before = await read(f);
    await f.Model.collection.updateOne({ _id: f.reportId }, { $set: { imageUrls: ["changed"], updatedAt: before.updatedAt } });
    await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 });
    await f.Model.collection.updateOne({ _id: f.reportId }, { $set: { imageUrls: before.imageUrls, user: new mongoose.Types.ObjectId() } });
    await expect(retry(input)).rejects.toMatchObject({ statusCode: 404 });
    await f.Model.updateOne({ _id: f.reportId }, { $set: { user: f.userId } });
    await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each(["missing-job", "leased-job", "wrong-job-owner", "missing-session", "foreign-session", "truncated-payload", "different-size", "different-bucket", "foreign-url", "wrong-key-url", "cleanup", "smart-upload"])("refuses unverifiable retained metadata: %s", async corruption => {
    const f = await seed();
    if (corruption === "missing-job") await ReportJob.deleteOne({ _id: f.oldJob._id });
    if (corruption === "leased-job") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { lockedBy: "worker" } });
    if (corruption === "wrong-job-owner") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.user.id": String(new mongoose.Types.ObjectId()) } });
    if (corruption === "missing-session") await UploadSession.deleteOne({ _id: f.sessionId });
    if (corruption === "foreign-session") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { user: new mongoose.Types.ObjectId() } });
    if (corruption === "truncated-payload") await ReportJob.updateOne({ _id: f.oldJob._id }, { $pop: { "payload.images": 1 } });
    if (corruption === "different-size") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.images.0.size": 99 } });
    if (corruption === "different-bucket") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { r2Bucket: "foreign" } });
    if (corruption === "foreign-url") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.images.0.r2PublicUrl": "https://elsewhere.test/photo.jpg" } });
    if (corruption === "wrong-key-url") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.images.0.r2PublicUrl": "https://fixture.test/other.jpg" } });
    if (corruption === "cleanup") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { cleanupStartedAt: new Date() } });
    if (corruption === "smart-upload") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { smartUpload: true } });
    expect((await state(f.input)).initialPreviewRetryEligible).toBe(false);
    expect(mocks.head).not.toHaveBeenCalled(); expect(await f.Model.countDocuments()).toBe(1);
  });
});

describe.sequential("worker source checks precede any initial analysis", () => {
  it.each(["report", "report-details", "session-details"])("blocks Auctionsoft %s added after acceptance before any HEAD and rejects replay", async location => {
    const f = await seed("lotListing"), input = await prepare(f); await retry(input);
    const job = await queued(f), binding = { taskId: "incoming-task" };
    if (location === "report") await f.Model.updateOne({ _id: f.reportId }, { $set: { auctionsoft: binding } });
    if (location === "report-details") await f.Model.collection.updateOne({ _id: f.reportId }, { $set: { "details.auctionsoft": binding } });
    if (location === "session-details") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { "details.auctionsoft": binding } });
    await expect(verify(job as any, context())).rejects.toMatchObject({ statusCode: 409 });
    if (location !== "session-details") await expect(retry(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.head).not.toHaveBeenCalled(); expect((await read(f)).preview_data).toBeNull();
    expect(await ReportJob.countDocuments()).toBe(2);
  });
  it("checks all originals with at most four concurrent bounded HEAD calls", async () => {
    const f = await seed("asset", {}, 9); await retry(await prepare(f)); let inflight = 0, peak = 0;
    mocks.head.mockImplementation(async (_bucket, _key, options) => { inflight++; peak = Math.max(peak, inflight);
      expect(options.timeoutMs).toBeLessThanOrEqual(15000); await new Promise(r => setTimeout(r, 2)); inflight--; return { size: 100 }; });
    await verify(await queued(f) as any, context()); expect(mocks.head).toHaveBeenCalledTimes(9); expect(peak).toBe(4);
  });
  it.each(["missing", "truncated", "revoked", "owner-changed", "preview-saved", "source-changed", "session-changed", "lease-lost"])("rejects %s before analysis", async mutation => {
    const f = await seed(); await retry(await prepare(f)); const job = await queued(f), ctx = context();
    if (mutation === "missing") mocks.head.mockRejectedValue(new Error("not found"));
    if (mutation === "truncated") mocks.head.mockResolvedValue({ size: 1 });
    if (mutation === "revoked") await User.updateOne({ _id: f.userId }, { $set: { isBlocked: true } });
    if (mutation === "owner-changed") await f.Model.updateOne({ _id: f.reportId }, { $set: { user: new mongoose.Types.ObjectId() } });
    if (mutation === "preview-saved") await f.Model.updateOne({ _id: f.reportId }, { $set: { preview_data: { lots: [{ title: "New edit" }] } } });
    if (mutation === "source-changed") await ReportJob.updateOne({ _id: f.oldJob._id }, { $set: { "payload.details.contract_no": "changed" } });
    if (mutation === "session-changed") await UploadSession.updateOne({ _id: f.sessionId }, { $set: { "files.0.captureOrder": 999 } });
    if (mutation === "lease-lost") ctx.assertOwned.mockRejectedValue(Object.assign(new Error("Lost ownership"), { code: "REPORT_JOB_OWNERSHIP_LOST" }));
    await expect(verify(job as any, ctx)).rejects.toThrow();
    expect((await read(f)).preview_data).toEqual(mutation === "preview-saved" ? { lots: [{ title: "New edit" }] } : null);
    expect((await read(f)).preview_submitted_at).toBeUndefined();
  });
  it("rechecks access after storage checks and never resumes after mid-check revocation", async () => {
    const f = await seed(); await retry(await prepare(f)); mocks.head.mockImplementation(async () => {
      await User.updateOne({ _id: f.userId }, { $set: { isBlocked: true } }); return { size: 100 };
    });
    await expect(verify(await queued(f) as any, context())).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe.sequential("explicit owner/admin recovery HTTP boundary", () => {
  it("requires exact request body and current admin role; returns no-store eligibility and same-report receipt", async () => {
    const f = await seed(); const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { req.userId = String(f.userId); req.user = { role: "user" }; next(); });
    app.get("/:id/retry-preview", initialPreviewRetryController("asset", "read"));
    app.post("/:id/retry-preview", initialPreviewRetryController("asset", "retry"));
    app.get("/admin/:id/retry-preview", initialPreviewRetryController("admin", "read"));
    const eligible = await request(app).get(`/${f.reportId}/retry-preview`);
    expect(eligible.status).toBe(200); expect(eligible.headers["cache-control"]).toBe("no-store");
    const baseRevision = eligible.body.data.initialPreviewRetryRevision;
    for (const body of [{}, { baseRevision: "bad" }, { baseRevision, preview_data: {} }, { baseRevision, actorId: "other" }]) {
      expect((await request(app).post(`/${f.reportId}/retry-preview`).send(body)).status).toBe(400);
    }
    expect((await request(app).get(`/admin/${f.reportId}/retry-preview`)).status).toBe(403);
    const accepted = await request(app).post(`/${f.reportId}/retry-preview`).send({ baseRevision });
    expect(accepted.status).toBe(202); expect(accepted.body.data.reportId).toBe(String(f.reportId));
    expect(accepted.body.data.retry_stage).toBe("initial_preview");
  });
});
