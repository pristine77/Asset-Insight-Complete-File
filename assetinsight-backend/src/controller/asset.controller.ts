import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { productionReportOwnerFilter } from "../service/reviewReportPolicy.js";
import { optionalCaptureId } from "../service/captureInventoryService.js";
import { hasRecoverableFailedPreview } from "../utils/reportPreviewAvailability.js";
import { retryInitialAuctioneerPreview } from "../service/auctioneerInitialPreviewRetryService.js";
/**
 * Authenticated Asset-report workflow controller.
 *
 * It adapts uploads and preview edits into the report/job model, enforces ownership and
 * approval/release gates, and keeps legacy progress/response contracts intact. Heavy
 * generation, merge, assignment, storage and notification behavior lives in services
 * and jobs so HTTP acceptance is distinct from asynchronous completion.
 */
import { Response } from "express";
import { assertReportLotPhotoManifest } from "../utils/mixedLotPhotoManifest.js";
import { randomUUID } from "node:crypto";
import { reportJobUpload } from "../utils/multerStorage.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { endProgress, getProgress } from "../utils/progressStore.js";
import AssetReport from "../models/asset.model.js";
import { attachYoutubeSubmission } from "../service/youtubeVideoService.js";
import {
  buildAssetPreviewFilesJobOutbox,
  buildAssetPreviewJobOutbox,
  queueAssetPreviewJob,
  queuePreviewFilesJob,
  type AssetJobInput,
} from "../jobs/assetReportJob.js";
import {
  deleteFromR2,
  resolveCurrentR2ObjectLocationFromUrl,
} from "../utils/r2Storage/r2Upload.js";
import { notifyUser } from "../service/notificationService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import {
  ensureReportJobOutbox,
  getMongoReportJobProgress,
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";
import { cleanupMulterFiles } from "../utils/reportTempFiles.js";
import { assetCategorySpecs, allowedCategories } from "../utils/assetCategorySpecs.js";
import { normalizePreviewDataAuctioneerSpecs } from "../utils/auctioneerSpecRows.js";
import {
  normalizePreviewLotNumbers,
} from "../utils/lotNumbers.js";
import { normalizeReviewedPreviewLotsForBusinessRules } from "../utils/reviewedPreviewNormalization.js";
import {
  generateAndStoreAssetCrArtifacts,
} from "../service/auctioneerSpecPdfRefreshService.js";
import { sanitizeAssetPreviewSignature } from "../utils/assetPreviewSignature.js";
import {
  appendImagesToPreviewLot,
  collectPreviewImageUploadFiles,
  parseMultipartPreviewData,
} from "../utils/previewLotImageUpload.js";
import {
  assignReportApprover,
  assignedApprovalDeniedMessage,
  canProcessAssignedApproval,
} from "../service/approvalAssignmentService.js";
import {
  assertReportFilesReadyForWorkflow,
  assignReleaseManager,
  getReportDownloadAccessForGeneration,
  releaseStatusForPayload,
  sendAssignedReleaseEmail,
} from "../service/reportReleaseService.js";
import {
  getMixedLotPhotoLimitMessage,
  getPreviewLotPhotoLimitMessage,
} from "../utils/assetPhotoLimits.js";
import {
  reportFilesGeneratingForProfile,
  reportFilesRegeneratingForProfile,
  resolveReportGenerationStateForProfile,
} from "../utils/reportFileState.js";
import {
  AssetMergeError,
  findMergedLotConflicts,
  getAssetMergeCandidates as loadAssetMergeCandidates,
  mergeAssetReports as createMergedAssetReport,
} from "../service/assetReportMergeService.js";
import { syncAssetPreviewDataToRoot } from "../utils/assetPreviewRootSync.js";
import {
  requiresAssetApproval,
  shouldEnterAssetApprovalQueue,
} from "../utils/assetApprovalThreshold.js";
import {
  auctioneerContextErrorBody,
  linkAuctioneerReport,
  resolveAuctioneerReportContext,
} from "../service/auctioneerReportLinkService.js";
import { preserveAssetProposalValuationPreviewState } from "../utils/assetProposalValuationPreviewState.js";
import { saveAssetReportWithProtectedPreviewData } from "../service/assetPreviewDataPersistenceService.js";
import {
  findActiveSameContractReport,
  findSubmissionContractClaimant,
  isSubmissionContractClaimDuplicateKeyError,
  releaseInactiveSubmissionContractClaim,
  resolvePersistedSubmissionContractIdentity,
  resolveSubmissionContractClaim,
} from "../service/reportSubmissionConflictService.js";
import {
  getExplicitCoordinates,
  hasAnyCoordinateInput,
} from "../utils/auctionLocations.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";
import { previewQueueSummary } from "../utils/previewQueueSummary.js";
import {
  assetPreviewFingerprint,
  matchesAssetGenerationSnapshot,
  stableAssetPreviewJson as stablePreviewJson,
} from "../utils/assetGenerationIdentity.js";
import {
  claimHiddenReportDraftPromotion,
  completeReportDraftPreviewPromotion,
  rollbackReportDraftPreviewPromotion,
  type ReportDraftPromotionClaim,
} from "../service/reportDraftPromotionService.js";
import {
  createAssetPreviewFilesGenerationToken,
  reconcileAssetPreviewFilesQueueFailure,
} from "../service/assetPreviewFilesGenerationService.js";
import { ensureActiveAssetPreviewFilesHandoff } from "../service/assetPreviewFilesHandoffService.js";
import {
  acquireReportSubmissionAdmission,
  activeUploadSessionConflict,
  findActiveUploadSessionContractOwner,
  type ReportSubmissionAdmissionLease,
} from "../service/reportSubmissionAdmissionService.js";
import {
  claimReportApprovalDecision,
  releaseFieldsForApprovalDecision,
} from "../service/reportApprovalDecisionService.js";

export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue"
  | "combined"
  | "mixed";

const toNonNegativeInt = (value: unknown): number => {
  const parsed = parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const getExpectedMixedImageCount = (details: any): number => {
  if (!Array.isArray(details?.mixed_lots)) return 0;
  return details.mixed_lots.reduce((sum: number, lot: any) => {
    return (
      sum +
      toNonNegativeInt(lot?.count) +
      toNonNegativeInt(lot?.extra_count)
    );
  }, 0);
};

const preserveCrDisclaimers = (nextPreviewData: any, previousPreviewData: any) => {
  if (!nextPreviewData || typeof nextPreviewData !== "object") return nextPreviewData;
  return preserveAssetProposalValuationPreviewState({
    ...nextPreviewData,
    ...(!nextPreviewData.cr_disclaimers && previousPreviewData?.cr_disclaimers
      ? { cr_disclaimers: previousPreviewData.cr_disclaimers }
      : {}),
    ...(!nextPreviewData.cr_disclaimers_by_lot && previousPreviewData?.cr_disclaimers_by_lot
      ? { cr_disclaimers_by_lot: previousPreviewData.cr_disclaimers_by_lot }
      : {}),
  }, previousPreviewData);
};

function sendAssetPreviewMutationError(
  res: Response,
  error: any,
  fallbackMessage: string
) {
  const statusCode = Number(error?.statusCode);
  if (
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return res.status(statusCode).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || fallbackMessage,
      ...(Number.isInteger(Number(error?.currentRevision))
        ? { currentRevision: Number(error.currentRevision) }
        : {}),
      ...(Number.isInteger(Number(error?.retryAfterMs)) &&
      Number(error.retryAfterMs) > 0
        ? { retryAfterMs: Number(error.retryAfterMs) }
        : {}),
      ...(error?.data && typeof error.data === "object"
        ? { data: error.data }
        : {}),
    });
  }
  return res.status(500).json({ message: fallbackMessage });
}

export const getAssetMergeCandidates = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const data = await loadAssetMergeCandidates(String(req.userId), String(req.params.id));
    return res.status(200).json({ message: "Merge candidates fetched successfully", data });
  } catch (error: any) {
    const status = error instanceof AssetMergeError ? error.statusCode : 500;
    if (status >= 500) console.error("Error fetching Asset merge candidates:", error);
    return res.status(status).json({ message: error?.message || "Unable to load merge candidates" });
  }
};

export const mergeAssetReports = async (req: AuthRequest, res: Response) => {
  try {
    const result = await createMergedAssetReport({
      userId: String(req.userId),
      sourceReportIds: Array.isArray(req.body?.sourceReportIds) ? req.body.sourceReportIds : [],
      primaryReportId: String(req.body?.primaryReportId || ""),
      mergeRequestId: String(req.body?.mergeRequestId || ""),
    });
    const report: any = result.report;
    return res.status(result.resumed ? 200 : 201).json({
      message: result.resumed
        ? "Existing merged Asset report resumed"
        : report.merge_conflicts?.length
          ? "Merged preview created. Resolve duplicate lot numbers before submission."
          : "Merged Asset preview is being generated.",
      data: {
        reportId: String(report._id),
        status: report.status,
        resumed: result.resumed,
        is_merged_report: true,
        sourceCount: Array.isArray(report.merged_from_report_ids)
          ? report.merged_from_report_ids.length
          : 0,
        lotCount: Array.isArray(report.preview_data?.lots) ? report.preview_data.lots.length : 0,
        merge_conflicts: report.merge_conflicts || [],
        ...resolveReportGenerationStateForProfile(
          "asset",
          report,
          report.preview_files,
          report.files
        ),
      },
    });
  } catch (error: any) {
    const status = error instanceof AssetMergeError ? error.statusCode : 500;
    if (status >= 500) console.error("Error merging Asset reports:", error);
    return res.status(status).json({ message: error?.message || "Unable to merge Asset reports" });
  }
};

const resolveBooleanFlag = (value: any, fallback = false): boolean => {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
};

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function hasOwn(value: any, key: string): boolean {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function isAssetFileGenerationActive(report: any): boolean {
  return Boolean(
    report?.files_generating === true ||
      report?.files_regenerating === true ||
      ["queued", "processing"].includes(String(report?.job_status || ""))
  );
}

function buildComparableAssetPreviewData(
  report: any,
  submittedPreviewData: any
): any | null {
  const previousPreviewData = clonePlain(report?.preview_data || {});
  const candidate = submittedPreviewData || previousPreviewData;
  if (!candidate || typeof candidate !== "object") return null;
  const signatureResult = sanitizeAssetPreviewSignature(candidate);
  if (signatureResult.message) return null;
  const lotNumberResult = normalizePreviewLotNumbers(
    signatureResult.data,
    previousPreviewData
  );
  if (lotNumberResult.message) return null;
  const previewData = preserveCrDisclaimers(
    normalizePreviewDataAuctioneerSpecs(
      normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
        preserveDescription: true,
        previousPreviewData,
      })
    ),
    previousPreviewData
  );
  if (report?.is_merged_report) {
    previewData.merge_conflicts = findMergedLotConflicts(
      Array.isArray(previewData?.lots) ? previewData.lots : []
    );
  }
  return previewData;
}

function matchesActiveAssetSnapshot(report: any, previewData: any): boolean {
  return matchesAssetGenerationSnapshot(report, previewData);
}

async function sendActiveAssetGeneration(res: Response, report: any) {
  try {
    await ensureActiveAssetPreviewFilesHandoff(report);
  } catch (error: any) {
    return res.status(Number(error?.statusCode) || 503).json({
      code: error?.code || "ASSET_QUEUE_HANDOFF_PENDING",
      message:
        error?.message ||
        "The Asset report is saved, but its worker handoff is still pending. Retry this request.",
    });
  }
  const generation = resolveReportGenerationStateForProfile(
    "asset",
    report,
    report?.preview_files,
    report?.files
  );
  const downloadAccess = getReportDownloadAccessForGeneration(
    report,
    generation
  );
  return res.status(202).json({
    message: "Asset report files are already being generated.",
    data: {
      reportId: String(report._id),
      reportType: "asset",
      status: report.status,
      release_status: releaseStatusForPayload(report),
      downloadable: false,
      download_access: downloadAccess,
      preview_submitted_at: report.preview_submitted_at,
      approval_requested_at: report.approval_requested_at,
      generation_target_status: report.generation_target_status,
      preview_data: report.preview_data,
      ...generation,
      files_generating: true,
      files_regenerating: Boolean(report.files_regenerating),
      message: generation.workflow_message,
    },
  });
}

function sendActiveAssetGenerationConflict(res: Response) {
  return res.status(409).json({
    code: "ASSET_PREVIEW_GENERATION_IN_PROGRESS",
    message:
      "This Asset report is already generating files. Wait for it to finish before saving different edits.",
  });
}

async function findCurrentActiveAssetGeneration(input: {
  reportId: unknown;
  userId: unknown;
}) {
  const latest = await AssetReport.findOne({
    _id: input.reportId as any,
    user: input.userId as any,
  });
  return latest && isAssetFileGenerationActive(latest) ? latest : null;
}

function acceptedReportJobSourcePaths(job: any): Set<string> | null {
  const payload = job?.payload;
  if (!payload || typeof payload !== "object") return null;
  const descriptors = [
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.videos) ? payload.videos : []),
  ];
  return new Set(
    descriptors
      .map((file: any) => String(file?.path || "").trim())
      .filter(Boolean)
  );
}

type AssetPreviewHandoff = {
  input: AssetJobInput;
  outbox?: ReportJobOutbox;
};

function prepareAssetPreviewHandoff(
  input: AssetJobInput
): AssetPreviewHandoff {
  const outbox = shouldUseMongoReportQueue()
    ? buildAssetPreviewJobOutbox(input)
    : undefined;
  return {
    input: {
      ...input,
      reportJobOutboxToken: outbox?.token,
    },
    outbox,
  };
}

async function dispatchAssetPreviewHandoff(
  handoff: AssetPreviewHandoff,
  context: string
): Promise<{ job: any; pending: boolean }> {
  try {
    return {
      job: await queueAssetPreviewJob(handoff.input),
      pending: false,
    };
  } catch (error) {
    if (!handoff.outbox) throw error;
    // The exact source-file descriptors and logical job identity live on the
    // report row. Worker reconciliation can safely finish an ambiguous API
    // acknowledgement without reopening the report or deleting its sources.
    console.error(`[Asset] Durable ${context} handoff is pending:`, error);
    return { job: null, pending: true };
  }
}

type AssetPreviewFilesOptions = NonNullable<
  Parameters<typeof queuePreviewFilesJob>[1]
>;

function prepareAssetPreviewFilesHandoff(
  reportId: string,
  options: AssetPreviewFilesOptions
): {
  options: AssetPreviewFilesOptions;
  outbox?: ReportJobOutbox;
} {
  const outbox = shouldUseMongoReportQueue()
    ? buildAssetPreviewFilesJobOutbox(reportId, options)
    : undefined;
  return {
    options: {
      ...options,
      reportJobOutboxToken: outbox?.token,
    },
    outbox,
  };
}

async function dispatchAssetPreviewFilesHandoff(input: {
  reportId: string;
  options: AssetPreviewFilesOptions;
  outbox?: ReportJobOutbox;
  context: string;
}): Promise<boolean> {
  try {
    await queuePreviewFilesJob(input.reportId, input.options);
    return true;
  } catch (error) {
    if (!input.outbox) throw error;
    console.error(`[Asset] Durable ${input.context} handoff is pending:`, error);
    return false;
  }
}

/**
 * An idempotent queue call can return somebody else's already-accepted job.
 * Remove only this request's local duplicates; never delete a path referenced
 * by the durable winner. An undefined result is the legacy in-memory queue,
 * whose closure still owns the request files until it finishes.
 */
async function cleanupAssetRequestFilesNotOwnedByJob(
  files: Express.Multer.File[],
  acceptedJob: any
): Promise<void> {
  const acceptedPaths = acceptedReportJobSourcePaths(acceptedJob);
  if (!acceptedPaths) return;
  const unowned = files.filter((file: any) => {
    const sourcePath = String(file?.path || "").trim();
    return sourcePath && !acceptedPaths.has(sourcePath);
  });
  if (unowned.length > 0) await cleanupMulterFiles(unowned);
}

function clearAssetApprovalAssignment(report: any): void {
  report.approval_assigned_to = undefined;
  report.approval_assigned_at = undefined;
  report.approval_assigned_source = undefined;
}

/**
 * Asset approval is a two-part gate: the report must exceed the configured
 * value limit and its creator must currently have an approver. A missing
 * approver always means automatic approval, including Auctioneer-linked work.
 */
async function resolveAssetApprovalRoute(report: any): Promise<{
  approverId: any | null;
  thresholdExceeded: boolean;
  approvalRequired: boolean;
}> {
  const thresholdExceeded = await requiresAssetApproval(report);
  const approverId = thresholdExceeded
    ? await assignReportApprover(report, { userId: report.user })
    : null;

  if (!approverId) clearAssetApprovalAssignment(report);

  return {
    approverId,
    thresholdExceeded,
    approvalRequired: shouldEnterAssetApprovalQueue(
      thresholdExceeded,
      approverId
    ),
  };
}

async function mapAssetDraftPromotionContractConflict(input: {
  error: any;
  userId: unknown;
  claim: ReportDraftPromotionClaim | null;
}) {
  const contractClaim = String(
    (input.claim as any)?.submissionContractClaim || ""
  ).trim();
  if (
    !contractClaim ||
    !isSubmissionContractClaimDuplicateKeyError(input.error)
  ) {
    return null;
  }
  const claimant = await findSubmissionContractClaimant({
    reportType: "asset",
    userId: input.userId,
    contractClaim,
  });
  return Object.assign(
    new Error("An asset report for this contract is already being processed."),
    {
      statusCode: 409,
      code: "ACTIVE_REPORT_EXISTS",
      data: claimant
        ? {
            reportId: String((claimant as any)._id),
            jobId: (claimant as any).job_id,
            status:
              (claimant as any).job_status || (claimant as any).status,
          }
        : undefined,
    }
  );
}

export const createAssetReport = async (req: AuthRequest, res: Response) => {
  let processingClaimReportId: string | undefined;
  let processingClaimJobId: string | undefined;
  let processingClaimOutboxToken: string | undefined;
  let submissionIdentityUserId: string | undefined;
  let submissionIdentityClientId: string | undefined;
  let submissionIdentityContractClaim: string | undefined;
  let submissionAdmission: ReportSubmissionAdmissionLease | null = null;
  try {
    const details = JSON.parse(req.body.details || "{}");
    const user = (req as any)?.user;
    const auctioneerWorkItem = await resolveAuctioneerReportContext({
      details,
      userId: user?._id || req.userId,
      reportType: "asset",
    });
    // Support both array-style (single field) and fields-style (images/videos)
    let images: Express.Multer.File[] = [];
    let videos: Express.Multer.File[] = [];
    const anyFiles = req.files as any;
    if (Array.isArray(anyFiles)) {
      images = anyFiles as Express.Multer.File[];
    } else if (anyFiles && typeof anyFiles === "object") {
      images = Array.isArray(anyFiles.images) ? (anyFiles.images as Express.Multer.File[]) : [];
      videos = Array.isArray(anyFiles.videos) ? (anyFiles.videos as Express.Multer.File[]) : [];
    }

    const submittedCoordinates = getExplicitCoordinates(details);
    if (hasAnyCoordinateInput(details) && !submittedCoordinates) {
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(400).json({
        message:
          "Latitude and longitude must be supplied together within valid ranges.",
      });
    }
    delete details.latitude;
    delete details.longitude;
    if (submittedCoordinates) Object.assign(details, submittedCoordinates);

    const expectedMixedImageCount = getExpectedMixedImageCount(details);
    const mixedLotPhotoLimitMessage = getMixedLotPhotoLimitMessage(details);
    if (mixedLotPhotoLimitMessage) {
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(400).json({ message: mixedLotPhotoLimitMessage });
    }
    const mixedLotsCount = Array.isArray(details?.mixed_lots)
      ? details.mixed_lots.length
      : 0;
    console.log("[AssetUpload] received asset report upload", {
      jobId:
        details?.progress_id ||
        details?.progressId ||
        details?.job_id ||
        undefined,
      groupingMode: details?.grouping_mode,
      images: images.length,
      videos: videos.length,
      mixedLots: mixedLotsCount,
      expectedMixedImages: expectedMixedImageCount,
      contractNo: details?.contract_no,
    });
    if (
      details?.grouping_mode === "mixed" &&
      expectedMixedImageCount > 0 &&
      images.length < expectedMixedImageCount
    ) {
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(400).json({
        message: `Upload incomplete: received ${images.length} image(s), expected ${expectedMixedImageCount}. Please retry from the saved draft so all lots are included.`,
      });
    }
    assertReportLotPhotoManifest("asset", details, images.length);

    const providedId: string | undefined =
      (typeof details?.progress_id === "string" && details.progress_id) ||
      (typeof details?.progressId === "string" && details.progressId) ||
      (typeof details?.job_id === "string" && details.job_id) ||
      undefined;
    const jobId =
      providedId || `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const clientSubmissionId = String(
      details.client_submission_id || jobId
    ).trim().slice(0, 160);
    details.client_submission_id = clientSubmissionId;
    details.capture_id = optionalCaptureId(details.capture_id);
    submissionIdentityUserId = String(user?._id || req.userId || "");
    submissionIdentityClientId = clientSubmissionId;
    submissionIdentityContractClaim = resolveSubmissionContractClaim({
      contractNo: details.contract_no,
      forceNew: details.force_new,
    });
    const submissionIdentityBypassed = [true, "true", 1, "1"].includes(
      details.force_new,
    );

    submissionAdmission = await acquireReportSubmissionAdmission({
      reportType: "asset",
      userId: user?._id || req.userId,
      contractClaim: submissionIdentityContractClaim,
    });

    const existingSubmission = await AssetReport.findOne({
      user: user?._id,
      client_submission_id: clientSubmissionId,
    })
      .select(
        "+report_job_outbox +submission_contract_claim +submission_contract_claim_bypassed",
      )
      .lean();
    if (existingSubmission) {
      if (auctioneerWorkItem) {
        await linkAuctioneerReport({
          item: auctioneerWorkItem,
          userId: user?._id || req.userId,
          reportType: "asset",
          reportId: (existingSubmission as any)._id,
        });
      }
      if (
        ((existingSubmission as any).status === "error" ||
          (existingSubmission as any).job_status === "error") &&
        images.length > 0
      ) {
        const persistedIdentity = resolvePersistedSubmissionContractIdentity(
          existingSubmission,
        );
        if (
          persistedIdentity.bypassed !== submissionIdentityBypassed ||
          (!persistedIdentity.bypassed &&
            persistedIdentity.contractClaim !==
              normalizeReportContractKey(details.contract_no))
        ) {
          await cleanupMulterFiles([...images, ...videos]);
          return res.status(409).json({
            code: "REPORT_SUBMISSION_IDENTITY_CHANGED",
            message:
              "The contract or force-new mode cannot change when retrying a failed submission. Start a separate submission instead.",
          });
        }
        // A failed multipart attempt may already have a terminal durable job
        // whose immutable payload points at cleaned-up temp files. Retrying is
        // a new generation under the same client submission, never a revival
        // of that old payload/idempotency key.
        const retryJobId = `asset-preview-retry-${Date.now()}-${randomUUID()}`;
        const uploadOwner = await findActiveUploadSessionContractOwner({
          reportType: "asset",
          userId: user?._id || req.userId,
          contractClaim: persistedIdentity.contractClaim,
        });
        if (uploadOwner) {
          await cleanupMulterFiles([...images, ...videos]);
          const conflict: any = activeUploadSessionConflict(uploadOwner);
          return res.status(conflict.statusCode).json({
            code: conflict.code,
            message: conflict.message,
            data: conflict.data,
          });
        }
        const retryHandoff = prepareAssetPreviewHandoff({
          reportId: String((existingSubmission as any)._id),
          user: {
            id: String(user?._id),
            email: String(user?.email || ""),
            name: (user as any)?.name || (user as any)?.username || undefined,
          },
          images,
          videos,
          details,
          progressId: retryJobId,
          submissionAttemptId: retryJobId,
        });
        await releaseInactiveSubmissionContractClaim({
          reportType: "asset",
          userId: user?._id,
          contractClaim: persistedIdentity.contractClaim,
        });
        let retryClaim;
        try {
          await submissionAdmission?.assertOwned();
          retryClaim = await AssetReport.findOneAndUpdate(
            {
              _id: (existingSubmission as any)._id,
              user: user?._id,
              $or: [{ status: "error" }, { job_status: "error" }],
              files_generating: { $ne: true },
              files_regenerating: { $ne: true },
              ...(persistedIdentity.bypassed
                ? { submission_contract_claim_bypassed: true }
                : { submission_contract_claim_bypassed: { $ne: true } }),
            },
            {
              $set: {
                status: "processing",
                job_id: retryJobId,
                job_status: "queued",
                queued_at: new Date(),
                ...(persistedIdentity.contractClaim
                  ? {
                      submission_contract_claim:
                        persistedIdentity.contractClaim,
                    }
                  : {}),
                ...(persistedIdentity.bypassed
                  ? { submission_contract_claim_bypassed: true }
                  : {}),
                ...(retryHandoff.outbox
                  ? { report_job_outbox: retryHandoff.outbox }
                  : {}),
              },
              $unset: {
                job_error: 1,
                job_execution_token: 1,
                processing_completed_at: 1,
                ...(persistedIdentity.bypassed
                  ? { submission_contract_claim: 1 }
                  : { submission_contract_claim_bypassed: 1 }),
              },
            },
            { new: true },
          );
        } catch (error) {
          if (
            persistedIdentity.contractClaim &&
            isSubmissionContractClaimDuplicateKeyError(error)
          ) {
            const claimant = await findSubmissionContractClaimant({
              reportType: "asset",
              userId: user?._id,
              contractClaim: persistedIdentity.contractClaim,
            });
            await cleanupMulterFiles([...images, ...videos]);
            return res.status(409).json({
              code: "ACTIVE_REPORT_EXISTS",
              message:
                "Another asset report for this contract became active before this retry.",
              data: claimant
                ? {
                    reportId: String((claimant as any)._id),
                    jobId: (claimant as any).job_id,
                    status:
                      (claimant as any).job_status || (claimant as any).status,
                  }
                : undefined,
            });
          }
          throw error;
        }
        if (!retryClaim) {
          await cleanupMulterFiles([...images, ...videos]);
          return res.status(409).json({
            code: "ASSET_PREVIEW_GENERATION_IN_PROGRESS",
            message:
              "This submission was already retried from another request. Wait for its current processing state.",
          });
        }
        processingClaimReportId = String((existingSubmission as any)._id);
        processingClaimJobId = retryJobId;
        processingClaimOutboxToken = retryHandoff.outbox?.token;
        const dispatched = await dispatchAssetPreviewHandoff(
          retryHandoff,
          "preview retry"
        );
        if (!dispatched.pending) {
          await cleanupAssetRequestFilesNotOwnedByJob(
            [...images, ...videos],
            dispatched.job
          );
        }
        return res.status(202).json({
          message: "The failed submission was queued again.",
          jobId: retryJobId,
          reportId: (existingSubmission as any)._id,
          status: "processing",
          phase: "processing",
          resumed: true,
        });
      }
      const existingJobId = String(
        (existingSubmission as any).job_id || jobId
      );
      const persistedOutbox = (existingSubmission as any)
        .report_job_outbox as ReportJobOutbox | undefined;
      if (
        String((existingSubmission as any).job_status || "") === "queued" &&
        existingJobId &&
        (persistedOutbox || images.length + videos.length > 0)
      ) {
        // The API may have stopped after persisting the placeholder but before
        // createMongoReportJob acknowledged. Repeating the same client
        // submission repairs that gap with the same logical job identity.
        processingClaimReportId = String((existingSubmission as any)._id);
        processingClaimJobId = existingJobId;
        let recoveryHandoff = prepareAssetPreviewHandoff({
          reportId: processingClaimReportId,
          user: {
            id: String(user?._id),
            email: String(user?.email || ""),
            name: (user as any)?.name || (user as any)?.username || undefined,
          },
          images,
          videos,
          details,
          progressId: existingJobId,
        });
        if (persistedOutbox) {
          recoveryHandoff = {
            input: {
              ...recoveryHandoff.input,
              reportJobOutboxToken: persistedOutbox.token,
            },
            outbox: persistedOutbox,
          };
        } else if (recoveryHandoff.outbox) {
          const embedded = await AssetReport.updateOne(
            {
              _id: processingClaimReportId,
              job_id: existingJobId,
              job_status: "queued",
              $or: [
                { report_job_outbox: { $exists: false } },
                { report_job_outbox: null },
              ],
            },
            { $set: { report_job_outbox: recoveryHandoff.outbox } }
          );
          if (embedded.matchedCount !== 1) {
            const current = await AssetReport.findById(processingClaimReportId)
              .select("+report_job_outbox")
              .lean();
            const concurrentOutbox = (current as any)?.report_job_outbox as
              | ReportJobOutbox
              | undefined;
            if (!concurrentOutbox?.token) {
              await cleanupMulterFiles([...images, ...videos]);
              return res.status(202).json({
                message: "This submission was already accepted.",
                jobId: (current as any)?.job_id || existingJobId,
                reportId: processingClaimReportId,
                status: (current as any)?.status || (existingSubmission as any).status,
                phase: "processing",
                resumed: true,
              });
            }
            recoveryHandoff = {
              input: {
                ...recoveryHandoff.input,
                reportJobOutboxToken: concurrentOutbox.token,
              },
              outbox: concurrentOutbox,
            };
          }
        }
        processingClaimOutboxToken = recoveryHandoff.outbox?.token;
        const dispatched = await dispatchAssetPreviewHandoff(
          recoveryHandoff,
          "preview recovery"
        );
        if (!dispatched.pending) {
          await cleanupAssetRequestFilesNotOwnedByJob(
            [...images, ...videos],
            dispatched.job
          );
        }
        return res.status(202).json({
          message: "This submission was accepted and its processing job was verified.",
          jobId: existingJobId,
          reportId: (existingSubmission as any)._id,
          status: (existingSubmission as any).status,
          phase: "processing",
          resumed: true,
        });
      }
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(202).json({
        message: "This submission was already accepted.",
        jobId: (existingSubmission as any).job_id || jobId,
        reportId: (existingSubmission as any)._id,
        status: (existingSubmission as any).status,
        phase:
          (existingSubmission as any).job_status === "done"
            ? "done"
            : (existingSubmission as any).job_status === "error"
              ? "error"
              : "processing",
        resumed: true,
      });
    }

    if (
      ![true, "true", 1, "1"].includes(details.force_new) &&
      String(details.contract_no || "").trim()
    ) {
      const uploadOwner = await findActiveUploadSessionContractOwner({
        reportType: "asset",
        userId: user?._id || req.userId,
        contractClaim: submissionIdentityContractClaim,
      });
      if (uploadOwner) {
        const conflict: any = activeUploadSessionConflict(uploadOwner);
        await cleanupMulterFiles([...images, ...videos]);
        return res.status(conflict.statusCode).json({
          code: conflict.code,
          message: conflict.message,
          data: conflict.data,
        });
      }
      const active = await findActiveSameContractReport({
        reportType: "asset",
        userId: user?._id,
        contractNo: details.contract_no,
      });
      if (active) {
        const activeJobId = String((active as any).job_id || "");
        const activeProgress = activeJobId
          ? getProgress(activeJobId) || await getMongoReportJobProgress(activeJobId)
          : null;
        await cleanupMulterFiles([...images, ...videos]);
        return res.status(409).json({
          code: "ACTIVE_REPORT_EXISTS",
          message: "An asset report for this contract is already being processed.",
          data: {
            reportId: String((active as any)._id),
            jobId: (active as any).job_id,
            status: (active as any).job_status || (active as any).status,
            progress: (activeProgress as any)?.progress || activeProgress || undefined,
          },
        });
      }
    }

    await releaseInactiveSubmissionContractClaim({
      reportType: "asset",
      userId: user?._id,
      contractClaim: submissionIdentityContractClaim,
    });

    const report = new AssetReport({
      user: user?._id,
      client_submission_id: clientSubmissionId,
      capture_id: details.capture_id,
      submission_contract_claim: submissionIdentityContractClaim,
      submission_contract_claim_bypassed: submissionIdentityBypassed
        ? true
        : undefined,
      grouping_mode: details.grouping_mode || "mixed",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: jobId,
      job_status: "queued",
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
      language: details.language || "en",
      currency: details.currency || "CAD",
      bank_photos_enabled: resolveBooleanFlag(details.bank_photos_enabled, false),
      watermark_images: resolvePhotoWatermark(details.watermark_images),
      auctioneerWorkItem: auctioneerWorkItem?._id,
    });
    processingClaimReportId = String(report._id);
    processingClaimJobId = jobId;
    const previewHandoff = prepareAssetPreviewHandoff({
      reportId: processingClaimReportId,
      user: {
        id: String(user?._id),
        email: String(user?.email || ""),
        name: (user as any)?.name || (user as any)?.username || undefined,
      },
      images,
      videos,
      details,
      progressId: jobId,
    });
    if (previewHandoff.outbox) {
      (report as any).report_job_outbox = previewHandoff.outbox;
    }
    await submissionAdmission?.assertOwned();
    await report.save();
    processingClaimOutboxToken = previewHandoff.outbox?.token;
    if (auctioneerWorkItem) {
      await linkAuctioneerReport({
        item: auctioneerWorkItem,
        userId: user?._id || req.userId,
        reportType: "asset",
        reportId: report._id,
      });
    }
    const dispatched = await dispatchAssetPreviewHandoff(
      previewHandoff,
      "initial preview"
    );
    if (!dispatched.pending) {
      await cleanupAssetRequestFilesNotOwnedByJob(
        [...images, ...videos],
        dispatched.job
      );
    }

    res.status(202).json({
      message:
        "Your report is being processed. You will receive an email when it's ready.",
      jobId,
      reportId: report._id,
      status: report.status,
      phase: (getProgress(jobId)?.phase) || "processing",
    });
  } catch (error: any) {
    if (
      Number(error?.code) === 11000 &&
      submissionIdentityUserId &&
      submissionIdentityClientId
    ) {
      const winner = await AssetReport.findOne({
        user: submissionIdentityUserId as any,
        client_submission_id: submissionIdentityClientId,
      })
        .select("+report_job_outbox")
        .lean();
      if (winner) {
        const anyFiles = req.files as any;
        const loserFiles: Express.Multer.File[] = [];
        if (Array.isArray(anyFiles)) {
          loserFiles.push(...anyFiles);
        } else if (anyFiles && typeof anyFiles === "object") {
          if (Array.isArray(anyFiles.images)) loserFiles.push(...anyFiles.images);
          if (Array.isArray(anyFiles.videos)) loserFiles.push(...anyFiles.videos);
        }
        const winnerOutbox = (winner as any).report_job_outbox as
          | ReportJobOutbox
          | undefined;
        if (
          String((winner as any).job_status || "") === "queued" &&
          (winnerOutbox || loserFiles.length > 0)
        ) {
          try {
            const retryDetails = JSON.parse((req.body as any)?.details || "{}");
            retryDetails.client_submission_id = submissionIdentityClientId;
            let retryHandoff = prepareAssetPreviewHandoff({
              reportId: String((winner as any)._id),
              user: {
                id: submissionIdentityUserId,
                email: String((req as any)?.user?.email || ""),
                name:
                  (req as any)?.user?.name ||
                  (req as any)?.user?.username ||
                  undefined,
              },
              images: Array.isArray(anyFiles)
                ? loserFiles
                : Array.isArray(anyFiles?.images)
                  ? anyFiles.images
                  : [],
              videos:
                !Array.isArray(anyFiles) && Array.isArray(anyFiles?.videos)
                  ? anyFiles.videos
                  : [],
              details: retryDetails,
              progressId: String((winner as any).job_id || ""),
            });
            if (winnerOutbox) {
              retryHandoff = {
                input: {
                  ...retryHandoff.input,
                  reportJobOutboxToken: winnerOutbox.token,
                },
                outbox: winnerOutbox,
              };
            } else if (retryHandoff.outbox) {
              const embedded = await AssetReport.updateOne(
                {
                  _id: (winner as any)._id,
                  job_id: (winner as any).job_id,
                  job_status: "queued",
                  $or: [
                    { report_job_outbox: { $exists: false } },
                    { report_job_outbox: null },
                  ],
                },
                { $set: { report_job_outbox: retryHandoff.outbox } }
              );
              if (embedded.matchedCount !== 1) {
                const current = await AssetReport.findById((winner as any)._id)
                  .select("+report_job_outbox")
                  .lean();
                const concurrentOutbox = (current as any)?.report_job_outbox as
                  | ReportJobOutbox
                  | undefined;
                if (!concurrentOutbox?.token) {
                  throw Object.assign(
                    new Error("The concurrent Asset preview changed during recovery."),
                    { code: "ASSET_PREVIEW_RECOVERY_STALE" }
                  );
                }
                retryHandoff = {
                  input: {
                    ...retryHandoff.input,
                    reportJobOutboxToken: concurrentOutbox.token,
                  },
                  outbox: concurrentOutbox,
                };
              }
            }
            const dispatched = await dispatchAssetPreviewHandoff(
              retryHandoff,
              "concurrent preview recovery"
            );
            if (!dispatched.pending) {
              await cleanupAssetRequestFilesNotOwnedByJob(
                loserFiles,
                dispatched.job
              );
            }
          } catch (queueError) {
            console.error("Failed to recover the concurrent Asset preview:", queueError);
            return res.status(503).json({
              code: "ASSET_PREVIEW_QUEUE_STATE_UNKNOWN",
              message:
                "The report was saved, but processing could not be confirmed. Retry the same submission ID; uploaded files were retained.",
              jobId: (winner as any).job_id,
              reportId: (winner as any)._id,
              status: (winner as any).status,
              retryable: true,
              resumed: true,
            });
          }
        } else {
          await cleanupMulterFiles(loserFiles);
        }
        return res.status(202).json({
          message: "This submission was already accepted.",
          jobId: (winner as any).job_id,
          reportId: (winner as any)._id,
          status: (winner as any).status,
          phase:
            (winner as any).job_status === "done"
              ? "done"
              : (winner as any).job_status === "error"
                ? "error"
                : "processing",
          resumed: true,
        });
      }
    }
    if (
      isSubmissionContractClaimDuplicateKeyError(error) &&
      submissionIdentityUserId &&
      submissionIdentityContractClaim
    ) {
      const claimant = await findSubmissionContractClaimant({
        reportType: "asset",
        userId: submissionIdentityUserId,
        contractClaim: submissionIdentityContractClaim,
      });
      const anyFiles = req.files as any;
      const loserFiles: Express.Multer.File[] = Array.isArray(anyFiles)
        ? [...anyFiles]
        : [
            ...(Array.isArray(anyFiles?.images) ? anyFiles.images : []),
            ...(Array.isArray(anyFiles?.videos) ? anyFiles.videos : []),
          ];
      await cleanupMulterFiles(loserFiles);
      if (claimant) {
        return res.status(409).json({
          code: "ACTIVE_REPORT_EXISTS",
          message: "An asset report for this contract is already being processed.",
          data: {
            reportId: String((claimant as any)._id),
            jobId: (claimant as any).job_id,
            status: (claimant as any).job_status || (claimant as any).status,
          },
        });
      }
      return res.status(409).json({
        code: "REPORT_SUBMISSION_CONFLICT",
        message: "Another submission changed while this report was starting. Retry once.",
      });
    }
    console.error("Error processing asset data:", error);
    if (
      processingClaimReportId &&
      processingClaimJobId &&
      processingClaimOutboxToken
    ) {
      try {
        const ensured = await ensureReportJobOutbox(
          "asset",
          processingClaimReportId,
          processingClaimOutboxToken
        );
        if (ensured) {
          const anyFiles = req.files as any;
          const acceptedFiles: Express.Multer.File[] = Array.isArray(anyFiles)
            ? [...anyFiles]
            : [
                ...(Array.isArray(anyFiles?.images) ? anyFiles.images : []),
                ...(Array.isArray(anyFiles?.videos) ? anyFiles.videos : []),
              ];
          await cleanupAssetRequestFilesNotOwnedByJob(acceptedFiles, ensured);
          return res.status(202).json({
            message: "Your report was accepted and is being processed.",
            jobId: processingClaimJobId,
            reportId: processingClaimReportId,
            status: "processing",
            phase: "processing",
            resumed: true,
          });
        }
      } catch (handoffError) {
        console.error(
          "Could not finish the durable Asset preview handoff; retaining source files:",
          handoffError
        );
      }
      return res.status(503).json({
        code: "ASSET_PREVIEW_QUEUE_HANDOFF_PENDING",
        message:
          "The report and its upload are saved durably, but worker handoff is still pending. Retry the same submission ID.",
        jobId: processingClaimJobId,
        reportId: processingClaimReportId,
        status: "processing",
        phase: "queued",
        retryable: true,
        resumed: true,
      });
    }
    let durableJob: any = null;
    let durableLookupError: unknown;
    if (processingClaimJobId) {
      try {
        durableJob = await getMongoReportJobProgress(processingClaimJobId);
      } catch (lookupError) {
        durableLookupError = lookupError;
      }
    }
    if (durableLookupError) {
      console.error(
        "Could not verify Asset preview queue acceptance; retaining source files:",
        durableLookupError
      );
      return res.status(503).json({
        code: "ASSET_PREVIEW_QUEUE_STATE_UNKNOWN",
        message:
          "The report was saved, but processing could not be confirmed. Retry the same submission ID; uploaded files were retained.",
        jobId: processingClaimJobId,
        reportId: processingClaimReportId,
        status: "processing",
        phase: "queued",
        retryable: true,
        resumed: true,
      });
    }
    if (
      durableJob &&
      (durableJob as any).type === "asset-preview" &&
      String((durableJob as any).reportId || "") === processingClaimReportId &&
      ["queued", "processing", "completed"].includes(
        String((durableJob as any).status || "")
      )
    ) {
      return res.status(202).json({
        message: "Your report was accepted and is being processed.",
        jobId: processingClaimJobId,
        reportId: processingClaimReportId,
        status: "processing",
        phase:
          (durableJob as any).status === "completed" ? "done" : "processing",
        resumed: true,
      });
    }
    const anyFiles = req.files as any;
    const filesToCleanup: Express.Multer.File[] = [];
    if (Array.isArray(anyFiles)) {
      filesToCleanup.push(...anyFiles);
    } else if (anyFiles && typeof anyFiles === "object") {
      if (Array.isArray(anyFiles.images)) filesToCleanup.push(...anyFiles.images);
      if (Array.isArray(anyFiles.videos)) filesToCleanup.push(...anyFiles.videos);
    }
    await cleanupMulterFiles(filesToCleanup);
    if (processingClaimReportId && processingClaimJobId) {
      try {
        await AssetReport.updateOne(
          {
            _id: processingClaimReportId,
            job_id: processingClaimJobId,
            job_status: "queued",
          },
          {
            $set: {
              status: "error",
              files_generating: false,
              files_regenerating: false,
              job_status: "error",
              job_error: error instanceof Error ? error.message : String(error),
              processing_completed_at: new Date(),
            },
            $unset: { job_execution_token: 1 },
          }
        );
      } catch {}
    }
    try {
      const details = JSON.parse((req.body as any)?.details || "{}");
      const progressId: string | undefined =
        (typeof details?.progress_id === "string" && details.progress_id) ||
        (typeof details?.progressId === "string" && details.progressId) ||
        (typeof details?.job_id === "string" && details.job_id) ||
        undefined;
      if (progressId) endProgress(progressId, false, "Error processing request");
    } catch {}
    const auctioneerError = auctioneerContextErrorBody(error);
    if (auctioneerError) {
      return res.status(auctioneerError.statusCode).json(auctioneerError.body);
    }
    if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) {
      return res.status(Number(error.statusCode)).json({
        code: error?.code,
        message: error?.message || "The report submission conflicted with another request.",
        data: error?.data,
      });
    }
    res.status(500).json({ message: "Error processing request", error });
  } finally {
    await submissionAdmission?.release().catch((releaseError) => {
      console.error("Failed to release Asset submission admission:", releaseError);
    });
  }
};

export const getAssetReports = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const reports = await AssetReport.find({
      user: req.userId as any,
      is_draft_preview: { $ne: true },
    }).sort({
      createdAt: -1,
    }).lean();
    res.status(200).json({
      message: "Asset reports fetched successfully!",
      data: reports.map((report: any) => {
        const generation = resolveReportGenerationStateForProfile(
          "asset",
          report,
          report.preview_files,
          report.files
        );
        const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
        const downloadable = downloadAccess.allowed;
        const previewFiles = downloadable ? report.preview_files : {};
        return {
          ...report,
          release_status: releaseStatusForPayload(report),
          downloadable,
          download_access: downloadAccess,
          preview_files: previewFiles,
          ...generation,
          files_generating: reportFilesGeneratingForProfile(
            "asset",
            report,
            report.preview_files,
            report.files
          ),
          files_regenerating: reportFilesRegeneratingForProfile(
            "asset",
            report,
            report.preview_files,
            report.files
          ),
        };
      }).map(report => req.query.view === "previews" ? previewQueueSummary(report, "asset") : report),
    });
  } catch (error) {
    console.error("Error fetching asset reports:", error);
    res.status(500).json({ message: "Error fetching reports", error });
  }
};

export const getAssetProgress = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Missing progress id" });
    }
    const rec = getProgress(id);
    if (rec) {
      return res.status(200).json({
        id: rec.id,
        phase: rec.phase,
        serverProgress01: rec.serverProgress01,
        steps: rec.steps,
        message: rec.message,
        result: rec.result,
        stage: (rec as any).stage,
        progressPercent: (rec as any).progressPercent ?? Math.round((rec.serverProgress01 || 0) * 100),
        currentLot: (rec as any).currentLot,
        totalLots: (rec as any).totalLots,
        updatedAt: (rec as any).updatedAt,
      });
    }

    const durableJob = await getMongoReportJobProgress(id);
    if (!durableJob) {
      return res.status(404).json({ message: "Not found" });
    }

    const progress = (durableJob as any).progress || {};
    res.status(200).json({
      id,
      phase:
        progress.phase ||
        (durableJob.status === "completed"
          ? "done"
          : durableJob.status === "failed"
            ? "error"
            : "processing"),
      serverProgress01:
        typeof progress.serverProgress01 === "number"
          ? progress.serverProgress01
          : durableJob.status === "completed"
            ? 1
            : 0,
      steps: Array.isArray(progress.steps) ? progress.steps : [],
      message: progress.message || durableJob.lastError,
      stage: progress.stage,
      progressPercent: progress.progressPercent ?? Math.round((progress.serverProgress01 || 0) * 100),
      currentLot: progress.currentLot,
      totalLots: progress.totalLots,
      updatedAt: progress.updatedAt,
      result:
        progress.result ||
        (durableJob.reportId
          ? {
              reportId: durableJob.reportId,
              reportType: "asset",
              status: durableJob.status,
            }
          : undefined),
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching progress", error });
  }
};

export const getAssetCategorySpecs = async (_req: AuthRequest, res: Response) => {
  res.status(200).json({
    message: "Auctioneer Import category specs fetched successfully",
    data: {
      categories: allowedCategories,
      specs: assetCategorySpecs,
    },
  });
};

// Accept both images and videos in memory; images are used for AI and reports, videos are zipped with originals only
// No limits on uploads - users can upload thousands of images across multiple lots
// AI analysis is limited to 50 images per lot on the backend
export const uploadMiddleware = reportJobUpload.fields([
  { name: "images", maxCount: 100000 }, // Effectively unlimited (100k images)
  { name: "videos", maxCount: 10000 },  // Support 1 video per lot for thousands of lots
]);

/**
 * Get preview data for editing
 */
export const getPreviewData = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { id } = req.params;
    
    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Allow preview for: preview, declined, pending_approval, and approved
    const allowedStatuses = ['preview', 'declined', 'pending_approval', 'approved'];
    if (!allowedStatuses.includes(report.status) && !hasRecoverableFailedPreview("asset", report)) {
      return res.status(400).json({ 
        message: `Cannot preview report with status: ${report.status}` 
      });
    }

    const generation = resolveReportGenerationStateForProfile(
      "asset",
      report,
      (report as any).preview_files,
      (report as any).files
    );
    const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
    const downloadable = downloadAccess.allowed;
    const previewFiles = downloadable ? (report as any).preview_files : {};

    res.status(200).json({
      message: "Preview data fetched successfully",
      data: {
        status: report.status,
        release_status: releaseStatusForPayload(report),
        downloadable,
        download_access: downloadAccess,
        ...generation,
        files_generating: reportFilesGeneratingForProfile(
          "asset",
          report,
          (report as any).preview_files,
          (report as any).files
        ),
        files_regenerating: reportFilesRegeneratingForProfile(
          "asset",
          report,
          (report as any).preview_files,
          (report as any).files
        ),
        preview_data: report.preview_data,
        preview_files: previewFiles,
        grouping_mode: report.grouping_mode,
        image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
        imageUrls: report.imageUrls || [],
        decline_reason: report.decline_reason,
        reportId: report._id,
      },
    });
  } catch (error) {
    console.error("Error fetching preview data:", error);
    res.status(500).json({ message: "Error fetching preview data", error });
  }
};

/**
 * Update preview data with user edits
 */
export const updatePreviewData = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { preview_data } = req.body;

    if (!preview_data) {
      return res.status(400).json({ message: "preview_data is required" });
    }

    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (isAssetFileGenerationActive(report)) {
      return res.status(400).json({
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    // Allow updates for: preview, declined, pending_approval, and approved
    const allowedStatuses = ['preview', 'declined', 'pending_approval', 'approved'];
    if (!allowedStatuses.includes(report.status) && !hasRecoverableFailedPreview("asset", report)) {
      return res.status(400).json({ 
        message: `Cannot update report with status: ${report.status}` 
      });
    }

    const signatureResult = sanitizeAssetPreviewSignature(preview_data);
    if (signatureResult.message) {
      return res.status(400).json({ message: signatureResult.message });
    }

    const lotNumberResult = normalizePreviewLotNumbers(signatureResult.data, report.preview_data);
    if (lotNumberResult.message) {
      return res.status(400).json({ message: lotNumberResult.message });
    }

    const previousPreviewData = report.preview_data
      ? JSON.parse(JSON.stringify(report.preview_data))
      : {};

    // Update preview data
    report.preview_data = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      previousPreviewData
    );
    const mergeConflicts = (report as any).is_merged_report
      ? findMergedLotConflicts(
          Array.isArray((report.preview_data as any)?.lots)
            ? (report.preview_data as any).lots
            : []
        )
      : [];
    if ((report as any).is_merged_report) {
      (report as any).merge_conflicts = mergeConflicts;
      (report.preview_data as any).merge_conflicts = mergeConflicts;
      report.markModified("merge_conflicts");
    }
    const photoLimitMessage = getPreviewLotPhotoLimitMessage(report.preview_data);
    if (photoLimitMessage) {
      return res.status(400).json({ message: photoLimitMessage });
    }
    syncAssetPreviewDataToRoot(report, report.preview_data);
    report.markModified("preview_data");
    const shouldGenerateResolvedMergedPreview =
      (report as any).is_draft_preview !== true &&
      (report as any).is_merged_report === true &&
      mergeConflicts.length === 0 &&
      !(report as any).preview_files?.excel;
    const shouldRegenerateFiles =
      (report as any).is_draft_preview !== true &&
      ["pending_approval", "approved"].includes(report.status) &&
      stablePreviewJson(previousPreviewData) !== stablePreviewJson(report.preview_data);
    const shouldQueueFiles = shouldGenerateResolvedMergedPreview || shouldRegenerateFiles;
    const queueFallbackStatus = String(report.status);
    const generationJobId = shouldQueueFiles
      ? createAssetPreviewFilesGenerationToken()
      : undefined;
    const generationTarget = shouldGenerateResolvedMergedPreview
      ? "preview"
      : (report.status as "pending_approval" | "approved");
    const generationHandoff = shouldQueueFiles
      ? prepareAssetPreviewFilesHandoff(String(report._id), {
          previewDataSnapshot: clonePlain(report.preview_data),
          targetStatus: generationTarget,
          jobId: generationJobId,
        })
      : undefined;

    if (shouldQueueFiles) {
      (report as any).files_regenerating = true;
      (report as any).files_generating = true;
      (report as any).job_id = generationJobId;
      (report as any).job_execution_token = undefined;
      (report as any).job_status = "queued";
      (report as any).job_error = undefined;
      (report as any).queued_at = new Date();
      (report as any).generation_progress = {
        stage: "generating_files",
        progressPercent: 1,
        message: "Queued to generate report files",
        updatedAt: new Date(),
      };
      if (shouldGenerateResolvedMergedPreview) {
        report.status = "processing" as any;
        (report as any).generation_target_status = "preview";
      } else {
        (report as any).generation_target_status = report.status;
      }
      (report as any).report_job_outbox = generationHandoff?.outbox;
    }

    await saveAssetReportWithProtectedPreviewData({
      report,
      previousPreviewData,
    });

    if (shouldQueueFiles) {
      try {
        await dispatchAssetPreviewFilesHandoff({
          reportId: String(report._id),
          options: generationHandoff!.options,
          outbox: generationHandoff?.outbox,
          context: "preview save",
        });
      } catch (queueError) {
        const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
          reportId: String(report._id),
          generationToken: String(generationJobId),
          error: queueError,
          fallbackStatus: queueFallbackStatus,
        });
        if (!reconciliation.queued) throw queueError;
      }
    }

    res.status(200).json({
      message: shouldGenerateResolvedMergedPreview
        ? "Merge conflicts resolved. The merged preview files are being generated."
        : shouldRegenerateFiles
          ? "Preview data updated successfully. Files are being regenerated."
          : "Preview data updated successfully",
      data: report.preview_data,
      imageUrls: report.imageUrls || [],
      image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
      files_regeneration_queued: shouldQueueFiles,
      merge_conflicts: mergeConflicts,
    });
  } catch (error: any) {
    console.error("Error updating preview data:", error);
    return sendAssetPreviewMutationError(
      res,
      error,
      "Error updating preview data"
    );
  }
};

export const uploadPreviewLotImages = async (req: AuthRequest, res: Response) => {
  const uploadedFiles = collectPreviewImageUploadFiles(req.files);
  try {
    const { id, lotKey } = req.params;
    const incomingPreviewData = parseMultipartPreviewData(req.body?.preview_data);

    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!report) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(404).json({ message: "Report not found" });
    }

    if (isAssetFileGenerationActive(report)) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    const allowedStatuses = ["preview", "declined", "pending_approval", "approved"];
    if (!allowedStatuses.includes(report.status) && !hasRecoverableFailedPreview("asset", report)) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({
        message: `Cannot update report with status: ${report.status}`,
      });
    }

    const previousPreviewData = report.preview_data
      ? JSON.parse(JSON.stringify(report.preview_data))
      : {};
    const candidatePreviewData = incomingPreviewData || previousPreviewData;
    if (!candidatePreviewData || typeof candidatePreviewData !== "object") {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: "Preview data is missing" });
    }

    const signatureResult = sanitizeAssetPreviewSignature(candidatePreviewData);
    if (signatureResult.message) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: signatureResult.message });
    }

    const lotNumberResult = normalizePreviewLotNumbers(signatureResult.data, previousPreviewData);
    if (lotNumberResult.message) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: lotNumberResult.message });
    }

    const normalizedPreviewData = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      previousPreviewData
    );
    const existingPhotoLimitMessage = getPreviewLotPhotoLimitMessage(
      normalizedPreviewData
    );
    if (existingPhotoLimitMessage) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: existingPhotoLimitMessage });
    }

    const appendResult = await appendImagesToPreviewLot({
      kind: "asset",
      previewData: normalizedPreviewData,
      rootImageUrls: report.imageUrls,
      reportId: String(report._id),
      lotKey: lotKey || "",
      files: uploadedFiles,
      watermarkImages: resolvePhotoWatermark(
        (normalizedPreviewData as any)?.watermark_images,
        (report as any).watermark_images
      ),
    });

    const nextPreviewData = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(appendResult.previewData, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      previousPreviewData
    );
    if ((report as any).is_merged_report) {
      const mergeConflicts = findMergedLotConflicts(
        Array.isArray((nextPreviewData as any)?.lots)
          ? (nextPreviewData as any).lots
          : []
      );
      (report as any).merge_conflicts = mergeConflicts;
      (nextPreviewData as any).merge_conflicts = mergeConflicts;
      report.markModified("merge_conflicts");
    }
    // The complete candidate was checked above and the append helper validates
    // the selected lot before its first R2 write. Later normalization does not
    // add photo references, so limit failures remain side-effect free.
    const previewChanged =
      stablePreviewJson(previousPreviewData) !== stablePreviewJson(nextPreviewData);
    const imagesAdded = appendResult.added.length > 0;
    const rootImagesChanged =
      stablePreviewJson(report.imageUrls || []) !==
      stablePreviewJson(appendResult.imageUrls);
    if (!previewChanged && !imagesAdded && !rootImagesChanged) {
      return res.status(200).json({
        message: "These images are already saved.",
        data: {
          preview_data: report.preview_data,
          preview_files: (report as any).preview_files,
          imageUrls: report.imageUrls || [],
          image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
          added: [],
          duplicatesSkipped: appendResult.duplicatesSkipped,
          lotIndex: appendResult.lotIndex,
          files_generating: false,
          files_regenerating: false,
        },
        files_regeneration_queued: false,
      });
    }

    report.preview_data = nextPreviewData;
    report.imageUrls = appendResult.imageUrls;
    syncAssetPreviewDataToRoot(report, report.preview_data);
    report.markModified("preview_data");
    report.markModified("imageUrls");

    const shouldRegenerateFiles =
      (report as any).is_draft_preview !== true &&
      ["pending_approval", "approved"].includes(report.status) &&
      (previewChanged || imagesAdded);
    const queueFallbackStatus = String(report.status);
    const generationJobId = shouldRegenerateFiles
      ? createAssetPreviewFilesGenerationToken()
      : undefined;
    const generationHandoff = shouldRegenerateFiles
      ? prepareAssetPreviewFilesHandoff(String(report._id), {
          previewDataSnapshot: clonePlain(report.preview_data),
          targetStatus: report.status as "pending_approval" | "approved",
          jobId: generationJobId,
        })
      : undefined;
    if (shouldRegenerateFiles) {
      (report as any).files_regenerating = true;
      (report as any).files_generating = true;
      (report as any).job_id = generationJobId;
      (report as any).job_execution_token = undefined;
      (report as any).job_status = "queued";
      (report as any).job_error = undefined;
      (report as any).queued_at = new Date();
      (report as any).generation_target_status = report.status;
      (report as any).generation_progress = {
        stage: "generating_files",
        progressPercent: 1,
        message: "Queued to generate report files",
        updatedAt: new Date(),
      };
      (report as any).report_job_outbox = generationHandoff?.outbox;
    }

    await saveAssetReportWithProtectedPreviewData({
      report,
      previousPreviewData,
    });

    if (shouldRegenerateFiles) {
      try {
        await dispatchAssetPreviewFilesHandoff({
          reportId: String(report._id),
          options: generationHandoff!.options,
          outbox: generationHandoff?.outbox,
          context: "preview image update",
        });
      } catch (queueError) {
        const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
          reportId: String(report._id),
          generationToken: String(generationJobId),
          error: queueError,
          fallbackStatus: queueFallbackStatus,
        });
        if (!reconciliation.queued) throw queueError;
      }
    }

    return res.status(200).json({
      message: shouldRegenerateFiles
        ? "Images uploaded. Files are being regenerated."
        : "Images uploaded.",
      data: {
        preview_data: report.preview_data,
        preview_files: (report as any).preview_files,
        imageUrls: report.imageUrls || [],
        image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
        added: appendResult.added,
        duplicatesSkipped: appendResult.duplicatesSkipped,
        lotIndex: appendResult.lotIndex,
        files_generating: Boolean((report as any).files_generating),
        files_regenerating: Boolean((report as any).files_regenerating),
      },
      files_regeneration_queued: shouldRegenerateFiles,
    });
  } catch (error: any) {
    await cleanupMulterFiles(uploadedFiles);
    console.error("Error uploading preview lot images:", error);
    return sendAssetPreviewMutationError(
      res,
      error,
      "Error uploading preview lot images"
    );
  }
};

/**
 * Generate/refresh the printable CR after preview edits are saved.
 */
export const refreshPreviewSpecPdf = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    }).populate("user", "email username name companyName");

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if ((report as any).is_draft_preview === true) {
      return res.status(409).json({
        code: "DRAFT_PREVIEW_NOT_PROMOTED",
        message:
          "Save this draft preview, then move or submit it before generating CR files.",
      });
    }

    if (!report.preview_data) {
      return res.status(400).json({ message: "Preview data is missing" });
    }

    if (isAssetFileGenerationActive(report)) {
      return res.status(400).json({
        message: "This report is already generating files and cannot refresh the CR right now.",
      });
    }

    const previousPreviewData = clonePlain(report.preview_data);
    const signatureResult = sanitizeAssetPreviewSignature(report.preview_data as any);
    if (signatureResult.message) {
      return res.status(400).json({ message: signatureResult.message });
    }

    const lotNumberResult = normalizePreviewLotNumbers(signatureResult.data as any);
    if (lotNumberResult.message) {
      return res.status(400).json({ message: lotNumberResult.message });
    }
    report.preview_data = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      report.preview_data
    );
    if ((report as any).is_merged_report) {
      const mergeConflicts = findMergedLotConflicts(
        Array.isArray((report.preview_data as any)?.lots)
          ? (report.preview_data as any).lots
          : []
      );
      (report as any).merge_conflicts = mergeConflicts;
      (report.preview_data as any).merge_conflicts = mergeConflicts;
      report.markModified("merge_conflicts");
      if (mergeConflicts.length > 0) {
        return res.status(400).json({
          message: "Duplicate lot numbers must be resolved before this merged report can be submitted.",
          merge_conflicts: mergeConflicts,
        });
      }
    }
    const photoLimitMessage = getPreviewLotPhotoLimitMessage(report.preview_data);
    if (photoLimitMessage) {
      return res.status(400).json({ message: photoLimitMessage });
    }
    syncAssetPreviewDataToRoot(report, report.preview_data);
    report.markModified("preview_data");
    await saveAssetReportWithProtectedPreviewData({
      report,
      previousPreviewData,
    });
    const { specPdf, crDocx } =
      await generateAndStoreAssetCrArtifacts(report);
    return res.status(200).json({
      message: "CR generated",
      data: {
        spec_pdf: specPdf,
        cr_docx: crDocx,
        preview_files: (report as any).preview_files,
        preview_data: report.preview_data,
        imageUrls: report.imageUrls || [],
        image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
      },
    });
  } catch (error: any) {
    console.error("Error generating asset CR:", error);
    return sendAssetPreviewMutationError(res, error, "Error generating CR");
  }
};

/**
 * Submit report for admin approval
 */
export const submitForApproval = async (req: AuthRequest, res: Response) => {
  let draftPromotionClaim: ReportDraftPromotionClaim | null = null;
  let draftPromotionPersisted = false;
  try {
    const { id } = req.params;
    const { preview_data } = req.body || {};

    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    }).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (isAssetFileGenerationActive(report)) {
      if (!hasOwn(req.body || {}, "preview_data")) {
        return sendActiveAssetGeneration(res, report);
      }
      const activePreviewData = buildComparableAssetPreviewData(
        report,
        preview_data
      );
      if (
        activePreviewData &&
        matchesActiveAssetSnapshot(report, activePreviewData)
      ) {
        return sendActiveAssetGeneration(res, report);
      }
      return sendActiveAssetGenerationConflict(res);
    }

    // Only allow submission from preview or declined status
    if (report.status !== 'preview' && report.status !== 'declined') {
      return res.status(400).json({ 
        message: `Cannot submit report with status: ${report.status}` 
      });
    }

    const previousPreviewData = report.preview_data || {};
    const submittedPreviewData = preview_data || previousPreviewData;

    // Validate preview_data exists
    if (!submittedPreviewData || typeof submittedPreviewData !== "object") {
      return res.status(400).json({ 
        message: "Preview data is missing. Please review the report first." 
      });
    }

    const signatureResult = sanitizeAssetPreviewSignature(submittedPreviewData as any);
    if (signatureResult.message) {
      return res.status(400).json({ message: signatureResult.message });
    }

    const lotNumberResult = normalizePreviewLotNumbers(
      signatureResult.data as any,
      previousPreviewData
    );
    if (lotNumberResult.message) {
      return res.status(400).json({ message: lotNumberResult.message });
    }
    report.preview_data = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      previousPreviewData
    );
    if ((report as any).is_merged_report) {
      const mergeConflicts = findMergedLotConflicts(
        Array.isArray((report.preview_data as any)?.lots)
          ? (report.preview_data as any).lots
          : []
      );
      (report as any).merge_conflicts = mergeConflicts;
      (report.preview_data as any).merge_conflicts = mergeConflicts;
      report.markModified("merge_conflicts");
      if (mergeConflicts.length > 0) {
        return res.status(400).json({
          message: "Duplicate lot numbers must be resolved before this merged report can be submitted.",
          merge_conflicts: mergeConflicts,
        });
      }
    }
    const photoLimitMessage = getPreviewLotPhotoLimitMessage(report.preview_data);
    if (photoLimitMessage) {
      return res.status(400).json({ message: photoLimitMessage });
    }
    syncAssetPreviewDataToRoot(report, report.preview_data);
    report.markModified("preview_data");

    const queueFallbackStatus = String(report.status);
    const { approverId, thresholdExceeded, approvalRequired } =
      await resolveAssetApprovalRoute(report);
    const generationTarget = approvalRequired ? "pending_approval" : "approved";
    const generationJobId = createAssetPreviewFilesGenerationToken();
    await attachYoutubeSubmission(report, generationJobId);
    const generationHandoff = prepareAssetPreviewFilesHandoff(
      String(report._id),
      {
        previewDataSnapshot: clonePlain(report.preview_data),
        targetStatus: generationTarget,
        jobId: generationJobId,
      }
    );
    (report as any).files_generating = true;
    (report as any).files_regenerating = false;
    (report as any).job_id = generationJobId;
    (report as any).job_execution_token = undefined;
    (report as any).job_status = "queued";
    (report as any).job_error = undefined;
    (report as any).queued_at = new Date();
    (report as any).generation_target_status = generationTarget;
    (report as any).generation_progress = {
      stage: "generating_files",
      progressPercent: 1,
      message: "Queued to generate report files",
      previousStatus: queueFallbackStatus,
      previewFingerprint: assetPreviewFingerprint(report.preview_data),
      updatedAt: new Date(),
    };
    (report as any).report_job_outbox = generationHandoff.outbox;
    report.preview_submitted_at = new Date();
    report.approval_requested_at = approvalRequired ? new Date() : undefined;
    report.approval_processed_at = undefined;
    (report as any).approval_assignment_email_sent_at = undefined;
    (report as any).release_status = undefined;
    (report as any).release_assigned_to = undefined;
    (report as any).release_assigned_at = undefined;
    (report as any).release_assigned_source = undefined;
    (report as any).release_assignment_email_sent_at = undefined;
    (report as any).released_by = undefined;
    (report as any).released_at = undefined;
    report.decline_reason = undefined;
    draftPromotionClaim = await claimHiddenReportDraftPromotion({
      report,
      userId: req.userId,
      type: "asset",
      submit: true,
    });
    try {
      await saveAssetReportWithProtectedPreviewData({
        report,
        previousPreviewData,
      });
    } catch (saveError: any) {
      const contractConflict = await mapAssetDraftPromotionContractConflict({
        error: saveError,
        userId: req.userId,
        claim: draftPromotionClaim,
      });
      if (contractConflict) throw contractConflict;
      if (
        saveError?.code === "PV_PREVIEW_WRITE_CONFLICT" &&
        !draftPromotionClaim
      ) {
        const current = await findCurrentActiveAssetGeneration({
          reportId: report._id,
          userId: req.userId,
        });
        if (current) {
          if (matchesActiveAssetSnapshot(current, report.preview_data)) {
            return sendActiveAssetGeneration(res, current);
          }
          return sendActiveAssetGenerationConflict(res);
        }
      }
      throw saveError;
    }
    draftPromotionPersisted = true;

    // The immutable snapshot and explicit target prevent a later read from using
    // stale preview data or changing this submission's approval decision.
    try {
      await dispatchAssetPreviewFilesHandoff({
        reportId: String(report._id),
        options: generationHandoff.options,
        outbox: generationHandoff.outbox,
        context: "submission",
      });
    } catch (queueError) {
      const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
        reportId: String(report._id),
        generationToken: generationJobId,
        error: queueError,
        fallbackStatus: queueFallbackStatus,
      });
      if (!reconciliation.queued) {
        // The preview/workflow save already committed. Consume only this
        // promotion claim even if another generation superseded our queue
        // token before reconciliation; leaving it claimed would strand the
        // user's draft until the lease expires.
        await completeReportDraftPreviewPromotion(draftPromotionClaim);
        throw queueError;
      }
    }
    await completeReportDraftPreviewPromotion(draftPromotionClaim);

    const state = resolveReportGenerationStateForProfile(
      "asset",
      report,
      report.preview_files,
      (report as any).files
    );
    const downloadAccess = getReportDownloadAccessForGeneration(report, state);
    res.status(202).json({
      message: approverId
        ? "Report submitted. Files are being generated before approval."
        : thresholdExceeded
          ? "Report submitted. No approver is assigned, so it will be approved automatically after file generation."
          : "Report submitted. Its value is within the automatic approval threshold.",
      data: {
        reportId: report._id,
        reportType: "asset",
        auctioneer_work_item_id: (report as any).auctioneerWorkItem || undefined,
        status: report.status,
        release_status: releaseStatusForPayload(report),
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        preview_submitted_at: report.preview_submitted_at,
        approval_requested_at: report.approval_requested_at,
        generation_target_status: generationTarget,
        preview_data: report.preview_data,
        ...state,
        files_generating: (report as any).files_generating || false,
        message: state.workflow_message,
      },
    });
  } catch (error: any) {
    if (draftPromotionClaim && !draftPromotionPersisted) {
      await rollbackReportDraftPreviewPromotion(draftPromotionClaim).catch(
        (rollbackError) =>
          console.error("Failed to roll back Asset draft promotion:", rollbackError)
      );
    }
    console.error("Error submitting for approval:", error);
    return sendAssetPreviewMutationError(
      res,
      error,
      "Error submitting for approval"
    );
  }
};

/**
 * Approve report (Admin only)
 */
export const approveReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Check admin role
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.isAdmin) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    let report: any = await AssetReport.findById(id).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (!canProcessAssignedApproval(report, user)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (report.status === "approved") {
      return res.status(200).json({
        message: "Report was already approved.",
        data: {
          reportId: report._id,
          status: report.status,
          already_processed: true,
        },
      });
    }
    if (report.status === "declined") {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: "This report was already declined.",
      });
    }
    if (report.status !== 'pending_approval') {
      return res.status(400).json({ 
        message: `Cannot approve report with status: ${report.status}` 
      });
    }
    assertReportFilesReadyForWorkflow("asset", report);

    const reportUser = report.user as any;

    const approvalProcessedAt = new Date();
    await assignReleaseManager(report, {
      userId: reportUser?._id || report.user,
      forceManual: Boolean((report as any).auctioneerWorkItem),
    });
    const decision = await claimReportApprovalDecision({
      model: AssetReport,
      report,
      pendingStatus: "pending_approval",
      targetStatus: "approved",
      set: {
        approval_processed_at: approvalProcessedAt,
        ...releaseFieldsForApprovalDecision(report),
      },
      unset: { decline_reason: 1 },
      populate: "user",
    });
    report = decision.report;
    if (!decision.claimed) {
      return res.status(200).json({
        message: "Report was already approved.",
        data: {
          reportId: report._id,
          status: report.status,
          already_processed: true,
        },
      });
    }
    await sendAssignedReleaseEmail(report, {
      reportType: "Asset",
      creatorUserId: reportUser?._id || report.user,
      title: (report as any).preview_data?.client_name || (report as any).contract_no,
      summary: (report as any).contract_no || (report as any).preview_data?.contract_no,
    });
    if ((report as any).isModified?.("release_assignment_email_sent_at")) {
      await report.save().catch((markerError: unknown) => {
        console.error("asset release email marker save error", markerError);
      });
    }

    // NO LONGER NEEDED: Use preview_files URLs directly instead of creating local copies
    // const { queueDocxGenerationJob } = await import("../jobs/assetReportJob.js");
    // await queueDocxGenerationJob(String(report._id));

    // Send approval email
    try {
      const { sendReportApprovedEmail } = await import("../service/assetEmailService.js");
      if ((report as any).release_status === "pending_release") {
        await sendEmail(
          reportUser.email,
          "Asset Report Approved - Awaiting Release",
          `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111827;">
            <h2>Report approved</h2>
            <p>Your asset report has been approved and is waiting for release before downloads are available.</p>
          </div>`
        );
      } else {
        await sendReportApprovedEmail(
          reportUser.email,
          reportUser.name || reportUser.username || 'User',
          String(report._id)
        );
      }
    } catch (emailError) {
      console.error("asset approveReport email error", emailError);
    }

    await notifyUser({
      userId: String(reportUser?._id || report?.user || ""),
      category: "report",
      type: "report_approved",
      title: "Report Approved",
      body: (report as any).release_status === "pending_release"
        ? "Your asset report has been approved and is waiting for release."
        : "Your asset report has been approved and is ready for download.",
      data: {
        type: "report_approved",
        reportId: String(report._id),
        reportType: "Asset",
      },
    }).catch((pushErr) => {
      console.error("asset approveReport notification error", pushErr);
    });

    res.status(200).json({
      message: "Report approved successfully.",
      data: {
        reportId: report._id,
        status: report.status,
      },
    });
  } catch (error: any) {
    if (Number(error?.statusCode) === 409) {
      return res.status(409).json({
        code: error?.code,
        message: error?.message || "Report files are not ready for approval",
      });
    }
    console.error("Error approving report:", error);
    res.status(500).json({ message: "Error approving report", error });
  }
};

/**
 * Get submitted reports (pending_approval and approved) for the user
 */
export const getSubmittedReports = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const reports = await AssetReport.find({
      user: req.userId as any,
      is_draft_preview: { $ne: true },
      $or: [
        { preview_submitted_at: { $exists: true } },
        { status: "pending_approval" },
        { status: "approved" },
        { status: "error", approval_requested_at: { $exists: true } },
      ],
    }).sort({ createdAt: -1 }).lean();

    res.status(200).json({
      message: "Submitted reports fetched successfully",
      // Submitted is also the user's submission history. Ready reports remain
      // visible here with a terminal status instead of disappearing after a
      // fast worker completes between client refreshes.
      data: reports.map((report: any) => {
        const generation = resolveReportGenerationStateForProfile(
          "asset",
          report,
          report.preview_files,
          report.files
        );
        const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
        const downloadable = downloadAccess.allowed;
        const previewFiles = downloadable ? report.preview_files : {};
        return {
          ...report,
          release_status: releaseStatusForPayload(report),
          downloadable,
          download_access: downloadAccess,
          preview_files: previewFiles,
          ...generation,
          files_generating: reportFilesGeneratingForProfile(
            "asset",
            report,
            report.preview_files,
            report.files
          ),
          files_regenerating: reportFilesRegeneratingForProfile(
            "asset",
            report,
            report.preview_files,
            report.files
          ),
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching submitted reports:", error);
    res.status(500).json({ message: "Error fetching submitted reports", error });
  }
};

/**
 * Resubmit report - allows editing and regenerating files for approved/pending reports
 */
export const resubmitReport = async (req: AuthRequest, res: Response) => {
  let draftPromotionClaim: ReportDraftPromotionClaim | null = null;
  let draftPromotionPersisted = false;
  try {
    const { id } = req.params;
    const { preview_data } = req.body;

    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    }).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (report.auctioneerWorkItem) {
      const initialRetry = await retryInitialAuctioneerPreview({ reportType: "asset", reportId: report._id,
        userId: req.userId, hasIncomingEdits: Object.keys(req.body || {}).length > 0 });
      if (initialRetry) return res.status(202).json(initialRetry);
    }

    if (isAssetFileGenerationActive(report)) {
      if (!hasOwn(req.body || {}, "preview_data")) {
        return sendActiveAssetGeneration(res, report);
      }
      const activePreviewData = buildComparableAssetPreviewData(
        report,
        preview_data
      );
      if (
        activePreviewData &&
        matchesActiveAssetSnapshot(report, activePreviewData)
      ) {
        return sendActiveAssetGeneration(res, report);
      }
      return sendActiveAssetGenerationConflict(res);
    }

    const canRetryFailedPreview = hasRecoverableFailedPreview("asset", report);

    // Allow resubmit for pending_approval or approved status, plus failed preview-file jobs that still have preview data.
    if (report.status !== 'pending_approval' && report.status !== 'approved' && !canRetryFailedPreview) {
      return res.status(400).json({ 
        message: `Cannot resubmit report with status: ${report.status}. Only pending, approved, or failed reports with preview data can be resubmitted.` 
      });
    }

    const previousPreviewData = report.preview_data || {};
    const signatureResult = sanitizeAssetPreviewSignature(preview_data || previousPreviewData);
    if (signatureResult.message) {
      return res.status(400).json({ message: signatureResult.message });
    }

    const lotNumberResult = normalizePreviewLotNumbers(signatureResult.data, previousPreviewData);
    if (lotNumberResult.message) {
      return res.status(400).json({ message: lotNumberResult.message });
    }
    const nextPreviewData = preserveCrDisclaimers(
      normalizePreviewDataAuctioneerSpecs(
        normalizeReviewedPreviewLotsForBusinessRules(lotNumberResult.data || {}, {
          preserveDescription: true,
          previousPreviewData,
        })
      ),
      previousPreviewData
    );
    if ((report as any).is_merged_report) {
      const mergeConflicts = findMergedLotConflicts(
        Array.isArray((nextPreviewData as any)?.lots) ? (nextPreviewData as any).lots : []
      );
      (report as any).merge_conflicts = mergeConflicts;
      (nextPreviewData as any).merge_conflicts = mergeConflicts;
      report.markModified("merge_conflicts");
      if (mergeConflicts.length > 0) {
        return res.status(400).json({
          message: "Duplicate lot numbers must be resolved before this merged report can be resubmitted.",
          merge_conflicts: mergeConflicts,
        });
      }
    }
    const photoLimitMessage = getPreviewLotPhotoLimitMessage(nextPreviewData);
    if (photoLimitMessage) {
      return res.status(400).json({ message: photoLimitMessage });
    }
    // Update preview data if provided
    report.preview_data = nextPreviewData;
    syncAssetPreviewDataToRoot(report, report.preview_data);
    report.markModified("preview_data");

    // An already-approved report remains approved while its files regenerate.
    // Reports that have not completed approval are re-evaluated against both
    // the current value threshold and the creator's current approver setting.
    const wasApproved = report.status === "approved";
    const wasPendingApproval = report.status === "pending_approval";
    const queueFallbackStatus = String(report.status);
    const preserveApprovedState = wasApproved;
    const approvalRoute = preserveApprovedState
      ? {
          approverId: (report as any).approval_assigned_to || null,
          thresholdExceeded: false,
          approvalRequired: false,
        }
      : await resolveAssetApprovalRoute(report);
    const { approvalRequired } = approvalRoute;
    const generationTarget = approvalRequired ? "pending_approval" : "approved";
    const nextStatus = preserveApprovedState
      ? "approved"
      : approvalRequired
        ? "pending_approval"
        : "preview";
    report.status = nextStatus as any;
    report.preview_submitted_at = new Date();
    (report as any).generation_target_status = generationTarget;
    if (approvalRequired && !report.approval_requested_at) {
      report.approval_requested_at = new Date();
    }
    if (!preserveApprovedState) {
      report.approval_processed_at = undefined;
      (report as any).approval_assignment_email_sent_at = undefined;
      if (!approvalRequired) {
        report.approval_requested_at = undefined;
      }
      (report as any).release_status = undefined;
      (report as any).release_assigned_to = undefined;
      (report as any).release_assigned_at = undefined;
      (report as any).release_assigned_source = undefined;
      (report as any).release_assignment_email_sent_at = undefined;
      (report as any).released_by = undefined;
      (report as any).released_at = undefined;
    }
    // Mark files as regenerating (will be cleared when job completes)
    const generationJobId = createAssetPreviewFilesGenerationToken();
    await attachYoutubeSubmission(report, generationJobId);
    const generationHandoff = prepareAssetPreviewFilesHandoff(
      String(report._id),
      {
        previewDataSnapshot: clonePlain(report.preview_data),
        targetStatus: generationTarget,
        jobId: generationJobId,
      }
    );
    (report as any).files_generating = true;
    (report as any).files_regenerating = wasApproved || wasPendingApproval;
    (report as any).job_id = generationJobId;
    (report as any).job_execution_token = undefined;
    (report as any).job_status = "queued";
    (report as any).job_error = undefined;
    (report as any).queued_at = new Date();
    (report as any).generation_progress = {
      stage: "generating_files",
      progressPercent: 1,
      message: "Queued to generate report files",
      previousStatus: queueFallbackStatus,
      previewFingerprint: assetPreviewFingerprint(report.preview_data),
      updatedAt: new Date(),
    };
    (report as any).report_job_outbox = generationHandoff.outbox;
    draftPromotionClaim = await claimHiddenReportDraftPromotion({
      report,
      userId: req.userId,
      type: "asset",
      submit: true,
    });
    try {
      await saveAssetReportWithProtectedPreviewData({
        report,
        previousPreviewData,
      });
    } catch (saveError: any) {
      const contractConflict = await mapAssetDraftPromotionContractConflict({
        error: saveError,
        userId: req.userId,
        claim: draftPromotionClaim,
      });
      if (contractConflict) throw contractConflict;
      if (
        saveError?.code === "PV_PREVIEW_WRITE_CONFLICT" &&
        !draftPromotionClaim
      ) {
        const current = await findCurrentActiveAssetGeneration({
          reportId: report._id,
          userId: req.userId,
        });
        if (current) {
          if (matchesActiveAssetSnapshot(current, report.preview_data)) {
            return sendActiveAssetGeneration(res, current);
          }
          return sendActiveAssetGenerationConflict(res);
        }
      }
      throw saveError;
    }
    draftPromotionPersisted = true;

    console.log(`[Resubmit] Report ${report._id} resubmitted, queuing file regeneration...`);
    
    // Queue background job to regenerate preview files (DOCX, XLSX, Images)
    try {
      await dispatchAssetPreviewFilesHandoff({
        reportId: String(report._id),
        options: generationHandoff.options,
        outbox: generationHandoff.outbox,
        context: "resubmission",
      });
    } catch (queueError) {
      const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
        reportId: String(report._id),
        generationToken: generationJobId,
        error: queueError,
        fallbackStatus: queueFallbackStatus,
      });
      if (!reconciliation.queued) {
        // The promoted preview is durable even when enqueue definitively
        // failed (or this token was superseded), so release its transient
        // promotion claim before returning the retryable report error.
        await completeReportDraftPreviewPromotion(draftPromotionClaim);
        throw queueError;
      }
    }
    await completeReportDraftPreviewPromotion(draftPromotionClaim);

    const state = resolveReportGenerationStateForProfile(
      "asset",
      report,
      report.preview_files,
      (report as any).files
    );
    const downloadAccess = getReportDownloadAccessForGeneration(report, state);
    res.status(202).json({
      message: "Report resubmitted successfully! Files are being regenerated.",
      data: {
        reportId: report._id,
        reportType: "asset",
        auctioneer_work_item_id: (report as any).auctioneerWorkItem || undefined,
        status: report.status,
        release_status: releaseStatusForPayload(report),
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        preview_submitted_at: report.preview_submitted_at,
        approval_requested_at: report.approval_requested_at,
        generation_target_status: generationTarget,
        ...state,
        files_generating: (report as any).files_generating || false,
        files_regenerating: (report as any).files_regenerating || false,
        preview_data: report.preview_data,
        preview_files: downloadAccess.allowed ? report.preview_files : {},
        message: "Your updated report files are being regenerated."
      },
    });
  } catch (error: any) {
    if (draftPromotionClaim && !draftPromotionPersisted) {
      await rollbackReportDraftPreviewPromotion(draftPromotionClaim).catch(
        (rollbackError) =>
          console.error("Failed to roll back Asset draft promotion:", rollbackError)
      );
    }
    console.error("Error resubmitting report:", error);
    return sendAssetPreviewMutationError(
      res,
      error,
      "Error resubmitting report"
    );
  }
};

/**
 * Get preview data for submitted reports (pending/approved) for editing
 */
export const getSubmittedPreviewData = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Submitted previews remain editable/viewable throughout their persisted
    // generation, approval, release, and terminal-error lifecycle.
    if (
      !(report as any).preview_submitted_at &&
      report.status !== "pending_approval" &&
      report.status !== "approved"
    ) {
      return res.status(400).json({ 
        message: "This report has not been submitted yet."
      });
    }

    const generation = resolveReportGenerationStateForProfile(
      "asset",
      report,
      report.preview_files,
      (report as any).files
    );
    const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
    const downloadable = downloadAccess.allowed;
    res.status(200).json({
      message: "Submitted preview data fetched successfully",
      data: {
        status: report.status,
        release_status: releaseStatusForPayload(report),
        downloadable,
        download_access: downloadAccess,
        ...generation,
        files_generating: reportFilesGeneratingForProfile(
          "asset",
          report,
          report.preview_files,
          (report as any).files
        ),
        files_regenerating: reportFilesRegeneratingForProfile(
          "asset",
          report,
          report.preview_files,
          (report as any).files
        ),
        preview_data: report.preview_data,
        preview_files: downloadable ? report.preview_files : {},
        grouping_mode: report.grouping_mode,
        image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
        imageUrls: report.imageUrls || [],
        reportId: report._id,
        createdAt: (report as any).createdAt,
        preview_submitted_at: report.preview_submitted_at,
        approval_requested_at: report.approval_requested_at,
      },
    });
  } catch (error) {
    console.error("Error fetching submitted preview data:", error);
    res.status(500).json({ message: "Error fetching submitted preview data", error });
  }
};

/**
 * Decline report (Admin only)
 */
export const declineReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Check admin role
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.isAdmin) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ 
        message: "Decline reason is required (minimum 10 characters)" 
      });
    }

    let report: any = await AssetReport.findById(id).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (!canProcessAssignedApproval(report, user)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (report.status === "declined") {
      return res.status(200).json({
        message: "Report was already declined.",
        data: {
          reportId: report._id,
          status: report.status,
          decline_reason: report.decline_reason,
          already_processed: true,
        },
      });
    }
    if (report.status === "approved") {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: "This report was already approved.",
      });
    }
    if (report.status !== 'pending_approval') {
      return res.status(400).json({ 
        message: `Cannot decline report with status: ${report.status}` 
      });
    }
    const decision = await claimReportApprovalDecision({
      model: AssetReport,
      report,
      pendingStatus: "pending_approval",
      targetStatus: "declined",
      set: {
        decline_reason: reason,
        approval_processed_at: new Date(),
      },
      populate: "user",
    });
    report = decision.report;
    if (!decision.claimed) {
      return res.status(200).json({
        message: "Report was already declined.",
        data: {
          reportId: report._id,
          status: report.status,
          decline_reason: report.decline_reason,
          already_processed: true,
        },
      });
    }

    // Send decline email
    const { sendReportDeclinedEmail } = await import("../service/assetEmailService.js");
    const reportUser = report.user as any;
    await sendReportDeclinedEmail(
      reportUser.email,
      reportUser.name || reportUser.username || 'User',
      String(report._id),
      reason
    ).catch((emailError) => {
      console.error("asset declineReport email error", emailError);
    });

    await notifyUser({
      userId: String(reportUser?._id || report?.user || ""),
      category: "report",
      type: "report_declined",
      title: "Report Requires Revision",
      body: "Your asset report was declined. Review the notes and resubmit it.",
      data: {
        type: "report_declined",
        reportId: String(report._id),
        reportType: "Asset",
      },
    }).catch((pushErr) => {
      console.error("asset declineReport notification error", pushErr);
    });

    res.status(200).json({
      message: "Report declined successfully",
      data: {
        reportId: report._id,
        status: report.status,
        decline_reason: report.decline_reason,
      },
    });
  } catch (error: any) {
    if (Number(error?.statusCode) === 409) {
      return res.status(409).json({
        code: error?.code,
        message:
          error?.message ||
          "The report changed while the approval decision was being saved.",
      });
    }
    console.error("Error declining report:", error);
    res.status(500).json({ message: "Error declining report", error });
  }
};

/**
 * Get all approved asset reports with images (for gallery)
 */
export const getAllApprovedReports = async (req: AuthRequest, res: Response) => {
  try {
    const reviewOwner: Record<string, any> = req.user?.isReviewAccount === true ? { user: req.userId } : await productionReportOwnerFilter();
    const reports = await AssetReport.find({
      ...reviewOwner,
      status: 'approved',
      is_draft_preview: { $ne: true },
    })
      .populate("user", "email username name")
      .select("_id client_name preview_data imageUrls createdAt user")
      .sort({ createdAt: -1 })
      .limit(500);

    res.status(200).json({
      reports: reports.map((r: any) => ({
        _id: r._id,
        client_name: r.client_name || r.preview_data?.client_name,
        imageUrls: r.imageUrls || [],
        createdAt: r.createdAt,
        user: r.user,
      })),
    });
  } catch (error) {
    console.error("Error fetching approved reports:", error);
    res.status(500).json({ message: "Error fetching approved reports", error });
  }
};

/**
 * Delete an asset report (user can only delete their own reports)
 */
export const deleteAssetReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const report = await AssetReport.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    const previewFiles = (report as any).preview_files || {};
    const bucketName = process.env.R2_BUCKET_NAME;

    if (bucketName) {
      const deleteTargets = [
        previewFiles.pdf,
        previewFiles.spec_pdf,
        previewFiles.docx,
        previewFiles.excel,
        previewFiles.images,
      ].flatMap((fileUrl) => {
        if (typeof fileUrl !== "string" || !fileUrl) {
          return [];
        }

        const location = resolveCurrentR2ObjectLocationFromUrl(fileUrl);
        return location ? [location.key] : [];
      });

      if (deleteTargets.length > 0) {
        await Promise.all(
          deleteTargets.map((key) => deleteFromR2(bucketName, key))
        );
      }
    }

    // Delete the report
    await AssetReport.deleteOne({ _id: id as any });

    res.status(200).json({
      message: "Report deleted successfully",
      data: { reportId: id },
    });
  } catch (error) {
    console.error("Error deleting asset report:", error);
    res.status(500).json({ message: "Error deleting report", error });
  }
};
