import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn() }));
const mocks = vi.hoisted(() => ({ event: vi.fn(), head: vi.fn(), ensure: vi.fn(), queue: vi.fn(), ensureReal: undefined as any }));
vi.mock("../src/service/auctioneerEventResolutionService.js", () => ({
  AUCTIONEER_EVENT_REQUIRED_MESSAGE: "The imported contract needs an auction event before automatic lot numbers can be assigned. Ask the auction team to check its event.",
  recoverInitialAuctioneerEventIdentity: mocks.event,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ headR2Object: mocks.head, resolvePersistedR2StorageTarget: ({ r2Bucket }: any) => ({ bucketName: r2Bucket || "legacy-fixture" }) }));
vi.mock("../src/utils/reportJobMongoQueue.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  mocks.ensureReal = actual.ensureReportJobOutbox;
  return { ...actual, ensureReportJobOutbox: mocks.ensure, shouldUseMongoReportQueue: mocks.queue };
});
import Asset from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import { AUCTIONEER_EVENT_REQUIRED_MESSAGE } from "../src/service/auctioneerEventResolutionService.js";
import { retryInitialAuctioneerPreview as retry, verifyInitialAuctioneerRetrySources as verifySources } from "../src/service/auctioneerInitialPreviewRetryService.js";
import { createMongoReportJob } from "../src/utils/reportJobMongoQueue.js";

type Kind = "asset" | "lotListing";
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await ReportJob.createIndexes();
  vi.clearAllMocks();
  mocks.queue.mockReturnValue(true);
  mocks.event.mockImplementation(async ({ assertOwned }) => { await assertOwned(); return { eventId: "event-1", contractId: "contract-1" }; });
  mocks.head.mockResolvedValue({ size: 100 });
  mocks.ensure.mockImplementation(mocks.ensureReal);
});

async function seed(kind: Kind = "asset", overrides: any = {}) {
  const Model = kind === "asset" ? Asset : LotListing;
  const reportId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const workId = new mongoose.Types.ObjectId();
  const original = { r2Key: "uploads/session/first.jpg", r2Bucket: "fixture", r2PublicUrl: "https://fixture.test/first.jpg", size: 100,
    role: "main", lotIndex: 0, imageIndex: 0, originalOrder: 0, captureOrder: 0, originalname: "first.jpg", mimetype: "image/jpeg" };
  const photos = [original, { ...original, r2Key: "uploads/session/last.jpg", imageIndex: 1, originalOrder: 1, role: "extra" }];
  await Model.collection.insertOne({ _id: reportId, user: userId, auctioneerWorkItem: workId, status: "error", job_status: "error",
    job_error: AUCTIONEER_EVENT_REQUIRED_MESSAGE, job_id: `original-${reportId}`, updatedAt: new Date(),
    contract_no: "93530", imageUrls: photos.map((f) => f.r2PublicUrl), videoUrls: [],
    lots: [{ lot_id: "original-lot", lot_number: "1", image_indexes: [0, 1], cover_index: 1 }], ...overrides });
  const payload = { [kind === "asset" ? "reportId" : "listingId"]: String(reportId), user: { id: String(userId), email: "fixture@example.test" },
    progressId: `original-${reportId}`, images: photos, videos: [],
    details: { contract_no: "93530", client_submission_id: "same-submission", upload_session_id: "same-session", watermark_images: false,
      mixed_lots: [{ count: 1, extra_count: 1, mode: "Bundle", cover_index: 0 }], notes: "Retain original input." } };
  const sourceJob = await ReportJob.create({ type: kind === "asset" ? "asset-preview" : "lot-listing-preview", status: "failed",
    reportId: String(reportId), progressId: payload.progressId, targetStatus: "preview", payload,
    attempts: 3, maxAttempts: 3, lastError: AUCTIONEER_EVENT_REQUIRED_MESSAGE });
  return { Model, reportId, userId, workId, sourceJob, payload, kind };
}
const run = (fixture: Awaited<ReturnType<typeof seed>>, options: any = {}) => retry({ reportType: fixture.kind,
  reportId: fixture.reportId, userId: fixture.userId, hasIncomingEdits: false, ...options });
const read = (fixture: Awaited<ReturnType<typeof seed>>) => fixture.Model.findById(fixture.reportId).select("+report_job_outbox +report_recovery +report_recovery_history").lean();

describe.sequential("manual Auctioneer missing-event initial preview retry", () => {
  it.each(["asset", "lotListing"] as const)("requeues %s original source on the same report, without files, submission or numbering changes", async (kind) => {
    const fixture = await seed(kind);
    const before: any = await read(fixture);
    const result = await run(fixture);
    expect(result?.data).toMatchObject({ reportId: String(fixture.reportId), reportType: kind, job_status: "queued", retry_stage: "initial_preview", downloadable: false });
    const after: any = await read(fixture);
    expect(after.status).toBe("processing");
    expect(after.generation_target_status).toBe("preview");
    for (const field of ["_id", "user", "auctioneerWorkItem", "contract_no", "lots", "imageUrls", "videoUrls"]) expect(after[field]).toEqual(before[field]);
    expect(after.preview_submitted_at).toBeUndefined();
    expect(after.approval_requested_at).toBeUndefined();
    const job = await ReportJob.findOne({ progressId: after.job_id }).lean();
    expect(job?.targetStatus).toBe("preview");
    expect(job?.maxAttempts).toBe(1);
    expect(job?.payload).toMatchObject({ ...fixture.payload, progressId: after.job_id });
    expect(job?.payload.images).toEqual(fixture.payload.images);
    expect(job?.payload.details).toEqual(fixture.payload.details);
    expect((await ReportJob.findById(fixture.sourceJob._id).lean())?.payload).toEqual(fixture.payload);
    expect(await fixture.Model.countDocuments()).toBe(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(mocks.head).not.toHaveBeenCalled();
  });
  it("retains a failed Lot default preview shell but does not treat it as reviewed", async () => {
    const fixture = await seed("lotListing", { preview_data: { include_damage_analysis: true, bank_photos_enabled: false, valuation_methods: ["FML"], lots: [] } });
    expect((await run(fixture))?.data.retry_stage).toBe("initial_preview");
  });
  it("keeps uncertain outbox acceptance and exact retry on one immutable attempt", async () => {
    const fixture = await seed();
    mocks.ensure.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const first = await run(fixture);
    expect((await read(fixture) as any).report_job_outbox).toBeDefined();
    const second = await run(fixture);
    expect(second?.data.job_id).toBe(first?.data.job_id);
    expect(await ReportJob.countDocuments({ status: "queued" })).toBe(1);
    expect((await read(fixture) as any).report_recovery_history).toHaveLength(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });
  it("a delayed outbox sweep cannot revive the one-attempt initial retry after terminal failure", async () => {
    const fixture = await seed();
    mocks.ensure.mockImplementationOnce(async () => {
      const report: any = await read(fixture);
      await createMongoReportJob(report.report_job_outbox);
      throw new Error("Accepted queue write but outbox-clear response was lost");
    });
    const accepted = await run(fixture);
    const queued = await ReportJob.findOne({ progressId: accepted!.data.job_id });
    await ReportJob.updateOne({ _id: queued!._id }, { $set: { status: "failed", attempts: 1, lastError: "Source unavailable" }, $unset: { dedupeKey: 1 } });
    await fixture.Model.updateOne({ _id: fixture.reportId }, { $set: { status: "error", job_status: "error", job_error: "Source unavailable" } });
    const result = await mocks.ensureReal(fixture.kind, String(fixture.reportId), accepted!.data.job_id);
    expect(String(result._id)).toBe(String(queued!._id));
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect((await read(fixture) as any).report_job_outbox).toBeUndefined();
    expect((await read(fixture) as any).job_status).toBe("error");
    expect(await ReportJob.countDocuments()).toBe(2);
    await expect(run(fixture)).rejects.toMatchObject({ code: "AUCTIONEER_INITIAL_RETRY_INCOMPLETE" });
  });
  it("ordinary initial jobs retain their existing failed-outbox revival behavior", async () => {
    const fixture = await seed();
    const input = { type: "asset-preview" as const, reportId: String(fixture.reportId), progressId: "ordinary-initial",
      idempotencyKey: "ordinary-initial", targetStatus: "preview" as const, maxAttempts: 1, payload: fixture.payload };
    const job = await createMongoReportJob(input);
    await ReportJob.updateOne({ _id: job!._id }, { $set: { status: "failed", attempts: 1 }, $unset: { dedupeKey: 1 } });
    const replay = await createMongoReportJob(input);
    expect(String(replay!._id)).toBe(String(job!._id));
    expect(replay!.status).toBe("queued");
    expect(replay!.attempts).toBe(0);
  });
  it("a delayed empty Retry after preview completion never submits files", async () => {
    const fixture = await seed("lotListing");
    await run(fixture);
    await fixture.Model.updateOne({ _id: fixture.reportId }, { $set: { status: "preview", job_status: "done", preview_data: { lots: [{ title: "Now ready" }] } } });
    expect((await run(fixture))?.data.preview_available).toBe(true);
    expect(await ReportJob.countDocuments()).toBe(2);
    expect((await read(fixture) as any).preview_submitted_at).toBeUndefined();
    expect(await run(fixture, { hasIncomingEdits: true })).toBeNull();
  });
  it.each(["asset", "lotListing"] as const)("a subsequent %s source/analysis failure never promotes intake rows to submitted files", async (kind) => {
    const fixture = await seed(kind);
    await run(fixture);
    await fixture.Model.updateOne({ _id: fixture.reportId }, { $set: { status: "error", job_status: "error", job_error: "Source unavailable" } });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_INITIAL_RETRY_INCOMPLETE" });
    await expect(run(fixture, { hasIncomingEdits: true })).rejects.toMatchObject({ statusCode: 409, code: "AUCTIONEER_INITIAL_RETRY_INCOMPLETE" });
    expect(await ReportJob.countDocuments()).toBe(2);
    expect((await read(fixture) as any).preview_submitted_at).toBeUndefined();
    await fixture.Model.updateOne({ _id: fixture.reportId }, { $set: { preview_data: { lots: [{ title: "Real saved preview" }] } } });
    expect(await run(fixture)).toBeNull();
  });
  it("concurrent clicks queue at most one new initial attempt", async () => {
    const fixture = await seed();
    const results = await Promise.allSettled([run(fixture), run(fixture), run(fixture)]);
    expect(results.some((item) => item.status === "fulfilled")).toBe(true);
    expect(await ReportJob.countDocuments({ status: "queued" })).toBe(1);
    expect((await read(fixture) as any).report_recovery_history).toHaveLength(1);
  });
  it.each([
    { job_error: "Unrelated failure" }, { status: "preview", job_status: "done" },
    { preview_data: { lots: [] } }, { preview_data: { lots: [{ title: "Edited" }] } },
    { preview_submitted_at: new Date() }, { approval_requested_at: new Date() }, { released_at: new Date() },
    { preview_files: { xlsx: "https://fixture.test/saved.xlsx" } },
  ])("leaves saved/submitted/unrelated state to the existing workflow %j", async (overrides) => {
    const fixture = await seed("asset", overrides);
    expect(await run(fixture)).toBeNull();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(1);
  });
  it.each([{ adminArchivedAt: new Date() }, { is_draft_preview: true }, { files_generating: true }, { report_recovery: { manualReviewRequired: true } }])("rejects protected state %j", async (overrides) => {
    const fixture = await seed("asset", overrides);
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("does not expose another owner's retained data or accept new edits", async () => {
    const fixture = await seed();
    expect(await run(fixture, { userId: new mongoose.Types.ObjectId() })).toBeNull();
    await expect(run(fixture, { hasIncomingEdits: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each(["missing", "local", "changed-owner", "wrong-kind", "active", "cancelled"])("does not revive unusable source job: %s", async (state) => {
    const fixture = await seed();
    if (state === "missing") await ReportJob.deleteOne({ _id: fixture.sourceJob._id });
    else if (state === "local") await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { "payload.images": [{ path: "/removed/original.jpg", size: 100 }] } });
    else if (state === "changed-owner") await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { "payload.user.id": String(new mongoose.Types.ObjectId()) } });
    else if (state === "wrong-kind") await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { type: "asset-preview-files" } });
    else await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { status: state === "active" ? "processing" : "cancelled" } });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("event preflight rejection preserves the error and does not queue analysis", async () => {
    const fixture = await seed();
    mocks.event.mockRejectedValueOnce(Object.assign(new Error(AUCTIONEER_EVENT_REQUIRED_MESSAGE), { statusCode: 409, code: "auctioneer_lot_event_required" }));
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "auctioneer_lot_event_required" });
    expect((await read(fixture) as any).job_id).toBe(fixture.payload.progressId);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("a concurrent saved edit defeats the claim even with the same updatedAt", async () => {
    const fixture = await seed();
    mocks.event.mockImplementationOnce(async () => {
      await fixture.Model.collection.updateOne({ _id: fixture.reportId }, { $set: { lots: [{ lot_number: "999", title: "Changed by owner" }] } });
      return { eventId: "event-1", contractId: "contract-1" };
    });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("a reassignment during preflight cannot queue the former owner's payload", async () => {
    const fixture = await seed();
    mocks.event.mockImplementationOnce(async () => { await fixture.Model.updateOne({ _id: fixture.reportId }, { user: new mongoose.Types.ObjectId() }); });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it.each(["asset", "lotListing"] as const)("existing owner %s resubmit HTTP route returns the initial-preview receipt and safe event error", async (kind) => {
    const fixture = await seed(kind);
    const handler = kind === "asset" ? (await import("../src/controller/asset.controller.js")).resubmitReport
      : (await import("../src/controller/lotListing.controller.js")).resubmitLotListing;
    const app = express();
    app.use(express.json());
    app.post("/api/report/:id/resubmit", (req: any, res) => { req.userId = String(fixture.userId); return handler(req, res); });
    mocks.event.mockRejectedValueOnce(Object.assign(new Error(AUCTIONEER_EVENT_REQUIRED_MESSAGE), { statusCode: 409, code: "auctioneer_lot_event_required" }));
    const failed = await request(app).post(`/api/report/${fixture.reportId}/resubmit`).send({});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ code: "auctioneer_lot_event_required", message: AUCTIONEER_EVENT_REQUIRED_MESSAGE });
    expect(await ReportJob.countDocuments()).toBe(1);
    const accepted = await request(app).post(`/api/report/${fixture.reportId}/resubmit`).send({});
    expect(accepted.status).toBe(202);
    expect(accepted.body.data).toMatchObject({ reportId: String(fixture.reportId), reportType: kind,
      retry_stage: "initial_preview", job_status: "queued", downloadable: false });
    expect(await ReportJob.countDocuments()).toBe(2);
  });
});

describe.sequential("retained source worker preflight", () => {
  const context = () => ({ assertOwned: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal } as any);
  it("leaves ordinary initial jobs untouched", async () => {
    await verifySources({ payload: {} } as any, context());
    expect(mocks.head).not.toHaveBeenCalled();
  });
  it("checks every object before work with four bounded requests and no image reads/copies", async () => {
    const fixture = await seed();
    await run(fixture);
    const job = await ReportJob.findOne({ status: "queued" });
    const photos = Array.from({ length: 31 }, (_, index) => ({ ...fixture.payload.images[0], r2Key: `photo-${index}` }));
    job!.payload.images = photos;
    let active = 0, max = 0;
    mocks.head.mockImplementation(async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 2)); active--; return { size: 100 }; });
    await verifySources(job!, context());
    expect(mocks.head).toHaveBeenCalledTimes(31);
    expect(max).toBe(4);
    expect(job!.payload.images).toEqual(photos);
  });
  it.each(["missing", "size"])("fails before analysis when original is %s", async (failure) => {
    const fixture = await seed(); await run(fixture);
    const job = await ReportJob.findOne({ status: "queued" });
    if (failure === "missing") mocks.head.mockRejectedValueOnce(new Error("No such object"));
    else mocks.head.mockResolvedValueOnce({ size: 99 });
    await expect(verifySources(job!, context())).rejects.toMatchObject({ code: "AUCTIONEER_INITIAL_RETRY_SOURCE_UNAVAILABLE" });
  });
  it("stops scheduling reads after parent ownership is lost", async () => {
    const fixture = await seed(); await run(fixture);
    const job = await ReportJob.findOne({ status: "queued" });
    await fixture.Model.updateOne({ _id: fixture.reportId }, { $set: { job_id: "newer-attempt" } });
    await expect(verifySources(job!, context())).rejects.toMatchObject({ code: "AUCTIONEER_INITIAL_RETRY_CONFLICT" });
    expect(mocks.head).not.toHaveBeenCalled();
  });
});
