/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Late lot videos for Auctioneer 2.0
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-11-20 ("Yes, build it"): a lot's video reaches Auctioneer 2.0
 * only as its YouTube link, and the delivery fixes that link when the lot is
 * SENT (auctioneer2VideoManifest.ts: only a Public or Unlisted video counts).
 * A Lot Listing can be sent as soon as its report is ready — before its clip
 * has finished uploading to YouTube and turned Public, or while YouTube's daily
 * upload limit holds it back (18 Nov 2026: 11 clips stopped that way). Such a
 * lot reached Auctioneer without its video, and nothing sent the link later.
 *
 * This sweep (run with the YouTube maintenance in the report worker) takes
 * each Public/Unlisted video not yet checked, finds the delivery of its
 * report, and for every lot that delivery SENT without a video, whose saved
 * lot (the delivery's frozen manifest, never the live report) carries this
 * very clip, sets the lot's video in Auctioneer through the same link-only
 * call the delivery uses (setLotVideo; Auctioneer accepts a video on its own,
 * after the photos, and treats the same link again as a no-op).
 *
 * Kept to the delivery's own rules:
 * - The video must pass the same authorization the delivery checks before it
 *   sends a link (assertAuctioneerVideoReceipt: Public/Unlisted confirmed by
 *   YouTube, report approved and released, same owner, generation and lot).
 * - Only the lot that carried this clip when it was sent; a lot whose saved
 *   data names a different video link keeps that one. A delivery from before
 *   manifests kept their lots is left alone (nothing says which lot it was).
 * - Proposal items returned for review are not lots and are skipped.
 * - A delivery being sent right now is not touched; the video waits until it
 *   finishes. One that failed or awaits reconciliation is idle, so its lots
 *   already sent are given the video and the rest are checked again later.
 * - Each lot is recorded on its checkpoint (videoUploadedAt + videoSentLateAt)
 *   with an update that only applies while it is still unrecorded, so a lot is
 *   sent once; a repeat after a lost answer is Auctioneer's no-op.
 * - Failures retry with growing gaps and stop after MAX_ATTEMPTS, recorded on
 *   the video (auctioneerVideoError) for support.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import AssetReport from "../models/asset.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import LotListing from "../models/lotListing.model.js";
import YoutubeVideo from "../models/youtubeVideo.model.js";
import { Auctioneer2ClientError, getAuctioneer2ConfigStatus, setLotVideo } from "./auctioneer2Client.js";
import { AuctioneerDeliveryError } from "./auctioneer2DeliveryError.js";
import { assertAuctioneerVideoReceipt } from "./auctioneer2VideoManifest.js";
import { auctioneerYoutubeUrl, frozenAuctioneerVideo, lotVideoSources } from "./auctioneer2VideoPolicy.js";
import { YOUTUBE_RELEASE_FIELDS, type YoutubeReportType } from "./youtubeVideoPolicy.js";

/** Videos looked at per sweep. */
const BATCH = 25;
/** How long one worker holds a video while it sends; another worker skips it meanwhile. */
const LEASE_MS = 2 * 60_000;
/** A delivery being sent right now: look again after this. */
const WAIT_WHILE_SENDING_MS = 5 * 60_000;
/** A delivery that may still send more lots (failed, awaiting reconciliation): look again after this. */
const WAIT_FOR_UNFINISHED_MS = 30 * 60_000;
/** Failures before the video is left for support. */
export const LATE_VIDEO_MAX_ATTEMPTS = 8;

const ACTIVE_DELIVERY = new Set(["queued", "sending"]);

type Outcome = {
  /** Lots that received the link in this pass. */
  lotsSent: number;
  /** Nothing is left for this video to give its link to. */
  done: boolean;
  /** Look again after this long without counting a failure. */
  waitMs?: number;
  /** A failure to retry (counted). */
  error?: string;
};

const clean = (value: unknown) => String(value ?? "").trim();

function safeMessage(error: unknown): string {
  if (error instanceof AuctioneerDeliveryError || error instanceof Auctioneer2ClientError) return error.message;
  return "The lot video could not be sent to Auctioneer 2.0. It will be retried.";
}

/** The Auctioneer lot the delivery sent this checkpoint's lot to, the same id it gave setLotVideo. */
function auctioneerLotId(kind: string, checkpoint: any, lot: any): string {
  const created = clean(checkpoint?.createdLotId);
  if (created) return created;
  // A Schedule A line patches the lot that already exists for it; its splits
  // are created (and so carry createdLotId above).
  if (kind === "scheduleA" && !clean(lot?.auctioneer_source_parent_key)) return clean(checkpoint?.sourceLotId);
  return "";
}

async function deliverLateVideo(receipt: any): Promise<Outcome> {
  const reportType = receipt.reportType as YoutubeReportType;
  const workItem: any = await AuctioneerWorkItem.findOne({ linkedReportId: receipt.reportId })
    .select("kind selectedReportType delivery.status delivery.manifest delivery.lots contract.contractNo")
    .lean();
  // Not sent to Auctioneer yet: the Send freezes the Public link itself.
  if (!workItem || workItem.selectedReportType !== reportType || !workItem.delivery?.manifest) return { lotsSent: 0, done: true };
  const status = clean(workItem.delivery.status);
  if (ACTIVE_DELIVERY.has(status)) return { lotsSent: 0, done: false, waitMs: WAIT_WHILE_SENDING_MS };

  const manifest = workItem.delivery.manifest as any;
  const frozenLots: any[] | null = Array.isArray(manifest?.previewData?.lots) ? manifest.previewData.lots : null;
  if (!frozenLots) return { lotsSent: 0, done: true };

  const url = auctioneerYoutubeUrl(receipt.url);
  if (!url) return { lotsSent: 0, done: true, error: "YouTube gave this video no usable link." };
  const reportModel: any = reportType === "asset" ? AssetReport : LotListing;
  const report = await reportModel.findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
  if (!report) return { lotsSent: 0, done: true };
  // The same check the delivery makes before sending a frozen link; throws when
  // the video or its report is no longer authorized (retried, then left).
  await assertAuctioneerVideoReceipt(report, reportType, String(receipt._id), url);

  const checkpoints: any[] = Array.isArray(workItem.delivery.lots) ? workItem.delivery.lots : [];
  let lotsSent = 0;
  let failure = "";
  for (let index = 0; index < frozenLots.length; index += 1) {
    const lot = frozenLots[index];
    const checkpoint = checkpoints[index];
    if (!checkpoint || checkpoint.status !== "sent" || checkpoint.videoUploadedAt || checkpoint.step === "returned") continue;
    if (!lotVideoSources(lot).includes(receipt.sourceUrl)) continue;
    let frozen: string | null;
    try { frozen = frozenAuctioneerVideo(manifest, lot, index); } catch { continue; }
    // The lot names another video link; that one stays.
    if (frozen && frozen !== url) continue;
    const lotId = auctioneerLotId(workItem.kind, checkpoint, lot);
    if (!lotId) continue;
    try {
      await setLotVideo(lotId, url);
    } catch (error) {
      failure = safeMessage(error);
      console.error("[Auctioneer2LateVideo] sending the lot video failed", {
        videoId: String(receipt._id), workItemId: String(workItem._id), contractNo: clean(workItem.contract?.contractNo), lotIndex: index, message: failure,
      });
      continue;
    }
    const path = `delivery.lots.${index}`;
    const now = new Date();
    await AuctioneerWorkItem.updateOne(
      { _id: workItem._id, "delivery.status": { $nin: [...ACTIVE_DELIVERY] }, [`${path}.sourceKey`]: checkpoint.sourceKey, [`${path}.videoUploadedAt`]: { $exists: false } },
      { $set: { [`${path}.videoUploadedAt`]: now, [`${path}.videoSentLateAt`]: now } },
    );
    lotsSent += 1;
    console.info("[Auctioneer2LateVideo] lot video sent after the lot", {
      videoId: String(receipt._id), workItemId: String(workItem._id), contractNo: clean(workItem.contract?.contractNo), lotIndex: index, auctioneerLotId: lotId,
    });
  }
  if (failure) return { lotsSent, done: false, error: failure };
  // A finished delivery sends no more lots; an idle unfinished one may.
  if (status !== "sent") return { lotsSent, done: false, waitMs: WAIT_FOR_UNFINISHED_MS };
  return { lotsSent, done: true };
}

async function recordOutcome(receipt: any, outcome: Outcome): Promise<void> {
  const now = Date.now();
  const lotsSent = (receipt.auctioneerVideoLotsSent || 0) + outcome.lotsSent;
  const base = { auctioneerVideoLotsSent: lotsSent };
  if (outcome.done) {
    await YoutubeVideo.updateOne({ _id: receipt._id }, {
      $set: { ...base, auctioneerVideoCheckedAt: new Date(now), ...(outcome.error ? { auctioneerVideoError: outcome.error } : {}) },
      $unset: { auctioneerVideoLeaseUntil: 1, auctioneerVideoNextAt: 1, ...(outcome.error ? {} : { auctioneerVideoError: 1 }) },
    });
    return;
  }
  if (!outcome.error) {
    await YoutubeVideo.updateOne({ _id: receipt._id }, {
      $set: { ...base, auctioneerVideoNextAt: new Date(now + (outcome.waitMs || WAIT_FOR_UNFINISHED_MS)) },
      $unset: { auctioneerVideoLeaseUntil: 1 },
    });
    return;
  }
  const attempts = (receipt.auctioneerVideoAttempts || 0) + 1;
  if (attempts >= LATE_VIDEO_MAX_ATTEMPTS) {
    console.error("[Auctioneer2LateVideo] giving up on a lot video", { videoId: String(receipt._id), attempts, message: outcome.error });
    await YoutubeVideo.updateOne({ _id: receipt._id }, {
      $set: { ...base, auctioneerVideoAttempts: attempts, auctioneerVideoError: outcome.error, auctioneerVideoCheckedAt: new Date(now) },
      $unset: { auctioneerVideoLeaseUntil: 1, auctioneerVideoNextAt: 1 },
    });
    return;
  }
  // 5 min, 10, 20, 40 … at most 6 hours apart.
  const gap = Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (attempts - 1));
  await YoutubeVideo.updateOne({ _id: receipt._id }, {
    $set: { ...base, auctioneerVideoAttempts: attempts, auctioneerVideoError: outcome.error, auctioneerVideoNextAt: new Date(now + gap) },
    $unset: { auctioneerVideoLeaseUntil: 1 },
  });
}

/**
 * One sweep: gives Auctioneer the link of each Public video whose lot was sent
 * without it. Returns how many lots received a link. Does nothing while the
 * Auctioneer 2.0 connection is switched off or not configured.
 */
export async function sendLateAuctioneerVideos(signal?: AbortSignal): Promise<number> {
  const config = getAuctioneer2ConfigStatus();
  if (!config.enabled || !config.configured) return 0;
  const now = new Date();
  const candidates = await YoutubeVideo.find({
    status: { $in: ["public", "unlisted"] },
    providerAvailable: true,
    auctioneerVideoCheckedAt: { $exists: false },
    $and: [
      { $or: [{ auctioneerVideoNextAt: { $exists: false } }, { auctioneerVideoNextAt: { $lte: now } }] },
      { $or: [{ auctioneerVideoLeaseUntil: { $exists: false } }, { auctioneerVideoLeaseUntil: { $lte: now } }] },
    ],
  }).select("_id").sort({ updatedAt: 1, _id: 1 }).limit(BATCH).lean();

  let sent = 0;
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    // Claim it so a second worker does not send the same video at the same time.
    const receipt: any = await YoutubeVideo.findOneAndUpdate(
      {
        _id: candidate._id,
        auctioneerVideoCheckedAt: { $exists: false },
        $or: [{ auctioneerVideoLeaseUntil: { $exists: false } }, { auctioneerVideoLeaseUntil: { $lte: new Date() } }],
      },
      { $set: { auctioneerVideoLeaseUntil: new Date(Date.now() + LEASE_MS) } },
      { returnDocument: "after" },
    ).select("+sourceUrl").lean();
    if (!receipt) continue;
    let outcome: Outcome;
    try {
      outcome = await deliverLateVideo(receipt);
    } catch (error) {
      outcome = { lotsSent: 0, done: false, error: safeMessage(error) };
    }
    sent += outcome.lotsSent;
    await recordOutcome(receipt, outcome);
  }
  return sent;
}
