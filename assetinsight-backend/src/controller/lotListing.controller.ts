import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { optionalCaptureId } from "../service/captureInventoryService.js";
import { getCanonicalLotListingPreview, hasRecoverableFailedPreview } from "../utils/reportPreviewAvailability.js";
import { retryInitialAuctioneerPreview } from "../service/auctioneerInitialPreviewRetryService.js";
/**
 * Authenticated Lot Listing report workflow controller.
 *
 * Upload acceptance, preview editing, image replacement, approval submission and
 * regeneration are exposed as one client workflow. Durable jobs own long-running
 * generation; this layer preserves ownership, photo-limit, assignment and artifact
 * readiness invariants while maintaining existing response shapes.
 */
import { Response } from "express";
import { assertReportLotPhotoManifest } from "../utils/mixedLotPhotoManifest.js";
import { randomUUID } from "node:crypto";
import { reportJobUpload } from "../utils/multerStorage.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { getProgress } from "../utils/progressStore.js";
import LotListing from "../models/lotListing.model.js";
import { attachYoutubeSubmission } from "../service/youtubeVideoService.js";
import ReportJob from "../models/reportJob.model.js";
import {
  buildLotListingFilesJobOutbox,
  buildLotListingPreviewJobOutbox,
  queueLotListingJob,
  regenerateLotListingFiles,
} from "../jobs/lotListingJob.js";
import { normalizePreviewDataAuctioneerSpecs } from "../utils/auctioneerSpecRows.js";
import {
  normalizePreviewLotNumbers,
} from "../utils/lotNumbers.js";
import { normalizeReviewedPreviewLotsForBusinessRules } from "../utils/reviewedPreviewNormalization.js";
import {
  generateAndStoreLotListingCrArtifacts,
} from "../service/auctioneerSpecPdfRefreshService.js";
import { cleanupMulterFiles } from "../utils/reportTempFiles.js";
import {
  appendImagesToPreviewLot,
  collectPreviewImageUploadFiles,
  parseMultipartPreviewData,
} from "../utils/previewLotImageUpload.js";
import {
  getReportDownloadAccessForGeneration,
  releaseStatusForPayload,
} from "../service/reportReleaseService.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";
import {
  ensureReportJobOutbox,
  getMongoReportJobProgress,
  shouldUseMongoReportQueue,
  type ReportJobOutbox,
} from "../utils/reportJobMongoQueue.js";
import {
  auctioneerContextErrorBody,
  linkAuctioneerReport,
  resolveAuctioneerReportContext,
} from "../service/auctioneerReportLinkService.js";
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
  isReadableAuctionLocation,
} from "../utils/auctionLocations.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";
import { previewQueueSummary } from "../utils/previewQueueSummary.js";
import {
  claimHiddenReportDraftPromotion,
  completeReportDraftPreviewPromotion,
  findCurrentReportFileGenerationJob,
  rollbackReportDraftPreviewPromotion,
  type ReportDraftPromotionClaim,
} from "../service/reportDraftPromotionService.js";
import { normalizeLotListingValuationMethods } from "../utils/lotListingValuationMethods.js";
import {
  isLotListingArtifactPublicationLive,
  lotListingArtifactPublicationAvailableCondition,
} from "../service/lotListingArtifactPublicationService.js";
import {
  lotListingPreviewFingerprint,
  matchesLotListingGenerationSnapshot,
  stableLotListingPreviewJson,
} from "../utils/lotListingGenerationIdentity.js";
import { buildLotListingPreviewPersistence } from "../utils/lotListingPreviewPersistence.js";
import {
  acquireReportSubmissionAdmission,
  activeUploadSessionConflict,
  findActiveUploadSessionContractOwner,
  type ReportSubmissionAdmissionLease,
} from "../service/reportSubmissionAdmissionService.js";

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

const resolveLotListingDownloadState = (listing: any) => {
  const generation = resolveReportGenerationStateForProfile(
    "lotListing",
    listing,
    listing?.preview_files,
    listing?.files
  );
  const downloadAccess = getReportDownloadAccessForGeneration(
    listing,
    generation
  );
  return {
    generation,
    downloadAccess,
    downloadable: downloadAccess.allowed,
  };
};

const withoutGeneratedFileUrls = (listing: any) => {
  const plain = listing?.toObject?.() || listing || {};
  const { preview_files: _previewFiles, files: _files, youtube_submission: _youtubeSubmission, ...safe } = plain;
  return safe;
};

const resolveIncludeDamageAnalysis = (value: any, fallback = true): boolean => {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
};

const normalizeValuationMethods = normalizeLotListingValuationMethods;

const normalizeLotListingPreviewData = (previewData: any, listing: any) => {
  // Preview edits may omit generated CR disclaimer fields. Preserve existing values
  // unless the client explicitly replaces them so unrelated edits are non-destructive.
  const existingPreviewData = (listing?.preview_data as any) || {};
  const previousLocation = String(
    existingPreviewData.location || listing?.location || ""
  ).trim();
  const requestedLocation = String(previewData?.location || "").trim();
  const defaultLocation = isReadableAuctionLocation(requestedLocation)
    ? requestedLocation
    : isReadableAuctionLocation(previousLocation)
      ? previousLocation
      : "";
  const previousCoordinates =
    getExplicitCoordinates(existingPreviewData) || getExplicitCoordinates(listing);
  const previousPreviewForLocation = {
    ...existingPreviewData,
    location: previousLocation,
    ...(previousCoordinates || {}),
  };
  const existingCrDisclaimers = (listing?.preview_data as any)?.cr_disclaimers;
  const existingCrDisclaimersByLot = (listing?.preview_data as any)?.cr_disclaimers_by_lot;
  const basePreviewData: any = {
    ...(previewData || {}),
    valuation_methods: normalizeValuationMethods(
      previewData?.valuation_methods,
      normalizeValuationMethods(listing?.valuation_methods)
    ),
    watermark_images: resolvePhotoWatermark(previewData?.watermark_images, listing?.watermark_images),
    ...(!previewData?.cr_disclaimers && existingCrDisclaimers
      ? { cr_disclaimers: existingCrDisclaimers }
      : {}),
    ...(!previewData?.cr_disclaimers_by_lot && existingCrDisclaimersByLot
      ? { cr_disclaimers_by_lot: existingCrDisclaimersByLot }
      : {}),
  };
  return normalizePreviewDataAuctioneerSpecs(
    normalizeReviewedPreviewLotsForBusinessRules(
      {
        ...basePreviewData,
        ...(defaultLocation && !basePreviewData?.location ? { location: defaultLocation } : {}),
      },
      {
        defaultLocation,
        previousPreviewData: previousPreviewForLocation,
        // This is an owner-edited preview, not the short auction-import column.
        preserveDescription: true,
      }
    )
  );
};

function stablePreviewJson(value: any): string {
  return stableLotListingPreviewJson(value);
}

function createLotListingRegenerationJobId() {
  return `ll-regenerate-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type LotListingFilesQueueInput = Parameters<typeof regenerateLotListingFiles>[0];

function prepareLotListingFilesHandoff(
  input: LotListingFilesQueueInput,
  targetStatus: "pending_approval" | "approved"
): { input: LotListingFilesQueueInput; outbox?: ReportJobOutbox } {
  const outbox = shouldUseMongoReportQueue()
    ? buildLotListingFilesJobOutbox(input, targetStatus)
    : undefined;
  return {
    input: {
      ...input,
      reportJobOutboxToken: outbox?.token,
    },
    outbox,
  };
}

async function dispatchLotListingFilesHandoff(input: {
  queueInput: LotListingFilesQueueInput;
  outbox?: ReportJobOutbox;
  context: string;
}) {
  try {
    await regenerateLotListingFiles(input.queueInput);
    return true;
  } catch (error) {
    if (!input.outbox) throw error;
    // The exact job payload is embedded in the same atomic report mutation.
    // A worker or same-request retry will ensure it; never roll the report back
    // and erase the only crash-safe handoff.
    console.error(`[LotListing] Durable ${input.context} handoff is pending:`, error);
    return false;
  }
}

async function saveLotListingPreviewMutation(
  listing: any,
  options: {
    expectedUpdatedAt?: Date;
    expectedIsDraftPreview?: boolean;
    expectedStatus?: string;
    requireInactiveGeneration?: boolean;
  } = {}
) {
  const expectedUpdatedAt = options.expectedUpdatedAt ?? listing?.updatedAt;
  const wasDraftPreview = options.expectedIsDraftPreview ??
    listing?.is_draft_preview === true;
  listing.$where = {
    $and: [
      ...(expectedUpdatedAt ? [{ updatedAt: expectedUpdatedAt }] : []),
      wasDraftPreview
        ? { is_draft_preview: true }
        : { is_draft_preview: { $ne: true } },
      ...(options.expectedStatus ? [{ status: options.expectedStatus }] : []),
      ...(options.requireInactiveGeneration
        ? [
            { files_generating: { $ne: true } },
            { files_regenerating: { $ne: true } },
            { job_status: { $nin: ["queued", "processing"] } },
            lotListingArtifactPublicationAvailableCondition(),
          ]
        : []),
    ],
  };
  try {
    await listing.save();
  } catch (error: any) {
    if (
      error?.name === "DocumentNotFoundError" ||
      error?.name === "VersionError"
    ) {
      throw Object.assign(
        new Error(
          "The Lot Listing changed while preview data was being saved. Refresh and retry."
        ),
        { code: "LOT_LISTING_PREVIEW_WRITE_CONFLICT", statusCode: 409 }
      );
    }
    throw error;
  }
}

function isLotListingGenerationActive(listing: any): boolean {
  return Boolean(
    isLotListingArtifactPublicationLive(listing) ||
      listing?.files_generating === true ||
      listing?.files_regenerating === true ||
      ["queued", "processing"].includes(String(listing?.job_status || ""))
  );
}

function queuedPreviewJobOwnsRequestFiles(
  durableJob: any,
  images: Express.Multer.File[],
  videos: Express.Multer.File[]
): boolean {
  // The in-memory queue does not return a durable job and always receives the
  // current request objects directly.
  if (!durableJob) return true;
  const identity = (file: any) =>
    [
      file?.r2Bucket,
      file?.r2Key,
      file?.r2PublicUrl,
      file?.path,
      file?.filename,
      file?.size,
    ]
      .map((value) => String(value ?? ""))
      .join("\u0000");
  const sameFiles = (queued: any, current: Express.Multer.File[]) => {
    if (!Array.isArray(queued) || queued.length !== current.length) return false;
    return queued.every((file, index) => identity(file) === identity(current[index]));
  };
  return (
    sameFiles(durableJob?.payload?.images, images) &&
    sameFiles(durableJob?.payload?.videos || [], videos)
  );
}

async function ensureActiveLotListingFilesHandoff(
  listing: any,
  requestUser?: any
) {
  if (!shouldUseMongoReportQueue()) return;
  const reportId = String(listing?._id || "");
  const generationToken = String(listing?.job_id || "");
  if (!reportId || !generationToken) return;

  let current: any = await LotListing.findById(reportId)
    .select("+report_job_outbox +job_execution_token")
    .lean();
  if (!current || String(current.job_id || "") !== generationToken) {
    throw Object.assign(
      new Error(
        "The Lot Listing generation changed while its worker handoff was being recovered. Refresh and retry."
      ),
      { code: "LOT_LISTING_QUEUE_HANDOFF_CHANGED", statusCode: 409 }
    );
  }
  let outboxToken = String(current.report_job_outbox?.token || "");
  if (outboxToken) {
    await ensureReportJobOutbox("lotListing", reportId, outboxToken);
    return;
  }
  if (
    await findCurrentReportFileGenerationJob({
      report: current,
      type: "lotListing",
    })
  ) {
    return;
  }

  const queueInput: LotListingFilesQueueInput = {
    listingId: reportId,
    user: {
      id: String(requestUser?._id || current.user || ""),
      email: String(requestUser?.email || ""),
      name: requestUser?.name || requestUser?.username || undefined,
    },
    generationToken,
    previewDataSnapshot: clonePlain(current.preview_data || listing.preview_data),
  };
  const outbox = buildLotListingFilesJobOutbox(
    queueInput,
    current.generation_target_status === "pending_approval"
      ? "pending_approval"
      : "approved"
  );
  const claimed = await LotListing.updateOne(
    {
      _id: reportId,
      job_id: generationToken,
      job_status: { $in: ["queued", "processing"] },
      $or: [
        { report_job_outbox: { $exists: false } },
        { report_job_outbox: null },
      ],
      $and: [
        {
          $or: [
            { job_execution_token: { $exists: false } },
            { job_execution_token: null },
          ],
        },
      ],
    },
    { $set: { report_job_outbox: outbox } }
  );
  if (claimed.matchedCount === 1) {
    outboxToken = outbox.token;
  } else {
    current = await LotListing.findById(reportId)
      .select("+report_job_outbox +job_execution_token")
      .lean();
    outboxToken = String(current?.report_job_outbox?.token || "");
    if (!outboxToken) {
      if (
        await findCurrentReportFileGenerationJob({
          report: current,
          type: "lotListing",
        })
      ) {
        return;
      }
      throw Object.assign(
        new Error(
          "The Lot Listing worker handoff changed while it was being recovered. Refresh and retry."
        ),
        { code: "LOT_LISTING_QUEUE_HANDOFF_CHANGED", statusCode: 409 }
      );
    }
  }

  try {
    await regenerateLotListingFiles({
      ...queueInput,
      reportJobOutboxToken: outboxToken,
    });
  } catch (error) {
    let accepted: any = null;
    try {
      accepted = await findCurrentReportFileGenerationJob({
        report: current || listing,
        type: "lotListing",
      });
    } catch {
      // The lookup is intentionally tri-state: uncertainty preserves the
      // embedded outbox and asks the same request to retry.
    }
    if (accepted) return;
    throw Object.assign(
      new Error(
        "The Lot Listing and its exact processing request are saved, but the worker handoff could not be confirmed. Retry this request."
      ),
      {
        code: "LOT_LISTING_QUEUE_HANDOFF_PENDING",
        statusCode: 503,
        cause: error,
      }
    );
  }
}

async function sendActiveLotListingGeneration(
  res: Response,
  listing: any,
  requestUser?: any
) {
  try {
    await ensureActiveLotListingFilesHandoff(listing, requestUser);
  } catch (error: any) {
    return res.status(Number(error?.statusCode) || 503).json({
      code: error?.code || "LOT_LISTING_QUEUE_HANDOFF_PENDING",
      message:
        error?.message ||
        "The Lot Listing is saved, but its worker handoff is still pending. Retry this request.",
    });
  }
  const { generation, downloadAccess } = resolveLotListingDownloadState(listing);
  return res.status(202).json({
    message: "Lot listing files are already being generated",
    data: {
      reportId: String(listing._id),
      reportType: "lotListing",
      ...withoutGeneratedFileUrls(listing),
      downloadable: false,
      download_access: downloadAccess,
      ...generation,
    },
  });
}

function activeLotListingGenerationConflict(res: Response) {
  return res.status(409).json({
    code: "LOT_LISTING_GENERATION_IN_PROGRESS",
    message:
      "This Lot Listing is already generating files. Wait for it to finish before saving different edits.",
  });
}

async function findCurrentActiveLotListingGeneration(input: {
  listingId: unknown;
  userId: unknown;
}) {
  const latest = await LotListing.findOne({
    _id: input.listingId as any,
    user: input.userId as any,
  });
  if (!latest || !isLotListingGenerationActive(latest)) return null;
  return latest;
}

async function reconcileLotListingPreviewQueueFailure(
  listing: any,
  jobId: string,
  queueError: unknown
): Promise<boolean> {
  const durableJob = await ReportJob.findOne({
    type: "lot-listing-preview",
    reportId: String(listing._id),
    progressId: jobId,
    status: { $in: ["queued", "processing", "completed"] },
  }).lean();
  if (durableJob) return true;

  const message = queueError instanceof Error
    ? queueError.message
    : "Lot Listing preview could not be queued.";
  await LotListing.updateOne(
    {
      _id: listing._id,
      job_id: jobId,
      job_status: "queued",
    },
    {
      $set: {
        status: "error",
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: message,
        error_message: message,
        processing_completed_at: new Date(),
        generation_progress: {
          stage: "error",
          progressPercent: 100,
          message,
          updatedAt: new Date(),
        },
      },
      $unset: { job_execution_token: 1 },
    }
  );
  return false;
}

async function reconcileLotListingFilesQueueFailure(
  listing: any,
  generationJobId: string,
  previousWorkflowStatus: string,
  queueError: unknown
): Promise<boolean> {
  const durableJob = await findCurrentReportFileGenerationJob({
    report: listing,
    type: "lotListing",
  });
  if (durableJob) return true;

  const message = queueError instanceof Error
    ? queueError.message
    : "Lot Listing files could not be queued.";
  const retryStatus = previousWorkflowStatus === "approved" ? "approved" : "error";
  const result = await LotListing.updateOne(
    {
      _id: listing._id,
      job_id: generationJobId,
      job_status: "queued",
    },
    {
      $set: {
        status: retryStatus,
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: message,
        processing_completed_at: new Date(),
        generation_progress: {
          stage: "error",
          progressPercent: 100,
          message,
          previousStatus: previousWorkflowStatus,
          updatedAt: new Date(),
        },
      },
      $unset: { job_execution_token: 1 },
    }
  );
  return result.matchedCount === 1;
}

function hasOwn(value: any, key: string): boolean {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function hasDefinedOwn(value: any, key: string): boolean {
  return hasOwn(value, key) && value[key] !== undefined;
}

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function buildLotListingPreviewDataFromRequest(listing: any, input: any = {}) {
  const canonicalPreview = getCanonicalLotListingPreview(listing);
  const existingPreviewData = canonicalPreview
    ? clonePlain(canonicalPreview)
    : {};
  const existingLots = Array.isArray(listing.lots) ? clonePlain(listing.lots) : [];

  let rawPreviewData: any;
  if (input.preview_data && typeof input.preview_data === "object") {
    rawPreviewData = {
      ...existingPreviewData,
      ...input.preview_data,
      lots: hasDefinedOwn(input.preview_data, "lots")
        ? input.preview_data.lots
        : existingPreviewData.lots || existingLots,
    };
  } else if (hasDefinedOwn(input, "lots") || hasDefinedOwn(input, "details")) {
    rawPreviewData = {
      ...existingPreviewData,
      ...(input.details || {}),
      lots: hasDefinedOwn(input, "lots")
        ? input.lots
        : existingPreviewData.lots || existingLots,
    };
  } else if (canonicalPreview) {
    rawPreviewData = existingPreviewData;
  } else {
    rawPreviewData = {
      contract_no: listing.contract_no,
      sales_date:
        listing.sales_date instanceof Date
          ? listing.sales_date.toISOString()
          : String(listing.sales_date || ""),
      location: listing.location,
      latitude: listing.latitude,
      longitude: listing.longitude,
      currency: listing.currency,
      total_value: listing.total_value,
      include_damage_analysis: listing.include_damage_analysis !== false,
      bank_photos_enabled: (listing as any).bank_photos_enabled === true,
      watermark_images: resolvePhotoWatermark((listing as any).watermark_images),
      valuation_methods: normalizeValuationMethods((listing as any).valuation_methods),
      lots: existingLots,
    };
  }

  // Title and description are independent editable auction fields. Never copy
  // one over the other while normalizing a saved preview.
  rawPreviewData = {
    ...rawPreviewData,
    lots: Array.isArray(rawPreviewData?.lots) ? rawPreviewData.lots : [],
  };

  const lotNumberResult = normalizePreviewLotNumbers(rawPreviewData, existingPreviewData);
  if (lotNumberResult.message) {
    return { message: lotNumberResult.message, previousPreviewData: existingPreviewData };
  }

  return {
    data: normalizeLotListingPreviewData(lotNumberResult.data, listing),
    previousPreviewData: existingPreviewData,
  };
}

function applyLotListingPreviewData(listing: any, nextPreviewData: any) {
  const persistence = buildLotListingPreviewPersistence(nextPreviewData, listing);
  listing.preview_data = persistence.previewData;
  listing.markModified("preview_data");
  for (const [field, value] of Object.entries(persistence.set)) {
    if (field !== "preview_data") listing.set(field, value);
  }
  for (const field of Object.keys(persistence.unset)) {
    listing.set(field, undefined);
  }
  listing.markModified("lots");
}

export const createLotListing = async (req: AuthRequest, res: Response) => {
  let images: Express.Multer.File[] = [];
  let videos: Express.Multer.File[] = [];
  let queuedListing: any = null;
  let queuedJobId = "";
  let sourceFilesOwnedByQueue = false;
  let queueOwnershipUncertain = false;
  let requestClientSubmissionId = "";
  let requestContractClaim: string | undefined;
  let submissionAdmission: ReportSubmissionAdmissionLease | null = null;
  let pendingPreviewJobInput: Parameters<typeof queueLotListingJob>[0] | null = null;
  try {
    const anyFiles = req.files as any;
    if (Array.isArray(anyFiles)) {
      images = (anyFiles as Express.Multer.File[]).filter(
        (file) => file.fieldname !== "videos"
      );
      videos = (anyFiles as Express.Multer.File[]).filter(
        (file) => file.fieldname === "videos"
      );
    } else if (anyFiles && typeof anyFiles === "object") {
      images = Array.isArray(anyFiles.images) ? (anyFiles.images as Express.Multer.File[]) : [];
      videos = Array.isArray(anyFiles.videos) ? (anyFiles.videos as Express.Multer.File[]) : [];
    }
    const details = JSON.parse(req.body.details || "{}");
    const user = (req as any)?.user;
    const auctioneerWorkItem = await resolveAuctioneerReportContext({
      details,
      userId: user?._id || req.userId,
      reportType: "lotListing",
    });

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
    if (expectedMixedImageCount > 0 && images.length < expectedMixedImageCount) {
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(400).json({
        message: `Upload incomplete: received ${images.length} image(s), expected ${expectedMixedImageCount}. Please retry from the saved draft so all lots are included.`,
      });
    }
    assertReportLotPhotoManifest("lotListing", details, images.length);

    const providedId: string | undefined =
      (typeof details?.progress_id === "string" && details.progress_id) ||
      (typeof details?.progressId === "string" && details.progressId) ||
      undefined;
    const jobId =
      providedId || `ll-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const clientSubmissionId = String(
      details.client_submission_id || jobId
    ).trim().slice(0, 160);
    requestClientSubmissionId = clientSubmissionId;
    details.capture_id = optionalCaptureId(details.capture_id);
    requestContractClaim = resolveSubmissionContractClaim({
      contractNo: details.contract_no,
      forceNew: details.force_new,
    });
    const requestContractClaimBypassed = [true, "true", 1, "1"].includes(
      details.force_new,
    );

    submissionAdmission = await acquireReportSubmissionAdmission({
      reportType: "lotListing",
      userId: user?._id || req.userId,
      contractClaim: requestContractClaim,
    });

    // client_submission_id is the idempotency key for mobile/network retries. A failed
    // prior attempt may be resumed; accepted work returns its original report/job.
    const existingSubmission = await LotListing.findOne({
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
          reportType: "lotListing",
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
          persistedIdentity.bypassed !== requestContractClaimBypassed ||
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
        const valuationMethods = normalizeValuationMethods(details.valuation_methods);
        if (valuationMethods.length === 0) {
          await cleanupMulterFiles([...images, ...videos]);
          return res.status(400).json({
            message: "Select at least one supported valuation method",
          });
        }
        // Terminal durable jobs keep an immutable source payload. A direct
        // multipart retry supplies new temp files, so it must use a new
        // generation/idempotency identity under the same client submission.
        const retryJobId = `ll-preview-retry-${Date.now()}-${randomUUID()}`;
        const retryPreviewJobInput = {
          listingId: String((existingSubmission as any)._id),
          user: {
            id: String(user?._id),
            email: String(user?.email || ""),
            name: (user as any)?.name || (user as any)?.username || undefined,
          },
          images,
          videos,
          details: {
            contract_no: details.contract_no || "",
            sales_date: details.sales_date || new Date().toISOString(),
            location: details.location || "",
            latitude: details.latitude,
            longitude: details.longitude,
            language: details.language || "en",
            currency: details.currency || "CAD",
            include_damage_analysis: resolveIncludeDamageAnalysis(details.include_damage_analysis, true),
            bank_photos_enabled: resolveIncludeDamageAnalysis(details.bank_photos_enabled, false),
            watermark_images: resolvePhotoWatermark(details.watermark_images),
            valuation_methods: valuationMethods,
            mixed_lots: details.mixed_lots || [],
            focus_boxes: Array.isArray(details.focus_boxes) ? details.focus_boxes : [],
          },
          progressId: retryJobId,
        };
        const uploadOwner = await findActiveUploadSessionContractOwner({
          reportType: "lotListing",
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
        const retryOutbox = shouldUseMongoReportQueue()
          ? buildLotListingPreviewJobOutbox(retryPreviewJobInput)
          : undefined;
        await releaseInactiveSubmissionContractClaim({
          reportType: "lotListing",
          userId: user?._id,
          contractClaim: persistedIdentity.contractClaim,
        });
        try {
          await submissionAdmission?.assertOwned();
          queuedListing = await LotListing.findOneAndUpdate(
            {
              _id: (existingSubmission as any)._id,
              $or: [{ status: "error" }, { job_status: "error" }],
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
                ...(retryOutbox ? { report_job_outbox: retryOutbox } : {}),
              },
              $unset: {
                job_error: 1,
                job_execution_token: 1,
                ...(persistedIdentity.bypassed
                  ? { submission_contract_claim: 1 }
                  : { submission_contract_claim_bypassed: 1 }),
              },
            },
            { returnDocument: "after" },
          );
        } catch (error) {
          if (
            persistedIdentity.contractClaim &&
            isSubmissionContractClaimDuplicateKeyError(error)
          ) {
            const claimant = await findSubmissionContractClaimant({
              reportType: "lotListing",
              userId: user?._id,
              contractClaim: persistedIdentity.contractClaim,
            });
            await cleanupMulterFiles([...images, ...videos]);
            return res.status(409).json({
              code: "ACTIVE_REPORT_EXISTS",
              message:
                "Another lot listing for this contract became active before this retry.",
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
        if (!queuedListing) {
          await cleanupMulterFiles([...images, ...videos]);
          const latest = await LotListing.findById((existingSubmission as any)._id).lean();
          return res.status(202).json({
            message: "This submission was already accepted.",
            jobId: (latest as any)?.job_id || jobId,
            reportId: (existingSubmission as any)._id,
            status: (latest as any)?.status || (existingSubmission as any).status,
            phase: "processing",
            resumed: true,
          });
        }
        queuedJobId = retryJobId;
        if (retryOutbox) {
          sourceFilesOwnedByQueue = true;
          queueOwnershipUncertain = true;
        }
        await queueLotListingJob({
          ...retryPreviewJobInput,
          reportJobOutboxToken: retryOutbox?.token,
        });
        queueOwnershipUncertain = false;
        sourceFilesOwnedByQueue = true;
        return res.status(202).json({
          message: "The failed submission was queued again.",
          jobId: retryJobId,
          reportId: (existingSubmission as any)._id,
          status: "processing",
          phase: "processing",
          resumed: true,
        });
      }

      const existingJobId = String((existingSubmission as any).job_id || "").trim();
      const existingGenerationActive =
        existingJobId &&
        ["uploading", "queued", "processing"].includes(
          String((existingSubmission as any).job_status || "")
        );
      if (existingGenerationActive) {
        const persistedOutboxToken = String(
          (existingSubmission as any).report_job_outbox?.token || ""
        );
        if (shouldUseMongoReportQueue() && persistedOutboxToken) {
          try {
            await ensureReportJobOutbox(
              "lotListing",
              String((existingSubmission as any)._id),
              persistedOutboxToken
            );
          } catch (outboxError) {
            await cleanupMulterFiles([...images, ...videos]);
            console.error("Failed to ensure existing Lot Listing outbox:", outboxError);
            return res.status(503).json({
              code: "LOT_LISTING_QUEUE_HANDOFF_PENDING",
              message:
                "The saved Lot Listing is queued durably but its worker handoff is still pending. Retry with the same submission ID.",
              reportId: (existingSubmission as any)._id,
              jobId: existingJobId,
            });
          }
          await cleanupMulterFiles([...images, ...videos]);
          return res.status(202).json({
            message: "The saved Lot Listing processing job was recovered.",
            jobId: existingJobId,
            reportId: (existingSubmission as any)._id,
            status: (existingSubmission as any).status,
            phase: "processing",
            resumed: true,
            recovered: true,
          });
        }
        const durableJob = await ReportJob.findOne({
          type: "lot-listing-preview",
          reportId: String((existingSubmission as any)._id),
          progressId: existingJobId,
          status: { $in: ["queued", "processing", "completed"] },
        }).lean();
        if (!durableJob) {
          if (images.length === 0) {
            return res.status(409).json({
              code: "LOT_LISTING_QUEUE_RECOVERY_REQUIRES_FILES",
              message:
                "The saved Lot Listing has no active processing job. Retry with the original images to recover it.",
              reportId: (existingSubmission as any)._id,
              jobId: existingJobId,
              status: (existingSubmission as any).status,
            });
          }
          const valuationMethods = normalizeValuationMethods(
            details.valuation_methods,
            normalizeValuationMethods((existingSubmission as any).valuation_methods)
          );
          if (valuationMethods.length === 0) {
            await cleanupMulterFiles([...images, ...videos]);
            return res.status(400).json({
              message: "Select at least one supported valuation method",
            });
          }
          const recoveryJobInput = {
            listingId: String((existingSubmission as any)._id),
            user: {
              id: String(user?._id),
              email: String(user?.email || ""),
              name: (user as any)?.name || (user as any)?.username || undefined,
            },
            images,
            videos,
            details: {
              contract_no:
                String((existingSubmission as any).contract_no || "") ||
                String(details.contract_no || ""),
              sales_date:
                String(
                  (existingSubmission as any).sales_date ||
                    details.sales_date ||
                    new Date().toISOString()
                ),
              location:
                String((existingSubmission as any).location || "") ||
                String(details.location || ""),
              latitude: (existingSubmission as any).latitude ?? details.latitude,
              longitude: (existingSubmission as any).longitude ?? details.longitude,
              language: (existingSubmission as any).language || details.language || "en",
              currency: (existingSubmission as any).currency || details.currency || "CAD",
              include_damage_analysis: resolveIncludeDamageAnalysis(
                (existingSubmission as any).include_damage_analysis,
                resolveIncludeDamageAnalysis(details.include_damage_analysis, true)
              ),
              bank_photos_enabled: resolveIncludeDamageAnalysis(
                (existingSubmission as any).bank_photos_enabled,
                resolveIncludeDamageAnalysis(details.bank_photos_enabled, false)
              ),
              watermark_images: resolvePhotoWatermark(
                (existingSubmission as any).watermark_images,
                resolvePhotoWatermark(details.watermark_images)
              ),
              valuation_methods: valuationMethods,
              mixed_lots:
                (existingSubmission as any).mixed_lots || details.mixed_lots || [],
              focus_boxes: Array.isArray(details.focus_boxes)
                ? details.focus_boxes
                : [],
            },
            progressId: existingJobId,
          };
          const recoveryOutbox = shouldUseMongoReportQueue()
            ? buildLotListingPreviewJobOutbox(recoveryJobInput)
            : undefined;
          if (recoveryOutbox) {
            const claimed = await LotListing.updateOne(
              {
                _id: (existingSubmission as any)._id,
                job_id: existingJobId,
                job_status: { $in: ["uploading", "queued", "processing"] },
                $or: [
                  { report_job_outbox: { $exists: false } },
                  { report_job_outbox: null },
                ],
              },
              { $set: { report_job_outbox: recoveryOutbox } }
            );
            if (claimed.matchedCount !== 1) {
              const current: any = await LotListing.findById(
                (existingSubmission as any)._id
              )
                .select("+report_job_outbox")
                .lean();
              await cleanupMulterFiles([...images, ...videos]);
              const concurrentToken = String(current?.report_job_outbox?.token || "");
              if (concurrentToken) {
                await ensureReportJobOutbox(
                  "lotListing",
                  String((existingSubmission as any)._id),
                  concurrentToken
                ).catch(() => undefined);
                return res.status(202).json({
                  message: "This submission was already accepted.",
                  jobId: current?.job_id || existingJobId,
                  reportId: current?._id || (existingSubmission as any)._id,
                  status: current?.status || (existingSubmission as any).status,
                  phase: "processing",
                  resumed: true,
                });
              }
              return res.status(409).json({
                code: "LOT_LISTING_QUEUE_RECOVERY_CONFLICT",
                message:
                  "The Lot Listing changed while its processing job was being recovered. Retry once.",
              });
            }
          }
          queuedListing = existingSubmission;
          queuedJobId = existingJobId;
          if (recoveryOutbox) {
            sourceFilesOwnedByQueue = true;
            queueOwnershipUncertain = true;
          }
          const queuedJob = await queueLotListingJob({
            ...recoveryJobInput,
            reportJobOutboxToken: recoveryOutbox?.token,
          });
          queueOwnershipUncertain = false;
          sourceFilesOwnedByQueue = recoveryOutbox
            ? true
            : queuedPreviewJobOwnsRequestFiles(queuedJob, images, videos);
          if (!sourceFilesOwnedByQueue) {
            await cleanupMulterFiles([...images, ...videos]);
          }
          return res.status(202).json({
            message: "The saved Lot Listing processing job was recovered.",
            jobId: existingJobId,
            reportId: (existingSubmission as any)._id,
            status: (existingSubmission as any).status,
            phase: "processing",
            resumed: true,
            recovered: true,
          });
        }
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
        reportType: "lotListing",
        userId: user?._id || req.userId,
        contractClaim: requestContractClaim,
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
      // Contract-level duplicate protection is separate from request idempotency and
      // avoids two expensive generations for the same active business submission.
      const active = await findActiveSameContractReport({
        reportType: "lotListing",
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
          message: "A lot listing for this contract is already being processed.",
          data: {
            reportId: String((active as any)._id),
            jobId: (active as any).job_id,
            status: (active as any).job_status || (active as any).status,
            progress: (activeProgress as any)?.progress || activeProgress || undefined,
          },
        });
      }
    }

    const valuationMethods = normalizeValuationMethods(details.valuation_methods);
    if (valuationMethods.length === 0) {
      await cleanupMulterFiles([...images, ...videos]);
      return res.status(400).json({
        message: "Select at least one supported valuation method",
      });
    }
    await releaseInactiveSubmissionContractClaim({
      reportType: "lotListing",
      userId: user?._id,
      contractClaim: requestContractClaim,
    });
    const listing = new LotListing({
      user: user?._id,
      client_submission_id: clientSubmissionId,
      capture_id: details.capture_id,
      submission_contract_claim: requestContractClaim,
      submission_contract_claim_bypassed: requestContractClaimBypassed
        ? true
        : undefined,
      contract_no: details.contract_no || "",
      sales_date: new Date(details.sales_date || new Date().toISOString()),
      location: details.location || "",
      latitude: details.latitude,
      longitude: details.longitude,
      imageUrls: [],
      videoUrls: [],
      lots: [],
      mixed_lots: details.mixed_lots || [],
      status: "processing",
      language: details.language || "en",
      currency: details.currency || "CAD",
      include_damage_analysis: resolveIncludeDamageAnalysis(details.include_damage_analysis, true),
      bank_photos_enabled: resolveIncludeDamageAnalysis(details.bank_photos_enabled, false),
      watermark_images: resolvePhotoWatermark(details.watermark_images),
      valuation_methods: valuationMethods,
      job_id: jobId,
      job_status: "queued",
      queued_at: new Date(),
      auctionsoft:
        !auctioneerWorkItem &&
        details.auctionsoft &&
        typeof details.auctionsoft === "object"
          ? details.auctionsoft
          : undefined,
      auctioneerWorkItem: auctioneerWorkItem?._id,
    });
    const previewJobInput = {
      listingId: String(listing._id),
      user: {
        id: String(user?._id),
        email: String(user?.email || ""),
        name: (user as any)?.name || (user as any)?.username || undefined,
      },
      images,
      videos,
      details: {
        contract_no: details.contract_no || "",
        sales_date: details.sales_date || new Date().toISOString(),
        location: details.location || "",
        latitude: details.latitude,
        longitude: details.longitude,
        language: details.language || "en",
        currency: details.currency || "CAD",
        include_damage_analysis: resolveIncludeDamageAnalysis(details.include_damage_analysis, true),
        bank_photos_enabled: resolveIncludeDamageAnalysis(details.bank_photos_enabled, false),
        watermark_images: resolvePhotoWatermark(details.watermark_images),
        valuation_methods: valuationMethods,
        mixed_lots: details.mixed_lots || [],
        focus_boxes: Array.isArray(details.focus_boxes) ? details.focus_boxes : [],
      },
      progressId: jobId,
    };
    pendingPreviewJobInput = previewJobInput;
    const reportJobOutbox = shouldUseMongoReportQueue()
      ? buildLotListingPreviewJobOutbox(previewJobInput)
      : undefined;
    if (reportJobOutbox) {
      (listing as any).report_job_outbox = reportJobOutbox;
    }
    // Persist the report and queue identity before enqueueing so worker execution and
    // progress polling always have an authoritative durable record. The embedded
    // outbox makes the report row and its exact queue intent one atomic write.
    await submissionAdmission?.assertOwned();
    await listing.save();
    queuedListing = listing;
    queuedJobId = jobId;
    if (reportJobOutbox) {
      sourceFilesOwnedByQueue = true;
      queueOwnershipUncertain = true;
    }
    if (auctioneerWorkItem) {
      await linkAuctioneerReport({
        item: auctioneerWorkItem,
        userId: user?._id || req.userId,
        reportType: "lotListing",
        reportId: listing._id,
      });
    }

    // Queue the job for background processing
    const queuedJob = await queueLotListingJob({
      ...previewJobInput,
      reportJobOutboxToken: reportJobOutbox?.token,
    });
    queueOwnershipUncertain = false;
    sourceFilesOwnedByQueue = reportJobOutbox
      ? true
      : queuedPreviewJobOwnsRequestFiles(queuedJob, images, videos);
    if (!sourceFilesOwnedByQueue) {
      await cleanupMulterFiles([...images, ...videos]);
    }

    res.status(202).json({
      message: "Your lot listing is being processed. You will receive an email when it's ready.",
      jobId,
      reportId: listing._id,
      status: listing.status,
      phase: getProgress(jobId)?.phase || "processing",
    });
  } catch (error: any) {
    if (
      Number(error?.code) === 11000 &&
      !queuedListing &&
      requestClientSubmissionId &&
      req.userId
    ) {
      const accepted = await LotListing.findOne({
        user: req.userId as any,
        client_submission_id: requestClientSubmissionId,
      })
        .select("+report_job_outbox")
        .lean()
        .catch(() => null);
      if (accepted) {
        let acceptedOutboxOwnsCurrentFiles = false;
        if (shouldUseMongoReportQueue()) {
          const acceptedReportId = String((accepted as any)._id);
          const acceptedJobId = String((accepted as any).job_id || "");
          let acceptedOutboxToken = String(
            (accepted as any).report_job_outbox?.token || ""
          );
          const acceptedJob = acceptedJobId
            ? await ReportJob.findOne({
                type: "lot-listing-preview",
                reportId: acceptedReportId,
                progressId: acceptedJobId,
                status: { $in: ["queued", "processing", "completed"] },
              }).lean()
            : null;
          if (!acceptedJob && !acceptedOutboxToken && pendingPreviewJobInput && acceptedJobId) {
            const recoveryInput = {
              ...pendingPreviewJobInput,
              listingId: acceptedReportId,
              progressId: acceptedJobId,
            };
            const recoveryOutbox = buildLotListingPreviewJobOutbox(recoveryInput);
            const claimed = await LotListing.updateOne(
              {
                _id: (accepted as any)._id,
                job_id: acceptedJobId,
                job_status: { $in: ["uploading", "queued", "processing"] },
                $or: [
                  { report_job_outbox: { $exists: false } },
                  { report_job_outbox: null },
                ],
              },
              { $set: { report_job_outbox: recoveryOutbox } }
            );
            if (claimed.matchedCount === 1) {
              acceptedOutboxToken = recoveryOutbox.token;
              acceptedOutboxOwnsCurrentFiles = true;
              sourceFilesOwnedByQueue = true;
            } else {
              const latest: any = await LotListing.findById((accepted as any)._id)
                .select("+report_job_outbox")
                .lean();
              acceptedOutboxToken = String(latest?.report_job_outbox?.token || "");
            }
          }
          if (!acceptedJob && acceptedOutboxToken) {
            try {
              await ensureReportJobOutbox(
                "lotListing",
                acceptedReportId,
                acceptedOutboxToken
              );
            } catch (outboxError) {
              if (!acceptedOutboxOwnsCurrentFiles) {
                await cleanupMulterFiles([...images, ...videos]);
              }
              console.error("Failed to ensure concurrent Lot Listing outbox:", outboxError);
              return res.status(503).json({
                code: "LOT_LISTING_QUEUE_HANDOFF_PENDING",
                message:
                  "The Lot Listing was saved, but its worker handoff is still pending. Retry with the same submission ID.",
                reportId: (accepted as any)._id,
                jobId: acceptedJobId,
              });
            }
          }
        }
        if (!acceptedOutboxOwnsCurrentFiles) {
          await cleanupMulterFiles([...images, ...videos]);
        }
        return res.status(202).json({
          message: "This submission was already accepted.",
          jobId: (accepted as any).job_id || queuedJobId,
          reportId: (accepted as any)._id,
          status: (accepted as any).status,
          phase:
            (accepted as any).job_status === "done"
              ? "done"
              : (accepted as any).job_status === "error"
                ? "error"
                : "processing",
          resumed: true,
        });
      }
    }
    if (
      isSubmissionContractClaimDuplicateKeyError(error) &&
      !queuedListing &&
      requestContractClaim &&
      req.userId
    ) {
      const claimant = await findSubmissionContractClaimant({
        reportType: "lotListing",
        userId: req.userId,
        contractClaim: requestContractClaim,
      });
      await cleanupMulterFiles([...images, ...videos]);
      if (claimant) {
        return res.status(409).json({
          code: "ACTIVE_REPORT_EXISTS",
          message: "A lot listing for this contract is already being processed.",
          data: {
            reportId: String((claimant as any)._id),
            jobId: (claimant as any).job_id,
            status: (claimant as any).job_status || (claimant as any).status,
          },
        });
      }
      return res.status(409).json({
        code: "REPORT_SUBMISSION_CONFLICT",
        message: "Another submission changed while this listing was starting. Retry once.",
      });
    }
    if (queuedListing && queuedJobId && !sourceFilesOwnedByQueue) {
      sourceFilesOwnedByQueue = await reconcileLotListingPreviewQueueFailure(
        queuedListing,
        queuedJobId,
        error
      ).catch((reconcileError) => {
        console.error("Failed to reconcile Lot Listing preview queue failure:", reconcileError);
        // Queue insertion can succeed even when the caller observes a Mongo
        // network error. Preserve local sources until a later retry can prove
        // whether the durable job owns them.
        queueOwnershipUncertain = true;
        return true;
      });
    }
    if (!sourceFilesOwnedByQueue) {
      await cleanupMulterFiles([...images, ...videos]);
    }
    console.error("Error processing lot listing:", error);
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
    res.status(queueOwnershipUncertain ? 503 : 500).json({
      message: queueOwnershipUncertain
        ? "The Lot Listing queue result could not be confirmed. Retry with the same submission ID."
        : "Error processing request",
      error,
    });
  } finally {
    await submissionAdmission?.release().catch((releaseError) => {
      console.error(
        "Failed to release Lot Listing submission admission:",
        releaseError,
      );
    });
  }
};

export const getLotListings = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const listings = await LotListing.find({
      user: req.userId as any,
      is_draft_preview: { $ne: true },
    }).sort({
      createdAt: -1,
    }).lean();
    res.status(200).json({
      message: "Lot listings fetched successfully!",
      data: listings.map((listing: any) => {
        const { generation, downloadAccess, downloadable } =
          resolveLotListingDownloadState(listing);
        const previewFiles = downloadable ? listing.preview_files : {};
        const files = downloadable ? listing.files : {};
        return {
          ...listing,
          release_status: releaseStatusForPayload(listing),
          downloadable,
          download_access: downloadAccess,
          preview_files: previewFiles,
          files,
          ...generation,
          files_generating: ["queued", "processing"].includes(
            generation.generation_state
          ),
          files_regenerating:
            Boolean(listing.files_regenerating) &&
            generation.generation_state === "processing",
        };
      }).map(report => req.query.view === "previews" ? previewQueueSummary(report, "lotListing") : report),
    });
  } catch (error) {
    console.error("Error fetching lot listings:", error);
    res.status(500).json({ message: "Error fetching lot listings", error });
  }
};

export const getLotListingProgress = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Missing progress id" });
    }
    // Prefer low-latency in-process progress, then fall back to the durable Mongo job so
    // polling survives worker/server restarts and horizontal routing.
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
    if (!durableJob) return res.status(404).json({ message: "Not found" });
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
              reportType: "lotListing",
              status: durableJob.status,
            }
          : undefined),
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching progress", error });
  }
};

export const getLotListingById = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { id } = req.params;
    
    const listing = await LotListing.findOne({
      _id: id as any,
      user: req.userId as any,
    }).lean();

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    // File URLs are policy-gated server-side. Returning empty maps when disallowed keeps
    // the response shape stable without leaking unreleased artifact locations.
    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    res.status(200).json({
      message: "Lot listing fetched successfully",
      data: {
        ...listing,
        release_status: releaseStatusForPayload(listing),
        downloadable,
        download_access: downloadAccess,
        preview_files: downloadable ? (listing as any).preview_files : {},
        files: downloadable ? (listing as any).files : {},
        ...generation,
      },
    });
  } catch (error) {
    console.error("Error fetching lot listing:", error);
    res.status(500).json({ message: "Error fetching lot listing", error });
  }
};

export const deleteLotListing = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const listing = await LotListing.findOneAndDelete({
      _id: id as any,
      user: req.userId as any,
    });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    res.status(200).json({
      message: "Lot listing deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting lot listing:", error);
    res.status(500).json({ message: "Error deleting lot listing", error });
  }
};

// Get lot listing preview
export const getLotListingPreview = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { id } = req.params;
    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    const previewFiles = downloadable ? (listing as any).preview_files : {};
    const files = downloadable ? (listing as any).files : {};

    res.status(200).json({
      message: "Preview data fetched",
      data: {
        _id: listing._id,
        status: listing.status,
        release_status: releaseStatusForPayload(listing),
        downloadable,
        download_access: downloadAccess,
        ...generation,
        files_generating: ["queued", "processing"].includes(
          generation.generation_state
        ),
        files_regenerating:
          Boolean((listing as any).files_regenerating) &&
          generation.generation_state === "processing",
        decline_reason: listing.decline_reason,
        include_damage_analysis: listing.include_damage_analysis !== false,
        bank_photos_enabled: (listing as any).bank_photos_enabled === true,
        watermark_images: resolvePhotoWatermark((listing as any).watermark_images),
        valuation_methods: normalizeValuationMethods((listing as any).valuation_methods),
        preview_data: getCanonicalLotListingPreview(listing) || {
          contract_no: listing.contract_no,
          sales_date: listing.sales_date,
          location: listing.location,
          latitude: listing.latitude,
          longitude: listing.longitude,
          videoUrls: listing.videoUrls,
          currency: listing.currency,
          total_value: listing.total_value,
          include_damage_analysis: listing.include_damage_analysis !== false,
          bank_photos_enabled: (listing as any).bank_photos_enabled === true,
          watermark_images: resolvePhotoWatermark((listing as any).watermark_images),
          valuation_methods: normalizeValuationMethods((listing as any).valuation_methods),
          lots: listing.lots,
        },
        preview_files: previewFiles,
        imageUrls: listing.imageUrls,
        image_count: listing.imageUrls?.length || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching lot listing preview:", error);
    res.status(500).json({ message: "Error fetching preview", error });
  }
};

// Get submitted preview (for editing after submission)
export const getLotListingSubmittedPreview = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { id } = req.params;
    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    res.status(200).json({
      message: "Submitted preview data fetched",
      data: {
        _id: listing._id,
        status: listing.status,
        release_status: releaseStatusForPayload(listing),
        downloadable,
        download_access: downloadAccess,
        ...generation,
        files_generating: ["queued", "processing"].includes(
          generation.generation_state
        ),
        files_regenerating:
          Boolean((listing as any).files_regenerating) &&
          generation.generation_state === "processing",
        decline_reason: listing.decline_reason,
        include_damage_analysis: listing.include_damage_analysis !== false,
        bank_photos_enabled: (listing as any).bank_photos_enabled === true,
        watermark_images: resolvePhotoWatermark((listing as any).watermark_images),
        valuation_methods: normalizeValuationMethods((listing as any).valuation_methods),
        preview_data: getCanonicalLotListingPreview(listing) || {
          contract_no: listing.contract_no,
          sales_date: listing.sales_date,
          location: listing.location,
          latitude: listing.latitude,
          longitude: listing.longitude,
          videoUrls: listing.videoUrls,
          currency: listing.currency,
          total_value: listing.total_value,
          include_damage_analysis: listing.include_damage_analysis !== false,
          bank_photos_enabled: (listing as any).bank_photos_enabled === true,
          watermark_images: resolvePhotoWatermark((listing as any).watermark_images),
          valuation_methods: normalizeValuationMethods((listing as any).valuation_methods),
          lots: listing.lots,
        },
        preview_files: downloadable ? listing.preview_files : {},
        files: downloadable ? listing.files : {},
        imageUrls: listing.imageUrls,
        image_count: listing.imageUrls?.length || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching submitted preview:", error);
    res.status(500).json({ message: "Error fetching submitted preview", error });
  }
};

// Update lot listing preview data
export const updateLotListingPreview = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      preview_data,
      lots,
      details,
    } = req.body || {};

    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (!["preview", "declined", "pending_approval", "approved"].includes(listing.status) && !hasRecoverableFailedPreview("lotListing", listing)) {
      return res.status(400).json({ message: "Cannot update preview in current status" });
    }

    // Editing while a worker uses an earlier preview snapshot would publish stale files;
    // require the active generation to settle before accepting another edit.
    if (isLotListingGenerationActive(listing)) {
      return res.status(400).json({
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    const previewBuild = buildLotListingPreviewDataFromRequest(listing, {
      preview_data,
      lots,
      details,
    });
    if (previewBuild.message) {
      return res.status(400).json({ message: previewBuild.message });
    }
    applyLotListingPreviewData(listing, previewBuild.data);
    const previousWorkflowStatus = listing.status;
    const shouldRegenerateFiles =
      (listing as any).is_draft_preview !== true &&
      ["pending_approval", "approved"].includes(listing.status) &&
      stablePreviewJson(previewBuild.previousPreviewData) !== stablePreviewJson(listing.preview_data);
    const regenerationJobId = shouldRegenerateFiles ? createLotListingRegenerationJobId() : "";
    const regenerationHandoff = shouldRegenerateFiles
      ? prepareLotListingFilesHandoff(
          {
            listingId: String(listing._id),
            user: {
              id: String(req.userId),
              email: (req as any).user?.email || "",
              name:
                (req as any).user?.name ||
                (req as any).user?.username ||
                undefined,
            },
            generationToken: regenerationJobId,
            previewDataSnapshot: clonePlain(listing.preview_data),
          },
          "approved"
        )
      : undefined;
    if (shouldRegenerateFiles) {
      listing.status = "processing";
      (listing as any).generation_target_status = "approved";
      (listing as any).files_generating = true;
      (listing as any).files_regenerating = true;
      (listing as any).job_id = regenerationJobId;
      (listing as any).job_execution_token = undefined;
      (listing as any).job_status = "queued";
      (listing as any).job_error = undefined;
      (listing as any).queued_at = new Date();
      (listing as any).report_job_outbox = regenerationHandoff?.outbox;
      (listing as any).generation_progress = {
        stage: "generating_files",
        progressPercent: 1,
        message: "Queued to regenerate final files",
        previousStatus: previousWorkflowStatus,
        previewFingerprint: lotListingPreviewFingerprint(previewBuild.data),
        updatedAt: new Date(),
      };
    }
    await saveLotListingPreviewMutation(
      listing,
      shouldRegenerateFiles
        ? {
            expectedStatus: previousWorkflowStatus,
            requireInactiveGeneration: true,
          }
        : {}
    );

    if (shouldRegenerateFiles) {
      try {
        await dispatchLotListingFilesHandoff({
          queueInput: regenerationHandoff!.input,
          outbox: regenerationHandoff?.outbox,
          context: "preview update",
        });
      } catch (queueError) {
        await reconcileLotListingFilesQueueFailure(
          listing,
          regenerationJobId,
          previousWorkflowStatus,
          queueError
        );
        throw queueError;
      }
    }

    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    res.status(200).json({
      message: shouldRegenerateFiles
        ? "Preview data updated. Files are being regenerated."
        : "Preview data updated",
      data: {
        ...withoutGeneratedFileUrls(listing),
        release_status: releaseStatusForPayload(listing),
        downloadable,
        download_access: downloadAccess,
        preview_files: downloadable ? (listing as any).preview_files : {},
        files: downloadable ? (listing as any).files : {},
        ...generation,
        preview_data: listing.preview_data,
        imageUrls: listing.imageUrls || [],
        image_count: Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0,
      },
      imageUrls: listing.imageUrls || [],
      image_count: Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0,
      files_regeneration_queued: shouldRegenerateFiles,
    });
  } catch (error: any) {
    console.error("Error updating lot listing preview:", error);
    const statusCode = Number(error?.statusCode);
    res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Error updating preview",
    });
  }
};

export const uploadLotListingPreviewLotImages = async (req: AuthRequest, res: Response) => {
  // Capture every temporary file before validation so every early return and exception
  // can clean up Multer's disk artifacts.
  const uploadedFiles = collectPreviewImageUploadFiles(req.files);
  try {
    const { id, lotKey } = req.params;
    const incomingPreviewData = parseMultipartPreviewData(req.body?.preview_data);

    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (!["preview", "declined", "pending_approval", "approved"].includes(listing.status) && !hasRecoverableFailedPreview("lotListing", listing)) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: "Cannot update preview in current status" });
    }

    if (isLotListingGenerationActive(listing)) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({
        message: "This report is already generating files and cannot be edited right now.",
      });
    }

    const previewBuild = buildLotListingPreviewDataFromRequest(listing, {
      ...(incomingPreviewData ? { preview_data: incomingPreviewData } : {}),
    });
    if (previewBuild.message) {
      await cleanupMulterFiles(uploadedFiles);
      return res.status(400).json({ message: previewBuild.message });
    }

    const appendResult = await appendImagesToPreviewLot({
      kind: "lot-listing",
      previewData: previewBuild.data,
      rootImageUrls: listing.imageUrls,
      reportId: String(listing._id),
      lotKey: lotKey || "",
      files: uploadedFiles,
      watermarkImages: resolvePhotoWatermark(
        previewBuild.data?.watermark_images,
        (listing as any).watermark_images
      ),
    });

    const hasPreviewChanges =
      appendResult.added.length > 0 ||
      stablePreviewJson(previewBuild.previousPreviewData) !==
        stablePreviewJson(appendResult.previewData);
    if (hasPreviewChanges) {
      applyLotListingPreviewData(listing, appendResult.previewData);
      listing.imageUrls = appendResult.imageUrls;
      listing.markModified("imageUrls");
    }
    const previousWorkflowStatus = listing.status;

    // Once final artifacts may have been reviewed or released, an image edit invalidates
    // them and must move the listing through regeneration before URLs are exposed again.
    const shouldRegenerateFiles =
      (listing as any).is_draft_preview !== true &&
      ["pending_approval", "approved"].includes(listing.status) &&
      hasPreviewChanges;
    const regenerationJobId = shouldRegenerateFiles ? createLotListingRegenerationJobId() : "";
    const regenerationHandoff = shouldRegenerateFiles
      ? prepareLotListingFilesHandoff(
          {
            listingId: String(listing._id),
            user: {
              id: String(req.userId),
              email: (req as any).user?.email || "",
              name:
                (req as any).user?.name ||
                (req as any).user?.username ||
                undefined,
            },
            generationToken: regenerationJobId,
            previewDataSnapshot: clonePlain(listing.preview_data),
          },
          "approved"
        )
      : undefined;
    if (shouldRegenerateFiles) {
      listing.status = "processing";
      (listing as any).generation_target_status = "approved";
      (listing as any).files_generating = true;
      (listing as any).files_regenerating = true;
      (listing as any).job_id = regenerationJobId;
      (listing as any).job_execution_token = undefined;
      (listing as any).job_status = "queued";
      (listing as any).job_error = undefined;
      (listing as any).queued_at = new Date();
      (listing as any).report_job_outbox = regenerationHandoff?.outbox;
      (listing as any).generation_progress = {
        stage: "generating_files",
        progressPercent: 1,
        message: "Queued to regenerate final files",
        previousStatus: previousWorkflowStatus,
        previewFingerprint: lotListingPreviewFingerprint(appendResult.previewData),
        updatedAt: new Date(),
      };
    }

    if (hasPreviewChanges) {
      await saveLotListingPreviewMutation(
        listing,
        shouldRegenerateFiles
          ? {
              expectedStatus: previousWorkflowStatus,
              requireInactiveGeneration: true,
            }
          : {}
      );
    }

    if (shouldRegenerateFiles) {
      try {
        await dispatchLotListingFilesHandoff({
          queueInput: regenerationHandoff!.input,
          outbox: regenerationHandoff?.outbox,
          context: "preview image update",
        });
      } catch (queueError) {
        await reconcileLotListingFilesQueueFailure(
          listing,
          regenerationJobId,
          previousWorkflowStatus,
          queueError
        );
        throw queueError;
      }
    }

    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    return res.status(200).json({
      message: shouldRegenerateFiles
        ? "Images uploaded. Files are being regenerated."
        : !hasPreviewChanges && appendResult.duplicatesSkipped > 0
          ? "These images are already saved."
          : "Images uploaded.",
      data: {
        preview_data: listing.preview_data,
        preview_files: downloadable ? listing.preview_files : {},
        files: downloadable ? listing.files : {},
        downloadable,
        download_access: downloadAccess,
        ...generation,
        imageUrls: listing.imageUrls || [],
        image_count: Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0,
        added: appendResult.added,
        duplicatesSkipped: appendResult.duplicatesSkipped,
        lotIndex: appendResult.lotIndex,
        files_generating: Boolean((listing as any).files_generating),
        files_regenerating: Boolean((listing as any).files_regenerating),
      },
      files_regeneration_queued: shouldRegenerateFiles,
    });
  } catch (error: any) {
    await cleanupMulterFiles(uploadedFiles);
    console.error("Error uploading lot listing preview lot images:", error);
    const statusCode = Number(error?.statusCode);
    return res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Error uploading preview lot images",
    });
  }
};

export const refreshLotListingSpecPdf = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any }).populate(
      "user",
      "email username name companyName"
    );

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if ((listing as any).is_draft_preview === true) {
      return res.status(409).json({
        code: "DRAFT_PREVIEW_NOT_PROMOTED",
        message:
          "Save this draft preview, then move or submit it before generating CR files.",
      });
    }

    if (!listing.preview_data) {
      return res.status(400).json({ message: "Preview data is missing" });
    }

    if (!["preview", "declined", "pending_approval", "approved", "error"].includes(listing.status)) {
      return res.status(400).json({ message: "Cannot generate CR in current status" });
    }

    const previewBuild = buildLotListingPreviewDataFromRequest(listing);
    if (previewBuild.message) {
      return res.status(400).json({ message: previewBuild.message });
    }
    applyLotListingPreviewData(listing, previewBuild.data);
    await saveLotListingPreviewMutation(listing, {
      expectedStatus: listing.status,
      requireInactiveGeneration: true,
    });
    const { specPdf, crDocx } =
      await generateAndStoreLotListingCrArtifacts(listing);
    const { generation, downloadAccess, downloadable } =
      resolveLotListingDownloadState(listing);
    return res.status(200).json({
      message: "CR generated",
      data: {
        spec_pdf: specPdf,
        cr_docx: crDocx,
        preview_files: downloadable ? listing.preview_files : {},
        files: downloadable ? listing.files : {},
        downloadable,
        download_access: downloadAccess,
        ...generation,
        preview_data: listing.preview_data,
        imageUrls: listing.imageUrls || [],
        image_count: Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0,
      },
    });
  } catch (error: any) {
    console.error("Error generating lot listing CR:", error);
    const statusCode = Number(error?.statusCode);
    const responseStatus =
      Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
        ? statusCode
        : 500;
    return res.status(responseStatus).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Error generating CR",
      ...(Number.isInteger(Number(error?.retryAfterMs)) &&
      Number(error.retryAfterMs) > 0
        ? { retryAfterMs: Number(error.retryAfterMs) }
        : {}),
    });
  }
};

// Submit a lot listing and generate its final files
export const submitLotListingForApproval = async (req: AuthRequest, res: Response) => {
  let draftPromotionClaim: ReportDraftPromotionClaim | null = null;
  let draftPromotionPersisted = false;
  try {
    const { id } = req.params;
    const { preview_data } = req.body || {};
    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (isLotListingGenerationActive(listing)) {
      if (!hasOwn(req.body || {}, "preview_data")) {
        return sendActiveLotListingGeneration(res, listing, (req as any).user);
      }
      const activePreviewBuild = buildLotListingPreviewDataFromRequest(listing, {
        preview_data,
      });
      if (
        !activePreviewBuild.message &&
        matchesLotListingGenerationSnapshot(listing, activePreviewBuild.data)
      ) {
        return sendActiveLotListingGeneration(res, listing, (req as any).user);
      }
      return activeLotListingGenerationConflict(res);
    }

    if (!["preview", "declined"].includes(listing.status)) {
      return res.status(400).json({ message: "Can only submit from preview or declined status" });
    }

    const previewBuild = buildLotListingPreviewDataFromRequest(listing, { preview_data });
    if (previewBuild.message) {
      return res.status(400).json({ message: previewBuild.message });
    }
    applyLotListingPreviewData(listing, previewBuild.data);

    const valuationMethods = normalizeValuationMethods(
      (listing.preview_data as any)?.valuation_methods,
      normalizeValuationMethods((listing as any).valuation_methods)
    );
    if (valuationMethods.length === 0) {
      return res.status(400).json({ message: "Select at least one valuation method" });
    }

    // Persist the transition and its target status before queueing. The worker consumes
    // the immutable preview snapshot and restores the intended workflow state on success.
    const regenerationJobId = createLotListingRegenerationJobId();
    await attachYoutubeSubmission(listing, regenerationJobId);
    const previousWorkflowStatus = listing.status;
    const requestUser = (req as any).user;
    const regenerationHandoff = prepareLotListingFilesHandoff(
      {
        listingId: String(listing._id),
        user: {
          id: String(requestUser?._id || listing.user),
          email: requestUser?.email || "",
          name: requestUser?.name || requestUser?.username || undefined,
        },
        generationToken: regenerationJobId,
        previewDataSnapshot: clonePlain(listing.preview_data),
      },
      "approved"
    );
    listing.status = "processing";
    listing.decline_reason = undefined;
    (listing as any).files_generating = true;
    (listing as any).files_regenerating = false;
    (listing as any).job_id = regenerationJobId;
    (listing as any).job_execution_token = undefined;
    (listing as any).job_status = "queued";
    (listing as any).job_error = undefined;
    (listing as any).valuation_methods = valuationMethods;
    (listing as any).queued_at = new Date();
    // Lot Listings retain their automatic finalization workflow, including
    // Auctioneer-linked listings. Only Asset Listings require manual approval
    // and release before Auctioneer delivery.
    (listing as any).preview_submitted_at = new Date();
    (listing as any).approval_requested_at = undefined;
    (listing as any).approval_processed_at = undefined;
    (listing as any).approval_assigned_to = undefined;
    (listing as any).approval_assigned_at = undefined;
    (listing as any).approval_assigned_source = undefined;
    (listing as any).approval_assignment_email_sent_at = undefined;
    (listing as any).release_status = undefined;
    (listing as any).release_assigned_to = undefined;
    (listing as any).release_assigned_at = undefined;
    (listing as any).release_assigned_source = undefined;
    (listing as any).release_assignment_email_sent_at = undefined;
    (listing as any).released_by = undefined;
    (listing as any).released_at = undefined;
    (listing as any).generation_target_status = "approved";
    (listing as any).report_job_outbox = regenerationHandoff.outbox;
    (listing as any).generation_progress = {
      stage: "generating_files",
      progressPercent: 1,
      message: "Queued to generate final files",
      previousStatus: previousWorkflowStatus,
      previewFingerprint: lotListingPreviewFingerprint(previewBuild.data),
      updatedAt: new Date(),
    };
    const expectedUpdatedAt = listing.updatedAt;
    const expectedIsDraftPreview = (listing as any).is_draft_preview === true;
    draftPromotionClaim = await claimHiddenReportDraftPromotion({
      report: listing,
      userId: req.userId,
      type: "lotListing",
      submit: true,
    });
    try {
      await saveLotListingPreviewMutation(listing, {
        expectedUpdatedAt,
        expectedIsDraftPreview,
        expectedStatus: previousWorkflowStatus,
        requireInactiveGeneration: true,
      });
    } catch (saveError: any) {
      if (
        draftPromotionClaim &&
        isSubmissionContractClaimDuplicateKeyError(saveError)
      ) {
        const claimant = draftPromotionClaim.submissionContractClaim
          ? await findSubmissionContractClaimant({
              reportType: "lotListing",
              userId: req.userId,
              contractClaim: draftPromotionClaim.submissionContractClaim,
            })
          : null;
        throw Object.assign(
          new Error(
            "A lot listing for this contract is already being processed. Use the existing report or explicitly create a separate one."
          ),
          {
            code: "ACTIVE_REPORT_EXISTS",
            statusCode: 409,
            data: claimant
              ? {
                  reportId: String((claimant as any)._id),
                  jobId: (claimant as any).job_id,
                  status:
                    (claimant as any).job_status || (claimant as any).status,
                }
              : undefined,
            cause: saveError,
          }
        );
      }
      if (saveError?.code === "LOT_LISTING_PREVIEW_WRITE_CONFLICT" && !draftPromotionClaim) {
        const current = await findCurrentActiveLotListingGeneration({
          listingId: listing._id,
          userId: req.userId,
        });
        if (current) {
          if (
            matchesLotListingGenerationSnapshot(current, previewBuild.data)
          ) {
            return sendActiveLotListingGeneration(res, current, (req as any).user);
          }
          return activeLotListingGenerationConflict(res);
        }
      }
      throw saveError;
    }
    draftPromotionPersisted = true;

    try {
      await dispatchLotListingFilesHandoff({
        queueInput: regenerationHandoff.input,
        outbox: regenerationHandoff.outbox,
        context: "submission",
      });
    } catch (queueError) {
      const reconciled = await reconcileLotListingFilesQueueFailure(
        listing,
        regenerationJobId,
        previousWorkflowStatus,
        queueError
      ).catch((reconcileError) => {
        console.error("Failed to reconcile Lot Listing file queue failure:", reconcileError);
        return false;
      });
      if (reconciled) {
        await completeReportDraftPreviewPromotion(draftPromotionClaim);
      }
      throw queueError;
    }
    await completeReportDraftPreviewPromotion(draftPromotionClaim);

    const { generation: state, downloadAccess } =
      resolveLotListingDownloadState(listing);
    res.status(202).json({
      message:
        "Lot listing submitted. Files are being generated and will be released automatically.",
      data: {
        reportId: String(listing._id),
        reportType: "lotListing",
        ...withoutGeneratedFileUrls(listing),
        auctioneer_work_item_id: (listing as any).auctioneerWorkItem || undefined,
        release_status: releaseStatusForPayload(listing),
        downloadable: false,
        download_access: downloadAccess,
        ...state,
      },
    });
  } catch (error: any) {
    if (draftPromotionClaim && !draftPromotionPersisted) {
      await rollbackReportDraftPreviewPromotion(draftPromotionClaim).catch(
        (rollbackError) =>
          console.error("Failed to roll back Lot Listing draft promotion:", rollbackError)
      );
    }
    console.error("Error submitting lot listing:", error);
    const statusCode = Number(error?.statusCode);
    res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Error submitting lot listing",
    });
  }
};

// Resubmit lot listing (regenerate files and resubmit)
export const resubmitLotListing = async (req: AuthRequest, res: Response) => {
  let draftPromotionClaim: ReportDraftPromotionClaim | null = null;
  let draftPromotionPersisted = false;
  try {
    const { id } = req.params;
    const { preview_data, lots, details } = req.body || {};

    const listing = await LotListing.findOne({ _id: id as any, user: req.userId as any });

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (listing.auctioneerWorkItem) {
      const initialRetry = await retryInitialAuctioneerPreview({ reportType: "lotListing", reportId: listing._id,
        userId: req.userId, hasIncomingEdits: Object.keys(req.body || {}).length > 0 });
      if (initialRetry) return res.status(202).json(initialRetry);
    }

    const hasIncomingEdits =
      hasOwn(req.body || {}, "preview_data") ||
      hasOwn(req.body || {}, "lots") ||
      hasOwn(req.body || {}, "details");
    if (isLotListingGenerationActive(listing)) {
      if (!hasIncomingEdits) {
        return sendActiveLotListingGeneration(res, listing, (req as any).user);
      }
      const activePreviewBuild = buildLotListingPreviewDataFromRequest(listing, {
        preview_data,
        lots,
        details,
      });
      if (
        !activePreviewBuild.message &&
        matchesLotListingGenerationSnapshot(listing, activePreviewBuild.data)
      ) {
        return sendActiveLotListingGeneration(res, listing, (req as any).user);
      }
      return activeLotListingGenerationConflict(res);
    }

    // Allow resubmit from: preview, declined, pending_approval, approved, error
    const allowedStatuses = ["preview", "declined", "pending_approval", "approved", "error"];
    if (listing.status === "error" && !hasRecoverableFailedPreview("lotListing", listing)) {
      return res.status(400).json({ message: "No saved preview is available. Reopen the saved draft to finish processing." });
    }
    if (!allowedStatuses.includes(listing.status)) {
      return res.status(400).json({ 
        message: `Cannot resubmit lot listing with status: ${listing.status}` 
      });
    }

    const previewBuild = buildLotListingPreviewDataFromRequest(listing, {
      preview_data,
      lots,
      details,
    });
    if (previewBuild.message) {
      return res.status(400).json({ message: previewBuild.message });
    }
    const nextPreviewData = previewBuild.data;

    applyLotListingPreviewData(listing, nextPreviewData);

    const valuationMethods = normalizeValuationMethods(
      nextPreviewData?.valuation_methods ?? (listing.preview_data as any)?.valuation_methods,
      normalizeValuationMethods((listing as any).valuation_methods)
    );
    if (valuationMethods.length === 0) {
      return res.status(400).json({ message: "Select at least one valuation method" });
    }

    const regenerationJobId = createLotListingRegenerationJobId();
    await attachYoutubeSubmission(listing, regenerationJobId);
    const previousWorkflowStatus = listing.status;
    const requestUser = (req as any).user;
    const regenerationHandoff = prepareLotListingFilesHandoff(
      {
        listingId: String(listing._id),
        user: {
          id: String(requestUser?._id || listing.user),
          email: requestUser?.email || "",
          name: requestUser?.name || requestUser?.username || undefined,
        },
        generationToken: regenerationJobId,
        previewDataSnapshot: clonePlain(listing.preview_data),
      },
      "approved"
    );
    listing.status = "processing";
    (listing as any).files_generating = true;
    (listing as any).files_regenerating = true;
    (listing as any).job_id = regenerationJobId;
    (listing as any).job_execution_token = undefined;
    (listing as any).job_status = "queued";
    (listing as any).job_error = undefined;
    (listing as any).valuation_methods = valuationMethods;
    (listing as any).queued_at = new Date();
    (listing as any).preview_submitted_at = new Date();
    (listing as any).approval_requested_at = undefined;
    (listing as any).approval_processed_at = undefined;
    (listing as any).approval_assigned_to = undefined;
    (listing as any).approval_assigned_at = undefined;
    (listing as any).approval_assigned_source = undefined;
    (listing as any).approval_assignment_email_sent_at = undefined;
    (listing as any).release_status = undefined;
    (listing as any).release_assigned_to = undefined;
    (listing as any).release_assigned_at = undefined;
    (listing as any).release_assigned_source = undefined;
    (listing as any).release_assignment_email_sent_at = undefined;
    (listing as any).released_by = undefined;
    (listing as any).released_at = undefined;
    (listing as any).generation_target_status = "approved";
    (listing as any).report_job_outbox = regenerationHandoff.outbox;
    (listing as any).generation_progress = {
      stage: "generating_files",
      progressPercent: 1,
      message: "Queued to regenerate final files",
      previousStatus: previousWorkflowStatus,
      previewFingerprint: lotListingPreviewFingerprint(nextPreviewData),
      updatedAt: new Date(),
    };
    const expectedUpdatedAt = listing.updatedAt;
    const expectedIsDraftPreview = (listing as any).is_draft_preview === true;
    draftPromotionClaim = await claimHiddenReportDraftPromotion({
      report: listing,
      userId: req.userId,
      type: "lotListing",
      submit: true,
    });
    try {
      await saveLotListingPreviewMutation(listing, {
        expectedUpdatedAt,
        expectedIsDraftPreview,
        expectedStatus: previousWorkflowStatus,
        requireInactiveGeneration: true,
      });
    } catch (saveError: any) {
      if (
        draftPromotionClaim &&
        isSubmissionContractClaimDuplicateKeyError(saveError)
      ) {
        const claimant = draftPromotionClaim.submissionContractClaim
          ? await findSubmissionContractClaimant({
              reportType: "lotListing",
              userId: req.userId,
              contractClaim: draftPromotionClaim.submissionContractClaim,
            })
          : null;
        throw Object.assign(
          new Error(
            "A lot listing for this contract is already being processed. Use the existing report or explicitly create a separate one."
          ),
          {
            code: "ACTIVE_REPORT_EXISTS",
            statusCode: 409,
            data: claimant
              ? {
                  reportId: String((claimant as any)._id),
                  jobId: (claimant as any).job_id,
                  status:
                    (claimant as any).job_status || (claimant as any).status,
                }
              : undefined,
            cause: saveError,
          }
        );
      }
      if (saveError?.code === "LOT_LISTING_PREVIEW_WRITE_CONFLICT" && !draftPromotionClaim) {
        const current = await findCurrentActiveLotListingGeneration({
          listingId: listing._id,
          userId: req.userId,
        });
        if (current) {
          if (
            matchesLotListingGenerationSnapshot(current, nextPreviewData)
          ) {
            return sendActiveLotListingGeneration(res, current, (req as any).user);
          }
          return activeLotListingGenerationConflict(res);
        }
      }
      throw saveError;
    }
    draftPromotionPersisted = true;

    try {
      await dispatchLotListingFilesHandoff({
        queueInput: regenerationHandoff.input,
        outbox: regenerationHandoff.outbox,
        context: "resubmission",
      });
    } catch (queueError) {
      const reconciled = await reconcileLotListingFilesQueueFailure(
        listing,
        regenerationJobId,
        previousWorkflowStatus,
        queueError
      ).catch((reconcileError) => {
        console.error("Failed to reconcile Lot Listing file queue failure:", reconcileError);
        return false;
      });
      if (reconciled) {
        await completeReportDraftPreviewPromotion(draftPromotionClaim);
      }
      throw queueError;
    }
    await completeReportDraftPreviewPromotion(draftPromotionClaim);

    const { generation: state, downloadAccess } =
      resolveLotListingDownloadState(listing);
    res.status(202).json({
      message: "Lot listing final files are being regenerated",
      data: {
        reportId: String(listing._id),
        reportType: "lotListing",
        ...withoutGeneratedFileUrls(listing),
        auctioneer_work_item_id: (listing as any).auctioneerWorkItem || undefined,
        downloadable: false,
        download_access: downloadAccess,
        ...state,
      },
    });
  } catch (error: any) {
    if (draftPromotionClaim && !draftPromotionPersisted) {
      await rollbackReportDraftPreviewPromotion(draftPromotionClaim).catch(
        (rollbackError) =>
          console.error("Failed to roll back Lot Listing draft promotion:", rollbackError)
      );
    }
    console.error("Error resubmitting lot listing:", error);
    const statusCode = Number(error?.statusCode);
    res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
      ...(error?.code ? { code: String(error.code) } : {}),
      message: error?.message || "Error resubmitting",
    });
  }
};

// Upload middleware - allow many images
export const uploadMiddleware = reportJobUpload.fields([
  { name: "images", maxCount: 100000 },
  { name: "videos", maxCount: 10000 },
]);
