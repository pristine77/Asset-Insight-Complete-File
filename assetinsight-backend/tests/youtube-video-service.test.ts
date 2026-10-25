import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connection: vi.fn(), assertConnection: vi.fn(), access: vi.fn(), head: vi.fn(), range: vi.fn(), resolve: vi.fn(), start: vi.fn(), check: vi.fn(), send: vi.fn(), publish: vi.fn(), states: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/service/youtubeConnectionService.js", () => ({
  getYoutubeConnection: mocks.connection, assertYoutubeConnection: mocks.assertConnection, getYoutubeAccessToken: mocks.access,
  encryptYoutubeSecret: (value: string, context: string) => JSON.stringify([context, value]),
  decryptYoutubeSecret: (cipher: string, context: string) => { const [saved, value] = JSON.parse(cipher); if (saved !== context) throw new Error("Wrong encryption context"); return value; },
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ headR2Object: mocks.head, readR2ObjectRange: mocks.range, resolveR2ObjectLocationFromUrl: mocks.resolve }));
vi.mock("../src/service/youtubeVideoClient.js", async (original) => ({ ...await original<typeof import("../src/service/youtubeVideoClient.js")>(), startYoutubeUpload: mocks.start, checkYoutubeUpload: mocks.check, sendYoutubeChunk: mocks.send, publishYoutubeVideo: mocks.publish, readYoutubeVideoStates: mocks.states }));
vi.mock("../src/utils/reportImageDeletionPlugin.js", () => ({ attachReportImageDeletionHooks: vi.fn() }));
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import { YoutubeProviderError } from "../src/service/youtubeVideoClient.js";
import { attachYoutubeSubmission, authorizeAutomaticYoutubeVideos, prepareReportYoutubeVideos, publishReleasedYoutubeVideos, readReportYoutubeLinks, refreshYoutubeVideoMetadata, uploadReviewedYoutubeVideos } from "../src/service/youtubeVideoService.js";
import { reviewAdminYoutubeVideo, retryAdminYoutubePublication } from "../src/controller/youtubeVideos.controller.js";
import { youtubeVideoIdentity, YOUTUBE_CHUNK_BYTES } from "../src/service/youtubeVideoPolicy.js";
const source = "https://assetinsight.test/video-one.mp4";
const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=isolated-session";
const videoId = "AbCdEfGhI_1";
const url = `https://www.youtube.com/watch?v=${videoId}`;
const connection = { channelId: "channel-1", revision: 2 };
const ownerId = new mongoose.Types.ObjectId("64b000000000000000000001");
const adminId = new mongoose.Types.ObjectId();
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create({ binary: { checkMD5: false } }); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.connection.mockResolvedValue(connection); mocks.assertConnection.mockResolvedValue(connection); mocks.access.mockResolvedValue("isolated-access-token");
  mocks.resolve.mockImplementation((value: string) => value.startsWith("https://assetinsight.test/") ? { bucketName: "isolated", key: value.split("/").at(-1) } : undefined);
  mocks.head.mockResolvedValue({ size: 4, etag: "isolated-etag", contentType: "video/mp4" }); mocks.range.mockResolvedValue(Buffer.from("clip"));
  mocks.start.mockResolvedValue(session); mocks.send.mockResolvedValue({ videoId, url }); mocks.check.mockResolvedValue({ videoId, url });
  mocks.publish.mockImplementation(async (_a, _b, _c, authorize) => { await authorize(); return true; });
  mocks.states.mockResolvedValue(new Map([[videoId, "unlisted"]]));
});
async function fixture(overrides: Record<string, any> = {}, reportType: "asset" | "lotListing" = "asset") {
  const model = reportType === "asset" ? AssetReport : LotListing; const reportId = new mongoose.Types.ObjectId();
  const lots = [{ lot_id: "lot-1", lot_number: "010", title: "Reviewed loader", description: "Reviewed description", video_urls: [source] }];
  const report: any = { _id: reportId, user: ownerId, videoUrls: [source], lots, preview_data: { lots }, youtube_videos_enabled: true,
    youtube_submission: { generationToken: "files-1", uploadGenerationToken: "files-1", channelId: connection.channelId, connectionRevision: connection.revision, ownerId: String(ownerId) },
    job_id: "files-1", job_status: "processing", status: "pending_approval", release_status: "pending_release", ...overrides };
  await model.collection.insertOne(report);
  const input = { reportType, reportId: String(reportId), generationToken: "files-1", enabled: true, lots: report.preview_data.lots, assertOwned: vi.fn().mockResolvedValue(undefined) };
  return { report, model, input, id: youtubeVideoIdentity(reportType, String(reportId), source, connection.channelId) };
}
async function review(f: Awaited<ReturnType<typeof fixture>>, privacyStatus = "private", changes: Record<string, any> = {}) {
  const receipt = await YoutubeVideo.findById(f.id).lean();
  const res: any = { code: 200, setHeader: vi.fn(), status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
  await reviewAdminYoutubeVideo({ params: { id: f.id }, query: {}, userId: String(adminId), body: { updatedAt: receipt!.updatedAt.toISOString(), title: "Exact reviewed title", description: "Exact reviewed\ndescription", privacyStatus, policyConsent: true, ...changes } } as any, res); return res;
}
async function prepareAutomatically(f: Awaited<ReturnType<typeof fixture>>) {
  await prepareReportYoutubeVideos(f.input); await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_status: "done" } });
  await authorizeAutomaticYoutubeVideos();
  const receipt = await YoutubeVideo.findById(f.id).select("+publicationToken").lean();
  expect(receipt).toMatchObject({ status: "uploading", privacyStatus: "public", publicationToken: expect.any(String) });
  expect(receipt!.reviewedBy).toBeUndefined();
}
async function retryReady(id: string) { await YoutubeVideo.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } }); }
async function retryAutomatic(id: string) {
  const receipt = await YoutubeVideo.findById(id).lean();
  const res: any = { code: 200, setHeader: vi.fn(), status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
  await retryAdminYoutubePublication({ params: { id }, query: {}, userId: String(adminId), body: { updatedAt: receipt!.updatedAt.toISOString() } } as any, res);
  expect(res.code, JSON.stringify(res.body)).toBe(202);
}
describe.sequential("automatic-public YouTube receipt lifecycle", () => {
  it.each(["asset", "lotListing"] as const)("%s report files prepare queued videos without provider work or waiting", async (type) => {
    const f = await fixture({}, type); expect(await prepareReportYoutubeVideos(f.input)).toEqual(new Map());
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "queued", title: "Lot 010 — Reviewed loader" });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); expect(await publishReleasedYoutubeVideos()).toBe(0);
    for (const mock of [mocks.head, mocks.range, mocks.start, mocks.send, mocks.publish]) expect(mock).not.toHaveBeenCalled();
    expect(await f.model.findById(f.report._id).lean()).toMatchObject({ status: "pending_approval", job_status: "processing", videoUrls: [source] });
  });
  it.each(["asset", "lotListing"] as const)("%s automatic bytes upload once after persisting the session", async (type) => {
    const f = await fixture({}, type); await prepareAutomatically(f);
    mocks.send.mockImplementationOnce(async () => { expect(await YoutubeVideo.findById(f.id).select("+sessionCipher").lean()).toMatchObject({ finalChunkAttempted: true, sessionCipher: JSON.stringify([`upload:${f.id}`, session]) }); return { videoId, url }; });
    await uploadReviewedYoutubeVideos(); await uploadReviewedYoutubeVideos();
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("isolated-access-token", { title: "Lot 010 — Reviewed loader", description: "Lot 010 — Reviewed loader\n\nReviewed description" }, 4, "video/mp4"); expect(mocks.send).toHaveBeenCalledOnce();
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map([[source, url]]));
    const receipt = await YoutubeVideo.findById(f.id).select("+sessionCipher +leaseToken").lean();
    expect(receipt).toMatchObject({ status: "private", videoId, offset: 4 }); expect(receipt!.sessionCipher).toBeUndefined(); expect(receipt!.leaseToken).toBeUndefined();
  });
  it.each(["private", "unlisted", "public"])("replaces old %s target with automatic public while retaining report release gates", async (privacy) => {
    const f = await fixture(); await prepareReportYoutubeVideos(f.input);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "pending_review", privacyStatus: privacy } });
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_status: "done" } });
    await uploadReviewedYoutubeVideos(); expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(mocks.publish).not.toHaveBeenCalled();
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { status: "approved", release_status: "released" } });
    await retryReady(f.id); expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(mocks.publish.mock.calls.at(-1)![5]).toBe("public"); expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "public", privacyStatus: "public", visibilityPending: false });
  });
  it("lost final responses query the same session without uploading again", async () => {
    const f = await fixture(); await prepareAutomatically(f); mocks.send.mockRejectedValueOnce(new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", "Uncertain final response"));
    await uploadReviewedYoutubeVideos(); expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ finalChunkAttempted: true, status: "uploading" }); await retryReady(f.id); await uploadReviewedYoutubeVideos();
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith("isolated-access-token", session, 4); expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("legacy pending partial transfers retain their attempts and resume only the same saved session", async () => {
    mocks.check.mockResolvedValue({ offset: 2 }); mocks.range.mockResolvedValue(Buffer.from("ip"));
    for (const status of ["pending_review", "queued"]) {
      const f = await fixture(); await prepareReportYoutubeVideos(f.input);
      await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_status: "done" } });
      const cipher = JSON.stringify([`upload:${f.id}`, session]);
      await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status, sourceSize: 4, sourceEtag: "isolated-etag",
        sessionCipher: cipher, offset: 2, uploadAttempts: 2, lastError: "Earlier connection interruption", lastErrorCode: "YOUTUBE_TRANSPORT_TIMEOUT" } });
      await authorizeAutomaticYoutubeVideos();
      expect(await YoutubeVideo.findById(f.id).select("+sessionCipher").lean()).toMatchObject({ status: "uploading", sessionCipher: cipher,
        offset: 2, uploadAttempts: 2, lastError: "Earlier connection interruption", lastErrorCode: "YOUTUBE_TRANSPORT_TIMEOUT" });
      expect(await uploadReviewedYoutubeVideos()).toBe(1);
      expect(mocks.check).toHaveBeenLastCalledWith("isolated-access-token", session, 4);
      expect(mocks.range).toHaveBeenLastCalledWith("isolated", "video-one.mp4", 2, 2, "isolated-etag");
      expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "private", videoId, uploadAttempts: 3 });
    }
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("legacy pending final-byte uncertainty without a session never starts a replacement", async () => {
    const f = await fixture(); await prepareReportYoutubeVideos(f.input);
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_status: "done" } });
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "pending_review", finalChunkAttempted: true, uploadAttempts: 2,
      lastError: "Final response unknown", lastErrorCode: "YOUTUBE_TRANSPORT_UNCERTAIN" } });
    expect(await uploadReviewedYoutubeVideos()).toBe(0);
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", finalChunkAttempted: true,
      uploadAttempts: 3, lastErrorCode: "YOUTUBE_RECONCILIATION_REQUIRED" });
    for (const mock of [mocks.start, mocks.check, mocks.send, mocks.range]) expect(mock).not.toHaveBeenCalled();
  });
  it("expired final responses quarantine despite legacy review or explicit same-session retry", async () => {
    const f = await fixture(); await prepareAutomatically(f); mocks.send.mockRejectedValueOnce(new Error("lost final")); await uploadReviewedYoutubeVideos();
    mocks.check.mockRejectedValue(new YoutubeProviderError("requestFailed", "expired", 404)); await retryReady(f.id); await uploadReviewedYoutubeVideos();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", finalChunkAttempted: true });
    expect((await review(f)).code).toBe(410); await uploadReviewedYoutubeVideos(); expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention" });
    await retryAutomatic(f.id); await uploadReviewedYoutubeVideos();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", finalChunkAttempted: true, lastErrorCode: "YOUTUBE_RECONCILIATION_REQUIRED" });
  });
  it("explicit retry queries the same saved session and resumes only its acknowledged bytes", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    mocks.head.mockResolvedValue({ size: YOUTUBE_CHUNK_BYTES + 4, etag: "isolated-etag", contentType: "video/mp4" });
    mocks.range.mockImplementation(async (_b, _k, _o, length) => Buffer.alloc(length, 7));
    mocks.send.mockRejectedValueOnce(new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", "Uncertain first chunk"));
    await uploadReviewedYoutubeVideos();
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "needs_attention", uploadAttempts: 5 } });
    const tokenBefore = (await YoutubeVideo.findById(f.id).select("+publicationToken").lean())!.publicationToken;
    mocks.check.mockResolvedValueOnce({ offset: YOUTUBE_CHUNK_BYTES });
    await retryAutomatic(f.id); expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.check).toHaveBeenCalledExactlyOnceWith("isolated-access-token", session, YOUTUBE_CHUNK_BYTES + 4);
    expect(mocks.send.mock.calls.map((call) => [call[3], call[4].length])).toEqual([[0, YOUTUBE_CHUNK_BYTES], [YOUTUBE_CHUNK_BYTES, 4]]);
    expect((await YoutubeVideo.findById(f.id).select("+publicationToken").lean())!.publicationToken).toBe(tokenBefore);
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ videoId, status: "private", lastError: "", lastErrorCode: "" });
  });
  it("may replace an expired session only when no final chunk was attempted", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    mocks.head.mockResolvedValue({ size: YOUTUBE_CHUNK_BYTES + 4, etag: "isolated-etag", contentType: "video/mp4" });
    mocks.range.mockImplementation(async (_b, _k, _o, length) => Buffer.alloc(length, 7));
    mocks.send.mockRejectedValueOnce(new YoutubeProviderError("YOUTUBE_TRANSPORT_TIMEOUT", "Connection timed out"));
    await uploadReviewedYoutubeVideos();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ finalChunkAttempted: false, lastErrorCode: "YOUTUBE_TRANSPORT_TIMEOUT" });
    mocks.check.mockRejectedValueOnce(new YoutubeProviderError("requestFailed", "expired", 404));
    mocks.send.mockResolvedValueOnce({ offset: YOUTUBE_CHUNK_BYTES });
    await retryAutomatic(f.id); expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(mocks.start).toHaveBeenCalledTimes(2); expect(mocks.check).toHaveBeenCalledOnce();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ videoId, status: "private" });
  });
  it("never creates a replacement when final bytes may have been sent but the session is missing", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "needs_attention", finalChunkAttempted: true, uploadAttempts: 5 }, $unset: { sessionCipher: 1 } });
    await retryAutomatic(f.id); expect(await uploadReviewedYoutubeVideos()).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", finalChunkAttempted: true, lastErrorCode: "YOUTUBE_RECONCILIATION_REQUIRED" });
  });
  it("streams exact bounded chunks and resumes the confirmed offset", async () => {
    const f = await fixture(); await prepareAutomatically(f); mocks.head.mockResolvedValue({ size: YOUTUBE_CHUNK_BYTES + 4, etag: "isolated-etag", contentType: "video/quicktime" });
    mocks.range.mockImplementation(async (_b, _k, _o, length) => Buffer.alloc(length, 7)); mocks.send.mockResolvedValueOnce({ offset: YOUTUBE_CHUNK_BYTES }).mockRejectedValueOnce(new Error("lost final"));
    await uploadReviewedYoutubeVideos(); mocks.check.mockResolvedValueOnce({ offset: YOUTUBE_CHUNK_BYTES }); await retryReady(f.id); await uploadReviewedYoutubeVideos();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send.mock.calls.map((call) => [call[3], call[4].length, call[5]])).toEqual([[0, YOUTUBE_CHUNK_BYTES, "video/quicktime"], [YOUTUBE_CHUNK_BYTES, 4, "video/quicktime"], [YOUTUBE_CHUNK_BYTES, 4, "video/quicktime"]]);
  });
  it("rejects changed original ETags without replacement uploads", async () => {
    const f = await fixture(); await prepareAutomatically(f); mocks.send.mockRejectedValueOnce(new Error("lost final")); await uploadReviewedYoutubeVideos();
    mocks.head.mockResolvedValue({ size: 4, etag: "changed", contentType: "video/mp4" }); await retryReady(f.id); await uploadReviewedYoutubeVideos();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.check).not.toHaveBeenCalled(); expect((await YoutubeVideo.findById(f.id).lean())!.lastError).toContain("source changed");
  });
  it.each(["owner", "generation", "source", "connection", "removal"])("fences %s changes before sending bytes", async (change) => {
    const f = await fixture(); await prepareAutomatically(f); mocks.range.mockImplementationOnce(async () => {
      if (change === "owner") await f.model.collection.updateOne({ _id: f.report._id }, { $set: { user: new mongoose.Types.ObjectId() } });
      if (change === "generation") await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_id: "new-generation" } });
      if (change === "source") await f.model.collection.updateOne({ _id: f.report._id }, { $set: { videoUrls: [] } });
      if (change === "connection") mocks.assertConnection.mockRejectedValue(new Error("revoked"));
      if (change === "removal") await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { status: "data_removed" }, $unset: { sourceUrl: 1, publicationToken: 1, leaseToken: 1 } }); return Buffer.from("clip");
    }); await uploadReviewedYoutubeVideos(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not resurrect redacted data from in-flight completion or report preparation", async () => {
    const f = await fixture(); await prepareAutomatically(f); mocks.send.mockImplementationOnce(async () => { await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { status: "data_removed" }, $unset: { sourceUrl: 1, publicationToken: 1, leaseToken: 1, sessionCipher: 1 } }); return { videoId, url }; });
    await uploadReviewedYoutubeVideos(); await prepareReportYoutubeVideos(f.input); const receipt = await YoutubeVideo.findById(f.id).select("+sourceUrl").lean();
    expect(receipt!.status).toBe("data_removed"); expect(receipt!.sourceUrl).toBeUndefined(); expect(receipt!.videoId).toBeUndefined(); expect(await readReportYoutubeLinks(f.input)).toEqual(new Map());
  });
  it("new generations invalidate automatic authority without rewriting public metadata", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); await publishReleasedYoutubeVideos();
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_id: "files-2", job_status: "processing", "youtube_submission.generationToken": "files-2", "youtube_submission.uploadGenerationToken": "files-2" } });
    await prepareReportYoutubeVideos({ ...f.input, generationToken: "files-2", lots: [{ ...f.input.lots[0], title: "New report title" }] });
    const receipt = await YoutubeVideo.findById(f.id).select("+publicationToken").lean(); expect(receipt).toMatchObject({ status: "public", title: "Lot 010 — Reviewed loader", generationToken: "files-2" }); expect(receipt!.publicationToken).toBeUndefined();
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("ordinary files carry existing links while invalidating leased publication authority without waiting", async () => {
    const f = await fixture(); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { leaseToken: "running-video-worker", leaseUntil: new Date(Date.now() + 60_000) } });
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { job_id: "artifact-only", job_status: "processing" } });
    expect(await prepareReportYoutubeVideos({ ...f.input, generationToken: "artifact-only", existingUploadsOnly: true })).toEqual(new Map([[source, url]]));
    const receipt = await YoutubeVideo.findById(f.id).select("+publicationToken +leaseToken").lean();
    expect(receipt).toMatchObject({ generationToken: "artifact-only", leaseToken: "running-video-worker", visibilityPending: false }); expect(receipt!.publicationToken).toBeUndefined();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(await publishReleasedYoutubeVideos()).toBe(0);
  });
  it("deprecated manual review cannot change public visibility or metadata", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); await publishReleasedYoutubeVideos();
    const before = await YoutubeVideo.findById(f.id).select("+publicationToken").lean();
    expect((await review(f, "private", { title: "Make private now" })).code).toBe(410); await publishReleasedYoutubeVideos();
    expect(await YoutubeVideo.findById(f.id).select("+publicationToken").lean()).toEqual(before);
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it("legacy uploaded receipts automatically become public without another upload or human review", async () => {
    const f = await fixture({ status: "approved", release_status: "released", job_status: "done" }); await prepareReportYoutubeVideos(f.input);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { videoId, url, status: "private", visibilityPending: true } });
    expect(await publishReleasedYoutubeVideos()).toBe(1); expect(mocks.publish).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
    const receipt = await YoutubeVideo.findById(f.id).select("+publicationToken +reviewToken").lean();
    expect(receipt).toMatchObject({ status: "public", publicationToken: expect.any(String), privacyStatus: "public" });
    expect(receipt!.reviewedBy).toBeUndefined(); expect(receipt!.reviewToken).toBeUndefined();
  });
  it("processes at most two automatic uploads per tick and honours cancellation", async () => {
    for (let i = 0; i < 3; i++) await prepareAutomatically(await fixture()); const signal = new AbortController(); signal.abort(); expect(await uploadReviewedYoutubeVideos(signal.signal)).toBe(0);
    await uploadReviewedYoutubeVideos(); expect(mocks.start).toHaveBeenCalledTimes(2); await uploadReviewedYoutubeVideos(); expect(mocks.start).toHaveBeenCalledTimes(3);
  });
  it("preserves all originals, rejects ambiguous mappings and ignores forged URLs", async () => {
    const f = await fixture({ videoUrls: [source, "https://assetinsight.test/unassigned.mp4"] }); f.input.lots[0].video_urls.push("https://evil.test/forged"); await prepareReportYoutubeVideos(f.input);
    expect(await YoutubeVideo.countDocuments()).toBe(1); expect(mocks.start).not.toHaveBeenCalled(); f.input.lots.push({ ...f.input.lots[0], lot_id: "second" });
    await expect(prepareReportYoutubeVideos(f.input)).rejects.toMatchObject({ code: "YOUTUBE_LOT_MAPPING_AMBIGUOUS" }); expect((await f.model.findById(f.report._id).lean())!.videoUrls).toHaveLength(2);
  });
  it("expired provider data disappears from links and cannot resume", async () => {
    const f = await fixture(); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: new Date(Date.now() - 31 * 86400_000) } });
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map()); expect((await review(f)).code).toBe(410); expect(await publishReleasedYoutubeVideos()).toBe(0);
  });
  it("refreshes provider visibility weekly without changing saved metadata or uploading", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); await publishReleasedYoutubeVideos();
    expect(await refreshYoutubeVideoMetadata()).toBe(0); expect(mocks.states).not.toHaveBeenCalled();
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: new Date(Date.now() - 8 * 86400_000) } });
    expect(await refreshYoutubeVideoMetadata()).toBe(1);
    expect(mocks.states).toHaveBeenCalledExactlyOnceWith("isolated-access-token", [videoId], connection.channelId);
    expect(await YoutubeVideo.findById(f.id).select("+description").lean()).toMatchObject({ status: "unlisted", title: "Lot 010 — Reviewed loader", description: "Lot 010 — Reviewed loader\n\nReviewed description", privacyStatus: "public", visibilityPending: false });
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it.each(["removed", "revoked", "new-authorization"])("refresh cannot overwrite %s changes during provider reads", async (change) => {
    const f = await fixture(); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: new Date(Date.now() - 8 * 86400_000) } });
    const before = await YoutubeVideo.findById(f.id).lean();
    mocks.states.mockImplementationOnce(async () => {
      if (change === "removed") await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { status: "data_removed" }, $unset: { channelId: 1, publicationToken: 1, videoId: 1 } });
      if (change === "revoked") mocks.assertConnection.mockRejectedValue(new Error("revoked"));
      // Freeze the old clock value: only the exact authorization-token fence,
      // not a lucky later millisecond, can reject this stale refresh response.
      if (change === "new-authorization") await YoutubeVideo.updateOne({ _id: f.id }, { $set: {
        title: "Newer saved title", publicationToken: "newer-authorization", updatedAt: before!.updatedAt,
      } }, { timestamps: false });
      return new Map([[videoId, "public"]]);
    });
    if (change === "revoked") await expect(refreshYoutubeVideoMetadata()).rejects.toThrow("revoked"); else expect(await refreshYoutubeVideoMetadata()).toBe(0);
    if (change === "removed") expect((await YoutubeVideo.findById(f.id).lean())!.status).toBe("data_removed");
    if (change === "new-authorization") expect(await YoutubeVideo.findById(f.id).select("+publicationToken").lean()).toMatchObject({
      title: "Newer saved title", publicationToken: "newer-authorization", updatedAt: before!.updatedAt,
      providerDataCheckedAt: before!.providerDataCheckedAt,
    });
  });
  it("refresh batch reads no more than 50 rows and never retries deleted remote videos as uploads", async () => {
    const f = await fixture(); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); const receipt = await YoutubeVideo.findById(f.id).select("+sourceUrl +description +publicationToken").lean();
    const old = new Date(Date.now() - 8 * 86400_000);
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: old, visibilityPending: false } });
    await YoutubeVideo.collection.insertMany(Array.from({ length: 54 }, (_, i) => ({ ...receipt, _id: `refresh-${i}`, videoId: `abcdefgh${String(i).padStart(3, "0")}`, providerDataCheckedAt: old, visibilityPending: false })));
    mocks.states.mockResolvedValue(new Map()); expect(await refreshYoutubeVideoMetadata()).toBe(50);
    expect(mocks.states.mock.calls[0][1]).toHaveLength(50); expect(mocks.start).toHaveBeenCalledOnce();
    expect(await YoutubeVideo.countDocuments({ status: "needs_attention" })).toBe(50);
  });
  it("suppresses known unavailable links, preserves bytes/receipts and restores links after a fresh availability observation", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos(); await publishReleasedYoutubeVideos();
    const old = new Date(Date.now() - 8 * 86400_000);
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: old } });
    mocks.states.mockResolvedValueOnce(new Map()); expect(await refreshYoutubeVideoMetadata()).toBe(1);
    expect(await YoutubeVideo.findById(f.id).select("+sourceUrl").lean()).toMatchObject({ status: "needs_attention", providerAvailable: false, sourceUrl: source, videoId, url });
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map());
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: old } });
    mocks.states.mockResolvedValueOnce(new Map([[videoId, "public"]])); expect(await refreshYoutubeVideoMetadata()).toBe(1);
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map([[source, url]]));
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "public", providerAvailable: true });
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
    expect((await f.model.findById(f.report._id).lean())!.videoUrls).toEqual([source]);
  });
  it("keeps unknown legacy/transient availability compatible while excluding confirmed absence", async () => {
    const f = await fixture(); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { status: "needs_attention" }, $unset: { providerAvailable: 1 } });
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map([[source, url]]));
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { providerAvailable: false } });
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map());
  });
  it("submission attachment only records metadata and requires a channel", async () => {
    const report: any = { user: ownerId, videoUrls: [source], set: vi.fn() }; await attachYoutubeSubmission(report, "files-1"); expect(report.set).toHaveBeenCalledWith("youtube_submission", expect.objectContaining({ uploadGenerationToken: "files-1" }));
    mocks.connection.mockResolvedValue(null); report.set.mockClear(); await attachYoutubeSubmission(report, "files-2"); expect(report.set).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("respects an active automatic-upload lease without starting another session", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { leaseToken: "another-worker", leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await uploadReviewedYoutubeVideos()).toBe(0);
    for (const mock of [mocks.head, mocks.start, mocks.send, mocks.check]) expect(mock).not.toHaveBeenCalled();
    expect((await YoutubeVideo.findById(f.id).select("+leaseToken").lean())!.leaseToken).toBe("another-worker");
  });
  it("fences completion after lease expiry and reconciles the same durable session", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    mocks.send.mockImplementationOnce(async () => { await YoutubeVideo.updateOne({ _id: f.id }, { $set: { leaseUntil: new Date(0) } }); return { videoId, url }; });
    await uploadReviewedYoutubeVideos();
    const expired = await YoutubeVideo.findById(f.id).lean(); expect(expired!.videoId).toBeUndefined(); expect(expired!.finalChunkAttempted).toBe(true);
    await retryReady(f.id); await uploadReviewedYoutubeVideos();
    expect(await readReportYoutubeLinks(f.input)).toEqual(new Map([[source, url]]));
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.check).toHaveBeenCalledOnce();
  });
  it.each(["prepare", "transfer"])("requires the persisted root enable flag during %s even with an old intent", async (stage) => {
    const f = await fixture();
    if (stage === "transfer") await prepareAutomatically(f);
    await f.model.collection.updateOne({ _id: f.report._id }, { $set: { youtube_videos_enabled: false } });
    expect(await prepareReportYoutubeVideos(f.input)).toEqual(new Map());
    expect(await uploadReviewedYoutubeVideos()).toBe(0);
    for (const mock of [mocks.head, mocks.range, mocks.start, mocks.send]) expect(mock).not.toHaveBeenCalled();
  });
  it.each(["disconnected", "revision"])("cannot publish after the connection is %s", async (change) => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    mocks.connection.mockResolvedValue(change === "disconnected" ? null : { ...connection, revision: connection.revision + 1 });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("rechecks parent ownership after claiming an automatic publication", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    mocks.assertConnection.mockImplementationOnce(async () => { await f.model.collection.updateOne({ _id: f.report._id }, { $set: { user: new mongoose.Types.ObjectId() } }); return connection; });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.publish).not.toHaveBeenCalled();
    expect((await YoutubeVideo.findById(f.id).select("+leaseToken").lean())!.leaseToken).toBeUndefined();
  });
  it.each(["release", "lease", "connection"])("rechecks %s authority immediately before the provider privacy mutation", async (change) => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    let providerMutation = false;
    mocks.publish.mockImplementationOnce(async (_token, _video, _channel, authorize) => {
      if (change === "release") await f.model.collection.updateOne({ _id: f.report._id }, { $set: { release_status: "pending_release" } });
      if (change === "lease") await YoutubeVideo.updateOne({ _id: f.id }, { $set: { leaseUntil: new Date(0) } });
      if (change === "connection") mocks.assertConnection.mockRejectedValueOnce(new Error("revoked"));
      await authorize(); providerMutation = true; return true;
    });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(providerMutation).toBe(false);
    expect((await YoutubeVideo.findById(f.id).lean())!.status).toBe("private");
  });
  it("does not claim forced-private outcomes as public or retry them automatically", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    mocks.publish.mockResolvedValueOnce(false);
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", publicationAttempts: 1, visibilityPending: true, lastError: expect.stringContaining("did not confirm") });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.publish).toHaveBeenCalledOnce(); expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("rejects stale concurrent publication snapshots after backoff and stops at five attempts", async () => {
    const f = await fixture({ status: "approved", release_status: "released" }); await prepareAutomatically(f); await uploadReviewedYoutubeVideos();
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { publicationAttempts: 3, nextAttemptAt: new Date(0) } });
    mocks.publish.mockRejectedValue(new YoutubeProviderError("quotaExceeded", "Wait for quota"));
    let releaseFirst!: () => void; let releaseSecond!: () => void;
    const bothCaptured = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let snapshots = 0;
    const originalFind = YoutubeVideo.find.bind(YoutubeVideo);
    const find = vi.spyOn(YoutubeVideo, "find").mockImplementation((...args: any[]) => {
      const query = originalFind(...args as Parameters<typeof originalFind>); const originalLean = query.lean.bind(query);
      query.lean = vi.fn(async () => {
        const candidates = await originalLean(); if (args[0]?.visibilityPending !== true) return candidates; snapshots += 1;
        if (snapshots === 1) await bothCaptured;
        else if (snapshots === 2) { releaseFirst(); await firstFinished; }
        return candidates;
      }) as any;
      return query;
    });
    const sweeps = [publishReleasedYoutubeVideos(), publishReleasedYoutubeVideos()];
    try {
      expect(await Promise.race(sweeps)).toBe(0);
      const deferred = await YoutubeVideo.findById(f.id).lean(); expect(deferred).toMatchObject({ status: "private", publicationAttempts: 4 });
      expect(deferred!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); releaseSecond();
      expect(await Promise.all(sweeps)).toEqual([0, 0]); expect(mocks.publish).toHaveBeenCalledOnce();
      expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "private", publicationAttempts: 4, nextAttemptAt: deferred!.nextAttemptAt });
    } finally { releaseFirst(); releaseSecond(); await Promise.allSettled(sweeps); find.mockRestore(); }
    await retryReady(f.id); expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", publicationAttempts: 5 });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.check).not.toHaveBeenCalled();
  });
  it("rejects stale concurrent upload snapshots after backoff and stops at five attempts", async () => {
    const f = await fixture(); await prepareAutomatically(f);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { uploadAttempts: 3, nextAttemptAt: new Date(0) } });
    mocks.send.mockRejectedValue(new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", "Uncertain final"));
    mocks.check.mockRejectedValue(new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", "Uncertain status"));
    let bothCaptured!: () => void; let firstFinished!: () => void;
    const captured = new Promise<void>((resolve) => { bothCaptured = resolve; });
    const finished = new Promise<void>((resolve) => { firstFinished = resolve; });
    let snapshots = 0;
    const originalFind = YoutubeVideo.find.bind(YoutubeVideo);
    const find = vi.spyOn(YoutubeVideo, "find").mockImplementation((...args: any[]) => {
      const query = originalFind(...args as Parameters<typeof originalFind>); const originalLean = query.lean.bind(query);
      query.lean = vi.fn(async () => {
        const candidates = await originalLean(); if (args[0]?.status !== "uploading") return candidates; snapshots += 1;
        if (snapshots === 1) await captured;
        else if (snapshots === 2) { bothCaptured(); await finished; }
        return candidates;
      }) as any;
      return query;
    });
    const sweeps = [uploadReviewedYoutubeVideos(), uploadReviewedYoutubeVideos()];
    try {
      expect(await Promise.race(sweeps)).toBe(0);
      const deferred = await YoutubeVideo.findById(f.id).lean(); expect(deferred).toMatchObject({ status: "uploading", uploadAttempts: 4 });
      expect(deferred!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); firstFinished();
      expect(await Promise.all(sweeps)).toEqual([0, 0]); expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.check).not.toHaveBeenCalled();
      expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ uploadAttempts: 4, nextAttemptAt: deferred!.nextAttemptAt });
    } finally { bothCaptured(); firstFinished(); await Promise.allSettled(sweeps); find.mockRestore(); }
    await retryReady(f.id); expect(await uploadReviewedYoutubeVideos()).toBe(0);
    expect(await YoutubeVideo.findById(f.id).lean()).toMatchObject({ status: "needs_attention", uploadAttempts: 5 });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); expect(mocks.check).toHaveBeenCalledOnce(); expect(mocks.start).toHaveBeenCalledOnce();
  });
});
