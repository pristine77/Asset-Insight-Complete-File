import { randomUUID } from "node:crypto";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import YoutubeVideo from "../models/youtubeVideo.model.js";
import { getYoutubeConnection, assertYoutubeConnection, getYoutubeAccessToken, encryptYoutubeSecret, decryptYoutubeSecret } from "./youtubeConnectionService.js";
import { headR2Object, readR2ObjectRange, resolveR2ObjectLocationFromUrl } from "../utils/r2Storage/r2Upload.js";
import { checkYoutubeUpload, publishYoutubeVideo, readYoutubeVideoStates, sendYoutubeChunk, startYoutubeUpload, YoutubeProviderError, type YoutubeUploadResult } from "./youtubeVideoClient.js";
import { trustedLotVideos, youtubeAutomaticLotMetadata, youtubeReceiptEligible, youtubePublicationCurrent, youtubeReleaseEligible, youtubeVideoIdentity, YOUTUBE_PUBLICATION_POLICY_VERSION, YOUTUBE_CHUNK_BYTES, YOUTUBE_RELEASE_FIELDS, type YoutubeReportType, type YoutubeSubmission } from "./youtubeVideoPolicy.js";

const modelFor = (type: YoutubeReportType): any => type === "asset" ? AssetReport : LotListing;
const LEASE_MS = 5 * 60_000;
const safeError = (error: unknown) => error instanceof YoutubeProviderError ? error.message :
  "YouTube video preparation could not finish. Originals are retained. Check the channel connection and video status in Admin YouTube.";
const safeErrorCode = (error: unknown) => error instanceof YoutubeProviderError ? error.code : "YOUTUBE_PREPARATION_FAILED";

/** Called only by explicit submit/resubmit; saved in the same parent CAS/outbox. */
export async function attachYoutubeSubmission(report: any, generationToken: string): Promise<void> {
  if (!Array.isArray(report.videoUrls) || !report.videoUrls.length) return;
  const connection = await getYoutubeConnection();
  if (!connection) return;
  report.set("youtube_videos_enabled", true);
  report.set("youtube_submission", {
    generationToken, uploadGenerationToken: generationToken, channelId: connection.channelId, connectionRevision: connection.revision,
    ownerId: String(report.user?._id || report.user),
  } satisfies YoutubeSubmission);
}

export async function readReportYoutubeLinks(input: { reportType: YoutubeReportType; reportId: string; enabled?: boolean }): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (!input.enabled) return links;
  const report = await modelFor(input.reportType).findById(input.reportId).select("user videoUrls +youtube_submission").lean();
  if (!report) return links;
  const allowed = new Set(report.videoUrls || []);
  const receipts = await YoutubeVideo.find({ reportType: input.reportType, reportId: input.reportId,
    ownerId: report.user, ...(report.youtube_submission?.channelId ? { channelId: report.youtube_submission.channelId } : {}),
    status: { $ne: "data_removed" }, providerAvailable: { $ne: false }, videoId: { $exists: true }, url: { $exists: true } }).select("+sourceUrl").sort({ createdAt: 1 }).lean();
  const cutoff = Date.now() - 30 * 86400_000;
  for (const receipt of receipts) if (allowed.has(receipt.sourceUrl) &&
    new Date(receipt.providerDataCheckedAt || receipt.uploadedAt || receipt.createdAt).getTime() > cutoff) links.set(receipt.sourceUrl, receipt.url!);
  return links;
}

export async function prepareReportYoutubeVideos(input: {
  reportType: YoutubeReportType; reportId: string; enabled?: boolean; generationToken: string;
  lots: any[]; assertOwned: () => Promise<void>; existingUploadsOnly?: boolean;
}): Promise<Map<string, string>> {
  if (!input.enabled) return new Map();
  await input.assertOwned();
  const report = await modelFor(input.reportType).findById(input.reportId).select("user job_id videoUrls youtube_videos_enabled +youtube_submission").lean();
  if (!report?.youtube_videos_enabled) return new Map();
  const intent = report?.youtube_submission as YoutubeSubmission | undefined;
  const sources = trustedLotVideos(input.lots, report.videoUrls);
  // Validate before either an explicit upload or an artifact-only carry. Never
  // silently choose one lot's public metadata for a shared original.
  const assigned = new Map<string, number>();
  for (let index = 0; index < input.lots.length; index += 1) {
    for (const { sourceUrl } of trustedLotVideos([input.lots[index]], report.videoUrls)) {
      if (assigned.has(sourceUrl) && assigned.get(sourceUrl) !== index) {
        throw new YoutubeProviderError("YOUTUBE_LOT_MAPPING_AMBIGUOUS", "The same video is assigned to more than one lot. Review the lot associations before submitting. Originals are retained.");
      }
      assigned.set(sourceUrl, index);
    }
  }
  // Artifact-only regeneration can carry already-uploaded clips forward, but
  // never gains authority to create an upload, even after a worker restart.
  if (!intent) return readReportYoutubeLinks(input);
  if (input.existingUploadsOnly || intent.generationToken !== input.generationToken ||
    (intent.uploadGenerationToken && intent.uploadGenerationToken !== input.generationToken)) {
    await carryExistingYoutubeAuthority(input, report, intent);
    return readReportYoutubeLinks(input);
  }
  if (String(report.user) !== intent.ownerId || report.job_id !== input.generationToken) throw new Error("YouTube submission ownership changed.");
  // Optional channel setup must not block the report's own artifact generation.
  const connection = await getYoutubeConnection();
  if (!connection || connection.channelId !== intent.channelId || connection.revision !== intent.connectionRevision) return readReportYoutubeLinks(input);
  // Root originals can include clips from removed lots. Retain them in storage,
  // but publish only explicitly associated current lots and never guess a lot.
  for (const { sourceUrl, lot } of sources) {
    await queueVideoReview({ ...input, intent, sourceUrl, lot });
  }
  return readReportYoutubeLinks(input);
}

async function carryExistingYoutubeAuthority(input: {
  reportType: YoutubeReportType; reportId: string; generationToken: string; lots: any[]; assertOwned: () => Promise<void>;
}, report: any, intent: YoutubeSubmission) {
  if (!input.generationToken || String(report.user) !== intent.ownerId || report.job_id !== input.generationToken) return;
  await input.assertOwned();
  const authority = {
    _id: input.reportId, user: intent.ownerId, job_id: input.generationToken, job_status: "processing",
    "youtube_submission.generationToken": intent.generationToken, "youtube_submission.channelId": intent.channelId,
    "youtube_submission.connectionRevision": intent.connectionRevision,
  };
  const changedParent = await modelFor(input.reportType).updateOne(authority, { $set: { youtube_submission: {
    ...intent, generationToken: input.generationToken,
    uploadGenerationToken: intent.uploadGenerationToken || intent.generationToken,
  } } });
  if (changedParent.matchedCount !== 1) throw new Error("YouTube report authorization changed.");
  authority["youtube_submission.generationToken"] = input.generationToken;
  const sources = trustedLotVideos(input.lots, report.videoUrls);
  const bySource = new Map(sources.map((source) => [source.sourceUrl, source.lot]));
  const receipts = await YoutubeVideo.find({ reportType: input.reportType, reportId: input.reportId,
    ownerId: intent.ownerId, channelId: intent.channelId, status: { $ne: "data_removed" }, videoId: { $exists: true } }).select("+sourceUrl").lean();
  for (const receipt of receipts) {
    const lot = bySource.get(receipt.sourceUrl);
    if (!lot) continue;
    await input.assertOwned();
    if (!await modelFor(input.reportType).exists(authority)) throw new Error("YouTube report authorization changed.");
    const changed = await YoutubeVideo.updateOne({ _id: receipt._id, ownerId: intent.ownerId,
      generationToken: receipt.generationToken, status: receipt.status,
      connectionRevision: receipt.connectionRevision, updatedAt: receipt.updatedAt,
      }, { $set: {
        generationToken: input.generationToken,
        ...(receipt.status !== "public" ? youtubeAutomaticLotMetadata(lot) : {}),
        visibilityPending: false,
      }, $unset: { publicationToken: 1, publicationGenerationToken: 1, publicationPolicyVersion: 1, publicationAuthorizedAt: 1 } });
    // A racing provider outcome may replace this snapshot. It must not block
    // the report files; the old review already fails the current-parent fence.
    // Preserve any in-flight lease so no replacement worker starts concurrently.
    if (changed.matchedCount !== 1 && !await modelFor(input.reportType).exists(authority)) throw new Error("YouTube report authorization changed.");
  }
  if (!await modelFor(input.reportType).exists(authority)) throw new Error("YouTube report authorization changed.");
}

async function queueVideoReview(input: {
  reportType: YoutubeReportType; reportId: string; generationToken: string; intent: YoutubeSubmission;
  sourceUrl: string; lot: any; assertOwned: () => Promise<void>;
}) {
  const { intent } = input;
  const location = resolveR2ObjectLocationFromUrl(input.sourceUrl);
  if (!location) throw new YoutubeProviderError("YOUTUBE_SOURCE_UNTRUSTED", "A saved video is not in supported report storage. Originals are unchanged.");
  const id = youtubeVideoIdentity(input.reportType, input.reportId, input.sourceUrl, intent.channelId);
  const metadata = youtubeAutomaticLotMetadata(input.lot);
  await input.assertOwned();
  try {
    await YoutubeVideo.updateOne({ _id: id }, { $setOnInsert: {
      reportType: input.reportType, reportId: input.reportId, ownerId: intent.ownerId,
      channelId: intent.channelId, connectionRevision: intent.connectionRevision,
      generationToken: input.generationToken, sourceUrl: input.sourceUrl,
      lotId: String(input.lot.lot_id || ""), ...metadata,
    } }, { upsert: true });
  } catch (error: any) { if (error?.code !== 11000) throw error; }
  const current = await YoutubeVideo.findById(id).select("+sourceUrl +description").lean();
  if (!current || current.status === "data_removed") return;
  if (current.generationToken === input.generationToken && current.connectionRevision === intent.connectionRevision &&
    String(current.ownerId) === intent.ownerId) return;
  await input.assertOwned();
  const parent = await modelFor(input.reportType).findById(input.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
  if (!youtubeReceiptEligible(parent, { ...current, ownerId: intent.ownerId, generationToken: input.generationToken,
    connectionRevision: intent.connectionRevision, lotId: String(input.lot.lot_id || "") })) return;
  await YoutubeVideo.updateOne({ _id: id, status: current.status, updatedAt: current.updatedAt }, { $set: {
    ownerId: intent.ownerId, generationToken: input.generationToken, connectionRevision: intent.connectionRevision,
    lotId: String(input.lot.lot_id || ""),
    ...(current.status !== "public" ? metadata : {}),
    // Preserve every transfer checkpoint, ambiguous outcome and retry budget.
    // A new generation is not permission to replace an uncertain upload.
    visibilityPending: false,
  }, $unset: { publicationToken: 1, publicationGenerationToken: 1, publicationPolicyVersion: 1, publicationAuthorizedAt: 1 } });
}

/** Adopt only existing, explicitly submitted receipts; never scan reports to create uploads. */
export async function authorizeAutomaticYoutubeVideos(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return 0;
  const connection = await getYoutubeConnection();
  if (!connection) return 0;
  const candidates = await YoutubeVideo.find({ status: { $ne: "data_removed" },
    channelId: connection.channelId, connectionRevision: connection.revision,
    nextAttemptAt: { $lte: new Date() },
    $and: [
      { $or: [{ publicationToken: { $exists: false } }, { publicationPolicyVersion: { $ne: YOUTUBE_PUBLICATION_POLICY_VERSION } },
        { $expr: { $ne: [{ $ifNull: ["$publicationGenerationToken", ""] }, "$generationToken"] } }] },
      { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
    ],
  }).select("+sourceUrl +sessionCipher +description +publicationToken").sort({ nextAttemptAt: 1, _id: 1 }).limit(50).lean();
  let authorized = 0;
  for (const receipt of candidates) {
    if (signal?.aborted) break;
    const snapshot = { _id: receipt._id, status: receipt.status, updatedAt: receipt.updatedAt,
      ownerId: receipt.ownerId, generationToken: receipt.generationToken, channelId: receipt.channelId,
      connectionRevision: receipt.connectionRevision,
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }],
    };
    const report = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId)
      .select(YOUTUBE_RELEASE_FIELDS).lean();
    const current = youtubeReceiptEligible(report, receipt) && report.job_status === "done" &&
      !report.files_generating && !report.files_regenerating && resolveR2ObjectLocationFromUrl(receipt.sourceUrl) &&
      // Artifact-only generations may adopt an existing provider ID, never new bytes.
      (receipt.videoId || (report.youtube_submission.uploadGenerationToken || report.youtube_submission.generationToken) === receipt.generationToken);
    if (!current) {
      // Cycle the bounded queue without changing any delivery attempt/checkpoint.
      await YoutubeVideo.updateOne(snapshot, { $set: { nextAttemptAt: new Date(Date.now() + 300_000) } });
      continue;
    }
    const assigned = (report.preview_data?.lots || report.lots || []).filter((lot: any) =>
      trustedLotVideos([lot], report.videoUrls).some(({ sourceUrl }) => sourceUrl === receipt.sourceUrl));
    if (assigned.length !== 1) continue; // Receipt eligibility is deliberately rechecked above.
    await assertYoutubeConnection(receipt.channelId, receipt.connectionRevision);
    if (signal?.aborted) break;
    const untouched = !receipt.videoId && !receipt.sessionCipher && !receipt.offset && !receipt.finalChunkAttempted && !receipt.uploadAttempts;
    const pendingCapture = !receipt.videoId && ["pending_review", "queued"].includes(receipt.status);
    const changed = await YoutubeVideo.updateOne(snapshot, { $set: {
      publicationToken: randomUUID(), publicationGenerationToken: receipt.generationToken,
      publicationPolicyVersion: YOUTUBE_PUBLICATION_POLICY_VERSION, publicationAuthorizedAt: new Date(),
      // Current saved lot data is an explicit allowlist, not arbitrary report fields.
      ...(receipt.status === "public" ? {} : youtubeAutomaticLotMetadata(assigned[0])),
      privacyStatus: "public",
      // Legacy resubmission sometimes marked a partial transfer pending_review.
      // Resume its existing session through the normal final-byte safety checks;
      // this transition never clears checkpoints or restores a retry budget.
      ...(pendingCapture ? ((receipt.uploadAttempts || 0) < 5 ? { status: "uploading" } : {
        status: "needs_attention",
        lastError: receipt.lastError || "Automatic upload attempts are paused. Retry to check the same saved upload; uncertain final uploads will not be replaced.",
        lastErrorCode: receipt.lastErrorCode || "YOUTUBE_UPLOAD_RETRY_LIMIT",
      }) : {}),
      ...(untouched && pendingCapture ? { lastError: "", lastErrorCode: "" } : {}),
      ...(receipt.videoId ? { visibilityPending: receipt.status !== "public" || receipt.visibilityPending === true } : {}),
    } });
    authorized += changed.modifiedCount;
  }
  return authorized;
}

/** Only the bounded worker sweep may transfer automatically authorized originals. */
async function uploadAutomaticallyAuthorizedVideo(id: string, expectedPublication: string, expectedAttempts: number, signal?: AbortSignal) {
  const token = randomUUID();
  const receipt = await YoutubeVideo.findOneAndUpdate({ _id: id, status: "uploading", publicationToken: expectedPublication,
    uploadAttempts: { $eq: expectedAttempts, $lt: 5 }, nextAttemptAt: { $lte: new Date() },
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
    { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) }, $inc: { uploadAttempts: 1 } }, { returnDocument: "after" })
    .select("+sourceUrl +sessionCipher +description +publicationToken");
  if (!receipt) return false;
  const location = resolveR2ObjectLocationFromUrl(receipt.sourceUrl);
  const intent = { channelId: receipt.channelId, connectionRevision: receipt.connectionRevision };
  const write = async (set: Record<string, unknown>, unset: Record<string, 1> = {}) => {
    const result = await YoutubeVideo.updateOne({ _id: id, status: { $ne: "data_removed" }, publicationToken: expectedPublication,
      generationToken: receipt.generationToken, leaseToken: token, leaseUntil: { $gt: new Date() } }, {
      $set: { ...set, leaseUntil: new Date(Date.now() + LEASE_MS) }, ...(Object.keys(unset).length ? { $unset: unset } : {}),
    });
    if (result.matchedCount !== 1) throw new Error("YouTube upload ownership changed.");
    Object.assign(receipt, set);
  };
  const owned = async () => {
    if (signal?.aborted) throw new Error("YouTube upload stopped.");
    await assertYoutubeConnection(intent.channelId, intent.connectionRevision);
    const parent = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
    if (!youtubeReceiptEligible(parent, receipt) || !youtubePublicationCurrent(receipt.toObject()) ||
      parent.job_status !== "done" || parent.files_generating || parent.files_regenerating ||
      (parent.youtube_submission.uploadGenerationToken || parent.youtube_submission.generationToken) !== receipt.generationToken) throw new Error("YouTube report authorization changed.");
    await write({});
  };
  try {
    await owned();
    if (!location) throw new YoutubeProviderError("YOUTUBE_SOURCE_UNTRUSTED", "A saved video is not in supported report storage. Originals are unchanged.");
    if (receipt.videoId) return false;
    if (receipt.status === "needs_attention") throw new YoutubeProviderError("YOUTUBE_RECONCILIATION_REQUIRED", receipt.lastError || "Review this video in YouTube Studio before retrying. A duplicate upload was prevented.");
    const head = await headR2Object(location.bucketName, location.key);
    if (!Number.isSafeInteger(head.size) || !head.size || !head.etag || !["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"].includes(head.contentType || "")) {
      throw new YoutubeProviderError("YOUTUBE_SOURCE_INVALID", "A saved video is missing, incomplete, or has an unsupported video format. Originals are unchanged.");
    }
    if (receipt.sourceEtag && (receipt.sourceEtag !== head.etag || receipt.sourceSize !== head.size)) {
      throw new YoutubeProviderError("YOUTUBE_SOURCE_CHANGED", "The saved video source changed. Review the report before retrying.");
    }
    await write({ sourceSize: head.size, sourceEtag: head.etag });
    const size = head.size;
    let session = receipt.sessionCipher ? decryptYoutubeSecret(receipt.sessionCipher, `upload:${id}`) : "";
    const access = () => getYoutubeAccessToken(intent.channelId, intent.connectionRevision);
    const applyResult = async (result: YoutubeUploadResult) => {
      if ("videoId" in result) {
        await write({ ...result, offset: size, status: "private", uploadedAt: new Date(), providerDataCheckedAt: new Date(), providerAvailable: true,
          lastError: "", lastErrorCode: "", nextAttemptAt: new Date(), publicationAttempts: 0, visibilityPending: true }, { sessionCipher: 1 });
        return true;
      }
      await write({ offset: result.offset });
      return false;
    };
    if (session) {
      await owned();
      try {
        if (await applyResult(await checkYoutubeUpload(await access(), session, size))) return true;
      } catch (error) {
        if (error instanceof YoutubeProviderError && error.status === 404) {
          // A lost final response may mean a video exists even though its session
          // expired. Never turn that uncertainty into another provider upload.
          if (receipt.finalChunkAttempted) {
            await write({ status: "needs_attention", lastError: "YouTube upload confirmation expired after the final bytes were sent. Review YouTube Studio; no duplicate will be uploaded automatically." });
            throw new YoutubeProviderError("YOUTUBE_RECONCILIATION_REQUIRED", receipt.lastError!);
          }
          await write({ offset: 0 }, { sessionCipher: 1 });
          session = "";
        } else throw error;
      }
    }
    if (!session) {
      if (receipt.finalChunkAttempted) {
        await write({ status: "needs_attention" });
        throw new YoutubeProviderError("YOUTUBE_RECONCILIATION_REQUIRED", "The final video upload has no saved confirmation session. Review YouTube Studio; no duplicate will be uploaded automatically.");
      }
      await owned();
      session = await startYoutubeUpload(await access(), { title: receipt.title!, description: receipt.description || "" }, size, head.contentType);
      // No media is sent until this private resumable capability is durable.
      await write({ sessionCipher: encryptYoutubeSecret(session, `upload:${id}`), offset: 0 });
    }
    let chunks = 0;
    while ((receipt.offset || 0) < size && chunks++ < 2048) {
      await owned();
      const offset = receipt.offset || 0;
      const length = Math.min(YOUTUBE_CHUNK_BYTES, size - offset);
      const bytes = await readR2ObjectRange(location.bucketName, location.key, offset, length, head.etag);
      await owned();
      if (offset + length === size) await write({ finalChunkAttempted: true });
      const result = await sendYoutubeChunk(await access(), session, size, offset, bytes, head.contentType);
      if (await applyResult(result)) return true;
      if ((receipt.offset || 0) <= offset || (receipt.offset || 0) > offset + length) throw new Error("YouTube upload did not confirm the expected byte range.");
    }
    throw new Error("YouTube did not confirm the completed video.");
  } catch (error) {
    await write({ lastError: safeError(error), lastErrorCode: safeErrorCode(error), nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 60_000 * 2 ** receipt.uploadAttempts)),
      ...(receipt.uploadAttempts >= 5 ? { status: "needs_attention" } : {}),
    }).catch(() => undefined);
    throw error instanceof YoutubeProviderError ? error : new YoutubeProviderError("YOUTUBE_UPLOAD_FAILED", safeError(error));
  } finally {
    await YoutubeVideo.updateOne({ _id: id, leaseToken: token }, { $unset: { leaseToken: 1, leaseUntil: 1 } });
  }
}

/** Two automatic transfers per tick; legacy function name retained for worker compatibility. */
export async function uploadReviewedYoutubeVideos(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return 0;
  await authorizeAutomaticYoutubeVideos(signal);
  if (signal?.aborted) return 0;
  const connection = await getYoutubeConnection();
  if (!connection) return 0;
  const candidates = await YoutubeVideo.find({ status: "uploading", videoId: { $exists: false },
    channelId: connection.channelId, connectionRevision: connection.revision, publicationToken: { $exists: true },
    nextAttemptAt: { $lte: new Date() }, uploadAttempts: { $lt: 5 },
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }],
  }).select("+sourceUrl +description +publicationToken").sort({ nextAttemptAt: 1, _id: 1 }).limit(2).lean();
  let completed = 0;
  for (const receipt of candidates) {
    if (signal?.aborted) break;
    if (!youtubePublicationCurrent(receipt)) continue;
    const report = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
    if (!youtubeReceiptEligible(report, receipt)) continue;
    try { if (await uploadAutomaticallyAuthorizedVideo(receipt._id, receipt.publicationToken!, receipt.uploadAttempts, signal)) completed += 1; } catch { /* Receipt retains safe error and same session. */ }
  }
  return completed;
}

/** Bounded public-visibility sweep; it never creates reports or approvals. */
export async function publishReleasedYoutubeVideos(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return 0;
  await authorizeAutomaticYoutubeVideos(signal);
  if (signal?.aborted) return 0;
  const connection = await getYoutubeConnection();
  if (!connection) return 0;
  const candidates = await YoutubeVideo.find({ status: { $in: ["private", "unlisted", "public"] }, visibilityPending: true,
    videoId: { $exists: true }, publicationToken: { $exists: true }, channelId: connection.channelId,
    connectionRevision: connection.revision, nextAttemptAt: { $lte: new Date() }, publicationAttempts: { $lt: 5 },
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] })
    .select("+sourceUrl +description +publicationToken").sort({ nextAttemptAt: 1, _id: 1 }).limit(10).lean();
  let published = 0;
  for (const receipt of candidates) {
    if (signal?.aborted) break;
    const report = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
    const eligible = (parent: any) => youtubePublicationCurrent(receipt) && youtubeReceiptEligible(parent, receipt) &&
      youtubeReleaseEligible(parent, receipt);
    if (!eligible(report)) {
      await YoutubeVideo.updateOne({ _id: receipt._id, status: receipt.status, publicationToken: receipt.publicationToken, generationToken: receipt.generationToken,
        updatedAt: receipt.updatedAt,
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }],
      }, { $set: { nextAttemptAt: new Date(Date.now() + 300_000) } });
      continue;
    }
    const token = randomUUID();
    const claim = await YoutubeVideo.updateOne({ _id: receipt._id, status: receipt.status, publicationToken: receipt.publicationToken, generationToken: receipt.generationToken,
      updatedAt: receipt.updatedAt, ownerId: receipt.ownerId, connectionRevision: receipt.connectionRevision,
      publicationAttempts: { $eq: receipt.publicationAttempts, $lt: 5 }, nextAttemptAt: { $lte: new Date() },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
      { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) }, $inc: { publicationAttempts: 1 } });
    if (!claim.matchedCount) continue;
    try {
      await assertYoutubeConnection(receipt.channelId, receipt.connectionRevision);
      const fresh = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
      if (!eligible(fresh)) continue;
      const authorize = async () => {
        if (signal?.aborted) throw new Error("YouTube publication stopped.");
        await assertYoutubeConnection(receipt.channelId, receipt.connectionRevision);
        const latest = await modelFor(receipt.reportType as YoutubeReportType).findById(receipt.reportId).select(YOUTUBE_RELEASE_FIELDS).lean();
        if (!eligible(latest) || !await YoutubeVideo.exists({ _id: receipt._id, status: { $ne: "data_removed" },
          publicationToken: receipt.publicationToken, generationToken: receipt.generationToken, leaseToken: token, leaseUntil: { $gt: new Date() } })) {
          throw new Error("YouTube publication authorization changed.");
        }
      };
      await authorize();
      const confirmed = await publishYoutubeVideo(await getYoutubeAccessToken(receipt.channelId, receipt.connectionRevision), receipt.videoId!, receipt.channelId, authorize,
        { title: receipt.title!, description: receipt.description || "" }, "public");
      const persisted = await YoutubeVideo.updateOne({ _id: receipt._id, status: { $ne: "data_removed" },
        publicationToken: receipt.publicationToken, generationToken: receipt.generationToken, leaseToken: token, leaseUntil: { $gt: new Date() } }, { $set: confirmed
        ? { status: "public", publishedAt: new Date(), providerDataCheckedAt: new Date(), providerAvailable: true, visibilityPending: false, lastError: "", lastErrorCode: "" }
        : { status: "needs_attention", providerDataCheckedAt: new Date(), providerAvailable: true, lastErrorCode: "YOUTUBE_VISIBILITY_UNCONFIRMED", lastError: "YouTube did not confirm public visibility and saved metadata. Check YouTube Studio and channel eligibility." } });
      if (confirmed && persisted.matchedCount) published += 1;
    } catch (error) {
      await YoutubeVideo.updateOne({ _id: receipt._id, status: { $ne: "data_removed" }, publicationToken: receipt.publicationToken,
        generationToken: receipt.generationToken, leaseToken: token, leaseUntil: { $gt: new Date() } }, { $set: {
        lastError: safeError(error), lastErrorCode: safeErrorCode(error), nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 60_000 * 2 ** receipt.publicationAttempts)),
        ...(receipt.publicationAttempts >= 4 ? { status: "needs_attention" } : {}),
      } });
    } finally {
      await YoutubeVideo.updateOne({ _id: receipt._id, leaseToken: token }, { $unset: { leaseToken: 1, leaseUntil: 1 } });
    }
  }
  return published;
}

export function startYoutubePublicationMaintenance(signal: AbortSignal): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const tick = async () => {
    if (pending || signal.aborted) return;
    pending = refreshYoutubeVideoMetadata(signal).then(() => uploadReviewedYoutubeVideos(signal)).then(() => publishReleasedYoutubeVideos(signal)).then(() => undefined).catch(() => undefined);
    try { await pending; } finally { pending = undefined; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  void tick();
  return async () => { clearInterval(timer); await pending; };
}

/** Refresh at most fifty saved IDs weekly. Never expands report/media access. */
export async function refreshYoutubeVideoMetadata(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return 0;
  const connection = await getYoutubeConnection();
  if (!connection) return 0;
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  const candidates = await YoutubeVideo.find({ status: { $in: ["private", "unlisted", "public", "needs_attention"] },
    videoId: { $exists: true }, channelId: connection.channelId, connectionRevision: connection.revision,
    $and: [
      { $or: [{ providerDataCheckedAt: { $lte: cutoff } }, { providerDataCheckedAt: { $exists: false }, uploadedAt: { $lte: cutoff } }, { providerDataCheckedAt: { $exists: false }, uploadedAt: { $exists: false }, createdAt: { $lte: cutoff } }] },
      { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
    ],
  }).select("+publicationToken").sort({ providerDataCheckedAt: 1, createdAt: 1, _id: 1 }).limit(50).lean();
  if (!candidates.length || signal?.aborted) return 0;
  await assertYoutubeConnection(connection.channelId, connection.revision);
  const states = await readYoutubeVideoStates(await getYoutubeAccessToken(connection.channelId, connection.revision),
    [...new Set(candidates.map((row) => row.videoId!))], connection.channelId);
  await assertYoutubeConnection(connection.channelId, connection.revision);
  let updated = 0;
  for (const receipt of candidates) {
    if (signal?.aborted) break;
    const status = states.get(receipt.videoId!);
    const changed = await YoutubeVideo.updateOne({ _id: receipt._id, status: receipt.status, updatedAt: receipt.updatedAt,
      channelId: connection.channelId, connectionRevision: connection.revision,
      generationToken: receipt.generationToken,
      publicationToken: receipt.publicationToken || { $exists: false },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }],
    }, { $set: { providerDataCheckedAt: new Date(), providerAvailable: Boolean(status),
      ...(!receipt.visibilityPending ? { status: status || "needs_attention", lastErrorCode: status ? "" : "YOUTUBE_VIDEO_UNAVAILABLE", lastError: status ? "" : "The YouTube video is no longer available in the connected channel. No replacement was uploaded." } : {}),
    } });
    updated += changed.modifiedCount;
  }
  return updated;
}
