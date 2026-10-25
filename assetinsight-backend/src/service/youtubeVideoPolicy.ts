import { createHash } from "node:crypto";

export type YoutubeReportType = "asset" | "lotListing";
export type YoutubeSubmission = {
  generationToken: string;
  uploadGenerationToken?: string;
  channelId: string;
  connectionRevision: number;
  ownerId: string;
};
export const YOUTUBE_CHUNK_BYTES = 8 * 1024 * 1024;
export type YoutubePrivacyStatus = "private" | "unlisted" | "public";
export const YOUTUBE_REVIEW_POLICY_VERSION = "youtube-video-review-v1";
export const YOUTUBE_PUBLICATION_POLICY_VERSION = "youtube-automatic-public-v1";
export function youtubeDataFresh(receipt: any, now = Date.now()): boolean {
  return receipt?.status !== "data_removed" && new Date(receipt?.providerDataCheckedAt || receipt?.uploadedAt || receipt?.createdAt).getTime() > now - 30 * 86400_000;
}
export const YOUTUBE_RELEASE_FIELDS = "user status release_status archived adminArchivedAt is_draft_preview files_generating files_regenerating job_id job_status videoUrls preview_data.lots.video_urls preview_data.lots.lot_id preview_data.lots.lot_number preview_data.lots.title preview_data.lots.description lots.video_urls lots.lot_id lots.lot_number lots.title lots.description youtube_videos_enabled +youtube_submission";

export function youtubeVideoIdentity(type: YoutubeReportType, reportId: string, sourceUrl: string, channelId: string) {
  return createHash("sha256").update(JSON.stringify([type, reportId, sourceUrl, channelId])).digest("hex");
}

function plain(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
/** Public metadata is intentionally an allowlist, not serialized report data. */
export function youtubeLotMetadata(lot: any) {
  const lotNumber = plain(lot?.lot_number).slice(0, 64);
  const heading = [lotNumber ? `Lot ${lotNumber}` : "", plain(lot?.title)].filter(Boolean).join(" — ");
  // This is a proposal for a human to review, never permission to transmit.
  // Do not silently truncate the user's description/title to fit provider limits.
  const title = heading || "Asset Insight lot video";
  const details = plain(lot?.description);
  return { title, description: [title, details].filter(Boolean).join("\n\n"), lotNumber };
}

/** Saved lot details only; no new analysis, report serialization or human review. */
export function youtubeAutomaticLotMetadata(lot: any) {
  const metadata = youtubeLotMetadata(lot);
  const wellFormed = (value: string) => value.replace(/[\ud800-\udfff]/gu, "");
  const title = Array.from(wellFormed(metadata.title)).slice(0, 100).join("") || "Asset Insight lot video";
  let description = "";
  let bytes = 0;
  for (const character of wellFormed(metadata.description)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 5000) break;
    description += character;
    bytes += size;
  }
  return { title, description, lotNumber: metadata.lotNumber };
}

export function validateYoutubeReviewedMetadata(value: any): value is { title: string; description: string; privacyStatus: YoutubePrivacyStatus; policyConsent: true } {
  return typeof value?.title === "string" && Boolean(value.title.trim()) && Array.from(value.title).length <= 100 &&
    !/[<>\u0000-\u001f\u007f\ud800-\udfff]/u.test(value.title) && typeof value.description === "string" &&
    Buffer.byteLength(value.description, "utf8") <= 5000 && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value.description) &&
    ["private", "unlisted", "public"].includes(value.privacyStatus) && value.policyConsent === true;
}

export function youtubeReviewCurrent(receipt: any): boolean {
  return Boolean(receipt && youtubeDataFresh(receipt) && receipt.reviewToken && receipt.reviewedAt &&
    receipt.reviewPolicyVersion === YOUTUBE_REVIEW_POLICY_VERSION && receipt.reviewGenerationToken === receipt.generationToken &&
    validateYoutubeReviewedMetadata({ ...receipt, policyConsent: true }));
}

/** System authorization is separate from retained historical human-review audit. */
export function youtubePublicationCurrent(receipt: any): boolean {
  return Boolean(receipt && youtubeDataFresh(receipt) && typeof receipt.publicationToken === "string" && receipt.publicationToken &&
    receipt.publicationAuthorizedAt && receipt.publicationPolicyVersion === YOUTUBE_PUBLICATION_POLICY_VERSION &&
    receipt.publicationGenerationToken === receipt.generationToken && receipt.privacyStatus === "public" &&
    validateYoutubeReviewedMetadata({ ...receipt, policyConsent: true }));
}

/** Current parent authority; neither approval nor review is inferred from a URL. */
export function youtubeReceiptEligible(report: any, receipt: any): boolean {
  const intent = report?.youtube_submission;
  if (!report || receipt?.status === "data_removed" || !report.youtube_videos_enabled || !intent ||
    report.archived || report.adminArchivedAt || report.is_draft_preview ||
    String(report.user?._id || report.user) !== String(receipt.ownerId) ||
    String(report.job_id) !== receipt.generationToken ||
    intent.generationToken !== receipt.generationToken || intent.channelId !== receipt.channelId ||
    intent.connectionRevision !== receipt.connectionRevision || String(intent.ownerId) !== String(receipt.ownerId)) return false;
  const assigned = (report.preview_data?.lots || report.lots || []).filter((lot: any) =>
    trustedLotVideos([lot], report.videoUrls).some(({ sourceUrl }) => sourceUrl === receipt.sourceUrl));
  return assigned.length === 1 && (!receipt.lotId || String(assigned[0].lot_id || "") === receipt.lotId);
}

export function trustedLotVideos(lots: any[], rootUrls: unknown): Array<{ sourceUrl: string; lot: any }> {
  const allowed = new Set(Array.isArray(rootUrls) ? rootUrls.filter((url) => typeof url === "string") : []);
  const used = new Set<string>();
  const result: Array<{ sourceUrl: string; lot: any }> = [];
  for (const lot of lots) {
    for (const url of Array.isArray(lot?.video_urls) ? lot.video_urls : []) {
      if (typeof url !== "string" || !allowed.has(url) || used.has(url)) continue;
      used.add(url);
      result.push({ sourceUrl: url, lot });
    }
  }
  return result;
}

export function youtubeWatchUrl(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error("YouTube returned an invalid video identifier.");
  return `https://www.youtube.com/watch?v=${id}`;
}

export function validateYoutubeSessionUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" || url.port ||
    url.username || url.password || url.hash || url.pathname !== "/upload/youtube/v3/videos" ||
    url.searchParams.get("uploadType") !== "resumable" || !url.searchParams.get("upload_id")) {
    throw new Error("YouTube returned an invalid upload session.");
  }
  return url.href;
}

export function youtubeUploadOffset(range: string | null, total: number): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > total) throw new Error("YouTube returned an invalid upload offset.");
  return offset;
}

export function youtubeReleaseEligible(report: any, receipt: any): boolean {
  const intent = report?.youtube_submission;
  return Boolean(receipt?.status !== "data_removed" && report && report.youtube_videos_enabled === true && intent && report.status === "approved" && report.release_status === "released" &&
    !report.archived && !report.adminArchivedAt && !report.is_draft_preview && !report.files_generating && !report.files_regenerating &&
    String(report.user?._id || report.user) === String(receipt.ownerId) &&
    String(report.job_id) === receipt.generationToken && report.job_status === "done" &&
    intent.generationToken === receipt.generationToken && intent.channelId === receipt.channelId &&
    intent.connectionRevision === receipt.connectionRevision &&
    trustedLotVideos(report.preview_data?.lots || report.lots || [], report.videoUrls)
      .some(({ sourceUrl }) => sourceUrl === receipt.sourceUrl));
}
