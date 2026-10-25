import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ find: vi.fn(), findOne: vi.fn(), rows: [] as any[] }));
vi.mock("../src/models/youtubeVideo.model.js", () => ({ default: { find: db.find, findOne: db.findOne } }));
import { buildAuctioneerVideoManifest, assertAuctioneerVideoReceipt } from "../src/service/auctioneer2VideoManifest.js";
const source = "https://assetinsight.test/video.mp4", url = "https://www.youtube.com/watch?v=AbCdEfGhI_1";
const lots = [{ lot_id: "first", video_urls: [source] }, { lot_id: "second", video_urls: [] }];
const report = () => ({ _id: "report", user: "owner", status: "approved", release_status: "released", job_id: "gen", job_status: "done",
  youtube_videos_enabled: true, videoUrls: [source], preview_data: { lots },
  youtube_submission: { ownerId: "owner", generationToken: "gen", channelId: "channel", connectionRevision: 1 } });
const receipt = () => ({ _id: "receipt", reportId: "report", reportType: "asset", ownerId: "owner", sourceUrl: source, lotId: "first", status: "public", privacyStatus: "public",
  channelId: "channel", connectionRevision: 1, generationToken: "gen", providerAvailable: true, providerDataCheckedAt: new Date(), url,
  title: "Test vehicle", description: "Reviewed details", reviewToken: "review", reviewedAt: new Date(), reviewGenerationToken: "gen", reviewPolicyVersion: "youtube-video-review-v1" });
beforeEach(() => {
  db.rows = [receipt()];
  db.find.mockReset().mockImplementation(() => ({ select: () => ({ sort: () => ({ lean: async () => db.rows }) }) }));
  db.findOne.mockReset().mockImplementation(() => ({ select: () => ({ lean: async () => db.rows[0] }) }));
});
describe("published video manifest", () => {
  it("freezes only the exact lot's reviewed published video and retains receipt identity", async () => {
    expect(await buildAuctioneerVideoManifest(report(), "asset", lots)).toEqual({ videoUrlsByLot: [url, null], videoReceiptIdsByLot: ["receipt", null] });
    expect(db.find).toHaveBeenCalledWith(expect.objectContaining({ reportId: "report", ownerId: "owner", reportType: "asset", channelId: "channel" }));
    await expect(assertAuctioneerVideoReceipt(report(), "asset", "receipt", url)).resolves.toBeUndefined();
  });
  it.each([{ status: "private" }, { status: "data_removed" }, { privacyStatus: "private" }, { privacyStatus: "unlisted" }, { visibilityPending: true }, { providerAvailable: false }, { ownerId: "other" }, { lotId: "second" }, { generationToken: "old" }, { reviewToken: null }, { providerDataCheckedAt: new Date(0) }])("does not export an ineligible receipt: %j", change => {
    db.rows = [{ ...receipt(), ...change }];
    return expect(buildAuctioneerVideoManifest(report(), "asset", lots)).resolves.toEqual({ videoUrlsByLot: [null, null], videoReceiptIdsByLot: [null, null] });
  });
  it("rejects authorization revoked after enqueue rather than sending the frozen URL", async () => {
    db.rows[0].status = "data_removed";
    await expect(assertAuctioneerVideoReceipt(report(), "asset", "receipt", url)).rejects.toThrow("no longer authorized");
  });
  it("keeps explicit lot links separate and never falls back to a root video for another lot", async () => {
    const value = await buildAuctioneerVideoManifest({ ...report(), youtube_videos_enabled: false, videoUrls: [url] }, "lotListing", [{ video_urls: [url] }, {}]);
    expect(value).toEqual({ videoUrlsByLot: [url, null], videoReceiptIdsByLot: [null, null] });
    expect(db.find).not.toHaveBeenCalled();
  });
});
