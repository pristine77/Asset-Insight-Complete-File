import YoutubeVideo from "../models/youtubeVideo.model.js";
import { youtubeDataFresh, youtubeReceiptEligible, youtubeReleaseEligible, youtubeReviewCurrent, youtubePublicationCurrent, type YoutubeReportType } from "./youtubeVideoPolicy.js";
import { auctioneerYoutubeUrl, lotVideoSources } from "./auctioneer2VideoPolicy.js";
import { AuctioneerDeliveryError } from "./auctioneer2DeliveryError.js";

function eligible(report: any, receipt: any) {
  return receipt && ["public", "unlisted"].includes(receipt.status) && receipt.privacyStatus === receipt.status &&
    receipt.visibilityPending !== true && receipt.providerAvailable === true &&
    youtubeDataFresh(receipt) && (youtubePublicationCurrent(receipt) || youtubeReviewCurrent(receipt)) &&
    youtubeReceiptEligible(report, receipt) && youtubeReleaseEligible(report, receipt);
}

/** Freeze only the exact lot's explicit link or currently published, authorized receipt. */
export async function buildAuctioneerVideoManifest(report: any, reportType: YoutubeReportType, lots: any[]) {
  const links = new Map<string, { url: string; receiptId: string }>();
  if (report.youtube_videos_enabled && report.youtube_submission) {
    const receipts = await YoutubeVideo.find({ reportType, reportId: report._id, ownerId: report.user,
      channelId: report.youtube_submission.channelId, status: { $in: ["public", "unlisted"] },
      providerAvailable: true }).select("+sourceUrl +reviewToken +publicationToken +description").sort({ createdAt: 1 }).lean();
    for (const receipt of receipts) {
      const url = auctioneerYoutubeUrl(receipt.url);
      if (url && eligible(report, receipt)) links.set(receipt.sourceUrl, { url, receiptId: String(receipt._id) });
    }
  }
  const selected = lots.map(lot => lotVideoSources(lot).map(source => {
    const direct = auctioneerYoutubeUrl(source);
    return direct ? { url: direct, receiptId: null } : links.get(source);
  }).find(Boolean));
  return { videoUrlsByLot: selected.map(value => value?.url || null), videoReceiptIdsByLot: selected.map(value => value?.receiptId || null) };
}

export async function assertAuctioneerVideoReceipt(report: any, reportType: YoutubeReportType, receiptId: string, url: string): Promise<void> {
  const receipt = await YoutubeVideo.findOne({ _id: receiptId, reportId: report._id, reportType, ownerId: report.user }).select("+sourceUrl +reviewToken +publicationToken +description").lean();
  if (!eligible(report, receipt) || auctioneerYoutubeUrl(receipt?.url) !== url) {
    throw new AuctioneerDeliveryError("The saved lot video is no longer authorized or available for publication. Ask support to review this delivery; photos already accepted are preserved.");
  }
}
