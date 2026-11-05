/**
 * Retry of a failed first preview from the photos the server kept
 * (owner, 2026-11-05).
 *
 * Colin Kostenuk's "Dustin Hawkins" Asset report stopped on "Duplicate lot
 * number 1" with no preview and no draft; Retry answered "Cannot resubmit
 * report with status: error". The failed job still names every uploaded photo
 * in R2, so the same report is queued again from those photos.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
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
import ReportDraft from "../src/models/reportDraft.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import {
  MAX_SOURCE_RETRIES,
  retryInitialAuctioneerPreview as retry,
  verifyInitialAuctioneerRetrySources as verifySources,
} from "../src/service/auctioneerInitialPreviewRetryService.js";
import { createMongoReportJob } from "../src/utils/reportJobMongoQueue.js";

type Kind = "asset" | "lotListing";
const DUPLICATE = "Duplicate lot number 1. Original photos are retained. Review the capture lot numbers before retrying; no lots have been renumbered.";
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await ReportJob.createIndexes();
  vi.clearAllMocks();
  mocks.queue.mockReturnValue(true);
  mocks.head.mockResolvedValue({ size: 100 });
  mocks.ensure.mockImplementation(mocks.ensureReal);
});

/** A failed first preview with no saved preview, no work item, its photos in R2. */
async function seed(kind: Kind = "asset", overrides: any = {}) {
  const Model = kind === "asset" ? Asset : LotListing;
  const reportId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const photo = { r2Key: "uploads/session/first.jpg", r2Bucket: "fixture", r2PublicUrl: "https://fixture.test/first.jpg", size: 100,
    role: "main", lotIndex: 0, imageIndex: 0, originalOrder: 0, captureOrder: 0, originalname: "first.jpg", mimetype: "image/jpeg" };
  const photos = [photo, { ...photo, r2Key: "uploads/session/second.jpg", lotIndex: 1, imageIndex: 0, originalOrder: 1, captureOrder: 1 }];
  await Model.collection.insertOne({ _id: reportId, user: userId, status: "error", job_status: "error",
    job_error: DUPLICATE, job_id: `original-${reportId}`, updatedAt: new Date(), contract_no: "95200",
    imageUrls: photos.map((f) => f.r2PublicUrl), videoUrls: [], ...overrides });
  const payload = { [kind === "asset" ? "reportId" : "listingId"]: String(reportId), user: { id: String(userId), email: "fixture@example.test" },
    progressId: `original-${reportId}`, images: photos, videos: [],
    details: { contract_no: "95200", client_submission_id: "colin-submission", upload_session_id: "session-1", grouping_mode: "mixed" } };
  const sourceJob = await ReportJob.create({ type: kind === "asset" ? "asset-preview" : "lot-listing-preview", status: "failed",
    reportId: String(reportId), progressId: payload.progressId, targetStatus: "preview", payload,
    attempts: 2, maxAttempts: 2, lastError: DUPLICATE });
  await ReportUploadSession.collection.insertOne({ user: userId, type: kind, clientSubmissionId: "colin-submission",
    reportId: String(reportId), jobId: payload.progressId, status: "failed", lastError: DUPLICATE, files: [], updatedAt: new Date() });
  return { Model, reportId, userId, sourceJob, payload, kind };
}
const run = (fixture: Awaited<ReturnType<typeof seed>>, options: any = {}) => retry({ reportType: fixture.kind,
  reportId: fixture.reportId, userId: fixture.userId, hasIncomingEdits: false, ...options });
const read = (fixture: Awaited<ReturnType<typeof seed>>) => fixture.Model.findById(fixture.reportId)
  .select("+report_job_outbox +report_recovery +report_recovery_history").lean();

describe.sequential("Retry of a failed first preview from the kept photos", () => {
  it.each(["asset", "lotListing"] as const)("queues the same %s report again from its original photos", async (kind) => {
    const fixture = await seed(kind);
    const result = await run(fixture);
    expect(result?.data).toMatchObject({ reportId: String(fixture.reportId), reportType: kind, job_status: "queued",
      retry_stage: "initial_preview", downloadable: false });
    expect(result?.data).not.toHaveProperty("auctioneer_work_item_id");
    const after: any = await read(fixture);
    expect(after.status).toBe("processing");
    expect(after.job_error).toBeUndefined();
    expect(after.job_id).toMatch(/^source-retry-/);
    expect(after.report_recovery_history).toHaveLength(1);
    expect(after.report_recovery_history[0]).toMatchObject({ mode: "owner_failed_preview_retry", previousError: DUPLICATE,
      sourceJobId: String(fixture.sourceJob._id) });
    const job: any = await ReportJob.findOne({ progressId: after.job_id }).lean();
    expect(job).toMatchObject({ type: kind === "asset" ? "asset-preview" : "lot-listing-preview", targetStatus: "preview", maxAttempts: 1 });
    // Exactly the photos that were sent, in order, with their lots and roles.
    expect(job.payload.images.map((file: any) => [file.r2Key, file.lotIndex, file.role]))
      .toEqual(fixture.payload.images.map((file: any) => [file.r2Key, file.lotIndex, file.role]));
    expect(job.payload.failedPreviewRetry).toEqual({ version: 1, originalJobId: String(fixture.sourceJob._id) });
    expect(job.payload.eventIdentityRetry).toBeUndefined();
    // The sweep must not take the photos while the attempt runs.
    expect((await ReportUploadSession.findOne({ reportId: String(fixture.reportId) }).lean())?.status).toBe("queued");
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("a second click answers with the same attempt", async () => {
    const fixture = await seed();
    const first = await run(fixture);
    const second = await run(fixture);
    expect(second?.data.job_id).toBe(first?.data.job_id);
    expect(await ReportJob.countDocuments({ status: "queued" })).toBe(1);
    expect(((await read(fixture)) as any).report_recovery_history).toHaveLength(1);
  });

  it("concurrent clicks queue at most one attempt", async () => {
    const fixture = await seed();
    const results = await Promise.allSettled([run(fixture), run(fixture), run(fixture)]);
    expect(results.some((item) => item.status === "fulfilled")).toBe(true);
    expect(await ReportJob.countDocuments({ status: "queued" })).toBe(1);
  });

  it("a failed Retry is never revived by a delayed outbox sweep", async () => {
    const fixture = await seed();
    const accepted = await run(fixture);
    const queued: any = await ReportJob.findOne({ progressId: accepted!.data.job_id }).lean();
    await ReportJob.updateOne({ _id: queued._id }, { $set: { status: "failed", attempts: 1 }, $unset: { dedupeKey: 1 } });
    const replay = await createMongoReportJob({ type: queued.type, reportId: queued.reportId, progressId: queued.progressId,
      idempotencyKey: queued.idempotencyKey, targetStatus: "preview", maxAttempts: 1, payload: queued.payload });
    expect(replay!.status).toBe("failed");
    expect(replay!.attempts).toBe(1);
  });

  it(`stops after ${MAX_SOURCE_RETRIES} Retries`, async () => {
    const history = Array.from({ length: MAX_SOURCE_RETRIES }, () => ({ mode: "owner_failed_preview_retry" }));
    const fixture = await seed("asset", { report_recovery_history: history });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "PREVIEW_RETRY_LIMIT_REACHED" });
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("says plainly when the photos have been removed by the 7-day sweep", async () => {
    const fixture = await seed();
    await ReportUploadSession.updateOne({ reportId: String(fixture.reportId) }, { $set: { cleanupStartedAt: new Date() } });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "PREVIEW_RETRY_SOURCE_REMOVED" });
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("does not run again when the last attempt already found photos missing", async () => {
    const fixture = await seed("asset", { job_error: "The photos for this report are no longer kept on the server (they are removed 7 days after processing stops). Upload them again as a new report." });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "PREVIEW_RETRY_SOURCE_REMOVED" });
  });

  it.each(["local", "changed-owner", "missing"])("refuses an upload that cannot be re-run as sent: %s", async (state) => {
    const fixture = await seed();
    if (state === "missing") await ReportJob.deleteOne({ _id: fixture.sourceJob._id });
    else if (state === "local") await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { "payload.images": [{ path: "/tmp/original.jpg", size: 100 }] } });
    else await ReportJob.updateOne({ _id: fixture.sourceJob._id }, { $set: { "payload.user.id": String(new mongoose.Types.ObjectId()) } });
    await expect(run(fixture)).rejects.toMatchObject({ statusCode: 409, code: "PREVIEW_RETRY_SOURCE_UNAVAILABLE" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it.each([
    { preview_data: { lots: [{ title: "Saved preview" }] } }, { status: "preview", job_status: "done" },
    { preview_submitted_at: new Date() }, { preview_files: { xlsx: "https://fixture.test/saved.xlsx" } },
  ])("leaves a report with a preview or files to the ordinary resubmit %j", async (overrides) => {
    const fixture = await seed("asset", overrides);
    expect(await run(fixture)).toBeNull();
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("an edit sent to a report without a preview keeps the ordinary answer", async () => {
    const fixture = await seed();
    expect(await run(fixture, { hasIncomingEdits: true })).toBeNull();
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("another user's report is never retried", async () => {
    const fixture = await seed();
    expect(await run(fixture, { userId: new mongoose.Types.ObjectId() })).toBeNull();
  });

  it("a draft kept from the report hides again while the Retry runs", async () => {
    const fixture = await seed();
    await ReportDraft.create({ user: fixture.userId, type: fixture.kind, clientDraftId: "colin-draft", title: "Dustin Hawkins",
      submittedReportId: fixture.reportId, submittedReportType: fixture.kind, submissionStatus: "failed", submissionError: DUPLICATE });
    await run(fixture);
    const draft: any = await ReportDraft.findOne({ clientDraftId: "colin-draft" }).lean();
    expect(draft.submissionStatus).toBe("processing");
    expect(draft.submissionError).toBeNull();
  });

  it("the worker checks every kept photo before the paid analysis, without the Auctioneer event repair", async () => {
    const fixture = await seed();
    const accepted = await run(fixture);
    const job: any = await ReportJob.findOne({ progressId: accepted!.data.job_id }).lean();
    const context = { assertOwned: vi.fn(async () => undefined) } as any;
    await verifySources(job, context);
    expect(mocks.head).toHaveBeenCalledTimes(2);
    expect(mocks.event).not.toHaveBeenCalled();
    mocks.head.mockReset().mockResolvedValueOnce({ size: 100 }).mockRejectedValueOnce(new Error("NoSuchKey"));
    await expect(verifySources(job, context)).rejects.toMatchObject({ code: "PREVIEW_RETRY_SOURCE_REMOVED" });
  });
});
