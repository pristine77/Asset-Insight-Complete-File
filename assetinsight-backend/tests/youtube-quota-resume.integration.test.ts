/**
 * YouTube's daily limit no longer parks a video (owner, 2026-11-20: "Yes,
 * build it"). A refusal for the limit waits for the reset at midnight Pacific
 * time without spending a try; a video already parked by one resumes after
 * the reset; anything else still waits for a person.
 * Real models on an in-memory database; YouTube and storage are faked.
 */
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
import { authorizeAutomaticYoutubeVideos, prepareReportYoutubeVideos, publishReleasedYoutubeVideos, resumeQuotaStoppedYoutubeVideos, uploadReviewedYoutubeVideos } from "../src/service/youtubeVideoService.js";
import {
  nextYoutubeQuotaReset, youtubeVideoIdentity, YOUTUBE_PUBLICATION_POLICY_VERSION, YOUTUBE_QUOTA_MAX_DEFERRALS,
  YOUTUBE_QUOTA_PERSISTENT_CODE, YOUTUBE_QUOTA_WAIT_MESSAGE,
} from "../src/service/youtubeVideoPolicy.js";

type Kind = "asset" | "lotListing";
const owner = new mongoose.Types.ObjectId(), admin = new mongoose.Types.ObjectId();
const channel = { channelId: "channel-quota", revision: 4 };
const source = "https://assetinsight.test/lot-1-walkaround.mp4";
const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=quota-test";
const videoId = "QuotaVideo1", url = `https://www.youtube.com/watch?v=${videoId}`;
const quotaRefusal = () => new YoutubeProviderError("quotaExceeded", "YouTube upload quota was reached. Wait for the channel quota to reset, then retry.", 403);
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
  mocks.resolve.mockImplementation((value: string) => value.startsWith("https://assetinsight.test/") ? { bucketName: "test", key: "lot-1-walkaround.mp4" } : undefined);
  mocks.head.mockResolvedValue({ size: 4, etag: "original-etag", contentType: "video/mp4" }); mocks.range.mockResolvedValue(Buffer.from("clip"));
  mocks.start.mockResolvedValue(session); mocks.check.mockResolvedValue({ videoId, url }); mocks.send.mockResolvedValue({ videoId, url });
  mocks.publish.mockImplementation(async (_token, _videoId, _channel, authorize) => { await authorize(); return true; });
});

/** A released Lot Listing whose one clip is queued for YouTube. */
async function queued(kind: Kind = "lotListing") {
  const model: any = kind === "asset" ? AssetReport : LotListing;
  const id = new mongoose.Types.ObjectId();
  const lots = [{ lot_id: "lot-1", lot_number: "1", title: "2021 Toyota RAV4 LE AWD", description: "Walkaround", video_urls: [source] }];
  await model.collection.insertOne({ _id: id, user: owner, status: "approved", release_status: "released", job_id: "generation-1", job_status: "done", videoUrls: [source], lots, preview_data: { lots }, youtube_videos_enabled: true,
    youtube_submission: { generationToken: "generation-1", uploadGenerationToken: "generation-1", ownerId: String(owner), channelId: channel.channelId, connectionRevision: channel.revision } });
  await prepareReportYoutubeVideos({ reportType: kind, reportId: String(id), generationToken: "generation-1", enabled: true, lots, assertOwned: vi.fn().mockResolvedValue(undefined) });
  return { model, id, receiptId: youtubeVideoIdentity(kind, String(id), source, channel.channelId) };
}
const stored = (id: string) => YoutubeVideo.findById(id).select("+publicationToken +sessionCipher").lean() as Promise<any>;
const due = (id: string) => YoutubeVideo.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } });
/** A receipt as the old five-try backoff left it: parked, by the limit, a while ago. */
const parked = (id: string, fields: Record<string, unknown> = {}) => YoutubeVideo.collection.updateOne({ _id: id as any }, { $set: {
  status: "needs_attention", uploadAttempts: 5, lastErrorCode: "quotaExceeded", lastError: "YouTube upload quota was reached. Wait for the channel quota to reset, then retry.",
  updatedAt: new Date(Date.now() - 2 * 24 * 3_600_000), ...fields } });

describe("when YouTube's daily quota is fresh again", () => {
  it.each([
    ["a winter afternoon", "2026-11-20T20:22:00Z", "2026-11-21T08:10:00Z"],
    ["the night before daylight time starts", "2026-03-07T12:00:00Z", "2026-03-08T08:10:00Z"],
    ["the day daylight time starts", "2026-03-08T12:00:00Z", "2026-03-09T07:10:00Z"],
    ["the day before daylight time ends", "2026-10-31T12:00:00Z", "2026-11-01T07:10:00Z"],
    ["the day daylight time ends", "2026-11-01T12:00:00Z", "2026-11-02T08:10:00Z"],
    ["just after a reset", "2026-11-21T08:20:00Z", "2026-11-22T08:10:00Z"],
  ])("on %s it is the next midnight Pacific time, ten minutes on", (_when, now, expected) => {
    expect(nextYoutubeQuotaReset(new Date(now)).toISOString()).toBe(new Date(expected).toISOString());
  });
});

describe.sequential("YouTube's daily limit", () => {
  it("waits for the reset without spending a try, keeps the video uploading, then carries on by itself", async () => {
    const f = await queued();
    mocks.start.mockRejectedValueOnce(quotaRefusal());
    expect(await uploadReviewedYoutubeVideos()).toBe(0);
    const waiting = await stored(f.receiptId);
    expect(waiting).toMatchObject({ status: "uploading", uploadAttempts: 0, quotaDeferrals: 1, lastErrorCode: "quotaExceeded", lastError: YOUTUBE_QUOTA_WAIT_MESSAGE });
    expect(waiting.nextAttemptAt.toISOString()).toBe(nextYoutubeQuotaReset(new Date(waiting.updatedAt)).toISOString());

    // Before the reset nothing is tried again.
    expect(await uploadReviewedYoutubeVideos()).toBe(0);
    expect(mocks.start).toHaveBeenCalledOnce();

    await due(f.receiptId);
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ status: "public", videoId, quotaDeferrals: 0, lastError: "", lastErrorCode: "" });
  });

  it("asks for a person after seven resets in a row, under a code the automatic resume leaves alone", async () => {
    const f = await queued();
    for (let day = 1; day <= YOUTUBE_QUOTA_MAX_DEFERRALS; day += 1) {
      mocks.start.mockRejectedValueOnce(quotaRefusal());
      await due(f.receiptId);
      await uploadReviewedYoutubeVideos();
    }
    const stopped = await stored(f.receiptId);
    expect(stopped).toMatchObject({ status: "needs_attention", quotaDeferrals: YOUTUBE_QUOTA_MAX_DEFERRALS, lastErrorCode: YOUTUBE_QUOTA_PERSISTENT_CODE, uploadAttempts: 0 });
    await YoutubeVideo.collection.updateOne({ _id: f.receiptId as any }, { $set: { updatedAt: new Date(Date.now() - 2 * 24 * 3_600_000) } });
    expect(await resumeQuotaStoppedYoutubeVideos()).toBe(0);
    expect((await stored(f.receiptId)).status).toBe("needs_attention");

    // The admin page's Resume starts the count again.
    const current = await stored(f.receiptId);
    const retry = await request(app).post(`/api/admin/youtube/videos/${f.receiptId}/retry-publication`).set(auth()).send({ updatedAt: new Date(current.updatedAt).toISOString() });
    expect(retry.status).toBe(202);
    expect(await stored(f.receiptId)).toMatchObject({ status: "uploading", uploadAttempts: 0, quotaDeferrals: 0 });
  });

  it("does the same when the limit refuses making the video Public", async () => {
    const f = await queued();
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    mocks.publish.mockRejectedValueOnce(quotaRefusal());
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(await stored(f.receiptId)).toMatchObject({ status: "private", visibilityPending: true, publicationAttempts: 0, quotaDeferrals: 1, lastError: YOUTUBE_QUOTA_WAIT_MESSAGE });
    expect(await publishReleasedYoutubeVideos()).toBe(0);
    expect(mocks.publish).toHaveBeenCalledOnce();
    await due(f.receiptId);
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ status: "public", quotaDeferrals: 0 });
  });

  it("other failures keep the five-try backoff", async () => {
    const f = await queued();
    mocks.start.mockRejectedValueOnce(new YoutubeProviderError("requestFailed", "YouTube request failed (500). Check the admin channel connection before retrying.", 500));
    await uploadReviewedYoutubeVideos();
    const failed = await stored(f.receiptId);
    expect(failed).toMatchObject({ status: "uploading", uploadAttempts: 1, lastErrorCode: "requestFailed" });
    expect(failed.quotaDeferrals || 0).toBe(0);
    expect(failed.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
  });
});

describe.sequential("a video already parked by the limit", () => {
  it("resumes after the reset that followed its stop, as Resume would, and uploads", async () => {
    const f = await queued();
    expect(await authorizeAutomaticYoutubeVideos()).toBe(1); // authorized, nothing sent yet
    await parked(f.receiptId);
    expect(await resumeQuotaStoppedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ status: "uploading", uploadAttempts: 0, lastErrorCode: "" });
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    expect((await stored(f.receiptId)).videoId).toBe(videoId);
  });

  it("asks YouTube again to make a parked uploaded video Public", async () => {
    const f = await queued();
    expect(await uploadReviewedYoutubeVideos()).toBe(1);
    await parked(f.receiptId, { publicationAttempts: 5 });
    expect(await resumeQuotaStoppedYoutubeVideos()).toBe(1);
    expect(await stored(f.receiptId)).toMatchObject({ status: "private", publicationAttempts: 0 });
    expect(await publishReleasedYoutubeVideos()).toBe(1);
    expect((await stored(f.receiptId)).status).toBe("public");
  });

  it("waits while it is still the quota day it stopped in", async () => {
    const f = await queued();
    expect(await authorizeAutomaticYoutubeVideos()).toBe(1);
    await parked(f.receiptId, { updatedAt: new Date() });
    expect(await resumeQuotaStoppedYoutubeVideos()).toBe(0);
    expect((await stored(f.receiptId)).status).toBe("needs_attention");
  });

  it.each([
    ["stopped for something else", { lastErrorCode: "YOUTUBE_RECONCILIATION_REQUIRED" }, undefined],
    ["whose report changed since", {}, { job_id: "generation-2" }],
    ["still leased to a worker", { leaseUntil: new Date(Date.now() + 60_000), leaseToken: "other" }, undefined],
  ])("is left for a person when %s", async (_why, receiptFields, reportFields) => {
    const f = await queued();
    expect(await authorizeAutomaticYoutubeVideos()).toBe(1);
    await parked(f.receiptId, receiptFields as Record<string, unknown>);
    if (reportFields) await f.model.collection.updateOne({ _id: f.id }, { $set: reportFields });
    expect(await resumeQuotaStoppedYoutubeVideos()).toBe(0);
    expect((await stored(f.receiptId)).status).toBe("needs_attention");
  });
});

describe("the automatic publication policy still applies", () => {
  it("uses the current policy version", () => {
    expect(YOUTUBE_PUBLICATION_POLICY_VERSION).toBe("youtube-automatic-public-v1");
  });
});
