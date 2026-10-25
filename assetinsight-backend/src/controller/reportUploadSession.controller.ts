import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { optionalCaptureId } from "../service/captureInventoryService.js";
/**
 * Durable upload-session state machine for Asset and Lot Listing generation.
 *
 * A session separates target issuance, object transfer/verification and job enqueueing
 * so large uploads can be retried without repeating completed work. Persisted manifest
 * hashes, ownership filters and expected-state updates protect idempotency and prevent
 * one user from completing or mutating another user's session.
 */
import path from "path";
import fs from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportUploadSession, {
  type ReportUploadSessionType,
} from "../models/reportUploadSession.model.js";
import ReportJob from "../models/reportJob.model.js";
import {
  createR2PresignedPutUrl,
  deleteFromR2,
  deleteFromR2Strict,
  getCurrentR2StorageTarget,
  getR2PublicUrl,
  headR2Object,
  isR2ObjectNotFoundError,
  resolvePersistedR2StorageTarget,
  uploadBufferToR2,
  uploadFilePathToR2,
} from "../utils/r2Storage/r2Upload.js";
import {
  buildAssetPreviewJobOutbox,
  queueAssetPreviewJob,
  type AssetJobInput,
} from "../jobs/assetReportJob.js";
import {
  buildLotListingPreviewJobOutbox,
  queueLotListingJob,
} from "../jobs/lotListingJob.js";
import {
  ensureReportJobOutbox,
  getMongoReportJobProgress,
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";
import { getMixedLotPhotoLimitMessage } from "../utils/assetPhotoLimits.js";
import {
  evaluateSmartUploadGrouping,
  getSmartUploadActiveInspectionErrors,
  sortSmartUploadFiles,
  validatePersistedSmartUploadGroups,
} from "../service/smartUploadGroupingService.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import {
  auctioneerContextErrorBody,
  linkAuctioneerReport,
  resolveAuctioneerReportContext,
} from "../service/auctioneerReportLinkService.js";
import {
  deleteReportDraftForSubmission,
  syncSmartUploadReportDraft,
} from "../service/reportDraftService.js";
import { getSmartUploadLimitViolation } from "../utils/smartUploadLimits.js";
import { applyReviewedGroupNumbers, isLotNumberUpload, lotNumberUploadWarnings, smartUploadGroupingMethod } from "../service/lotNumberUploadGrouping.js";
import { resolveSmartUploadOrderReviewState } from "../utils/smartUploadReviewState.js";
import {
  getSmartUploadManifestImageViolation,
  getUploadSessionFileViolation,
  getUploadSessionPostTransferViolation,
} from "../utils/uploadSessionFileValidation.js";
import {
  findActiveSameContractReport,
  findSubmissionContractClaimant,
  isSubmissionContractClaimDuplicateKeyError,
  releaseInactiveSubmissionContractClaim,
  resolveSubmissionContractClaim,
} from "../service/reportSubmissionConflictService.js";
import {
  getExplicitCoordinates,
  hasAnyCoordinateInput,
} from "../utils/auctionLocations.js";
import { normalizeLotListingValuationMethods } from "../utils/lotListingValuationMethods.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";
import { assertReportLotPhotoManifest } from "../utils/mixedLotPhotoManifest.js";
import { reportTransferSnapshotHash, wakeReportTransferNotification } from "../service/reportTransferService.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import { withAuctioneerContractOperation } from "../service/auctioneerContractCloseService.js";
import {
  acquireReportSubmissionAdmission,
  withReportSubmissionAdmission,
  type ReportSubmissionAdmissionLease,
} from "../service/reportSubmissionAdmissionService.js";

const toNonNegativeInt = (value: unknown): number => {
  const parsed = parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const getExpectedMixedImageCount = (details: any): number => {
  if (!Array.isArray(details?.mixed_lots)) return 0;
  return details.mixed_lots.reduce((sum: number, lot: any) => {
    return sum + toNonNegativeInt(lot?.count) + toNonNegativeInt(lot?.extra_count);
  }, 0);
};

const safeFilename = (value: unknown, fallback: string): string => {
  const original = String(value || fallback);
  const ext = path.extname(original);
  const base = path
    .basename(original, ext)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "upload"}${ext || ""}`;
};

const parseDetails = (value: any): Record<string, any> => {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim()) return JSON.parse(value);
  return {};
};

const normalizeClientSubmissionId = (value: unknown): string =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "-")
    .slice(0, 160);

const resolveBoolean = (value: unknown): boolean =>
  value === true || value === "true" || value === 1 || value === "1";

const deleteAcceptedDraftBestEffort = (session: any): void => {
  const notUpdatedAfter = session.uploadCompletedAt || session.queuedAt;
  // Legacy receipts without a server acceptance boundary cannot safely delete
  // a draft that may have been saved since. Retain it for explicit review.
  if (!(notUpdatedAfter instanceof Date) || !Number.isFinite(notUpdatedAfter.getTime())) return;
  const clientSubmissionIds = Array.from(
    new Set(
      [
        session.clientSubmissionId,
        ...(Array.isArray(session.supersedesClientSubmissionIds)
          ? session.supersedesClientSubmissionIds
          : []),
      ]
        .map(normalizeClientSubmissionId)
        .filter(Boolean),
    ),
  );
  void Promise.all(
    clientSubmissionIds.map((clientSubmissionId) =>
      deleteReportDraftForSubmission(
        session.user,
        session.type,
        clientSubmissionId,
        { notUpdatedAfter },
      ),
    ),
  ).catch((error) => {
    console.error("[UploadSession] accepted-session draft cleanup failed", {
      sessionId: String(session._id),
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

const findUploadSessionFollowingSupersedeAliases = async ({
  type,
  userId,
  clientSubmissionId,
}: {
  type: ReportUploadSessionType;
  userId: unknown;
  clientSubmissionId: string;
}) => {
  let currentClientSubmissionId = clientSubmissionId;
  let lastSession: any = null;
  const visited = new Set<string>();

  for (let depth = 0; depth < 16; depth += 1) {
    if (
      !currentClientSubmissionId ||
      visited.has(currentClientSubmissionId)
    ) {
      return lastSession;
    }
    visited.add(currentClientSubmissionId);
    const session = await ReportUploadSession.findOne({
      type,
      user: userId as any,
      clientSubmissionId: currentClientSubmissionId,
    }).select("+activeContractClaim +finalizationClaimToken");
    if (!session) return lastSession;
    lastSession = session;
    const replacementId = normalizeClientSubmissionId(
      session.supersededByClientSubmissionId,
    );
    if (!session.cleanupStartedAt || !replacementId) return session;
    currentClientSubmissionId = replacementId;
  }

  return lastSession;
};

const syncUploadSessionDraftBestEffort = async (
  session: any,
  stage: string
): Promise<void> => {
  try {
    await syncSmartUploadReportDraft(session);
  } catch (error) {
    console.error("[UploadSession] draft projection failed", {
      stage,
      sessionId: String(session._id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const smartUploadFilesAreEditable = (session: any): boolean =>
  !session.smartUpload ||
  String(session.smartGrouping?.status || "uploading") === "uploading";

const resolveUploadSessionContractClaim = (details: Record<string, any>) =>
  resolveSubmissionContractClaim({
    contractNo: details?.contract_no,
    forceNew: details?.force_new,
  });

const isUploadSessionContractClaimDuplicateKeyError = (error: any): boolean => {
  if (Number(error?.code) !== 11000) return false;
  if (error?.keyPattern?.activeContractClaim) return true;
  if (error?.keyValue?.activeContractClaim !== undefined) return true;
  return /activeContractClaim|uniq_active_upload_contract_claim/i.test(
    String(error?.message || ""),
  );
};

const findUploadSessionContractClaimant = async ({
  type,
  userId,
  contractClaim,
}: {
  type: ReportUploadSessionType;
  userId: unknown;
  contractClaim: string;
}) =>
  ReportUploadSession.findOne({
    type,
    user: userId as any,
    activeContractClaim: contractClaim,
  })
    .select("+activeContractClaim")
    .lean();

/**
 * The contract-claim index is partial, so sessions written by an older API
 * process during a rolling deploy are intentionally still readable. Adopt a
 * matching claimless session before admitting a new contract. This makes that
 * legacy row participate in the same unique-index fence and closes the narrow
 * gap between the pre-reload migration scan and the API reload.
 */
const claimMatchingLegacyUploadSession = async ({
  type,
  userId,
  contractClaim,
  excludeClientSubmissionId,
}: {
  type: ReportUploadSessionType;
  userId: unknown;
  contractClaim: string | undefined;
  excludeClientSubmissionId?: string;
}) => {
  if (!contractClaim) return null;
  const findOtherClaimant = async () => {
    const claimant = await findUploadSessionContractClaimant({
      type,
      userId,
      contractClaim,
    });
    return claimant &&
      normalizeClientSubmissionId(claimant.clientSubmissionId) !==
        excludeClientSubmissionId
      ? claimant
      : null;
  };
  const candidates = await ReportUploadSession.find({
    type,
    user: userId as any,
    status: { $in: ["created", "uploading", "completed", "queued"] },
    cleanupStartedAt: { $exists: false },
    ...(excludeClientSubmissionId
      ? { clientSubmissionId: { $ne: excludeClientSubmissionId } }
      : {}),
    $or: [
      { activeContractClaim: { $exists: false } },
      { activeContractClaim: null },
      { activeContractClaim: "" },
    ],
  })
    .select("+activeContractClaim")
    .sort({ createdAt: 1 });

  for (const candidate of candidates) {
    if (
      resolveBoolean(candidate.details?.force_new) ||
      normalizeReportContractKey(candidate.details?.contract_no) !==
        contractClaim
    ) {
      continue;
    }
    try {
      const claimed = await ReportUploadSession.findOneAndUpdate(
        {
          _id: candidate._id,
          type,
          user: userId as any,
          status: { $in: ["created", "uploading", "completed", "queued"] },
          cleanupStartedAt: { $exists: false },
          $or: [
            { activeContractClaim: { $exists: false } },
            { activeContractClaim: null },
            { activeContractClaim: "" },
          ],
        },
        { $set: { activeContractClaim: contractClaim } },
        { new: true, runValidators: true },
      )
        .select("+activeContractClaim")
        .lean();
      if (claimed) return claimed;
    } catch (error) {
      if (!isUploadSessionContractClaimDuplicateKeyError(error)) throw error;
      return findOtherClaimant();
    }
  }

  return findOtherClaimant();
};

/**
 * Terminal and cleanup-owned sessions can no longer produce a report. Release
 * only those claims so a later submission can acquire the canonical contract
 * identity without weakening the unique-index fence for active uploads.
 */
const releaseInactiveUploadSessionContractClaim = async ({
  type,
  userId,
  contractClaim,
}: {
  type: ReportUploadSessionType;
  userId: unknown;
  contractClaim: string | undefined;
}) => {
  if (!contractClaim) return;
  await ReportUploadSession.updateMany(
    {
      type,
      user: userId as any,
      activeContractClaim: contractClaim,
      $or: [
        { status: { $in: ["failed", "processed"] } },
        { cleanupStartedAt: { $exists: true } },
      ],
    },
    { $unset: { activeContractClaim: 1 } },
  );
};

const uploadSessionContractConflict = (claimant: any) => {
  const error: any = new Error(
    "Another upload for this contract is already in progress.",
  );
  error.statusCode = 409;
  error.code = "ACTIVE_REPORT_EXISTS";
  error.data = {
    sessionId: claimant?._id ? String(claimant._id) : undefined,
    reportId: claimant?.reportId,
    jobId: claimant?.jobId,
    status: claimant?.status,
  };
  return error;
};

/**
 * Legacy/recoverable sessions may not yet carry the hidden claim. Acquire it
 * with a CAS before the session can be completed or resumed. The unique index
 * is the authority when two requests race.
 */
const ensureUploadSessionContractClaim = async ({
  session,
  type,
  userId,
  contractClaim,
}: {
  session: any;
  type: ReportUploadSessionType;
  userId: unknown;
  contractClaim: string | undefined;
}) => {
  if (!contractClaim || session.status === "processed") return session;
  if (session.activeContractClaim === contractClaim) return session;

  await releaseInactiveUploadSessionContractClaim({
    type,
    userId,
    contractClaim,
  });

  try {
    const claimed = await ReportUploadSession.findOneAndUpdate(
      {
        _id: session._id,
        type,
        user: userId as any,
        status: { $ne: "processed" },
        cleanupStartedAt: { $exists: false },
        $or: [
          { activeContractClaim: { $exists: false } },
          { activeContractClaim: null },
          { activeContractClaim: "" },
        ],
      },
      { $set: { activeContractClaim: contractClaim } },
      { new: true, runValidators: true },
    ).select("+activeContractClaim");
    if (claimed) return claimed;
  } catch (error) {
    if (!isUploadSessionContractClaimDuplicateKeyError(error)) throw error;
  }

  const claimant = await findUploadSessionContractClaimant({
    type,
    userId,
    contractClaim,
  });
  if (claimant && String(claimant._id) !== String(session._id)) {
    throw uploadSessionContractConflict(claimant);
  }

  const latest = await ReportUploadSession.findById(session._id).select(
    "+activeContractClaim",
  );
  if (latest?.activeContractClaim === contractClaim) return latest;
  const error: any = new Error(
    "This upload session changed while its contract was being reserved. Refresh and try again.",
  );
  error.statusCode = 409;
  error.code = latest?.cleanupStartedAt
    ? "UPLOAD_SESSION_CLEANUP_STARTED"
    : "UPLOAD_SESSION_CHANGED";
  throw error;
};

const CURRENT_MANIFEST_VERSION = 2;
const UPLOAD_TARGET_TTL_SECONDS = 4 * 60 * 60;
const SUPERSEDE_CLEANUP_GRACE_MS = 5 * 60 * 1000;
export const LEGACY_UPLOAD_SESSION_READ_ONLY_CODE =
  "LEGACY_UPLOAD_SESSION_READ_ONLY";

const legacyUploadSessionReadOnlyBody = () => ({
  code: LEGACY_UPLOAD_SESSION_READ_ONLY_CODE,
  message:
    "This upload session predates the storage migration and is read-only. Start a new submission; existing uploaded files remain intact.",
});

const buildManifestHash = (
  files: ReturnType<typeof normalizeRequestedFiles>,
  version = CURRENT_MANIFEST_VERSION,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => ({
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size || 0,
          ...(version >= 2 ? { lastModified: file.lastModified } : {}),
          lotIndex: file.lotIndex,
          imageIndex: file.imageIndex,
          role: file.role,
          originalOrder: file.originalOrder,
        }))
      )
    )
    .digest("hex");

const normalizeRequestedFiles = (files: any[]) => {
  return files.map((file, index) => {
    const fieldname = file?.fieldname === "videos" || file?.kind === "video" || file?.role === "video"
      ? "videos"
      : "images";
    const originalname = safeFilename(file?.name || file?.originalname, `${fieldname}-${index + 1}.jpg`);
    const declaredMime = String(file?.type || file?.mimetype || "").trim();
    const imageExtension = path.extname(originalname).toLowerCase();
    const mimetype =
      declaredMime ||
      (fieldname === "videos"
        ? "video/mp4"
        : imageExtension === ".heic"
          ? "image/heic"
          : imageExtension === ".heif"
            ? "image/heif"
            : imageExtension === ".png"
              ? "image/png"
              : imageExtension === ".webp"
                ? "image/webp"
                : "image/jpeg");
    // File ids must survive request retries. Random ids make a resumed session
    // impossible to match back to the same client-side file descriptor.
    const fileId = String(file?.fileId || file?.id || `${fieldname}-${index}`);
    return {
      fileId,
      fieldname: fieldname as "images" | "videos",
      originalname,
      mimetype,
      size: Number.isFinite(Number(file?.size)) ? Number(file.size) : undefined,
      lastModified: Number.isFinite(Number(file?.lastModified))
        ? Math.max(0, Math.trunc(Number(file.lastModified)))
        : undefined,
      lotIndex: Number.isFinite(Number(file?.lotIndex)) ? Number(file.lotIndex) : undefined,
      imageIndex: Number.isFinite(Number(file?.imageIndex)) ? Number(file.imageIndex) : index,
      captureTimestamp: Number.isFinite(Number(file?.captureTimestamp))
        ? Number(file.captureTimestamp)
        : undefined,
      captureOrder: Number.isFinite(Number(file?.captureOrder))
        ? Number(file.captureOrder)
        : undefined,
      originalOrder: Number.isFinite(Number(file?.originalOrder))
        ? Number(file.originalOrder)
        : index,
      role:
        file?.role === "extra" || file?.role === "video" || file?.role === "main"
          ? file.role
          : fieldname === "videos"
            ? "video"
            : "main",
    };
  });
};

const normalizeValuationMethods = normalizeLotListingValuationMethods;

function uploadSessionPreviewJobType(type: ReportUploadSessionType) {
  return type === "asset" ? "asset-preview" : "lot-listing-preview";
}

function uploadSessionModel(type: ReportUploadSessionType): any {
  return type === "asset" ? AssetReport : LotListing;
}

const missingStringField = (field: string) => ({
  $or: [
    { [field]: { $exists: false } },
    { [field]: null },
    { [field]: "" },
  ],
});

async function findUploadSessionPlaceholder(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  const clientSubmissionId = normalizeClientSubmissionId(
    input.session?.clientSubmissionId || input.session?.jobId
  );
  const jobId = String(input.session?.jobId || "");
  if (!clientSubmissionId && !jobId) return null;
  const identity: Record<string, unknown>[] = [];
  if (clientSubmissionId) {
    identity.push({ client_submission_id: clientSubmissionId });
  }
  if (jobId) identity.push({ job_id: jobId });
  return uploadSessionModel(input.type)
    .findOne({
      user: input.session.user,
      $or: identity,
    })
    .select("_id")
    .maxTimeMS(10_000).setOptions({ timeoutMS: 10_000 })
    .lean();
}

async function findAnyUploadSessionJob(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  const jobId = String(input.session?.jobId || "");
  if (!jobId) return null;
  return ReportJob.findOne({
    type: uploadSessionPreviewJobType(input.type),
    progressId: jobId,
  })
    .select("_id")
    .sort({ createdAt: -1 })
    .maxTimeMS(10_000).setOptions({ timeoutMS: 10_000 })
    .lean();
}

async function uploadSessionHasReportHandoff(input: {
  type: ReportUploadSessionType;
  session: any;
}): Promise<boolean> {
  if (
    input.session.reportId ||
    input.session.finalizationClaimToken ||
    ["queued", "processed"].includes(input.session.status)
  ) return true;

  // A terminal worker failure also marks its accepted upload as failed. Even
  // when a legacy session lost reportId, a placeholder/outbox or terminal job
  // protects the existing report and its source objects from supersession.
  const [placeholder, durableJob] = await Promise.all([
    findUploadSessionPlaceholder(input),
    findAnyUploadSessionJob(input),
  ]);
  return Boolean(placeholder || durableJob);
}

/** Read-only recovery evidence; a placeholder is never proof of acceptance. */
export async function uploadSessionRecoveryReceipt(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  const { type, session } = input;
  const reportId = String(session.reportId || "");
  const jobId = String(session.jobId || "");
  const [report, unlinkedPreviewJob, job] = await Promise.all([
    reportId
      ? uploadSessionModel(type).findOne({ _id: reportId, user: session.user })
          .select({ _id: 1, "report_job_outbox.token": 1, "report_job_outbox.type": 1,
            "report_job_outbox.reportId": 1, "report_job_outbox.progressId": 1 })
          .maxTimeMS(10_000).setOptions({ timeoutMS: 10_000 }).lean()
      : null,
    // A legacy worker may have retained the durable preview job but lost the
    // session's report projection. Do not start another placeholder on retry.
    !reportId && jobId ? findAnyUploadSessionJob(input) : null,
    reportId && jobId
      ? ReportJob.findOne({ type: uploadSessionPreviewJobType(type), reportId, progressId: jobId })
          .select("status").sort({ createdAt: -1 }).maxTimeMS(10_000)
          .setOptions({ timeoutMS: 10_000 }).lean()
      : null,
  ]);
  const outbox = report?.report_job_outbox;
  const exactOutbox = Boolean(outbox?.token && outbox.type === uploadSessionPreviewJobType(type) &&
    String(outbox.reportId) === reportId && String(outbox.progressId) === jobId);
  // queued/processed are written only after queue acceptance. Keep that history
  // even after the report is deleted or its completed job expires; never requeue
  // the old identity or interpret deletion as permission to supersede it.
  const recordedAcceptance = ["queued", "processed"].includes(session.status);
  const accepted = Boolean(job || exactOutbox || (reportId && jobId && recordedAcceptance));
  const unconfirmed = Boolean(unlinkedPreviewJob || (recordedAcceptance && (!reportId || !jobId)));
  const reportAvailable = reportId ? Boolean(report) : null;
  const unavailable = reportAvailable === false;
  const incoming = Boolean(String(session.details?.auctioneer_work_item_id || "").trim());
  const noReportHandoff = !session.cleanupStartedAt && !accepted && !unconfirmed &&
    !(await uploadSessionHasReportHandoff(input));
  const canSupersede = !incoming && noReportHandoff;
  const canResumeUploads = noReportHandoff && ["created", "uploading", "failed"].includes(session.status);
  let status = session.status === "completed" ? "preparing" : "ready";
  let message = "Your saved upload can be continued.";
  if (unconfirmed) {
    status = "preparing";
    message = "This upload records processing, but its report receipt could not be confirmed. Keep the saved draft and contact support before trying a separate submission.";
  } else if (unavailable) {
    status = "unavailable";
    message = "The report linked to this upload is no longer available. Your current draft is retained. This upload will not be submitted again.";
  } else if (session.cleanupStartedAt) {
    status = "failed";
    message = "This expired upload session is being cleaned up and cannot be completed.";
  } else if (accepted) {
    status = job?.status === "completed" || (!job && session.status === "processed") ? "processed"
      : job && ["failed", "cancelled"].includes(job.status) ? "failed" : "queued";
    message = status === "failed"
      ? "Report processing stopped. Open the saved report to review or retry it."
      : "Your upload was accepted. Report processing continues in the background.";
  } else if (session.status === "failed") {
    status = "failed";
    message = "The upload needs attention. Reopen its saved review before continuing.";
  }
  return {
    sessionId: String(session._id), status, accepted, reportAvailable, canSupersede, canResumeUploads,
    canCreateSeparate: unavailable && accepted && !incoming && !session.cleanupStartedAt,
    ...(unavailable ? { code: "UPLOAD_SESSION_REPORT_UNAVAILABLE" }
      : unconfirmed ? { code: "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED" } : {}),
    message,
    // A missing report id remains historical evidence, not a navigation target.
    ...(accepted ? { reportId: reportId || undefined, jobId } : {}),
    phase: status === "processed" ? "done" : ["failed", "unavailable"].includes(status) ? "error"
      : accepted || status === "preparing" ? "processing" : "upload",
  };
}

async function unavailableUploadSessionReport(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  const receipt = await uploadSessionRecoveryReceipt(input);
  return receipt.code
    ? { code: receipt.code, message: receipt.message, data: receipt }
    : null;
}

async function findAcceptedUploadSessionPreviewJob(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  if (!input.session?.reportId || !input.session?.jobId) return null;
  return ReportJob.findOne({
    type: uploadSessionPreviewJobType(input.type),
    reportId: String(input.session.reportId),
    progressId: String(input.session.jobId),
    status: { $in: ["queued", "processing", "completed"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

type UploadSessionPreviewOutboxClaim = {
  durableJob?: any;
  outboxToken?: string;
};

async function findUploadSessionReportWithOutbox(input: {
  type: ReportUploadSessionType;
  reportId: string;
}) {
  const Model: any = input.type === "asset" ? AssetReport : LotListing;
  return Model.findById(input.reportId)
    .select("+report_job_outbox")
    .lean();
}

/**
 * Atomically publishes one exact upload-session queue intent on the report.
 * A concurrent completion either observes that outbox or the durable job it
 * created; neither path replaces a newer worker-owned transition.
 */
async function claimUploadSessionPreviewOutbox(input: {
  type: ReportUploadSessionType;
  session: any;
  outbox: ReportJobOutbox;
}): Promise<UploadSessionPreviewOutboxClaim> {
  const reportId = String(input.session?.reportId || "");
  const jobId = String(input.session?.jobId || "");
  if (!reportId || !jobId) {
    throw Object.assign(
      new Error("The completed upload session is missing its report queue identity."),
      { code: "UPLOAD_SESSION_REPORT_IDENTITY_MISSING", statusCode: 409 }
    );
  }

  const current: any = await findUploadSessionReportWithOutbox({
    type: input.type,
    reportId,
  });
  if (!current || String(current.job_id || "") !== jobId) {
    throw Object.assign(
      new Error(
        "The report changed while this upload session was being completed. Refresh before trying again."
      ),
      { code: "UPLOAD_SESSION_REPORT_CHANGED", statusCode: 409 }
    );
  }
  const currentOutboxToken = String(current.report_job_outbox?.token || "");
  if (currentOutboxToken) return { outboxToken: currentOutboxToken };

  const accepted = await findAcceptedUploadSessionPreviewJob({
    type: input.type,
    session: input.session,
  });
  if (accepted) return { durableJob: accepted };

  const Model: any = input.type === "asset" ? AssetReport : LotListing;
  const queuedAt = new Date();
  const claimed: any = await Model.findOneAndUpdate(
    {
      _id: reportId,
      job_id: jobId,
      job_status: { $in: ["uploading", "queued", "error"] },
      $or: [
        { report_job_outbox: { $exists: false } },
        { report_job_outbox: null },
      ],
    },
    {
      $set: {
        status: "processing",
        job_status: "queued",
        queued_at: queuedAt,
        report_job_outbox: input.outbox,
        "generation_progress.stage": "queued",
        "generation_progress.progressPercent": 0,
        "generation_progress.message": "Queued",
        "generation_progress.updatedAt": queuedAt,
      },
      $unset: {
        job_execution_token: 1,
        job_error: 1,
        error_message: 1,
      },
    },
    { returnDocument: "after" }
  )
    .select("+report_job_outbox")
    .lean();
  if (claimed?.report_job_outbox?.token) {
    return { outboxToken: String(claimed.report_job_outbox.token) };
  }

  // A same-session request may have won either side of the outbox-to-job
  // handoff while this CAS was running. Accept only its exact identity.
  const latest: any = await findUploadSessionReportWithOutbox({
    type: input.type,
    reportId,
  });
  const latestOutboxToken = String(latest?.report_job_outbox?.token || "");
  if (latestOutboxToken) return { outboxToken: latestOutboxToken };
  const concurrentJob = await findAcceptedUploadSessionPreviewJob({
    type: input.type,
    session: input.session,
  });
  if (concurrentJob) return { durableJob: concurrentJob };

  throw Object.assign(
    new Error(
      "The report queue handoff changed while this upload was completing. Retry with the same upload session."
    ),
    { code: "UPLOAD_SESSION_QUEUE_HANDOFF_CONFLICT", statusCode: 409 }
  );
}

async function ensureQueuedUploadSessionPreviewJob(input: {
  type: ReportUploadSessionType;
  session: any;
}) {
  if (!input.session?.reportId || !input.session?.jobId) {
    throw Object.assign(
      new Error("The queued upload session is missing its report queue identity."),
      { code: "UPLOAD_SESSION_REPORT_IDENTITY_MISSING", statusCode: 409 }
    );
  }
  const report: any = await findUploadSessionReportWithOutbox({
    type: input.type,
    reportId: String(input.session.reportId),
  });
  const token = String(report?.report_job_outbox?.token || "");
  if (token) {
    return ensureReportJobOutbox(
      input.type === "asset" ? "asset" : "lotListing",
      String(input.session.reportId),
      token
    );
  }
  const accepted = await findAcceptedUploadSessionPreviewJob(input);
  if (accepted) return accepted;
  throw Object.assign(
    new Error(
      "The upload was saved, but its worker handoff is still pending. Retry with the same upload session."
    ),
    { code: "UPLOAD_SESSION_QUEUE_HANDOFF_PENDING", statusCode: 503 }
  );
}

/**
 * Resolve an ambiguous completion enqueue before exposing a retry. An exact
 * durable job wins. Otherwise only the placeholder/session that still owns
 * this immutable upload claim is marked retryable; verified R2 objects remain
 * attached to the completed session for the next completion call.
 */
async function reconcileUploadSessionPreviewQueueFailure(input: {
  type: ReportUploadSessionType;
  session: any;
  error: unknown;
}) {
  const accepted = await findAcceptedUploadSessionPreviewJob(input);
  if (accepted) return accepted;
  if (!input.session?.reportId || !input.session?.jobId) return null;

  const message = input.error instanceof Error
    ? input.error.message
    : "The report preview could not be queued.";
  const reportFilter = {
    _id: input.session.reportId as any,
    job_id: String(input.session.jobId),
    job_status: { $in: ["uploading", "error"] },
  };
  const reportUpdate = {
    $set: {
      status: "error",
      files_generating: false,
      files_regenerating: false,
      job_status: "error",
      job_error: message,
      processing_completed_at: new Date(),
      "generation_progress.stage": "error",
      "generation_progress.progressPercent": 100,
      "generation_progress.message": message,
      "generation_progress.updatedAt": new Date(),
    },
    $unset: { job_execution_token: 1 },
  };
  const reset = input.type === "asset"
    ? await AssetReport.updateOne(reportFilter, reportUpdate)
    : await LotListing.updateOne(reportFilter, reportUpdate);
  if (reset.matchedCount === 1) {
    await ReportUploadSession.updateOne(
      {
        _id: input.session._id,
        type: input.type,
        user: input.session.user,
        reportId: input.session.reportId,
        jobId: input.session.jobId,
        status: "completed",
        cleanupStartedAt: { $exists: false },
      },
      { $set: { lastError: message } }
    );
  }

  // Close the narrow race where another completion accepted the exact job
  // after the first lookup. Its caller will restore queued report/session state.
  return findAcceptedUploadSessionPreviewJob(input);
}

const resolveIncludeDamageAnalysis = (value: any, fallback = true): boolean => {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
};

const resolveBooleanFlag = (value: any, fallback = false): boolean => {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
};

async function createPlaceholderReport(
  type: ReportUploadSessionType,
  req: AuthRequest,
  details: any,
  jobId: string,
  clientSubmissionId: string
) {
  const user = (req as any).user;
  const userId = user?._id || req.userId;
  const contractClaim = resolveSubmissionContractClaim({
    contractNo: details.contract_no,
    forceNew: details.force_new,
    draftPreview: resolveBoolean(details.draft_preview),
  });
  const contractClaimBypassed = resolveBoolean(details.force_new);
  const auctioneerWorkItem = await resolveAuctioneerReportContext({
    details,
    userId,
    reportType: type,
  });
  return withReportSubmissionAdmission(
    { reportType: type, userId, contractClaim },
    async (admission) => {
      await releaseInactiveSubmissionContractClaim({
        reportType: type,
        userId,
        contractClaim,
      });
      await admission?.assertOwned();
      if (type === "asset") {
        const filter = {
          user: userId,
          client_submission_id: clientSubmissionId,
        };
        const insert = {
          user: userId,
          client_submission_id: clientSubmissionId,
          capture_id: optionalCaptureId(details.capture_id),
          submission_contract_claim: contractClaim,
          submission_contract_claim_bypassed: contractClaimBypassed
            ? true
            : undefined,
          grouping_mode: details.grouping_mode || "mixed",
          imageUrls: [],
          lots: [],
          status: "processing",
          job_id: jobId,
          job_status: "uploading",
          queued_at: new Date(),
          client_name: details.client_name,
          effective_date: details.effective_date,
          appraisal_purpose: details.appraisal_purpose,
          owner_name: details.owner_name,
          appraiser: details.appraiser,
          appraisal_company: details.appraisal_company,
          industry: details.industry,
          inspection_date: details.inspection_date,
          contract_no: details.contract_no,
          // Query upserts do not execute document validation middleware, so
          // persist the identity that ordinary document saves derive.
          contract_key:
            normalizeReportContractKey(details.contract_no) || undefined,
          language: details.language || "en",
          currency: details.currency || "CAD",
          bank_photos_enabled: resolveBooleanFlag(
            details.bank_photos_enabled,
            false,
          ),
          watermark_images: resolvePhotoWatermark(details.watermark_images),
          auctioneerWorkItem: auctioneerWorkItem?._id,
        };
        let report;
        try {
          report = await AssetReport.findOneAndUpdate(
            filter,
            { $setOnInsert: insert },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
        } catch (error: any) {
          if (error?.code !== 11000) throw error;
          report = await AssetReport.findOne(filter);
          if (
            !report &&
            isSubmissionContractClaimDuplicateKeyError(error) &&
            contractClaim
          ) {
            const claimant = await findSubmissionContractClaimant({
              reportType: "asset",
              userId,
              contractClaim,
            });
            throw Object.assign(
              new Error(
                "An asset report for this contract is already being processed.",
              ),
              {
                statusCode: 409,
                code: "ACTIVE_REPORT_EXISTS",
                data: claimant
                  ? {
                      reportId: String((claimant as any)._id),
                      jobId: (claimant as any).job_id,
                      status:
                        (claimant as any).job_status ||
                        (claimant as any).status,
                    }
                  : undefined,
              },
            );
          }
        }
        if (!report) {
          throw new Error("Unable to create or resume the asset report");
        }
        if (auctioneerWorkItem) {
          await linkAuctioneerReport({
            item: auctioneerWorkItem,
            userId: user?._id || req.userId,
            reportType: "asset",
            reportId: report._id,
          });
        }
        return String(report._id);
      }

      const valuationMethods = normalizeValuationMethods(details.valuation_methods);
      const filter = { user: userId, client_submission_id: clientSubmissionId };
      const insert = {
        user: userId,
        client_submission_id: clientSubmissionId,
        capture_id: optionalCaptureId(details.capture_id),
        submission_contract_claim: contractClaim,
        submission_contract_claim_bypassed: contractClaimBypassed
          ? true
          : undefined,
        contract_no: details.contract_no || "",
        contract_key:
          normalizeReportContractKey(details.contract_no) || undefined,
        sales_date: new Date(details.sales_date || new Date().toISOString()),
        location: details.location || "",
        imageUrls: [],
        videoUrls: [],
        lots: [],
        mixed_lots: details.mixed_lots || [],
        status: "processing",
        language: details.language || "en",
        currency: details.currency || "CAD",
        include_damage_analysis: resolveIncludeDamageAnalysis(
          details.include_damage_analysis,
          true,
        ),
        bank_photos_enabled: resolveBooleanFlag(
          details.bank_photos_enabled,
          false,
        ),
        watermark_images: resolvePhotoWatermark(details.watermark_images),
        valuation_methods: valuationMethods,
        job_id: jobId,
        job_status: "uploading",
        queued_at: new Date(),
        auctionsoft:
          !auctioneerWorkItem &&
          details.auctionsoft &&
          typeof details.auctionsoft === "object"
            ? details.auctionsoft
            : undefined,
        auctioneerWorkItem: auctioneerWorkItem?._id,
      };
      let listing;
      try {
        listing = await LotListing.findOneAndUpdate(
          filter,
          { $setOnInsert: insert },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
        listing = await LotListing.findOne(filter);
        if (
          !listing &&
          isSubmissionContractClaimDuplicateKeyError(error) &&
          contractClaim
        ) {
          const claimant = await findSubmissionContractClaimant({
            reportType: "lotListing",
            userId,
            contractClaim,
          });
          throw Object.assign(
            new Error("A lot listing for this contract is already being processed."),
            {
              statusCode: 409,
              code: "ACTIVE_REPORT_EXISTS",
              data: claimant
                ? {
                    reportId: String((claimant as any)._id),
                    jobId: (claimant as any).job_id,
                    status:
                      (claimant as any).job_status ||
                      (claimant as any).status,
                  }
                : undefined,
            },
          );
        }
      }
      if (!listing) {
        throw new Error("Unable to create or resume the lot listing");
      }
      if (auctioneerWorkItem) {
        await linkAuctioneerReport({
          item: auctioneerWorkItem,
          userId: user?._id || req.userId,
          reportType: "lotListing",
          reportId: listing._id,
        });
      }
      return String(listing._id);
    },
  );
}

/**
 * Fence placeholder creation from a concurrent "start separate" request.
 * The token is a resumable logical lock rather than a process lease: after a
 * crash, the next completion adopts it and either links the idempotently
 * created placeholder or creates that same placeholder. Only a confirmed
 * pre-insert client error releases the lock for supersession.
 */
async function ensureUploadSessionPlaceholder(input: {
  type: ReportUploadSessionType;
  req: AuthRequest;
  session: any;
}) {
  const linkPlaceholder = async (reportId: string, token?: string) => {
    const linked = await ReportUploadSession.findOneAndUpdate(
      {
        _id: input.session._id,
        type: input.type,
        user: input.req.userId as any,
        status: "completed",
        cleanupStartedAt: { $exists: false },
        ...(token ? { finalizationClaimToken: token } : {}),
        $and: [missingStringField("reportId")],
      },
      {
        $set: { reportId },
        $unset: {
          finalizationClaimToken: 1,
          finalizationClaimedAt: 1,
          lastError: 1,
        },
      },
      { new: true }
    ).select("+finalizationClaimToken");
    if (linked) return reportId;

    const latest = await ReportUploadSession.findOne({
      _id: input.session._id,
      type: input.type,
      user: input.req.userId as any,
    }).select("+finalizationClaimToken");
    if (String(latest?.reportId || "") === reportId) return reportId;
    if (latest?.cleanupStartedAt) {
      throw Object.assign(
        new Error(
          "This upload session was stopped while report finalization was starting."
        ),
        { code: "UPLOAD_SESSION_CLEANUP_STARTED", statusCode: 409 }
      );
    }
    throw Object.assign(
      new Error(
        "The report placeholder was saved, but the upload session could not confirm it. Retry this completion."
      ),
      { code: "UPLOAD_SESSION_FINALIZATION_PENDING", statusCode: 503 }
    );
  };

  const recovered = await findUploadSessionPlaceholder(input);
  if (recovered) {
    return linkPlaceholder(String(recovered._id));
  }

  let current = await ReportUploadSession.findOne({
    _id: input.session._id,
    type: input.type,
    user: input.req.userId as any,
  }).select("+finalizationClaimToken");
  if (!current || current.cleanupStartedAt || current.status !== "completed") {
    throw Object.assign(
      new Error(
        "This upload session changed while report finalization was starting."
      ),
      {
        code: current?.cleanupStartedAt
          ? "UPLOAD_SESSION_CLEANUP_STARTED"
          : "UPLOAD_SESSION_COMPLETION_STALE",
        statusCode: 409,
      }
    );
  }
  if (current.reportId) return String(current.reportId);

  let token = String(current.finalizationClaimToken || "");
  if (!token) {
    token = randomUUID();
    current = await ReportUploadSession.findOneAndUpdate(
      {
        _id: current._id,
        type: input.type,
        user: input.req.userId as any,
        status: "completed",
        cleanupStartedAt: { $exists: false },
        $and: [
          missingStringField("reportId"),
          missingStringField("finalizationClaimToken"),
        ],
      },
      {
        $set: {
          finalizationClaimToken: token,
          finalizationClaimedAt: new Date(),
        },
      },
      { new: true }
    ).select("+finalizationClaimToken");
    if (!current) {
      const latest = await ReportUploadSession.findOne({
        _id: input.session._id,
        type: input.type,
        user: input.req.userId as any,
      }).select("+finalizationClaimToken");
      if (latest?.reportId) return String(latest.reportId);
      if (latest?.cleanupStartedAt) {
        throw Object.assign(
          new Error(
            "This upload session was stopped while report finalization was starting."
          ),
          { code: "UPLOAD_SESSION_CLEANUP_STARTED", statusCode: 409 }
        );
      }
      token = String(latest?.finalizationClaimToken || "");
      if (!token) {
        throw Object.assign(
          new Error(
            "This upload session changed while report finalization was starting. Retry the same completion."
          ),
          { code: "UPLOAD_SESSION_COMPLETION_STALE", statusCode: 409 }
        );
      }
    }
  }

  try {
    const reportId = await createPlaceholderReport(
      input.type,
      input.req,
      current?.details || input.session.details,
      String(current?.jobId || input.session.jobId),
      String(
        current?.clientSubmissionId ||
          input.session.clientSubmissionId ||
          current?.jobId ||
          input.session.jobId
      )
    );
    return await linkPlaceholder(reportId, token);
  } catch (error: any) {
    // A lost response after the report upsert is not proof that no report was
    // created. Link the exact stable placeholder before considering release.
    let exactPlaceholder: any = null;
    try {
      exactPlaceholder = await findUploadSessionPlaceholder({
        type: input.type,
        session: current || input.session,
      });
    } catch (lookupError) {
      console.error("[UploadSession] placeholder recovery lookup failed", {
        type: input.type,
        sessionId: String(input.session._id),
        jobId: input.session.jobId,
        error:
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError),
      });
    }
    if (exactPlaceholder) {
      return linkPlaceholder(String(exactPlaceholder._id), token);
    }

    const statusCode = Number(error?.statusCode);
    if (Number.isInteger(statusCode) && statusCode < 500) {
      await ReportUploadSession.updateOne(
        {
          _id: input.session._id,
          status: "completed",
          finalizationClaimToken: token,
          $and: [missingStringField("reportId")],
        },
        {
          $set: { lastError: error?.message || String(error) },
          $unset: {
            finalizationClaimToken: 1,
            finalizationClaimedAt: 1,
          },
        }
      );
    }
    throw error;
  }
}

export async function issueSessionUploadTargets(
  session: any,
  start = 0,
  limit = Number.MAX_SAFE_INTEGER
) {
  const storageTarget = resolvePersistedR2StorageTarget(session);
  if (storageTarget.generation !== "current") {
    const error = Object.assign(
      new Error(legacyUploadSessionReadOnlyBody().message),
      {
        code: LEGACY_UPLOAD_SESSION_READ_ONLY_CODE,
        statusCode: 409,
      }
    );
    throw error;
  }
  const bucketName = storageTarget.bucketName;
  return Promise.all(
    session.files.slice(start, start + limit).map(async (file: any) => ({
      fileId: file.fileId,
      key: file.key,
      uploadUrl: await createR2PresignedPutUrl(
        bucketName,
        file.key,
        file.mimetype,
        UPLOAD_TARGET_TTL_SECONDS,
        { preventOverwrite: true }
      ),
      method: "PUT",
      contentType: file.mimetype,
      // If-None-Match is part of the presigned request. Clients must send it
      // so a stale/retried URL can never replace an accepted report source.
      headers: { "If-None-Match": "*" },
      publicUrl: getR2PublicUrl(file.key, storageTarget),
    }))
  );
}

export function createUploadSession(type: ReportUploadSessionType) {
  const execute = createUploadSessionUnlocked(type);
  return async (req: AuthRequest, res: Response) => {
    try {
      let parsed: any;
      try { parsed = parseDetails(req.body?.details); } catch { return execute(req, res); }
      const providedId = normalizeClientSubmissionId(
        [parsed?.client_submission_id, parsed?.progress_id, parsed?.progressId, parsed?.job_id]
          .find(value => typeof value === "string" && value),
      );
      const existing = providedId ? await findUploadSessionFollowingSupersedeAliases({
        type, userId: req.userId, clientSubmissionId: providedId,
      }) : null;
      const persistedWorkItemId = String(existing?.details?.auctioneer_work_item_id || "");
      const requestedWorkItemId = String(parsed?.auctioneer_work_item_id || "");
      if (persistedWorkItemId && persistedWorkItemId !== requestedWorkItemId) {
        return res.status(409).json({ code: "UPLOAD_SESSION_IDENTITY_CHANGED",
          message: "The saved Incoming work-item identity cannot be removed or replaced. Retry the exact saved capture." });
      }
      // Persisted authority wins: omitting an Incoming field must not bypass
      // the lease or a durable parent pin after a partial reservation write.
      const workItemId = persistedWorkItemId || requestedWorkItemId;
      const parent = /^[a-f\d]{24}$/i.test(workItemId) ? await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: req.userId }).select("contract.id").lean() : null;
      if (!parent) return execute(req, res);
      // Serializes metadata mutation with queued-continuation pinning. A
      // pending parent pin also freezes details after an interrupted session CAS.
      return await withAuctioneerContractOperation(parent.contract.id, req.userId!, async lease => {
        await lease.assertOwned(); return execute(req, res);
      });
    } catch (error: any) {
      if (String(error?.code || "").startsWith("auctioneer_contract_")) return res.status(error.statusCode || 409).json({ code: error.code, message: error.message });
      throw error;
    }
  };
}

function createUploadSessionUnlocked(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    let submissionAdmission: ReportSubmissionAdmissionLease | null = null;
    try {
      const details = parseDetails(req.body?.details);
      details.capture_id = optionalCaptureId(details.capture_id);
      const submittedCoordinates = getExplicitCoordinates(details);
      if (hasAnyCoordinateInput(details) && !submittedCoordinates) {
        return res.status(400).json({
          message:
            "Latitude and longitude must be supplied together within valid ranges.",
        });
      }
      delete details.latitude;
      delete details.longitude;
      if (submittedCoordinates) Object.assign(details, submittedCoordinates);
      if (type === "lotListing") {
        const valuationMethods = normalizeValuationMethods(details.valuation_methods);
        if (valuationMethods.length === 0) {
          return res.status(400).json({
            message: "Select at least one supported valuation method",
          });
        }
        details.valuation_methods = valuationMethods;
      }

      await resolveAuctioneerReportContext({
        details,
        userId: (req as any).user?._id || req.userId,
        reportType: type,
      });
      const supersedesClientSubmissionId = normalizeClientSubmissionId(
        details?.supersedes_client_submission_id,
      );
      let supersedesClientSubmissionIds = supersedesClientSubmissionId
        ? [supersedesClientSubmissionId]
        : [];
      delete details.supersedes_client_submission_id;
      const requestedFiles = normalizeRequestedFiles(Array.isArray(req.body?.files) ? req.body.files : []);
      const providedId =
        (typeof details?.client_submission_id === "string" && details.client_submission_id) ||
        (typeof details?.progress_id === "string" && details.progress_id) ||
        (typeof details?.progressId === "string" && details.progressId) ||
        (typeof details?.job_id === "string" && details.job_id) ||
        undefined;
      let clientSubmissionId = normalizeClientSubmissionId(
        providedId || `${type}-${Date.now()}-${randomUUID()}`
      );
      details.client_submission_id = clientSubmissionId;
      const smartUpload = resolveBoolean(details.smart_upload);
      const groupingMethod = req.body?.groupingMethod ?? "black_divider";
      if (!["black_divider", "lot_number"].includes(groupingMethod) || (!smartUpload && groupingMethod !== "black_divider")) {
        return res.status(400).json({ code: "INVALID_UPLOAD_GROUPING_METHOD", message: "Choose a supported Smart Upload method." });
      }
      delete details.smart_upload_grouping_method;
      if (smartUpload) details.smart_upload_grouping_method = groupingMethod;
      const activeContractClaim = resolveUploadSessionContractClaim(details);
      submissionAdmission = await acquireReportSubmissionAdmission({
        reportType: type,
        userId: req.userId,
        contractClaim: activeContractClaim,
      });
      const manifestHash = buildManifestHash(requestedFiles);
      const imageCount = requestedFiles.filter((file) => file.fieldname === "images").length;
      const videoCount = requestedFiles.filter((file) => file.fieldname === "videos").length;
      const expectedMixedImages = getExpectedMixedImageCount(details);
      const mixedLotPhotoLimitMessage =
        !smartUpload && type === "asset" ? getMixedLotPhotoLimitMessage(details) : null;

      if (requestedFiles.length === 0) {
        return res.status(400).json({ message: "No files provided for upload session." });
      }
      if (!smartUpload && expectedMixedImages > 0 && imageCount < expectedMixedImages) {
        return res.status(400).json({
          message: `Upload incomplete: received ${imageCount} image(s), expected ${expectedMixedImages}. Please retry from the saved draft so all lots are included.`,
        });
      }
      if (mixedLotPhotoLimitMessage) {
        return res.status(400).json({ message: mixedLotPhotoLimitMessage });
      }
      if (!smartUpload) assertReportLotPhotoManifest(type, details, imageCount);
      if (smartUpload && (videoCount > 0 || imageCount !== requestedFiles.length)) {
        return res.status(400).json({
          code: "SMART_UPLOAD_IMAGES_ONLY",
          message: "Smart Upload accepts images only. Remove video files and try again.",
        });
      }
      let existingSession = await findUploadSessionFollowingSupersedeAliases({
        type,
        userId: req.userId,
        clientSubmissionId,
      });
      if (existingSession) {
        // The wrapper may have observed no session before a concurrent first
        // creation. Repeat this persisted-identity fence at the mutation boundary
        // so that such a request cannot enter as ordinary/unleased work.
        const savedIncomingId = String(existingSession.details?.auctioneer_work_item_id || "");
        if (savedIncomingId && savedIncomingId !== String(details.auctioneer_work_item_id || "")) {
          return res.status(409).json({ code: "UPLOAD_SESSION_IDENTITY_CHANGED",
            message: "The saved Incoming work-item identity cannot be removed or replaced. Retry the exact saved capture." });
        }
        const pinnedParent = !existingSession.continuationFreeze && existingSession.details?.auctioneer_work_item_id
          ? await AuctioneerWorkItem.findOne({ _id: existingSession.details.auctioneer_work_item_id, claimedBy: req.userId,
            "queuedContinuation.sessionId": String(existingSession._id) }).select({ queuedContinuation: 1 }).lean() : null;
        const continuationFreeze = existingSession.continuationFreeze || pinnedParent?.queuedContinuation;
        if (existingSession.cleanupStartedAt) {
          return res.status(409).json({
            code: "UPLOAD_SESSION_CLEANUP_STARTED",
            message:
              "This expired upload session is being cleaned up and cannot be resumed. Start a new submission.",
          });
        }
        clientSubmissionId = normalizeClientSubmissionId(
          existingSession.clientSubmissionId,
        );
        details.client_submission_id = clientSubmissionId;
        details.progress_id = existingSession.jobId;
        const existingContractKey = normalizeReportContractKey(
          existingSession.details?.contract_no,
        );
        const requestedContractKey = normalizeReportContractKey(
          details.contract_no,
        );
        if (
          existingContractKey !== requestedContractKey ||
          resolveBoolean(existingSession.details?.force_new) !==
            resolveBoolean(details.force_new)
        ) {
          return res.status(409).json({
            code: "UPLOAD_SESSION_IDENTITY_CHANGED",
            message:
              "The contract or force-new mode cannot change after an upload session starts. Start a separate submission.",
          });
        }
        const unavailable = await unavailableUploadSessionReport({ type, session: existingSession });
        if (unavailable) return res.status(409).json(unavailable);
        // The durable hash is authoritative. Very old sessions may predate the
        // stored hash; reconstruct the same canonical manifest from their
        // persisted files so only a genuinely identical retry is grandfathered.
        const existingManifestVersion =
          Number(existingSession.manifestVersion) || 1;
        const existingManifestHash =
          existingSession.manifestHash ||
          buildManifestHash(
            (existingSession.files || []) as any,
            existingManifestVersion,
          );
        const comparableRequestedManifestHash = buildManifestHash(
          requestedFiles,
          existingManifestVersion,
        );
        if (existingManifestHash !== comparableRequestedManifestHash) {
          return res.status(409).json({
            code: "SUBMISSION_MANIFEST_CHANGED",
            message: "This submission changed after upload started. Create a separate submission to continue.",
            data: await uploadSessionRecoveryReceipt({ type, session: existingSession }),
          });
        }
        if (Boolean(existingSession.smartUpload) !== smartUpload || (smartUpload && smartUploadGroupingMethod(existingSession) !== groupingMethod)) {
          return res.status(409).json({
            code: "UPLOAD_SESSION_MODE_CHANGED",
            message:
              "This upload session was created in a different upload mode. Start a new submission to switch Smart Upload on or off.",
          });
        }
        if (continuationFreeze && reportTransferSnapshotHash({ ...existingSession.toObject(), details }) !== continuationFreeze.snapshotHash) {
          return res.status(409).json({ code: "UPLOAD_SESSION_CONTINUATION_FROZEN", message: "This capture is queued with a reserved next lot. Its submitted details cannot change; continue the exact saved upload." });
        }
        if (existingSession.status === "queued" || existingSession.status === "processed") {
          const processed = existingSession.status === "processed";
          if (processed && existingSession.activeContractClaim) {
            await ReportUploadSession.updateOne(
              { _id: existingSession._id, status: "processed" },
              { $unset: { activeContractClaim: 1 } },
            );
          }
          deleteAcceptedDraftBestEffort(existingSession);
          return res.status(200).json({
            message: processed
              ? "Submission already completed."
              : "Submission already accepted and is being processed.",
            data: {
              sessionId: String(existingSession._id),
              jobId: existingSession.jobId,
              reportId: existingSession.reportId,
              status: existingSession.status,
              resumed: true,
              alreadyQueued: true,
              reusedAcceptance: true,
              accepted: true,
              reportAvailable: true,
              processed,
              readyToComplete: false,
              groupingMethod: smartUploadGroupingMethod(existingSession),
              files: [],
            },
          });
        }
        if (existingSession.status === "completed") {
          // Completion's compare-and-set freezes the accepted input snapshot.
          // A client retry may resume finalization, but it must not rewrite the
          // details that the placeholder/job will consume.
          return res.status(200).json({
            message: "Uploads already verified. Finalizing the existing submission.",
            data: {
              sessionId: String(existingSession._id),
              jobId: existingSession.jobId,
              reportId: existingSession.reportId,
              status: existingSession.status,
              resumed: true,
              alreadyQueued: false,
              readyToComplete: true,
              groupingMethod: smartUploadGroupingMethod(existingSession),
              files: [],
            },
          });
        }
        if (smartUpload && !smartUploadFilesAreEditable(existingSession)) {
          return res.status(200).json({
            message:
              "Uploads are locked while Smart Upload detection or review is in progress.",
            data: {
              sessionId: String(existingSession._id),
              jobId: existingSession.jobId,
              reportId: existingSession.reportId,
              status: existingSession.status,
              resumed: true,
              alreadyQueued: false,
              readyToComplete: false,
              files: [],
              smartUpload: true,
              smartGrouping: existingSession.smartGrouping,
              groupingMethod: smartUploadGroupingMethod(existingSession),
            },
          });
        }
        if (
          resolvePersistedR2StorageTarget(existingSession).generation !==
          "current"
        ) {
          return res.status(409).json(legacyUploadSessionReadOnlyBody());
        }
        existingSession = await ensureUploadSessionContractClaim({
          session: existingSession,
          type,
          userId: req.userId,
          contractClaim: activeContractClaim,
        });
        if (continuationFreeze) {
          return res.status(200).json({ message: "The exact queued upload is retained.", data: {
            sessionId: String(existingSession._id), jobId: existingSession.jobId, reportId: existingSession.reportId,
            status: existingSession.status, resumed: true, alreadyQueued: false, readyToComplete: false,
            files: await issueSessionUploadTargets(existingSession),
          } });
        }
        const resumedSession = await ReportUploadSession.findOneAndUpdate(
          {
            _id: existingSession._id,
            type,
            user: req.userId as any,
            status: { $nin: ["completed", "queued", "processed"] },
            cleanupStartedAt: { $exists: false },
            updatedAt: (existingSession as any).updatedAt,
            continuationFreeze: { $exists: false },
            ...(smartUpload
              ? { "smartGrouping.status": { $in: ["uploading", null] } }
              : {}),
          },
          {
            $set: {
              status: "uploading",
              smartUpload,
              details,
              lastError: undefined,
            },
          },
          { new: true, runValidators: true }
        );
        if (!resumedSession) {
          const latest = await ReportUploadSession.findById(existingSession._id);
          if (latest && smartUpload && !smartUploadFilesAreEditable(latest)) {
            return res.status(200).json({
              message:
                "Uploads are locked while Smart Upload detection or review is in progress.",
              data: {
                sessionId: String(latest._id),
                jobId: latest.jobId,
                reportId: latest.reportId,
                status: latest.status,
                resumed: true,
                alreadyQueued: false,
                readyToComplete: false,
                files: [],
                smartUpload: true,
                smartGrouping: latest.smartGrouping,
                groupingMethod: smartUploadGroupingMethod(latest),
              },
            });
          }
          return res.status(409).json({
            code: "UPLOAD_SESSION_CHANGED",
            message:
              "This upload session changed while it was being resumed. Refresh and continue from its latest state.",
          });
        }
        await syncUploadSessionDraftBestEffort(resumedSession, "resume");
        return res.status(200).json({
          message: "Upload session resumed",
          data: {
            sessionId: String(resumedSession._id),
            jobId: resumedSession.jobId,
            reportId: resumedSession.reportId,
            status: resumedSession.status,
            resumed: true,
            alreadyQueued: false,
            readyToComplete: false,
            files: await issueSessionUploadTargets(
              resumedSession,
              0,
              smartUpload ? 100 : Number.MAX_SAFE_INTEGER
            ),
            nextCursor:
              smartUpload && resumedSession.files.length > 100 ? "100" : undefined,
            smartUpload,
            smartGrouping: resumedSession.smartGrouping,
            groupingMethod: smartUploadGroupingMethod(resumedSession),
          },
        });
      }

      // New-session admission applies before creating a durable manifest or
      // issuing its first targets. Exact same-mode sessions accepted before an
      // allowlist/limit rollout resume above so deployments do not strand work
      // already in progress.
      if (smartUpload) {
        const mediaViolation =
          getSmartUploadManifestImageViolation(requestedFiles);
        if (mediaViolation) {
          return res.status(mediaViolation.statusCode).json({
            code: mediaViolation.code,
            message: mediaViolation.message,
            data: mediaViolation.data,
          });
        }
        const limitViolation = getSmartUploadLimitViolation(requestedFiles);
        if (limitViolation) {
          return res.status(limitViolation.statusCode).json({
            code: limitViolation.code,
            message: limitViolation.message,
            data: limitViolation.data,
          });
        }
      }

      if (
        supersedesClientSubmissionId &&
        supersedesClientSubmissionId !== clientSubmissionId
      ) {
        const supersededSession = await ReportUploadSession.findOne({
          type,
          user: req.userId as any,
          clientSubmissionId: supersedesClientSubmissionId,
        }).select("+finalizationClaimToken");
        if (supersededSession) {
          const supersededContractNo = String(
            supersededSession.details?.contract_no || "",
          ).trim();
          const replacementContractNo = String(
            details.contract_no || "",
          ).trim();
          if (
            normalizeReportContractKey(supersededContractNo) !==
              normalizeReportContractKey(replacementContractNo) ||
            Boolean(supersededSession.smartUpload) !== smartUpload
          ) {
            return res.status(409).json({
              code: "UPLOAD_SESSION_SUPERSEDE_MISMATCH",
              message:
                "The previous upload belongs to a different report or upload mode and cannot be replaced.",
            });
          }
          if (
            await uploadSessionHasReportHandoff({
              type,
              session: supersededSession,
            })
          ) {
            const receipt = await uploadSessionRecoveryReceipt({ type, session: supersededSession });
            return res.status(409).json({
              code: receipt.code || "ACTIVE_REPORT_EXISTS",
              message:
                receipt.code ? receipt.message : "The original upload is already finalizing or accepted and cannot be replaced. Continue the same saved upload.",
              data: receipt,
            });
          }

          supersedesClientSubmissionIds = Array.from(
            new Set(
              [
                ...(Array.isArray(
                  supersededSession.supersedesClientSubmissionIds,
                )
                  ? supersededSession.supersedesClientSubmissionIds
                  : []),
                supersededSession.clientSubmissionId,
                supersedesClientSubmissionId,
              ]
                .map(normalizeClientSubmissionId)
                .filter(Boolean),
            ),
          );

          const alreadyClaimedByReplacement =
            Boolean(supersededSession.cleanupStartedAt) &&
            supersededSession.supersededByClientSubmissionId ===
              clientSubmissionId;

          if (!alreadyClaimedByReplacement) {
            const cleanupStartedAt = new Date();
            const cleanupNotBefore = new Date(
              cleanupStartedAt.getTime() +
                UPLOAD_TARGET_TTL_SECONDS * 1000 +
                SUPERSEDE_CLEANUP_GRACE_MS,
            );
            const claimedSupersededSession =
              await ReportUploadSession.findOneAndUpdate(
                {
                  _id: supersededSession._id,
                  type,
                  user: req.userId as any,
                  cleanupStartedAt: { $exists: false },
                  updatedAt: (supersededSession as any).updatedAt,
                  status: { $in: ["created", "uploading", "failed", "completed"] },
                  $and: [
                    missingStringField("reportId"),
                    missingStringField("finalizationClaimToken"),
                  ],
                },
                {
                  $set: {
                    cleanupStartedAt,
                    cleanupNotBefore,
                    supersededAt: cleanupStartedAt,
                    supersededByClientSubmissionId: clientSubmissionId,
                    lastError: `Superseded by ${clientSubmissionId}`,
                  },
                  $unset: { activeContractClaim: 1 },
                },
                { new: true },
              );

            if (!claimedSupersededSession) {
              const latestSupersededSession =
                await ReportUploadSession.findById(
                  supersededSession._id
                ).select("+finalizationClaimToken");
              if (
                latestSupersededSession &&
                await uploadSessionHasReportHandoff({
                  type,
                  session: latestSupersededSession,
                })
              ) {
                const receipt = await uploadSessionRecoveryReceipt({ type, session: latestSupersededSession });
                return res.status(409).json({
                  code: receipt.code || "ACTIVE_REPORT_EXISTS",
                  message:
                    receipt.code ? receipt.message : "The original upload began finalizing before its replacement could start. Continue the same saved upload.",
                  data: receipt,
                });
              }
              if (
                !latestSupersededSession?.cleanupStartedAt ||
                latestSupersededSession.supersededByClientSubmissionId !==
                  clientSubmissionId
              ) {
                return res.status(409).json({
                  code: "UPLOAD_SESSION_SUPERSEDE_STALE",
                  message:
                    "The original upload changed while its replacement was starting. Retry after its current cleanup finishes.",
                });
              }
            }
          }
        }
      }

      if (!resolveBoolean(details.force_new)) {
        const active = await findActiveSameContractReport({
          reportType: type,
          userId: req.userId as any,
          contractNo: details.contract_no,
          excludeClientSubmissionId: clientSubmissionId,
        });
        if (active) {
          const activeJobId = String((active as any).job_id || "");
          const activeProgress = activeJobId
            ? await getMongoReportJobProgress(activeJobId)
            : null;
          return res.status(409).json({
            code: "ACTIVE_REPORT_EXISTS",
            message: "A report for this contract is already being processed.",
            data: {
              reportId: String((active as any)._id),
              jobId: (active as any).job_id,
              status: (active as any).job_status || (active as any).status,
              progress: (activeProgress as any)?.progress || undefined,
            },
          });
        }
      }

      // Clear a terminal owner's stale claim before looking for legacy
      // claimless sessions. Otherwise the claimant lookup below sees the
      // failed/processed row itself and incorrectly rejects a valid retry.
      await releaseInactiveUploadSessionContractClaim({
        type,
        userId: req.userId,
        contractClaim: activeContractClaim,
      });

      const legacyUploadClaimant = await claimMatchingLegacyUploadSession({
        type,
        userId: req.userId,
        contractClaim: activeContractClaim,
        excludeClientSubmissionId: clientSubmissionId,
      });
      if (legacyUploadClaimant) {
        const conflict = uploadSessionContractConflict(legacyUploadClaimant);
        return res.status(conflict.statusCode).json({
          code: conflict.code,
          message: conflict.message,
          data: conflict.data,
        });
      }

      const jobId =
        clientSubmissionId ||
        `${type === "asset" ? "cv" : "ll"}-r2-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      details.progress_id = jobId;
      const storageTarget = getCurrentR2StorageTarget();

      const session = new ReportUploadSession({
        type,
        status: "uploading",
        user: req.userId as any,
        jobId,
        clientSubmissionId,
        activeContractClaim,
        capture_id: details.capture_id,
        supersedesClientSubmissionIds:
          supersedesClientSubmissionIds.length > 0
            ? supersedesClientSubmissionIds
            : undefined,
        manifestHash,
        manifestVersion: CURRENT_MANIFEST_VERSION,
        smartUpload,
        smartGrouping: smartUpload
          ? {
              method: groupingMethod,
              status: "uploading",
              progressPercent: 0,
              revision: 0,
              orderReviewRequired: resolveBoolean(
                details.smart_upload_order_ambiguous
              ),
              unresolvedDividerIds: [],
              unresolvedLotNumberFileIds: [],
              dividerFileIds: [],
              groups: [],
              warnings: [],
              metrics: [],
            }
          : undefined,
        details,
        r2Bucket: storageTarget.bucketName,
        r2PublicBaseUrl: storageTarget.publicBaseUrl,
        files: [],
        expectedFileCount: requestedFiles.length,
        expectedImageCount: imageCount,
        expectedVideoCount: videoCount,
        totalBytes: requestedFiles.reduce((sum, file) => sum + (file.size || 0), 0),
        uploadStartedAt: new Date(),
      });

      const sessionId = String(session._id);
      const files = requestedFiles.map((file, index) => {
        const key = `uploads/report-sessions/${type}/${sessionId}/${String(index + 1).padStart(5, "0")}-${file.fileId}-${file.originalname}`;
        return { ...file, key };
      });
      session.files = files as any;
      await submissionAdmission?.assertOwned();
      await session.save();
      await syncUploadSessionDraftBestEffort(session, "create");

      const presignedFiles = await issueSessionUploadTargets(
        session,
        0,
        smartUpload ? 100 : Number.MAX_SAFE_INTEGER
      );

      console.log("[UploadSession] created", {
        type,
        sessionId,
        jobId,
        files: files.length,
        images: imageCount,
        videos: videoCount,
        bytes: session.totalBytes,
      });

      res.status(201).json({
        message: "Upload session created",
        data: {
          sessionId,
          jobId,
          reportId: session.reportId,
          status: session.status,
          resumed: false,
          alreadyQueued: false,
          readyToComplete: false,
          files: presignedFiles,
          nextCursor: smartUpload && files.length > 100 ? "100" : undefined,
          smartUpload,
          smartGrouping: session.smartGrouping,
          groupingMethod: smartUploadGroupingMethod(session),
        },
      });
    } catch (error: any) {
      console.error("[UploadSession] create failed:", error);
      if (error?.code === 11000) {
        const retryDetails = parseDetails(req.body?.details);
        const retrySmartUpload = resolveBoolean(retryDetails.smart_upload);
        const retryFiles = normalizeRequestedFiles(
          Array.isArray(req.body?.files) ? req.body.files : []
        );
        const retryId = normalizeClientSubmissionId(
          retryDetails?.client_submission_id ||
            retryDetails?.progress_id ||
            retryDetails?.progressId ||
            retryDetails?.job_id
        );
        if (isUploadSessionContractClaimDuplicateKeyError(error)) {
          const retryContractClaim = resolveUploadSessionContractClaim(
            retryDetails,
          );
          const claimant = retryContractClaim
            ? await findUploadSessionContractClaimant({
                type,
                userId: req.userId,
                contractClaim: retryContractClaim,
              })
            : null;
          if (
            !claimant ||
            normalizeClientSubmissionId(claimant.clientSubmissionId) !==
              retryId
          ) {
            const conflict = uploadSessionContractConflict(claimant);
            return res.status(conflict.statusCode).json({
              code: conflict.code,
              message: conflict.message,
              data: conflict.data,
            });
          }
        }
        const existing = retryId
          ? await findUploadSessionFollowingSupersedeAliases({
              type,
              userId: req.userId,
              clientSubmissionId: retryId,
            })
          : null;
        if (existing) {
          if (
            normalizeReportContractKey(existing.details?.contract_no) !==
              normalizeReportContractKey(retryDetails.contract_no) ||
            resolveBoolean(existing.details?.force_new) !==
              resolveBoolean(retryDetails.force_new)
          ) {
            return res.status(409).json({
              code: "UPLOAD_SESSION_IDENTITY_CHANGED",
              message:
                "The contract or force-new mode cannot change after an upload session starts. Start a separate submission.",
            });
          }
          const unavailable = await unavailableUploadSessionReport({ type, session: existing });
          if (unavailable) return res.status(409).json(unavailable);
          const existingManifestVersion = Number(existing.manifestVersion) || 1;
          const comparableRetryManifestHash = buildManifestHash(
            retryFiles,
            existingManifestVersion,
          );
          if (
            existing.manifestHash &&
            existing.manifestHash !== comparableRetryManifestHash
          ) {
            return res.status(409).json({
              code: "SUBMISSION_MANIFEST_CHANGED",
              message:
                "This submission changed after upload started. Create a separate submission to continue.",
              data: await uploadSessionRecoveryReceipt({ type, session: existing }),
            });
          }
          if (Boolean(existing.smartUpload) !== retrySmartUpload || (retrySmartUpload && smartUploadGroupingMethod(existing) !== (req.body?.groupingMethod ?? "black_divider"))) {
            return res.status(409).json({
              code: "UPLOAD_SESSION_MODE_CHANGED",
              message:
                "This upload session was created in a different upload mode. Start a new submission to switch Smart Upload on or off.",
            });
          }
          if (existing.cleanupStartedAt) {
            return res.status(409).json({
              code: "UPLOAD_SESSION_CLEANUP_STARTED",
              message:
                "This expired upload session is being cleaned up and cannot be resumed. Start a new submission.",
            });
          }
          const queued = existing.status === "queued" || existing.status === "processed";
          const processed = existing.status === "processed";
          const readyToComplete = existing.status === "completed";
          const uploadTargetsLocked =
            Boolean(existing.smartUpload) &&
            !smartUploadFilesAreEditable(existing);
          if (
            !queued &&
            !readyToComplete &&
            !uploadTargetsLocked &&
            resolvePersistedR2StorageTarget(existing).generation !== "current"
          ) {
            return res.status(409).json(legacyUploadSessionReadOnlyBody());
          }
          if (queued) {
            deleteAcceptedDraftBestEffort(existing);
          } else if (!readyToComplete) {
            await syncUploadSessionDraftBestEffort(
              existing,
              "duplicate-key-resume"
            );
          }
          return res.status(200).json({
            message: processed
              ? "Submission already completed."
              : queued
              ? "Submission already accepted and is being processed."
              : readyToComplete
                ? "Uploads already verified. Finalizing the existing submission."
                : "Upload session resumed",
            data: {
              sessionId: String(existing._id),
              jobId: existing.jobId,
              reportId: existing.reportId,
              status: existing.status,
              resumed: true,
              alreadyQueued: queued,
              ...(queued ? { accepted: true, reportAvailable: true, reusedAcceptance: true } : {}),
              processed,
              readyToComplete,
              files:
                queued || readyToComplete || uploadTargetsLocked
                  ? []
                  : await issueSessionUploadTargets(
                      existing,
                      0,
                      existing.smartUpload ? 100 : Number.MAX_SAFE_INTEGER
                    ),
              nextCursor:
                existing.smartUpload &&
                !uploadTargetsLocked &&
                existing.files.length > 100
                  ? "100"
                  : undefined,
              smartUpload: existing.smartUpload,
              smartGrouping: existing.smartGrouping,
              groupingMethod: smartUploadGroupingMethod(existing),
            },
          });
        }
      }
      const auctioneerError = auctioneerContextErrorBody(error);
      if (auctioneerError) {
        return res.status(auctioneerError.statusCode).json(auctioneerError.body);
      }
      const statusCode = Number(error?.statusCode);
      if (Number.isInteger(statusCode) && statusCode < 500) {
        return res.status(statusCode).json({
          ...(error?.code ? { code: String(error.code) } : {}),
          ...(error?.data ? { data: error.data } : {}),
          message: error?.message || "Error creating upload session",
        });
      }
      res.status(500).json({ message: "Error creating upload session", error: error?.message || String(error) });
    } finally {
      await submissionAdmission?.release().catch((releaseError) => {
        console.error(
          "[UploadSession] failed to release submission admission:",
          releaseError,
        );
      });
    }
  };
}

/** Small, read-only receipt lookup after a lost completion response. */
export function getUploadSessionStatus(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const session = await ReportUploadSession.findOne({
        _id: req.params.sessionId as any,
        type,
        user: req.userId as any,
      })
        .select("status user reportId jobId clientSubmissionId cleanupStartedAt details.auctioneer_work_item_id +finalizationClaimToken")
        .maxTimeMS(10_000)
        .setOptions({ timeoutMS: 10_000 })
        .lean();
      if (!session) return res.status(404).json({ message: "Upload session not found" });

      const receipt = await uploadSessionRecoveryReceipt({ type, session });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ data: receipt });
    } catch (error: any) {
      return res.status(error?.name === "CastError" ? 404 : 503).json({
        message: error?.name === "CastError" ? "Upload session not found"
          : "Upload status is temporarily unavailable. Retry with the same saved upload.",
      });
    }
  };
}

/*
 * Completion verification of an ordinary (non-Smart Upload) session.
 *
 * Completion HEADs every photo of the report before accepting it. The mobile
 * app waits 120 s for that answer, and so does the proxy in front of this API.
 * A report with a few thousand photos, or a slow storage day, can run past that
 * window; the app then retries -- up to four times -- and each retry used to
 * start the whole HEAD pass again while the abandoned attempt kept running, so
 * the work multiplied and the progress bar sat at "Finalizing" (reported from
 * the field, 2026-10-01).
 *
 * Three rules keep a retry from repeating finished work:
 *   1. Each successful HEAD is recorded on the session as it happens (in
 *      batches), so an attempt that outlives its caller still leaves progress
 *      behind for the retry.
 *   2. A photo whose recorded verification is recent and matches the manifest
 *      size exactly is not checked again. The record is only ever written by
 *      this server after a HEAD, a per-file verify, or a server-side upload of
 *      that same key, and an expired session's objects are only removed after
 *      cleanupStartedAt is set -- which the submission compare-and-set already
 *      refuses. The age bound keeps a session resumed much later honest.
 *   3. Each HEAD has a deadline, and a HEAD that fails for any reason other
 *      than "not found" is reported as retryable (503) instead of failing the
 *      session as a missing photo.
 *
 * Smart Upload sessions keep their existing rule (they are HEAD-verified by
 * the confirm API) and are not written to here.
 */
type VerifiedUploadMarker = {
  fileId: string;
  key: string;
  uploadedAt: Date;
  verifiedSize: number;
};

/** HEAD results recorded per database write; keeps a 5,000-photo pass to ~100 writes. */
const VERIFIED_MARKER_BATCH_SIZE = 50;

/**
 * Whether this photo's last server-side verification can stand in for a new
 * HEAD: it must match the manifest size exactly and be no older than maxAgeMs.
 * A small allowance covers clock differences between API processes.
 */
export function isRecentUploadVerification(
  file: {
    size?: number | null;
    verifiedSize?: number | null;
    uploadedAt?: Date | string | null;
  },
  now: number,
  maxAgeMs: number
): boolean {
  const expectedSize = Number(file.size || 0);
  const verifiedSize = Number(file.verifiedSize);
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) return false;
  if (!Number.isSafeInteger(verifiedSize) || verifiedSize !== expectedSize) return false;
  if (!file.uploadedAt) return false;
  const verifiedAt = new Date(file.uploadedAt).getTime();
  if (!Number.isFinite(verifiedAt)) return false;
  const age = now - verifiedAt;
  return age >= -60_000 && age <= maxAgeMs;
}

/**
 * Persist a batch of completion's own HEAD results. Best effort: a failed write
 * only means the next attempt checks those photos again.
 *
 * timestamps:false is load-bearing. The submission compare-and-set below
 * matches the session's updatedAt; letting Mongoose bump it here would make
 * this very request's submission look stale.
 */
async function recordVerifiedUploadFiles(input: {
  sessionId: unknown;
  type: ReportUploadSessionType;
  userId: unknown;
  markers: VerifiedUploadMarker[];
}): Promise<void> {
  if (input.markers.length === 0) return;
  const $set: Record<string, unknown> = {};
  const arrayFilters = input.markers.map((marker, index) => {
    $set[`files.$[v${index}].uploadedAt`] = marker.uploadedAt;
    $set[`files.$[v${index}].verifiedSize`] = marker.verifiedSize;
    return { [`v${index}.fileId`]: marker.fileId, [`v${index}.key`]: marker.key };
  });
  try {
    await ReportUploadSession.updateOne(
      {
        _id: input.sessionId as any,
        type: input.type,
        user: input.userId as any,
        status: { $nin: ["completed", "queued", "processed"] },
        cleanupStartedAt: { $exists: false },
      },
      { $set },
      { arrayFilters, timestamps: false }
    );
  } catch (error) {
    console.warn("[UploadSession] verification progress not recorded", {
      sessionId: String(input.sessionId),
      files: input.markers.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function completeUploadSession(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;
      const foundSession = await ReportUploadSession.findOne({
        _id: sessionId as any,
        type,
        user: req.userId as any,
      }).select("+activeContractClaim +finalizationClaimToken");

      if (!foundSession) {
        return res.status(404).json({ message: "Upload session not found" });
      }
      let session = foundSession;
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "UPLOAD_SESSION_CLEANUP_STARTED",
          message:
            "This expired upload session is being cleaned up and cannot be completed.",
        });
      }
      const unavailable = await unavailableUploadSessionReport({ type, session });
      if (unavailable) return res.status(409).json(unavailable);
      if (session.status === "queued" || session.status === "processed") {
        let processed = session.status === "processed";
        if (processed && session.activeContractClaim) {
          await ReportUploadSession.updateOne(
            { _id: session._id, status: "processed" },
            { $unset: { activeContractClaim: 1 } },
          );
        }
        if (!processed && shouldUseMongoReportQueue()) {
          try {
            const acceptedJob = await ensureQueuedUploadSessionPreviewJob({
              type,
              session,
            });
            // A worker can finish its exact report job and then lose the
            // best-effort session projection. Completion retries must heal
            // that split state instead of reporting "processing" forever.
            if (String(acceptedJob?.status || "") === "completed") {
              const healed = await ReportUploadSession.findOneAndUpdate(
                {
                  _id: session._id,
                  type,
                  user: req.userId as any,
                  reportId: session.reportId,
                  jobId: session.jobId,
                  status: "queued",
                  cleanupStartedAt: { $exists: false },
                },
                {
                  $set: { status: "processed", lastError: undefined },
                  $unset: { activeContractClaim: 1 },
                },
                { returnDocument: "after" },
              );
              processed = healed?.status === "processed";
            }
          } catch (error: any) {
            console.error("[UploadSession] queued handoff recovery pending", {
              type,
              sessionId: String(session._id),
              reportId: session.reportId,
              jobId: session.jobId,
              error: error instanceof Error ? error.message : String(error),
            });
            return res.status(Number(error?.statusCode) || 503).json({
              code: error?.code || "UPLOAD_SESSION_QUEUE_HANDOFF_PENDING",
              message:
                error?.message ||
                "The upload is saved, but its worker handoff is still pending. Retry this completion.",
              reportId: session.reportId,
              jobId: session.jobId,
            });
          }
        }
        deleteAcceptedDraftBestEffort(session);
        await wakeReportTransferNotification(session).catch(() => undefined);
        return res.status(200).json({
          message: processed ? "Upload session already processed" : "Upload session already queued",
          sessionId: String(session._id),
          accepted: true,
          reportAvailable: true,
          reusedAcceptance: true,
          jobId: session.jobId,
          reportId: session.reportId,
          status: processed ? "completed" : "processing",
          phase: processed ? "done" : "processing",
        });
      }
      session = await ensureUploadSessionContractClaim({
        session,
        type,
        userId: req.userId,
        contractClaim: resolveUploadSessionContractClaim(
          (session.details || {}) as Record<string, any>,
        ),
      });
      if (session.smartUpload && session.smartGrouping?.status !== "confirmed") {
        return res.status(409).json({
          code: "SMART_UPLOAD_GROUPING_REQUIRED",
          message: "Review and confirm the detected Smart Upload lots before creating the preview.",
          data: {
            groupingStatus: session.smartGrouping?.status || "uploading",
            progressPercent: session.smartGrouping?.progressPercent || 0,
          },
        });
      }
      if (session.smartUpload) {
        if (isLotNumberUpload(session) && ((session.smartGrouping?.dividerFileIds || []).length || (session.smartGrouping?.unresolvedLotNumberFileIds || []).length)) {
          return res.status(409).json({ code: "LOT_NUMBER_UPLOAD_REVIEW_REQUIRED", message: "Review every uncertain lot-number photo before creating the preview." });
        }
        const inspectionErrors = getSmartUploadActiveInspectionErrors(
          session.smartGrouping?.metrics,
          session.smartGrouping?.dividerFileIds || []
        );
        if (inspectionErrors.length) {
          return res.status(409).json({
            code: "SMART_UPLOAD_IMAGE_INSPECTION_FAILED",
            message:
              "One or more images could not be inspected safely. Retry or remove those images before creating the preview.",
            data: {
              unreadableFileIds: inspectionErrors.map(
                ({ fileId }) => fileId
              ),
              inspectionErrors,
            },
          });
        }
        const orderReviewState = resolveSmartUploadOrderReviewState({
          orderReviewRequired: session.smartGrouping?.orderReviewRequired,
          unresolvedDividerIds: session.smartGrouping?.unresolvedDividerIds,
          dividerFileIds: session.smartGrouping?.dividerFileIds || [],
          detailsOrderAmbiguous:
            session.details?.smart_upload_order_ambiguous,
        });
        if (
          orderReviewState.orderReviewRequired ||
          orderReviewState.unresolvedDividerIds.length > 0
        ) {
          return res.status(409).json({
            code: "SMART_UPLOAD_ORDER_REVIEW_REQUIRED",
            message:
              "Finish reviewing the image order and every unresolved divider before creating the preview.",
            data: orderReviewState,
          });
        }
      }

      const storageTarget = resolvePersistedR2StorageTarget(session);
      const bucketName = storageTarget.bucketName;
      const verifiedFiles: any[] = new Array(session.files.length);
      const missingFiles: string[] = [];
      // Photos storage could not answer for (deadline, 5xx, dropped socket).
      // Unlike a missing photo these say nothing about the upload, so they
      // never fail the session; the caller is asked to retry instead.
      const unconfirmedFiles: string[] = [];
      const sizeMismatchFiles: Array<{
        fileId: string;
        name: string;
        expectedSize: number;
        verifiedSize: number;
      }> = [];
      const smartDividerIds = new Set(
        session.smartUpload
          ? (session.smartGrouping?.dividerFileIds || []).map(String)
          : []
      );
      const verifyConcurrency = getPositiveIntEnv(
        "REPORT_UPLOAD_COMPLETE_VERIFY_CONCURRENCY",
        8
      );
      // See "Completion verification of an ordinary session" above.
      const headTimeoutMs = getPositiveIntEnv(
        "REPORT_UPLOAD_COMPLETE_HEAD_TIMEOUT_MS",
        15_000
      );
      const reuseVerifiedMs = getPositiveIntEnv(
        "REPORT_UPLOAD_VERIFIED_REUSE_MS",
        30 * 60_000
      );
      const verificationStartedAt = Date.now();
      const recordProgress =
        !session.smartUpload &&
        !["completed", "queued", "processed"].includes(String(session.status));
      const pendingMarkers: VerifiedUploadMarker[] = [];
      const markerWrites: Promise<void>[] = [];
      const flushVerifiedMarkers = () => {
        if (!recordProgress || pendingMarkers.length === 0) return;
        markerWrites.push(
          recordVerifiedUploadFiles({
            sessionId: session._id,
            type,
            userId: req.userId,
            markers: pendingMarkers.splice(0, pendingMarkers.length),
          })
        );
      };
      let reusedVerifications = 0;
      let storageChecks = 0;
      await mapWithConcurrency(
        session.files as any[],
        verifyConcurrency,
        async (file, index) => {
          const expectedSize = Number(file.size || 0);
          const hasExpectedSize =
            Number.isSafeInteger(expectedSize) && expectedSize > 0;
          const storedVerifiedSize = Number(file.verifiedSize);
          // Smart Upload batches are already HEAD-verified by the confirm API.
          // Repeating that work here makes a 1,000-image completion unnecessarily
          // slow and can trigger R2 rate limits. Trust that marker only when it
          // exactly matches the immutable manifest size; older sessions may have
          // been confirmed before strict size verification existed.
          if (
            session.smartUpload &&
            file.uploadedAt &&
            hasExpectedSize &&
            Number.isSafeInteger(storedVerifiedSize) &&
            storedVerifiedSize === expectedSize
          ) {
            verifiedFiles[index] = file;
            return;
          }
          if (
            !session.smartUpload &&
            isRecentUploadVerification(file, verificationStartedAt, reuseVerifiedMs)
          ) {
            reusedVerifications += 1;
            verifiedFiles[index] = file;
            return;
          }
          try {
            storageChecks += 1;
            const head = await headR2Object(bucketName, file.key, {
              timeoutMs: headTimeoutMs,
            });
            const headSize = Number(head.size || 0);
            if (
              (session.smartUpload && !hasExpectedSize) ||
              (hasExpectedSize && headSize !== expectedSize)
            ) {
              sizeMismatchFiles.push({
                fileId: String(file.fileId),
                name: String(file.originalname || file.fileId),
                expectedSize,
                verifiedSize: headSize,
              });
              return;
            }
            file.uploadedAt = new Date();
            file.verifiedSize = headSize;
            verifiedFiles[index] = file;
            if (recordProgress) {
              pendingMarkers.push({
                fileId: String(file.fileId),
                key: String(file.key),
                uploadedAt: file.uploadedAt,
                verifiedSize: headSize,
              });
              if (pendingMarkers.length >= VERIFIED_MARKER_BATCH_SIZE) {
                flushVerifiedMarkers();
              }
            }
          } catch (error) {
            // Divider images are never part of report inputs and may already
            // have been cleaned up by a prior completion attempt.
            if (smartDividerIds.has(String(file.fileId))) {
              verifiedFiles[index] = file;
            } else if (isR2ObjectNotFoundError(error)) {
              missingFiles.push(file.originalname || file.fileId);
            } else {
              unconfirmedFiles.push(file.originalname || file.fileId);
            }
          }
        }
      );
      flushVerifiedMarkers();
      await Promise.all(markerWrites);
      if (session.files.length >= 100 || unconfirmedFiles.length > 0) {
        console.info("[UploadSession] completion verification", {
          type,
          sessionId: String(session._id),
          files: session.files.length,
          reusedVerifications,
          storageChecks,
          unconfirmed: unconfirmedFiles.length,
          missing: missingFiles.length,
          elapsedMs: Date.now() - verificationStartedAt,
        });
      }

      if (sizeMismatchFiles.length > 0) {
        return res.status(409).json({
          code: "UPLOAD_FILE_SIZE_MISMATCH",
          message: `${sizeMismatchFiles.length} uploaded file(s) do not match the selected files. Retry those uploads before completing.`,
          data: {
            files: sizeMismatchFiles.slice(0, 50),
            mismatchCount: sizeMismatchFiles.length,
          },
        });
      }

      if (missingFiles.length > 0) {
        await ReportUploadSession.findOneAndUpdate(
          {
            _id: session._id,
            type,
            user: req.userId as any,
            status: { $nin: ["completed", "queued", "processed"] },
            cleanupStartedAt: { $exists: false },
            updatedAt: (session as any).updatedAt,
          },
          {
            $set: {
              status: "failed",
              lastError: `Missing uploaded file(s): ${missingFiles
                .slice(0, 10)
                .join(", ")}`,
            },
            $unset: { activeContractClaim: 1 },
          }
        );
        return res.status(400).json({
          message: `Upload session is missing ${missingFiles.length} file(s). Please retry failed uploads before completing.`,
          missingFiles,
        });
      }

      if (unconfirmedFiles.length > 0) {
        // Nothing is wrong with the upload; storage did not answer in time.
        // The session stays open and every photo already confirmed above is
        // recorded, so the retry the app makes for a 503 only checks the rest.
        res.setHeader("Retry-After", "5");
        return res.status(503).json({
          code: "UPLOAD_VERIFICATION_UNAVAILABLE",
          message: `Storage could not confirm ${unconfirmedFiles.length} uploaded file(s) just now. The upload is saved; finalize it again in a moment.`,
          retryable: true,
          data: {
            unconfirmedCount: unconfirmedFiles.length,
            files: unconfirmedFiles.slice(0, 50),
          },
        });
      }

      let queueSourceFiles: any[] = verifiedFiles;
      const queueSortOptions = {
        // A user-reviewed order is authoritative. Non-Smart Upload flows keep
        // their existing manifest order even if capture timestamps exist.
        preferOriginalOrder:
          !session.smartUpload ||
          ["manual", "groups"].includes(
            session.smartGrouping?.orderSource || ""
          ),
      };
      if (session.smartUpload) {
        const dividerIds = new Set(
          (session.smartGrouping?.dividerFileIds || []).map(String)
        );
        let groups: NonNullable<
          typeof session.smartGrouping
        >["groups"];
        let warnings: string[];
        if (session.smartGrouping?.orderSource === "groups" || isLotNumberUpload(session)) {
          const persistedValidation = validatePersistedSmartUploadGroups(
            session.files as any,
            dividerIds,
            session.smartGrouping?.groups || []
          );
          groups = isLotNumberUpload(session)
            ? applyReviewedGroupNumbers(persistedValidation.groups, session.smartGrouping?.groups || [])
            : persistedValidation.groups;
          warnings = persistedValidation.valid
            ? []
            : [
                "The confirmed Smart Upload lot arrangement is incomplete or invalid. Return to review before creating the preview.",
              ];
          if (isLotNumberUpload(session)) warnings.push(...lotNumberUploadWarnings(groups));
        } else {
          const evaluated = evaluateSmartUploadGrouping(
            session.files as any,
            dividerIds,
            undefined,
            queueSortOptions
          );
          groups = evaluated.groups;
          warnings = evaluated.warnings;
        }
        if (warnings.length) {
          return res.status(400).json({
            code: "INVALID_SMART_UPLOAD_GROUPING",
            message:
              warnings[0] ||
              "Smart Upload grouping is invalid. Review the image order and divider placement.",
            groups,
            warnings,
          });
        }

        const groupingByFileId = new Map<string, { lotIndex: number; imageIndex: number }>();
        groups.forEach((group, lotIndex) => {
          group.fileIds.forEach((fileId, imageIndex) => {
            groupingByFileId.set(String(fileId), { lotIndex, imageIndex });
          });
        });
        for (const file of session.files as any[]) {
          const grouping = groupingByFileId.get(String(file.fileId));
          if (!grouping) {
            if (dividerIds.has(String(file.fileId))) {
              file.lotIndex = undefined;
              file.imageIndex = undefined;
              file.role = undefined;
            }
            continue;
          }
          file.lotIndex = grouping.lotIndex;
          file.imageIndex = grouping.imageIndex;
          file.role = "main";
        }
        session.details = {
          ...(session.details || {}),
          smart_upload: true,
          smart_upload_grouping_method: smartUploadGroupingMethod(session),
          grouping_mode: "mixed",
          mixed_lots: groups.map((group) => ({
            count: group.imageCount,
            extra_count: 0,
            cover_index: 0,
            mode: "single_lot",
            ...(isLotNumberUpload(session) ? { reviewed_lot_number: group.lotNumber, lot_number: group.lotNumber } : {}),
          })),
        };
        session.markModified("details");
        session.markModified("files");
        queueSourceFiles = sortSmartUploadFiles(
          verifiedFiles.filter((file: any) => !dividerIds.has(String(file.fileId))) as any,
          queueSortOptions
        ) as any[];
      }

      assertReportLotPhotoManifest(type, session.details, queueSourceFiles.filter((file: any) => file.fieldname === "images").length);

      await req.assertTransferAuthorization?.();

      // Validate and map Smart Upload groups before creating a placeholder or
      // locking the session. A validation error must leave the session editable
      // so the user can correct its order/dividers and retry completion.
      if (session.status !== "completed") {
        const completionFilter: Record<string, any> = {
          _id: session._id,
          type,
          user: req.userId as any,
          status: session.status,
          cleanupStartedAt: { $exists: false },
          updatedAt: (session as any).updatedAt,
        };
        if (session.smartUpload) {
          const groupingRevision = Number.isFinite(
            Number(session.smartGrouping?.revision)
          )
            ? Number(session.smartGrouping?.revision)
            : 0;
          completionFilter["smartGrouping.status"] = "confirmed";
          completionFilter["smartGrouping.orderReviewRequired"] = {
            $ne: true,
          };
          completionFilter["smartGrouping.unresolvedDividerIds.0"] = {
            $exists: false,
          };
          if (groupingRevision === 0) {
            completionFilter.$or = [
              { "smartGrouping.revision": 0 },
              { "smartGrouping.revision": { $exists: false } },
              { "smartGrouping.revision": null },
            ];
          } else {
            completionFilter["smartGrouping.revision"] = groupingRevision;
          }
        }

        // This compare-and-set is the submission boundary. Once it succeeds,
        // grouping PATCHes are locked out; if a concurrent review edit won,
        // completion fails stale before any report or durable job is created.
        const claimed = await ReportUploadSession.findOneAndUpdate(
          completionFilter,
          {
            $set: {
              status: "completed",
              uploadCompletedAt: session.uploadCompletedAt || new Date(),
              lastError: undefined,
              details: session.details,
              files: session.files,
            },
          },
          { new: true, runValidators: true }
        );
        if (!claimed) {
          const latest = await ReportUploadSession.findOne({
            _id: session._id,
            type,
            user: req.userId as any,
          });
          if (["queued", "processed"].includes(latest?.status || "")) {
            const unavailable = await unavailableUploadSessionReport({ type, session: latest });
            if (unavailable) return res.status(409).json(unavailable);
            const processed = latest?.status === "processed";
            await wakeReportTransferNotification(latest).catch(() => undefined);
            return res.status(200).json({
              message: processed
                ? "Upload session already processed"
                : "Upload session already queued",
              sessionId: String(latest?._id),
              accepted: true,
              reportAvailable: true,
              reusedAcceptance: true,
              jobId: latest?.jobId,
              reportId: latest?.reportId,
              status: processed ? "completed" : "processing",
              phase: processed ? "done" : "processing",
            });
          }
          if (
            latest?.status === "completed" &&
            !latest.cleanupStartedAt &&
            latest.manifestHash === session.manifestHash
          ) {
            // An identical completion won the state boundary. Continue with
            // its authoritative snapshot so both callers converge on one
            // report outbox/job instead of returning a spurious stale error.
            session = latest;
          } else {
            return res.status(409).json({
              code: "UPLOAD_SESSION_COMPLETION_STALE",
              message:
                "The Smart Upload review changed while completion was starting. Refresh the lots and create the preview again.",
              data: {
                groupingStatus:
                  latest?.smartGrouping?.status || "uploading",
                revision: Number(latest?.smartGrouping?.revision || 0),
              },
            });
          }
        } else {
          session.status = "completed";
          session.uploadCompletedAt = claimed.uploadCompletedAt;
          session.lastError = undefined;
        }
      } else {
        // Refresh a recoverable completed session atomically before resuming
        // placeholder/job creation. This wins or loses cleanly against stale
        // session maintenance and keeps the accepted snapshot immutable.
        const resumedCompletion = await ReportUploadSession.findOneAndUpdate(
          {
            _id: session._id,
            type,
            user: req.userId as any,
            status: "completed",
            cleanupStartedAt: { $exists: false },
            updatedAt: (session as any).updatedAt,
          },
          {
            $set: {
              uploadCompletedAt: session.uploadCompletedAt || new Date(),
            },
          },
          { new: true }
        );
        if (!resumedCompletion) {
          return res.status(409).json({
            code: "UPLOAD_SESSION_COMPLETION_STALE",
            message:
              "This upload session changed while finalization was resuming. Refresh before trying again.",
          });
        }
        session.uploadCompletedAt = resumedCompletion.uploadCompletedAt;
      }

      if (!session.reportId) {
        session.reportId = await ensureUploadSessionPlaceholder({
          type,
          req,
          session,
        });
      }
      // "completed" means every R2 object and the confirmed lot arrangement
      // were validated. Keep this recoverable state until the durable Mongo job
      // exists; a retry can safely resume from the same placeholder/report id.
      await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          status: "completed",
          cleanupStartedAt: { $exists: false },
        },
        {
          $set: { reportId: session.reportId },
          $unset: {
            finalizationClaimToken: 1,
            finalizationClaimedAt: 1,
          },
        }
      );
      // The session is the durable source now; do not project a potentially
      // large draft immediately before acceptance deletes that same draft.

      const files = sortSmartUploadFiles(
        queueSourceFiles as any[],
        queueSortOptions
      ).map((file: any) => ({
        fieldname: file.fieldname,
        originalname: file.originalname,
        encoding: "7bit",
        mimetype: file.mimetype,
        filename: path.basename(file.key),
        size: file.verifiedSize || file.size || 0,
        r2Key: file.key,
        r2Bucket: bucketName,
        r2PublicUrl: getR2PublicUrl(file.key, storageTarget),
        lotIndex: file.lotIndex,
        imageIndex: file.imageIndex,
        captureOrder: file.captureOrder,
        originalOrder: file.originalOrder,
        role: file.role,
      })) as any as Express.Multer.File[];

      const images = files.filter((file: any) => file.fieldname === "images");
      const videos = files.filter((file: any) => file.fieldname === "videos");
      const user = (req as any).user;
      const queueDetails: Record<string, any> = {
        ...(session.details || {}),
        upload_session_id: String(session._id),
      };
      const queueUser = {
        id: String(user?._id),
        email: String(user?.email || ""),
        name: (user as any)?.name || (user as any)?.username || undefined,
      };
      const assetQueueInput: AssetJobInput = {
        reportId: String(session.reportId),
        user: queueUser,
        images,
        videos,
        details: queueDetails,
        progressId: session.jobId,
      };
      const lotListingQueueInput: Parameters<typeof queueLotListingJob>[0] = {
        listingId: String(session.reportId),
        user: queueUser,
        images,
        videos,
        details: {
          contract_no: queueDetails.contract_no || "",
          sales_date: queueDetails.sales_date || new Date().toISOString(),
          location: queueDetails.location || "",
          latitude: queueDetails.latitude,
          longitude: queueDetails.longitude,
          language: queueDetails.language || "en",
          currency: queueDetails.currency || "CAD",
          include_damage_analysis: resolveIncludeDamageAnalysis(
            queueDetails.include_damage_analysis,
            true
          ),
          bank_photos_enabled: resolveBooleanFlag(
            queueDetails.bank_photos_enabled,
            false
          ),
          watermark_images: resolvePhotoWatermark(queueDetails.watermark_images),
          valuation_methods: normalizeValuationMethods(
            queueDetails.valuation_methods
          ),
          mixed_lots: queueDetails.mixed_lots || [],
          smart_upload_grouping_method: queueDetails.smart_upload_grouping_method,
          focus_boxes: Array.isArray(queueDetails.focus_boxes)
            ? queueDetails.focus_boxes
            : [],
          upload_session_id: queueDetails.upload_session_id,
        },
        progressId: session.jobId,
      };
      const durableQueueEnabled = shouldUseMongoReportQueue();
      const proposedOutbox = durableQueueEnabled
        ? type === "asset"
          ? buildAssetPreviewJobOutbox(assetQueueInput)
          : buildLotListingPreviewJobOutbox(lotListingQueueInput)
        : undefined;
      let durableJob: any = null;
      let reportJobOutboxToken: string | undefined;

      if (proposedOutbox) {
        try {
          await req.assertTransferAuthorization?.();
          const claimed = await claimUploadSessionPreviewOutbox({
            type,
            session,
            outbox: proposedOutbox,
          });
          durableJob = claimed.durableJob || null;
          reportJobOutboxToken = claimed.outboxToken;
        } catch (handoffError: any) {
          console.error("[UploadSession] report outbox claim pending", {
            type,
            sessionId: String(session._id),
            reportId: session.reportId,
            jobId: session.jobId,
            error:
              handoffError instanceof Error
                ? handoffError.message
                : String(handoffError),
          });
          const explicitStatus = Number(handoffError?.statusCode);
          const statusCode =
            Number.isInteger(explicitStatus) && explicitStatus < 500
              ? explicitStatus
              : 503;
          return res.status(statusCode).json({
            code:
              handoffError?.code || "UPLOAD_SESSION_QUEUE_HANDOFF_PENDING",
            message:
              handoffError?.message ||
              "The upload is saved, but its worker handoff is still pending. Retry this completion.",
            reportId: session.reportId,
            jobId: session.jobId,
          });
        }
      }

      const reusedAcceptance = Boolean(durableJob);
      try {
        if (!proposedOutbox) await req.assertTransferAuthorization?.();
        if (!durableJob && type === "asset") {
          durableJob = await queueAssetPreviewJob({
            ...assetQueueInput,
            reportJobOutboxToken,
          });
        } else if (!durableJob) {
          durableJob = await queueLotListingJob({
            ...lotListingQueueInput,
            reportJobOutboxToken,
          });
        }
      } catch (queueError) {
        if (proposedOutbox) {
          try {
            durableJob = await findAcceptedUploadSessionPreviewJob({
              type,
              session,
            });
          } catch (lookupError) {
            console.error("[UploadSession] ambiguous queue lookup failed", {
              type,
              sessionId: String(session._id),
              reportId: session.reportId,
              jobId: session.jobId,
              error:
                lookupError instanceof Error
                  ? lookupError.message
                  : String(lookupError),
            });
          }
          if (!durableJob) {
            console.error("[UploadSession] durable queue handoff pending", {
              type,
              sessionId: String(session._id),
              reportId: session.reportId,
              jobId: session.jobId,
              error:
                queueError instanceof Error
                  ? queueError.message
                  : String(queueError),
            });
            return res.status(503).json({
              code: "UPLOAD_SESSION_QUEUE_HANDOFF_PENDING",
              message:
                "The upload and exact processing request are saved, but the worker handoff could not be confirmed. Retry this completion.",
              reportId: session.reportId,
              jobId: session.jobId,
            });
          }
        } else {
          durableJob = await reconcileUploadSessionPreviewQueueFailure({
            type,
            session,
            error: queueError,
          });
          if (!durableJob) throw queueError;
        }
      }

      const durableJobCompleted = durableJob?.status === "completed";
      if (durableJobCompleted) {
        await ReportUploadSession.findByIdAndUpdate(session._id, {
          $set: {
            status: "processed",
            reportId: session.reportId,
            files: session.files,
          },
          $unset: { lastError: 1, activeContractClaim: 1 },
        });
      } else {
        // Do not overwrite "processed" if a very fast worker completes between
        // queue creation and this persistence step.
        await ReportUploadSession.findOneAndUpdate(
          { _id: session._id, status: { $ne: "processed" } },
          {
            $set: {
              status: "queued",
              reportId: session.reportId,
              queuedAt: new Date(),
              files: session.files,
            },
            $unset: { lastError: 1 },
          }
        );
      }

      const finalSession = await ReportUploadSession.findById(session._id).select("status").lean();
      const processed = finalSession?.status === "processed";

      if (!processed && !durableQueueEnabled) {
        const filter = {
          _id: session.reportId as any,
          job_id: String(session.jobId),
          job_status: { $ne: "done" },
        };
        const update = {
          $set: {
            status: "processing",
            job_status: "queued",
            job_error: undefined,
            queued_at: new Date(),
          },
          $unset: { job_execution_token: 1 },
        };
        if (type === "asset") await AssetReport.findOneAndUpdate(filter, update);
        else await LotListing.findOneAndUpdate(filter, update);
      }

      // Divider cleanup is retryable maintenance, not part of this response.
      // Slow R2 deletes must never turn an accepted submission into a timeout.

      // The durable report job now owns the submission. Delete only the
      // matching client draft; contract numbers are intentionally not unique.
      const unavailableAfterQueue = await unavailableUploadSessionReport({ type, session });
      if (unavailableAfterQueue) return res.status(409).json(unavailableAfterQueue);
      deleteAcceptedDraftBestEffort(session);

      await wakeReportTransferNotification(session).catch(() => undefined);

      console.log(processed ? "[UploadSession] already processed" : "[UploadSession] completed and queued", {
        type,
        sessionId,
        reportId: session.reportId,
        jobId: session.jobId,
        files: files.length,
      });

      res.status(processed ? 200 : 202).json({
        message: processed
          ? "Submission already completed."
          : type === "asset"
            ? "Upload complete. Your report is being processed."
            : "Upload complete. Your lot listing is being processed.",
        sessionId: String(session._id),
        accepted: true,
        reportAvailable: true,
        reusedAcceptance,
        jobId: session.jobId,
        reportId: session.reportId,
        status: processed ? "completed" : "processing",
        phase: processed ? "done" : "processing",
      });
    } catch (error: any) {
      console.error("[UploadSession] complete failed:", error);
      const auctioneerError = auctioneerContextErrorBody(error);
      if (auctioneerError) {
        return res.status(auctioneerError.statusCode).json(auctioneerError.body);
      }
      const statusCode = Number(error?.statusCode);
      res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
        ...(error?.code ? { code: String(error.code) } : {}),
        ...(error?.data ? { data: error.data } : {}),
        message: error?.message || "Error completing upload session",
        ...(Number.isInteger(statusCode) && statusCode < 500
          ? {}
          : { error: error?.message || String(error) }),
      });
    }
  };
}

/**
 * Fallback for devices or networks that cannot PUT directly to a presigned R2 URL.
 * It uploads one file into the existing session, so retries cannot create another report.
 */
export function uploadUploadSessionFile(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    const file = req.file as Express.Multer.File | undefined;
    const diskPath =
      typeof (file as any)?.path === "string" ? String((file as any).path) : undefined;
    try {
      const { sessionId, fileId } = req.params;
      const hasMemoryFile = Buffer.isBuffer(file?.buffer) && file.buffer.length > 0;
      const hasDiskFile = Boolean(diskPath && Number(file?.size || 0) > 0);
      if (!file || (!hasMemoryFile && !hasDiskFile)) {
        return res.status(400).json({ message: "No fallback upload file was received." });
      }

      const session = await ReportUploadSession.findOne({
        _id: sessionId as any,
        type,
        user: req.userId as any,
      });
      if (!session) return res.status(404).json({ message: "Upload session not found." });
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({ message: "This upload session has already been queued." });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "UPLOAD_SESSION_CLEANUP_STARTED",
          message:
            "This expired upload session is being cleaned up and cannot be resumed.",
        });
      }
      if (
        session.smartUpload &&
        String(session.smartGrouping?.status || "uploading") !== "uploading"
      ) {
        return res.status(409).json({
          code: "SMART_UPLOAD_FILES_LOCKED",
          message:
            "Uploaded files cannot be changed after divider detection starts.",
        });
      }

      const sessionFile = session.files.find((entry: any) => String(entry.fileId) === String(fileId));
      if (!sessionFile) return res.status(404).json({ message: "Upload file was not found in this session." });

      const fileViolation = getUploadSessionFileViolation({
        smartUpload: session.smartUpload === true,
        manifestFile: sessionFile,
        multipartFile: file,
      });
      if (fileViolation) {
        return res.status(fileViolation.statusCode).json({
          code: fileViolation.code,
          message: fileViolation.message,
          data: fileViolation.data,
        });
      }

      const storageTarget = resolvePersistedR2StorageTarget(session);
      if (storageTarget.generation !== "current") {
        return res.status(409).json(legacyUploadSessionReadOnlyBody());
      }
      const bucketName = storageTarget.bucketName;
      const contentType = String(
        sessionFile.mimetype || file.mimetype || "application/octet-stream"
      );
      const previousKey = String(sessionFile.key);
      const attemptKey = `${previousKey}.fallback-${randomUUID()}`;
      await req.assertTransferAuthorization?.();
      if (hasMemoryFile) {
        await uploadBufferToR2(file.buffer, contentType, bucketName, attemptKey, {
          preventOverwrite: true,
        });
      } else {
        await uploadFilePathToR2(
          diskPath!,
          contentType,
          bucketName,
          attemptKey,
          file.size,
          { preventOverwrite: true }
        );
      }

      const latestAfterTransfer = await ReportUploadSession.findOne({
        _id: session._id,
        type,
        user: req.userId as any,
      }).select("status updatedAt smartUpload smartGrouping.status cleanupStartedAt");
      try {
        await req.assertTransferAuthorization?.();
      } catch (error) {
        await deleteFromR2Strict(bucketName, attemptKey).catch(() => undefined);
        throw error;
      }
      const postTransferViolation = latestAfterTransfer
        ? getUploadSessionPostTransferViolation({
            initialStatus: session.status,
            latestStatus: latestAfterTransfer.status,
            initialUpdatedAt: (session as any).updatedAt,
            latestUpdatedAt: (latestAfterTransfer as any).updatedAt,
            smartUpload: latestAfterTransfer.smartUpload === true,
            latestSmartGroupingStatus:
              latestAfterTransfer.smartGrouping?.status,
            cleanupStartedAt: latestAfterTransfer.cleanupStartedAt,
          })
        : {
            statusCode: 409 as const,
            code: "UPLOAD_SESSION_LOCKED" as const,
            message:
              "This upload session was removed while the file was uploading.",
          };
      if (postTransferViolation) {
        // Fallback writes to an attempt-specific key. It can therefore clean
        // up a losing attempt without deleting or replacing the source that
        // completion (or another upload request) already claimed.
        if (storageTarget.generation === "current") {
          await deleteFromR2Strict(bucketName, attemptKey).catch((error) => {
            console.error("[UploadSession] stale fallback object cleanup failed", {
              sessionId: String(session._id),
              fileId: String(sessionFile.fileId),
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return res.status(postTransferViolation.statusCode).json({
          code: postTransferViolation.code,
          message: postTransferViolation.message,
        });
      }

      const uploadedAt = new Date();
      const saved = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          status: { $nin: ["completed", "queued", "processed"] },
          cleanupStartedAt: { $exists: false },
          ...(session.smartUpload
            ? { "smartGrouping.status": { $in: ["uploading", null] } }
            : {}),
          files: {
            $elemMatch: {
              fileId: String(sessionFile.fileId),
              key: previousKey,
            },
          },
        },
        {
          $set: {
            "files.$[target].key": attemptKey,
            "files.$[target].uploadedAt": uploadedAt,
            "files.$[target].verifiedSize": file.size,
            lastError: undefined,
          },
        },
        {
          new: true,
          runValidators: true,
          arrayFilters: [
            {
              "target.fileId": String(sessionFile.fileId),
              "target.key": previousKey,
            },
          ],
        }
      );
      if (!saved) {
        if (storageTarget.generation === "current") {
          await deleteFromR2Strict(bucketName, attemptKey).catch((error) => {
            console.error("[UploadSession] losing fallback object cleanup failed", {
              sessionId: String(session._id),
              fileId: String(sessionFile.fileId),
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        const latest = await ReportUploadSession.findOne({
          _id: session._id,
          type,
          user: req.userId as any,
        })
          .select("status files.fileId files.key files.uploadedAt files.verifiedSize")
          .lean();
        const accepted = (latest?.files || []).find(
          (entry: any) => String(entry.fileId) === String(sessionFile.fileId)
        );
        // A retry of the same photo may lose to an earlier successful attempt.
        // Treat the already verified manifest entry as success, while the
        // attempt-specific object above is safely discarded.
        if (
          accepted?.uploadedAt &&
          Number(accepted.verifiedSize || 0) === Number(file.size || 0)
        ) {
          return res.status(200).json({
            message: "File was already uploaded through the server fallback.",
            data: {
              fileId: String(sessionFile.fileId),
              key: String(accepted.key),
              size: Number(accepted.verifiedSize),
            },
          });
        }
        return res.status(409).json({
          code: "UPLOAD_SESSION_LOCKED",
          message:
            "This upload session changed or was submitted while the file was uploading.",
        });
      }

      // The manifest now points only at the immutable attempt key. The former
      // key is no longer a report input and can be reclaimed best-effort.
      if (
        storageTarget.generation === "current" &&
        previousKey !== attemptKey
      ) {
        await deleteFromR2(bucketName, previousKey);
      }

      return res.status(200).json({
        message: "File uploaded through the server fallback.",
        data: { fileId: String(sessionFile.fileId), key: attemptKey, size: file.size },
      });
    } catch (error: any) {
      console.error("[UploadSession] server fallback upload failed:", error);
      if (String(error?.code || "").startsWith("REPORT_TRANSFER_")) return res.status(error.statusCode || 403).json({ code: error.code, message: error.message });
      return res.status(503).json({
        code: "R2_TRANSIENT_UPLOAD_FAILURE",
        message:
          "Storage is temporarily unavailable. This upload session is safe and can be resumed.",
      });
    } finally {
      if (diskPath) {
        await fs.unlink(diskPath).catch(() => undefined);
      }
    }
  };
}

/**
 * A browser can finish a presigned R2 PUT and still receive an opaque network
 * error when the bucket omits CORS response headers. Verify the object through
 * the authenticated API before the browser sends the full file a second time.
 */
export function verifyUploadSessionFile(type: ReportUploadSessionType) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId, fileId } = req.params;
      // Read only what this check needs: the session's state, its storage
      // target, and the one photo being checked. Loading the whole session
      // made every check hydrate up to 5,000 file entries; a resume checks
      // every photo, four at a time, and that synchronous work slowed every
      // other request on the API process (2026-10-02). The write below already
      // targets the photo by fileId and key, so it needs nothing more.
      const session: any = await ReportUploadSession.findOne(
        {
          _id: sessionId as any,
          type,
          user: req.userId as any,
        },
        {
          status: 1,
          cleanupStartedAt: 1,
          smartUpload: 1,
          "smartGrouping.status": 1,
          r2Bucket: 1,
          r2PublicBaseUrl: 1,
          files: { $elemMatch: { fileId: String(fileId) } },
        }
      ).lean();
      if (!session) return res.status(404).json({ message: "Upload session not found." });
      if (["completed", "queued", "processed"].includes(session.status)) {
        return res.status(409).json({
          code: "UPLOAD_SESSION_LOCKED",
          message: "This upload session has already been submitted.",
        });
      }
      if (session.cleanupStartedAt) {
        return res.status(409).json({
          code: "UPLOAD_SESSION_CLEANUP_STARTED",
          message:
            "This expired upload session is being cleaned up and cannot be resumed.",
        });
      }
      if (
        session.smartUpload &&
        String(session.smartGrouping?.status || "uploading") !== "uploading"
      ) {
        return res.status(409).json({
          code: "SMART_UPLOAD_FILES_LOCKED",
          message:
            "Uploaded files cannot be changed after divider detection starts.",
        });
      }

      const sessionFile = (session.files || []).find(
        (entry: any) => String(entry.fileId) === String(fileId)
      );
      if (!sessionFile) {
        return res.status(404).json({ message: "Upload file was not found in this session." });
      }

      let head: Awaited<ReturnType<typeof headR2Object>>;
      try {
        const storageTarget = resolvePersistedR2StorageTarget(session);
        head = await headR2Object(storageTarget.bucketName, sessionFile.key);
      } catch {
        return res.status(409).json({
          code: "UPLOAD_NOT_VERIFIED",
          message: "The uploaded file is not available in storage yet.",
          data: { fileId: String(sessionFile.fileId), verified: false },
        });
      }

      const expectedSize = Number(sessionFile.size || 0);
      const verifiedSize = Number(head.size || 0);
      if (
        (session.smartUpload &&
          (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) ||
        (expectedSize > 0 && verifiedSize !== expectedSize)
      ) {
        return res.status(409).json({
          code: "UPLOAD_FILE_SIZE_MISMATCH",
          message: "The uploaded file is incomplete and must be retried.",
          data: {
            fileId: String(sessionFile.fileId),
            verified: false,
            expectedSize,
            verifiedSize,
          },
        });
      }

      const verifiedAt = new Date();
      const sessionFileKey = String(sessionFile.key);
      await req.assertTransferAuthorization?.();
      const saved = await ReportUploadSession.findOneAndUpdate(
        {
          _id: session._id,
          type,
          user: req.userId as any,
          status: { $nin: ["completed", "queued", "processed"] },
          cleanupStartedAt: { $exists: false },
          ...(session.smartUpload
            ? { "smartGrouping.status": { $in: ["uploading", null] } }
            : {}),
          files: {
            $elemMatch: {
              fileId: String(sessionFile.fileId),
              key: sessionFileKey,
            },
          },
        },
        {
          $set: {
            "files.$[target].uploadedAt": verifiedAt,
            "files.$[target].verifiedSize": head.size,
            lastError: undefined,
          },
        },
        {
          new: true,
          runValidators: true,
          // Only the acknowledgement is used. Do not hydrate all 5,000 files
          // again after the bounded read above merely to confirm this write.
          projection: { _id: 1 },
          arrayFilters: [
            {
              "target.fileId": String(sessionFile.fileId),
              "target.key": sessionFileKey,
            },
          ],
        }
      ).lean();
      if (!saved) {
        return res.status(409).json({
          code: "UPLOAD_SESSION_LOCKED",
          message:
            "This upload session changed or was submitted while the file was being verified.",
        });
      }

      return res.status(200).json({
        message: "Uploaded file verified.",
        data: {
          fileId: String(sessionFile.fileId),
          verified: true,
          size: head.size,
        },
      });
    } catch (error: any) {
      console.error("[UploadSession] file verification failed:", error);
      if (String(error?.code || "").startsWith("REPORT_TRANSFER_")) return res.status(error.statusCode || 403).json({ code: error.code, message: error.message });
      return res.status(500).json({
        message: "Unable to verify the uploaded file.",
        error: error?.message || String(error),
      });
    }
  };
}
