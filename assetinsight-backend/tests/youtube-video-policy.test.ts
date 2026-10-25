import { describe, expect, it } from "vitest";
import { trustedLotVideos, validateYoutubeReviewedMetadata, validateYoutubeSessionUrl, youtubeLotMetadata, youtubeAutomaticLotMetadata, youtubePublicationCurrent, YOUTUBE_PUBLICATION_POLICY_VERSION, youtubeReleaseEligible, youtubeUploadOffset, youtubeVideoIdentity, youtubeWatchUrl } from "../src/service/youtubeVideoPolicy.js";

const source = "https://assetinsight.test/clip.mp4";
const owner = "64b000000000000000000001";
const receipt = { sourceUrl: source, ownerId: owner, generationToken: "files-1", channelId: "channel-1", connectionRevision: 2 };
const approvedReport = () => ({
  user: owner, status: "approved", release_status: "released", job_id: "files-1", job_status: "done",
  youtube_videos_enabled: true, videoUrls: [source], preview_data: { lots: [{ lot_id: "lot-1", video_urls: [source] }] },
  youtube_submission: { generationToken: "files-1", channelId: "channel-1", connectionRevision: 2, ownerId: owner },
});

describe("YouTube media policy", () => {
  it("uses only assigned root-manifest originals once in lot order", () => {
    const first = { lot_id: "first", video_urls: ["forged", source, source], youtube_video_urls: ["https://evil.test"] };
    const second = { lot_id: "second", video_urls: [source, "other"] };
    expect(trustedLotVideos([first, second], [source, "other", "unassigned"])).toEqual([{ sourceUrl: source, lot: first }, { sourceUrl: "other", lot: second }]);
    expect(trustedLotVideos([first], undefined)).toEqual([]);
  });

  it("limits public metadata to lot number/title/description and strips markup/control characters", () => {
    const result = youtubeLotMetadata({ lot_number: "<b>009</b>", title: "Loader\u0000 <script>word</script>", description: "<p>Appraiser description</p>", user: { email: "private@example.test" }, contract_no: "PRIVATE CONTRACT", sourceUrl: "PRIVATE SOURCE", client_name: "PRIVATE OWNER" });
    expect(result).toEqual({ title: "Lot 009 — Loader word", description: "Lot 009 — Loader word\n\nAppraiser description", lotNumber: "009" });
    const bounded = youtubeLotMetadata({ title: "🚜".repeat(110), description: "É".repeat(6000) });
    expect(Array.from(bounded.title)).toHaveLength(110);
    expect(Buffer.byteLength(bounded.description)).toBeGreaterThan(5000);
    expect(bounded.description).not.toContain("�");
  });

  it("rejects rather than truncates reviewed metadata and requires explicit policy consent", () => {
    const valid = { title: "🚜".repeat(100), description: "é".repeat(2500), privacyStatus: "unlisted", policyConsent: true };
    expect(validateYoutubeReviewedMetadata(valid)).toBe(true);
    for (const change of [{ title: "x".repeat(101) }, { title: " " }, { title: "bad\nname" }, { title: "bad\ud800" }, { description: "bad\udc00" }, { description: "é".repeat(2501) }, { description: "<script>" }, { policyConsent: false }, { privacyStatus: "default" }]) expect(validateYoutubeReviewedMetadata({ ...valid, ...change })).toBe(false);
  });

  it("bounds automatic saved metadata for YouTube without splitting Unicode or exposing private fields", () => {
    const metadata = youtubeAutomaticLotMetadata({ title: "🚜".repeat(110), description: "é".repeat(6000),
      client_name: "PRIVATE", email: "PRIVATE", title_extra: "PRIVATE", sourceUrl: "PRIVATE" });
    expect(Array.from(metadata.title)).toHaveLength(100);
    expect(Buffer.byteLength(metadata.description, "utf8")).toBeLessThanOrEqual(5000);
    expect(metadata.description).not.toContain("�");
    expect(metadata.description).not.toContain("PRIVATE");
    expect(validateYoutubeReviewedMetadata({ ...metadata, privacyStatus: "public", policyConsent: true })).toBe(true);
    const invalidUnicode = youtubeAutomaticLotMetadata({ title: "Truck\ud800", description: "Details\udc00" });
    expect(invalidUnicode).toMatchObject({ title: "Truck", description: "Truck\n\nDetails" });
  });

  it("uses explicit system publication authority, never a fabricated human review", () => {
    const current = { generationToken: "current", publicationGenerationToken: "current", publicationToken: "system-authority",
      publicationPolicyVersion: YOUTUBE_PUBLICATION_POLICY_VERSION, publicationAuthorizedAt: new Date(), createdAt: new Date(),
      privacyStatus: "public", title: "Lot 1", description: "Saved lot" };
    expect(youtubePublicationCurrent(current)).toBe(true);
    for (const change of [{ publicationToken: undefined }, { publicationGenerationToken: "older" },
      { publicationPolicyVersion: "older" }, { publicationAuthorizedAt: undefined }, { privacyStatus: "private" },
      { status: "data_removed" }, { title: "x".repeat(101) }, { createdAt: new Date(0) }]) {
      expect(youtubePublicationCurrent({ ...current, ...change })).toBe(false);
    }
    expect(youtubePublicationCurrent({ ...current, publicationToken: undefined, reviewToken: "legacy-review", reviewedAt: new Date() })).toBe(false);
  });

  it("keeps retry identity stable while separating reports, media and channels", () => {
    const identity = youtubeVideoIdentity("asset", "report", source, "channel");
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(youtubeVideoIdentity("asset", "report", source, "channel")).toBe(identity);
    expect(new Set([identity, youtubeVideoIdentity("lotListing", "report", source, "channel"), youtubeVideoIdentity("asset", "other", source, "channel"), youtubeVideoIdentity("asset", "report", "other", "channel"), youtubeVideoIdentity("asset", "report", source, "other")]).size).toBe(5);
  });

  it.each(["https://evil.test/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", "http://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", "https://www.googleapis.com.evil.test/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", "https://user:password@www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", "https://www.googleapis.com:444/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x#fragment", "https://www.googleapis.com/wrong?uploadType=resumable&upload_id=x", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable"])("rejects unsafe upload capabilities %s", (url) => {
    expect(() => validateYoutubeSessionUrl(url)).toThrow();
  });

  it("accepts only canonical video identifiers and bounded resumable offsets", () => {
    expect(youtubeWatchUrl("AbCdEfGhI_1")).toBe("https://www.youtube.com/watch?v=AbCdEfGhI_1");
    for (const id of [undefined, 123, "short", "AbCdEfGhI_1&bad=1", "<script>"]) expect(() => youtubeWatchUrl(id)).toThrow();
    expect(youtubeUploadOffset(null, 8)).toBe(0);
    expect(youtubeUploadOffset("bytes=0-3", 8)).toBe(4);
    expect(youtubeUploadOffset("bytes=0-7", 8)).toBe(8);
    for (const range of ["bytes=1-3", "bytes=0-8", "bytes=0--1", "bytes=0-9007199254740992", "unexpected"]) expect(() => youtubeUploadOffset(range, 8)).toThrow();
  });

  it("requires current explicit approval, release, ownership and exact-generation video association", () => {
    expect(youtubeReleaseEligible(approvedReport(), receipt)).toBe(true);
    const mutations = [
      { youtube_videos_enabled: false }, { status: "preview" }, { status: "error" }, { release_status: "pending_release" },
      { archived: true }, { adminArchivedAt: new Date() }, { is_draft_preview: true }, { files_generating: true }, { files_regenerating: true },
      { user: "64b000000000000000000002" }, { job_id: "old" }, { job_status: "processing" },
      { youtube_submission: undefined }, { videoUrls: [] }, { preview_data: { lots: [] } },
    ];
    for (const mutation of mutations) expect(youtubeReleaseEligible({ ...approvedReport(), ...mutation }, receipt), JSON.stringify(mutation)).toBe(false);
    for (const mutation of [{ channelId: "other" }, { connectionRevision: 1 }, { generationToken: "old" }]) {
      const report = approvedReport();
      report.youtube_submission = { ...report.youtube_submission, ...mutation };
      expect(youtubeReleaseEligible(report, receipt)).toBe(false);
    }
  });
});
