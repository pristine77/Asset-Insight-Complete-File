import type { Response } from "express";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import YoutubeVideo from "../models/youtubeVideo.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { getYoutubeConnection } from "../service/youtubeConnectionService.js";
import { youtubeDataFresh, youtubeReceiptEligible, youtubePublicationCurrent, youtubeReleaseEligible, YOUTUBE_RELEASE_FIELDS } from "../service/youtubeVideoPolicy.js";

const reportModel = (type: string): any => type === "asset" ? AssetReport : LotListing;
function publicationRetryKind(report: any, receipt: any, connection: Awaited<ReturnType<typeof getYoutubeConnection>>): "upload" | "publication" | null {
  if (!connection || !youtubePublicationCurrent(receipt) || !youtubeReceiptEligible(report, receipt) || report.job_status !== "done" ||
    report.files_generating || report.files_regenerating || connection.channelId !== receipt.channelId ||
    connection.revision !== receipt.connectionRevision || (receipt.leaseUntil && receipt.leaseUntil > new Date())) return null;
  if (!receipt.videoId && ["uploading", "needs_attention"].includes(receipt.status) &&
    (!report.youtube_submission?.uploadGenerationToken || report.youtube_submission.uploadGenerationToken === receipt.generationToken)) return "upload";
  if (receipt.videoId && receipt.visibilityPending && ["private", "unlisted", "public", "needs_attention"].includes(receipt.status) &&
    youtubeReleaseEligible(report, receipt)) return "publication";
  return null;
}

export async function listAdminYoutubeVideos(req: AdminAuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  const page = Number(req.query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 || Object.keys(req.query).some((key) => key !== "page")) {
    return res.status(400).json({ message: "Enter a valid video history page." });
  }
  try {
    const [receipts, total, connection] = await Promise.all([
      YoutubeVideo.find().select("+sourceUrl +description +publicationToken").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20).lean(),
      YoutubeVideo.countDocuments(), getYoutubeConnection(),
    ]);
    // Authenticated channel administrators inspect automatic publication status.
    // Source URIs, credentials and original report contents remain private.
    const items = await Promise.all(receipts.map(async (receipt) => {
      if (!youtubeDataFresh(receipt)) return { id: receipt._id, reportType: null, reportId: null, lotNumber: "", status: "data_removed",
        title: "", description: "", metadataOmitted: false, privacyStatus: null, reviewRequired: false, reviewEligible: false, url: null,
        publicationMode: "automatic_public", targetPrivacyStatus: "public",
        lastError: null, updatedAt: (receipt.updatedAt || receipt.dataRemovedAt || receipt.createdAt)?.toISOString() || null, retryEligible: false, retryKind: null, nextAttemptAt: null };
      let retryKind: "upload" | "publication" | null = null;
      let staleQueuedVersion = false;
      const metadataOmitted = (receipt.title?.length || 0) > 1000 || (receipt.description?.length || 0) > 10_000;
      if (receipt.status !== "data_removed" && connection?.channelId === receipt.channelId && connection.revision === receipt.connectionRevision &&
        (!receipt.leaseUntil || receipt.leaseUntil <= new Date())) {
        const report = await reportModel(receipt.reportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
        retryKind = publicationRetryKind(report, receipt, connection);
        // An old queued submission is not permission to upload a later saved
        // version. Explain the fence without changing its receipt or retry state.
        staleQueuedVersion = !receipt.videoId && ["queued", "pending_review"].includes(receipt.status) &&
          Boolean(report && String(report.user?._id || report.user) === String(receipt.ownerId) &&
            (String(report.job_id) !== receipt.generationToken || report.youtube_submission?.generationToken !== receipt.generationToken));
      }
      return {
        id: receipt._id, reportType: receipt.reportType || null, reportId: receipt.reportId ? String(receipt.reportId) : null,
        lotNumber: receipt.lotNumber || "", status: staleQueuedVersion ? "needs_attention" : receipt.status,
        title: metadataOmitted ? "" : receipt.title || "", description: metadataOmitted ? "" : receipt.description || "", metadataOmitted,
        privacyStatus: receipt.status === "data_removed" ? null : receipt.privacyStatus || "private",
        reviewRequired: false, reviewEligible: false, publicationMode: "automatic_public", targetPrivacyStatus: "public",
        url: receipt.providerAvailable !== false && ["public", "unlisted"].includes(receipt.status || "") ? receipt.url || null : null,
        lastError: staleQueuedVersion
          ? "This video belongs to an older saved report version. Open the current report and submit its video again, or contact support. No replacement upload was started."
          : ["queued", "pending_review"].includes(receipt.status) ? null : receipt.lastError || null,
        updatedAt: receipt.updatedAt.toISOString(), retryEligible: Boolean(retryKind), retryKind,
        nextAttemptAt: retryKind === "upload" && receipt.status === "uploading" && receipt.uploadAttempts < 5 && receipt.nextAttemptAt && receipt.nextAttemptAt > new Date()
          ? receipt.nextAttemptAt.toISOString() : null,
      };
    }));
    return res.json({ items, page, total, totalPages: Math.ceil(total / 20) });
  } catch {
    return res.status(500).json({ message: "Video status could not be loaded. Try again." });
  }
}

export async function reviewAdminYoutubeVideo(req: AdminAuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  return res.status(410).json({ code: "YOUTUBE_REVIEW_REMOVED",
    message: "Video review is no longer required. Eligible report videos are queued automatically for public publication." });
}

export async function retryAdminYoutubePublication(req: AdminAuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  const id = String(req.params.id || "");
  const rawDate = req.body?.updatedAt;
  if (!/^[a-f0-9]{64}$/.test(id) || Object.keys(req.query).length || !req.body || Object.keys(req.body).length !== 1 ||
    typeof rawDate !== "string" || !Number.isFinite(Date.parse(rawDate))) return res.status(400).json({ code: "YOUTUBE_RETRY_INVALID", message: "A current video receipt is required." });
  try {
    const receipt = await YoutubeVideo.findById(id).select("+sourceUrl +description +publicationToken").lean();
    if (!receipt) return res.status(404).json({ code: "YOUTUBE_VIDEO_NOT_FOUND", message: "Video receipt not found." });
    const connection = await getYoutubeConnection();
    const report = await reportModel(receipt.reportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
    const retryKind = publicationRetryKind(report, receipt, connection);
    if (!retryKind) {
      return res.status(409).json({ code: "YOUTUBE_RETRY_UNAVAILABLE", message: "This video cannot be retried now. Check its current report, automatic publication status and channel connection. No replacement upload was started." });
    }
    const updated = await YoutubeVideo.updateOne({ _id: id, status: receipt.status, publicationToken: receipt.publicationToken, updatedAt: new Date(rawDate),
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] }, {
      $set: { ...(retryKind === "upload" ? { status: "uploading", uploadAttempts: 0 } : {
        ...(receipt.status === "needs_attention" ? { status: "private" } : {}), publicationAttempts: 0,
      }), nextAttemptAt: new Date(), lastError: "", lastErrorCode: "" },
    });
    if (!updated.matchedCount) return res.status(409).json({ code: "YOUTUBE_RETRY_CHANGED", message: "Video status changed. Refresh before retrying." });
    return res.status(202).json({ message: retryKind === "upload"
      ? "Upload retry queued. Its saved session will be checked before sending more data; uncertain final uploads will not be replaced."
      : "Publication retry queued for the existing YouTube video. No new upload was started." });
  } catch {
    return res.status(500).json({ code: "YOUTUBE_RETRY_UNCONFIRMED", message: "Video retry could not be confirmed. Refresh video status before trying again." });
  }
}
