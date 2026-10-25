import { describe, expect, it } from "vitest";
import { auctioneerYoutubeUrl, frozenAuctioneerVideo } from "../src/service/auctioneer2VideoPolicy.js";
import { deliveryErrorDiagnostic } from "../src/service/auctioneer2DeliveryError.js";

const id = "AbCdEfGhI_1";
const canonical = `https://www.youtube.com/watch?v=${id}`;
describe("Auctioneer video and diagnostics policy", () => {
  it.each([id, `https://youtu.be/${id}?si=tracking`, canonical, `https://www.youtube.com/embed/${id}`, `https://youtube.com/shorts/${id}`, `https://www.youtube-nocookie.com/embed/${id}`])("normalizes an accepted YouTube reference: %s", value => {
    expect(auctioneerYoutubeUrl(value)).toBe(canonical);
  });
  it.each(["https://evil.test/video.mp4", "https://youtube.com.evil.test/watch?v=" + id, "http://youtu.be/" + id, "https://user:secret@youtu.be/" + id, "https://youtu.be:444/" + id, "https://youtu.be/short", "https://assetinsight.pro/clip.mp4", null])("does not send raw or malformed video references: %s", value => {
    expect(auctioneerYoutubeUrl(value)).toBeNull();
  });
  it("uses the frozen per-lot selection, including explicit no-video, never live/root fallback", () => {
    expect(frozenAuctioneerVideo({ videoOrderVersion: 1, videoUrlsByLot: [null, canonical], previewData: { videoUrls: [canonical] } }, { video_urls: [canonical] }, 0)).toBeNull();
    expect(frozenAuctioneerVideo({ videoOrderVersion: 1, videoUrlsByLot: [null, canonical] }, {}, 1)).toBe(canonical);
    expect(frozenAuctioneerVideo({ previewData: { videoUrls: [canonical] } }, {}, 0)).toBeNull();
    expect(frozenAuctioneerVideo({}, { videoUrls: [canonical] }, 0)).toBeNull();
    expect(frozenAuctioneerVideo({ previewData: { lots: [{ videoUrls: [canonical] }] } }, { videoUrls: ["https://youtu.be/ZyXwVuTsR_2"] }, 0)).toBe(canonical);
    expect(() => frozenAuctioneerVideo({ videoOrderVersion: 1, videoUrlsByLot: [] }, {}, 0)).toThrow();
  });
  it("logs stack locations without raw provider messages or signed URLs", () => {
    const error = new Error("Authorization Bearer secret-token https://storage.test/private?signature=secret");
    error.stack += "\n    at remote (https://storage.test/private?signature=secret:1:1)";
    const result = JSON.stringify(deliveryErrorDiagnostic(error));
    expect(result).toContain("auctioneer2-video-policy.test.ts");
    expect(result).not.toMatch(/secret|Authorization|storage\.test/);
    expect(deliveryErrorDiagnostic({ token: "secret" })).toEqual({ name: "Error", stack: "" });
  });
});
