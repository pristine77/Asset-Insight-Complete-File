import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), assertConnection: vi.fn(), access: vi.fn(), head: vi.fn(), range: vi.fn(), resolve: vi.fn(), start: vi.fn(), check: vi.fn(), send: vi.fn(), publish: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/service/youtubeConnectionService.js", () => ({
  getYoutubeConnection: mocks.connection, assertYoutubeConnection: mocks.assertConnection, getYoutubeAccessToken: mocks.access,
  encryptYoutubeSecret: (value: string, context: string) => JSON.stringify([context, value]),
  decryptYoutubeSecret: (cipher: string, context: string) => { const [saved, value] = JSON.parse(cipher); if (saved !== context) throw new Error("Wrong encryption context"); return value; },
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ headR2Object: mocks.head, readR2ObjectRange: mocks.range, resolveR2ObjectLocationFromUrl: mocks.resolve }));
vi.mock("../src/service/youtubeVideoClient.js", async (original) => ({ ...await original<typeof import("../src/service/youtubeVideoClient.js")>(), startYoutubeUpload: mocks.start, checkYoutubeUpload: mocks.check, sendYoutubeChunk: mocks.send, publishYoutubeVideo: mocks.publish }));
vi.mock("../src/controller/youtubeConnection.controller.js", () => ({ completeAdminYoutube: vi.fn(), connectAdminYoutube: vi.fn(), disconnectAdminYoutube: vi.fn(), getAdminYoutubeStatus: vi.fn(), revokeAdminYoutube: vi.fn(), eraseAdminYoutubeData: vi.fn(), acknowledgeAdminYoutubeRevocation: vi.fn() }));
vi.mock("../src/utils/reportImageDeletionPlugin.js", () => ({ attachReportImageDeletionHooks: vi.fn() }));

import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import User from "../src/models/user.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import youtubeRoutes from "../src/routes/youtube.routes.js";
import { YoutubeProviderError } from "../src/service/youtubeVideoClient.js";
import { authorizeAutomaticYoutubeVideos, prepareReportYoutubeVideos, publishReleasedYoutubeVideos, uploadReviewedYoutubeVideos } from "../src/service/youtubeVideoService.js";
import { youtubeVideoIdentity, YOUTUBE_PUBLICATION_POLICY_VERSION } from "../src/service/youtubeVideoPolicy.js";

type Kind = "asset" | "lotListing";
const owner = new mongoose.Types.ObjectId(), admin = new mongoose.Types.ObjectId();
const channel = { channelId: "channel-automatic", revision: 8 };
const source = "https://assetinsight.test/unchanged-original.mp4";
const photo = "https://assetinsight.test/unchanged-photo.jpg";
const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=automatic-test";
const videoId = "abcdefghijk", url = `https://www.youtube.com/watch?v=${videoId}`;
const app = express(); app.use(express.json()); app.use("/api/admin/youtube", youtubeRoutes);
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ id: String(admin) }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
let mongo: MongoMemoryServer;

beforeAll(async () => { mongo = await MongoMemoryServer.create({ binary: { checkMD5: false } }); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase(); for (const mock of Object.values(mocks)) mock.mockReset();
  await YoutubeVideo.syncIndexes();
  await User.collection.insertMany([{ _id: owner, role: "user", username: "Owner", email: "owner@example.test", isVerified: true }, { _id: admin, role: "admin", email: "admin@example.test" }]);
  mocks.connection.mockResolvedValue(channel); mocks.assertConnection.mockResolvedValue(channel); mocks.access.mockResolvedValue("isolated-token");
  mocks.resolve.mockImplementation((value: string) => value.startsWith("https://assetinsight.test/") ? { bucketName: "test", key: "unchanged-original.mp4" } : undefined);
  mocks.head.mockResolvedValue({ size: 4, etag: "original-etag", contentType: "video/mp4" }); mocks.range.mockResolvedValue(Buffer.from("clip"));
  mocks.start.mockResolvedValue(session); mocks.check.mockResolvedValue({ videoId, url }); mocks.send.mockResolvedValue({ videoId, url });
  mocks.publish.mockImplementation(async (_token, _videoId, _channel, authorize) => { await authorize(); return true; });
});

async function fixture(kind: Kind = "asset", fields: Record<string, any> = {}) {
  const model: any = kind === "asset" ? AssetReport : LotListing;
  const id = new mongoose.Types.ObjectId();
  const lots = [{ lot_id: "lot-182", lot_number: "182", title: "2006 Ford F-350 Lariat Truck", description: "Saved lot description", video_urls: [source], image_urls: [photo] }];
  await model.collection.insertOne({ _id: id, user: owner, status: "approved", release_status: "released", job_id: "generation-1", job_status: "done", videoUrls: [source], imageUrls: [photo], lots, preview_data: { lots }, youtube_videos_enabled: true,
    youtube_submission: { generationToken: "generation-1", uploadGenerationToken: "generation-1", ownerId: String(owner), channelId: channel.channelId, connectionRevision: channel.revision }, ...fields });
  const input = { reportType: kind, reportId: String(id), generationToken: "generation-1", enabled: true, lots, assertOwned: vi.fn().mockResolvedValue(undefined) };
  const receiptId = youtubeVideoIdentity(kind, String(id), source, channel.channelId);
  return { model, id, input, receiptId, lots };
}
async function stored(id: string) { return YoutubeVideo.findById(id).select("+publicationToken +reviewToken +sessionCipher +description +sourceUrl").lean(); }
async function ready(id: string) { await YoutubeVideo.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } }); }
async function legacy(f: Awaited<ReturnType<typeof fixture>>, changes: Record<string, any> = {}) {
  await YoutubeVideo.create({ _id: f.receiptId, reportType: f.input.reportType, reportId: f.id, ownerId: owner, channelId: channel.channelId, connectionRevision: channel.revision, generationToken: "generation-1", sourceUrl: source, lotId: "lot-182", status: "pending_review", title: "Old suggestion", description: "Old suggestion details", privacyStatus: "private", ...changes });
}

describe.sequential("automatic public YouTube publication without per-video manual review", () => {
  it.each(["asset", "lotListing"] as const)("%s prepares, uploads and publishes automatically without changing report originals or inventing a reviewer", async (kind) => {
    const f = await fixture(kind); const before = await f.model.findById(f.id).select("+youtube_submission").lean();
    await prepareReportYoutubeVideos(f.input);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ status: "private", videoId, privacyStatus: "public", visibilityPending: true, publicationPolicyVersion: YOUTUBE_PUBLICATION_POLICY_VERSION, publicationGenerationToken: "generation-1" });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("isolated-token", { title: "Lot 182 — 2006 Ford F-350 Lariat Truck", description: "Lot 182 — 2006 Ford F-350 Lariat Truck\n\nSaved lot description" }, 4, "video/mp4");
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    const receipt = await stored(f.receiptId);
    expect(receipt).toMatchObject({ status: "public", visibilityPending: false, publishedAt: expect.any(Date), publicationAuthorizedAt: expect.any(Date) });
    for (const field of ["reviewToken", "reviewedAt", "reviewedBy", "reviewPolicyVersion"] as const) expect(receipt![field]).toBeUndefined();
    expect(mocks.publish.mock.calls[0][5]).toBe("public");
    expect(await f.model.findById(f.id).select("+youtube_submission").lean()).toEqual(before);
    const removed = await request(app).post(`/api/admin/youtube/videos/${f.receiptId}/review`).set(auth()).send({ privacyStatus: "private" });
    expect(removed.status).toBe(410); expect(removed.body.code).toBe("YOUTUBE_REVIEW_REMOVED");
    expect((await stored(f.receiptId))!.status).toBe("public");
  });

  it.each(["pending_review", "queued"])("bounded worker adoption removes the %s backlog without administrator interaction", async (status) => {
    const f = await fixture(); await legacy(f, { status });
    expect(await uploadReviewedYoutubeVideos()).toBe(1); expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(await YoutubeVideo.countDocuments()).toBe(1); expect((await stored(f.receiptId))!.reviewedBy).toBeUndefined();
  });

  it.each(["private", "unlisted"])("adopts an existing %s provider ID and requests public without transferring bytes", async (status) => {
    const f = await fixture(); await legacy(f, { status, videoId, url, uploadedAt: new Date(), visibilityPending: false });
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.range).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(await stored(f.receiptId)).toMatchObject({ videoId, status: "public", privacyStatus: "public" });
  });

  it.each(["pending-approval", "pending-release", "processing", "generating", "regenerating"])("never declares a %s report public", async (condition) => {
    const changes: Record<string, any> = { "pending-approval": { status: "pending_approval" }, "pending-release": { release_status: "pending_release" }, processing: { job_status: "processing" }, generating: { files_generating: true }, regenerating: { files_regenerating: true } };
    const f = await fixture("asset", changes[condition]); await legacy(f, { status: "private", videoId, url });
    expect(await publishReleasedYoutubeVideos()).toBe(0); expect(mocks.publish).not.toHaveBeenCalled();
    expect((await stored(f.receiptId))!.status).toBe("private");
  });

  it.each(["owner", "generation", "channel", "connection-revision", "disabled", "removed-association", "archived", "draft"])("does not adopt or upload an unauthorized %s receipt", async (condition) => {
    const f = await fixture(); await legacy(f);
    const changes: Record<string, any> = { owner: { user: new mongoose.Types.ObjectId() }, generation: { job_id: "changed" }, disabled: { youtube_videos_enabled: false }, "removed-association": { preview_data: { lots: [] } }, archived: { adminArchivedAt: new Date() }, draft: { is_draft_preview: true } };
    if (changes[condition]) await f.model.collection.updateOne({ _id: f.id }, { $set: changes[condition] });
    if (condition === "channel") mocks.connection.mockResolvedValue({ ...channel, channelId: "other" });
    if (condition === "connection-revision") mocks.connection.mockResolvedValue({ ...channel, revision: channel.revision + 1 });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); expect(mocks.start).not.toHaveBeenCalled();
    expect((await stored(f.receiptId))!.publicationToken).toBeUndefined();
  });

  it("keeps active receipt leases and cancelled sweeps untouched", async () => {
    const f = await fixture(); await legacy(f, { leaseUntil: new Date(Date.now() + 60_000), leaseToken: "another-worker" });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); const before = await stored(f.receiptId);
    const signal = AbortSignal.abort(); expect(await authorizeAutomaticYoutubeVideos(signal)).toBe(0); expect(await publishReleasedYoutubeVideos(signal)).toBe(0);
    expect(await stored(f.receiptId)).toEqual(before); expect(mocks.start).not.toHaveBeenCalled();
  });

  it("two concurrent workers authorize and transfer one deterministic receipt only once", async () => {
    const f = await fixture(); await legacy(f);
    const results = await Promise.all([uploadReviewedYoutubeVideos(), uploadReviewedYoutubeVideos()]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1); expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
    expect(await YoutubeVideo.countDocuments()).toBe(1);
  });

  it("bounds backlog adoption and each transfer tick instead of creating an unbounded provider burst", async () => {
    const f = await fixture();
    const lots = Array.from({ length: 51 }, (_, index) => ({ lot_id: `lot-${index}`, lot_number: String(index), title: `Saved lot ${index}`, video_urls: [`https://assetinsight.test/source-${index}.mp4`] }));
    const sources = lots.map((lot) => lot.video_urls[0]);
    await f.model.collection.updateOne({ _id: f.id }, { $set: { videoUrls: sources, preview_data: { lots }, lots } });
    await YoutubeVideo.insertMany(lots.map((lot, index) => ({ _id: youtubeVideoIdentity("asset", String(f.id), sources[index], channel.channelId), reportType: "asset", reportId: f.id, ownerId: owner,
      channelId: channel.channelId, connectionRevision: channel.revision, generationToken: "generation-1", sourceUrl: sources[index], lotId: lot.lot_id, status: "pending_review" })));
    expect(await authorizeAutomaticYoutubeVideos()).toBe(50);
    expect(await YoutubeVideo.countDocuments({ publicationToken: { $exists: true } })).toBe(50);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await uploadReviewedYoutubeVideos()).toBe(2);
    expect(await YoutubeVideo.countDocuments({ publicationToken: { $exists: true } })).toBe(51);
    expect(mocks.start).toHaveBeenCalledTimes(2); expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("lost final responses check the same durable session instead of uploading duplicate bytes", async () => {
    const f = await fixture(); await legacy(f);
    mocks.send.mockRejectedValueOnce(new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", "The provider response was not confirmed."));
    expect(await uploadReviewedYoutubeVideos()).toBe(0); const uncertain = await stored(f.receiptId);
    expect(uncertain).toMatchObject({ status: "uploading", sourceEtag: "original-etag", sourceSize: 4, finalChunkAttempted: true, sessionCipher: JSON.stringify([`upload:${f.receiptId}`, session]) });
    await ready(f.receiptId); expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith("isolated-token", session, 4); expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
    expect((await stored(f.receiptId))!.publicationToken).toBe(uncertain!.publicationToken);
  });

  it("expired uncertain final uploads stay quarantined across repeated automatic sweeps", async () => {
    const f = await fixture(); await legacy(f, { status: "uploading", sourceEtag: "original-etag", sourceSize: 4, finalChunkAttempted: true, sessionCipher: JSON.stringify([`upload:${f.receiptId}`, session]) });
    mocks.check.mockRejectedValue(new YoutubeProviderError("requestFailed", "Expired session", 404));
    expect(await uploadReviewedYoutubeVideos()).toBe(0); await ready(f.receiptId); expect(await uploadReviewedYoutubeVideos()).toBe(0);
    expect(await stored(f.receiptId)).toMatchObject({ status: "needs_attention", finalChunkAttempted: true, lastErrorCode: "YOUTUBE_RECONCILIATION_REQUIRED" });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails closed if ownership or source bytes change after automatic authorization", async () => {
    const f = await fixture(); await legacy(f); await authorizeAutomaticYoutubeVideos();
    mocks.head.mockImplementationOnce(async () => { await f.model.collection.updateOne({ _id: f.id }, { $set: { user: new mongoose.Types.ObjectId() } }); return { size: 4, etag: "original-etag", contentType: "video/mp4" }; });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    await f.model.collection.updateOne({ _id: f.id }, { $set: { user: owner } }); await ready(f.receiptId);
    mocks.head.mockResolvedValue({ size: 5, etag: "changed-etag", contentType: "video/mp4" });
    expect(await uploadReviewedYoutubeVideos()).toBe(0); expect((await stored(f.receiptId))!.lastErrorCode).toBe("YOUTUBE_SOURCE_CHANGED");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("saved metadata is bounded to provider limits without including account or internal fields", async () => {
    const f = await fixture(); await legacy(f);
    await f.model.collection.updateOne({ _id: f.id }, { $set: { "preview_data.lots.0.title": "é".repeat(120), "preview_data.lots.0.description": "🙂".repeat(2000), "preview_data.lots.0.internal_secret": "NEVER-PUBLISH", "preview_data.lots.0.customer_email": "customer@example.test" } });
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    const metadata = mocks.start.mock.calls[0][1]; expect(Array.from(metadata.title)).toHaveLength(100); expect(Buffer.byteLength(metadata.description, "utf8")).toBeLessThanOrEqual(5000);
    expect(metadata.description).toContain("🙂"); expect(JSON.stringify(metadata)).not.toMatch(/NEVER-PUBLISH|customer@example.test/);
  });

  it("does not label requested public visibility as public before Google confirms it", async () => {
    const f = await fixture(); await legacy(f, { status: "private", videoId, url }); mocks.publish.mockResolvedValue(false);
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(await stored(f.receiptId)).toMatchObject({ status: "needs_attention", visibilityPending: true, lastErrorCode: "YOUTUBE_VISIBILITY_UNCONFIRMED" });
    expect((await stored(f.receiptId))!.publishedAt).toBeUndefined();
  });

  it("old human review evidence is retained as history, not forged or used instead of new system authority", async () => {
    const f = await fixture(); const reviewedAt = new Date("2026-09-01T12:00:00Z");
    await legacy(f, { reviewToken: "historical-review", reviewedAt, reviewedBy: admin, reviewPolicyVersion: "youtube-video-review-v1", reviewGenerationToken: "generation-1" });
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ publicationToken: expect.any(String), publicationPolicyVersion: YOUTUBE_PUBLICATION_POLICY_VERSION, reviewToken: "historical-review", reviewedAt, reviewedBy: admin });
  });
});
