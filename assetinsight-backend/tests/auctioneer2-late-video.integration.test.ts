/**
 * A lot sent to Auctioneer 2.0 before its clip went Public gets the YouTube
 * link afterwards (owner 2026-11-20; service/auctioneer2LateVideoService.ts).
 * Real models on an in-memory database; only the Auctioneer calls are faked.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setLotVideo: vi.fn(), config: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/reportImageDeletionPlugin.js", () => ({ attachReportImageDeletionHooks: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", async (original) => ({
  ...await original<typeof import("../src/service/auctioneer2Client.js")>(),
  setLotVideo: mocks.setLotVideo,
  getAuctioneer2ConfigStatus: mocks.config,
}));

import AuctioneerWorkItem from "../src/models/auctioneerWorkItem.model.js";
import LotListing from "../src/models/lotListing.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import { LATE_VIDEO_MAX_ATTEMPTS, sendLateAuctioneerVideos } from "../src/service/auctioneer2LateVideoService.js";
import { YOUTUBE_PUBLICATION_POLICY_VERSION } from "../src/service/youtubeVideoPolicy.js";

const owner = new mongoose.Types.ObjectId();
const channel = { channelId: "channel-late", revision: 3 };
const clip = "https://assetinsight.test/lot-1-walkaround.mp4";
const otherClip = "https://assetinsight.test/lot-3-walkaround.mp4";
const link = "https://www.youtube.com/watch?v=LateVideo01";
const otherLink = "https://www.youtube.com/watch?v=OtherVid002";
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { checkMD5: false } });
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mocks.setLotVideo.mockReset().mockImplementation(async (_lotId: string, url: string) => ({ success: true, video: { url } }));
  mocks.config.mockReset().mockReturnValue({ enabled: true, configured: true });
});

const lots = () => [
  { lot_id: "lot-1", lot_number: "1", title: "2021 Toyota RAV4 LE AWD", description: "Walkaround", video_urls: [clip] },
  { lot_id: "lot-2", lot_number: "2", title: "2021 Nissan Qashqai", description: "No clip" },
  { lot_id: "lot-3", lot_number: "3", title: "2017 Dodge Journey GT", description: "Already had its video", video_urls: [otherClip] },
];

/** A released Lot Listing with two clips, as its report holds them now. */
async function report(fields: Record<string, unknown> = {}) {
  const id = new mongoose.Types.ObjectId();
  await LotListing.collection.insertOne({
    _id: id, user: owner, status: "approved", release_status: "released", job_id: "gen-1", job_status: "done",
    videoUrls: [clip, otherClip], lots: lots(), preview_data: { lots: lots() }, youtube_videos_enabled: true,
    youtube_submission: { generationToken: "gen-1", uploadGenerationToken: "gen-1", ownerId: String(owner), channelId: channel.channelId, connectionRevision: channel.revision },
    ...fields,
  });
  return id;
}

/** A clip YouTube has confirmed Public under the automatic publication policy. */
async function publicVideo(reportId: mongoose.Types.ObjectId, sourceUrl = clip, url = link, lotId = "lot-1", fields: Record<string, unknown> = {}) {
  const id = `receipt-${new mongoose.Types.ObjectId()}`;
  await YoutubeVideo.create({
    _id: id, reportType: "lotListing", reportId, ownerId: owner, channelId: channel.channelId, connectionRevision: channel.revision,
    generationToken: "gen-1", sourceUrl, lotId, title: "Lot 1 — 2021 Toyota RAV4 LE AWD", description: "Walkaround",
    status: "public", privacyStatus: "public", visibilityPending: false, videoId: url.slice(-11), url,
    publicationToken: "publication", publicationGenerationToken: "gen-1", publicationPolicyVersion: YOUTUBE_PUBLICATION_POLICY_VERSION,
    publicationAuthorizedAt: new Date(), providerAvailable: true, providerDataCheckedAt: new Date(), uploadedAt: new Date(), publishedAt: new Date(),
    ...fields,
  });
  return id;
}

/**
 * The delivery as it was frozen when the lots were sent: lot 1's clip was not
 * Public yet (null), lot 3's was and went with it.
 */
async function delivery(reportId: mongoose.Types.ObjectId, changes: { status?: string; kind?: string; checkpoints?: any[]; manifest?: any } = {}) {
  const id = new mongoose.Types.ObjectId();
  await AuctioneerWorkItem.collection.insertOne({
    _id: id, source: "auctioneer2", cycleKey: `cycle-${id}`, kind: changes.kind || "unknown", selectedReportType: "lotListing",
    linkedReportModel: "LotListing", linkedReportId: reportId, contract: { id: "contract-1", contractNo: "825901" },
    status: "sent", claimedBy: owner, claimedAt: new Date(), clientSubmissionId: `submission-${id}`,
    snapshot: { lots: [], tasks: [], capturedAt: new Date() },
    delivery: {
      status: changes.status || "sent", completeContract: false, attempts: 1,
      manifest: changes.manifest || { previewData: { lots: lots() }, videoOrderVersion: 1, videoUrlsByLot: [null, null, otherLink], videoReceiptIdsByLot: [null, null, null] },
      lots: changes.checkpoints || [
        { sourceKey: "k1", createdLotId: "a2-lot-1", status: "sent", step: "sent", photosUploadedAt: new Date() },
        { sourceKey: "k2", createdLotId: "a2-lot-2", status: "sent", step: "sent", photosUploadedAt: new Date() },
        { sourceKey: "k3", createdLotId: "a2-lot-3", status: "sent", step: "sent", photosUploadedAt: new Date(), videoUploadedAt: new Date("2026-11-18T20:00:00Z") },
      ],
    },
  });
  return id;
}

const checkpoint = async (workItemId: mongoose.Types.ObjectId, index: number) =>
  ((await AuctioneerWorkItem.collection.findOne({ _id: workItemId })) as any).delivery.lots[index];
const receipt = (id: string) => YoutubeVideo.findById(id).lean() as Promise<any>;
const due = (id: string) => YoutubeVideo.updateOne({ _id: id }, { $set: { auctioneerVideoNextAt: new Date(0) } });

describe.sequential("late lot videos for Auctioneer 2.0", () => {
  it("gives the lot sent without its video the YouTube link once, and leaves every other lot alone", async () => {
    const reportId = await report();
    const video = await publicVideo(reportId);
    await publicVideo(reportId, otherClip, otherLink, "lot-3");
    const workItem = await delivery(reportId);

    expect(await sendLateAuctioneerVideos()).toBe(1);
    expect(mocks.setLotVideo).toHaveBeenCalledExactlyOnceWith("a2-lot-1", link);
    expect(await checkpoint(workItem, 0)).toMatchObject({ videoUploadedAt: expect.any(Date), videoSentLateAt: expect.any(Date), status: "sent" });
    expect((await checkpoint(workItem, 1)).videoUploadedAt).toBeUndefined();
    expect((await checkpoint(workItem, 2)).videoSentLateAt).toBeUndefined();
    expect(await receipt(video)).toMatchObject({ auctioneerVideoCheckedAt: expect.any(Date), auctioneerVideoLotsSent: 1 });

    mocks.setLotVideo.mockClear();
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
  });

  it("sends a Schedule A line's video to the lot that already existed for that line", async () => {
    const reportId = await report();
    await publicVideo(reportId);
    await delivery(reportId, {
      kind: "scheduleA",
      checkpoints: [
        { sourceKey: "line-1", sourceLotId: "a2-schedule-a-lot", status: "sent", step: "sent" },
        { sourceKey: "line-2", sourceLotId: "a2-other", status: "sent", step: "sent" },
        { sourceKey: "line-3", sourceLotId: "a2-third", status: "sent", step: "sent", videoUploadedAt: new Date() },
      ],
    });
    expect(await sendLateAuctioneerVideos()).toBe(1);
    expect(mocks.setLotVideo).toHaveBeenCalledExactlyOnceWith("a2-schedule-a-lot", link);
  });

  it("waits while the delivery is being sent, and sends once it has finished", async () => {
    const reportId = await report();
    const video = await publicVideo(reportId);
    const workItem = await delivery(reportId, { status: "sending" });
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
    const waiting = await receipt(video);
    expect(waiting.auctioneerVideoCheckedAt).toBeUndefined();
    expect(waiting.auctioneerVideoAttempts).toBeUndefined();
    expect(waiting.auctioneerVideoNextAt.getTime()).toBeGreaterThan(Date.now());

    await AuctioneerWorkItem.collection.updateOne({ _id: workItem }, { $set: { "delivery.status": "sent" } });
    await due(video);
    expect(await sendLateAuctioneerVideos()).toBe(1);
    expect(mocks.setLotVideo).toHaveBeenCalledExactlyOnceWith("a2-lot-1", link);
  });

  it("gives the sent lots of a failed delivery their video and keeps looking for the lots still to go", async () => {
    const reportId = await report();
    const video = await publicVideo(reportId);
    const workItem = await delivery(reportId, {
      status: "failed",
      checkpoints: [
        { sourceKey: "k1", createdLotId: "a2-lot-1", status: "sent", step: "sent" },
        { sourceKey: "k2", status: "failed", step: "submitting" },
        { sourceKey: "k3", status: "pending" },
      ],
    });
    expect(await sendLateAuctioneerVideos()).toBe(1);
    expect((await checkpoint(workItem, 0)).videoSentLateAt).toEqual(expect.any(Date));
    expect((await receipt(video)).auctioneerVideoCheckedAt).toBeUndefined();
  });

  it("never sends a video that is no longer authorized, and gives up after repeated refusals", async () => {
    const reportId = await report({ status: "preview" });
    const video = await publicVideo(reportId);
    const workItem = await delivery(reportId);
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
    expect(await receipt(video)).toMatchObject({ auctioneerVideoAttempts: 1, auctioneerVideoError: expect.stringMatching(/no longer authorized/) });
    for (let attempt = 2; attempt <= LATE_VIDEO_MAX_ATTEMPTS; attempt += 1) {
      await due(video);
      await sendLateAuctioneerVideos();
    }
    expect(await receipt(video)).toMatchObject({ auctioneerVideoAttempts: LATE_VIDEO_MAX_ATTEMPTS, auctioneerVideoCheckedAt: expect.any(Date) });
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
    expect((await checkpoint(workItem, 0)).videoUploadedAt).toBeUndefined();
  });

  it("retries when Auctioneer does not take the link, without recording the lot", async () => {
    const reportId = await report();
    const video = await publicVideo(reportId);
    const workItem = await delivery(reportId);
    mocks.setLotVideo.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect((await checkpoint(workItem, 0)).videoUploadedAt).toBeUndefined();
    const failed = await receipt(video);
    expect(failed).toMatchObject({ auctioneerVideoAttempts: 1 });
    expect(failed.auctioneerVideoCheckedAt).toBeUndefined();
    expect(failed.auctioneerVideoNextAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    expect(await sendLateAuctioneerVideos()).toBe(0); // not due yet
    await due(video);
    expect(await sendLateAuctioneerVideos()).toBe(1);
    expect((await receipt(video)).auctioneerVideoError).toBeUndefined();
  });

  it("skips items returned for a Proposal's review, lots naming another link, and old deliveries without saved lots", async () => {
    const proposal = await report();
    await publicVideo(proposal);
    await delivery(proposal, { checkpoints: [{ sourceKey: "k1", status: "sent", step: "returned" }, { sourceKey: "k2", status: "sent", step: "returned" }, { sourceKey: "k3", status: "sent", step: "returned" }] });

    const explicit = await report();
    await publicVideo(explicit);
    const explicitLots = lots();
    explicitLots[0].video_urls = [clip, "https://youtu.be/Explicit001"];
    await delivery(explicit, { manifest: { previewData: { lots: explicitLots }, videoOrderVersion: 1, videoUrlsByLot: ["https://www.youtube.com/watch?v=Explicit001", null, null] } });

    const legacy = await report();
    const legacyVideo = await publicVideo(legacy);
    await delivery(legacy, { manifest: { destination: "LottingBoard" } });

    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
    expect((await receipt(legacyVideo)).auctioneerVideoCheckedAt).toEqual(expect.any(Date));
  });

  it("checks off a video whose report was never sent, and does nothing while Auctioneer 2.0 is switched off", async () => {
    const unsent = await report();
    const video = await publicVideo(unsent);
    mocks.config.mockReturnValue({ enabled: false, configured: true });
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect((await receipt(video)).auctioneerVideoCheckedAt).toBeUndefined();

    mocks.config.mockReturnValue({ enabled: true, configured: true });
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect((await receipt(video)).auctioneerVideoCheckedAt).toEqual(expect.any(Date));
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
  });

  it("ignores videos that are not Public or Unlisted", async () => {
    const reportId = await report();
    const video = await publicVideo(reportId, clip, link, "lot-1", { status: "private", privacyStatus: "private" });
    await delivery(reportId);
    expect(await sendLateAuctioneerVideos()).toBe(0);
    expect((await receipt(video)).auctioneerVideoCheckedAt).toBeUndefined();
    expect(mocks.setLotVideo).not.toHaveBeenCalled();
  });
});
