import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { assertMixedLotPhotoManifest, resolveGroupModelImageIndex } from "../utils/mixedLotPhotoManifest.js";
import {
  getR2PublicUrl,
  uploadBufferToR2,
  uploadFilePathToR2,
} from "../utils/r2Storage/r2Upload.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  prepareImageWithoutWatermark,
  isHeicLikeImage,
  processImageWithLogo,
} from "../utils/imageProcessing.js";
import LotListing, { type LotListingMode, type LotListingValuationMethod } from "../models/lotListing.model.js";
import {
  startProgress,
  updateProgress,
  endProgress,
} from "../utils/progressStore.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import {
  analyzeAssetImages,
  normalizeAssetAiLot,
  type AssetAnalysisResult,
} from "../service/assetOpenAIService.js";
import {
  registerFocusBoxes,
  clearFocusBoxes,
  imageUrlToBase64WithMime,
  type FocusBoxRect,
} from "../service/assetOpenAIService/imageUtils.js";
import openai from "../utils/openaiClient.js";
import fs from "fs/promises";
import { notifyUser } from "../service/notificationService.js";
import { enqueueReportJob } from "../utils/reportJobQueue.js";
import { cleanupMulterFiles, readMulterFileBuffer } from "../utils/reportTempFiles.js";
import { normalizeAssetConditionReportSelections } from "../utils/assetConditionSelections.js";
import { generateLotListingXlsxFromReport } from "../service/xlsx/assetXlsxService.js";
import { prepareReportYoutubeVideos } from "../service/youtubeVideoService.js";
import {
  generateScheduleAPdfFromReport,
} from "../service/scheduleAReportPdfService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../service/auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../service/auctioneerSpecSheetDocxService.js";
import { generateImagesZip } from "./assetReportJob/imagesZip.js";
import {
  buildLotImageNameMaps,
  buildOrderedLotImageZipEntries,
  buildOrderedLotVideoZipEntries,
} from "./assetReportJob/imageNaming.js";
import { normalizeLotsForReportOrdering } from "./assetReportJob/lotOrdering.js";
import { allocateInitialAuctioneerLotNumbers } from "../service/auctioneerLotNumberAllocationService.js";
import { initialLotNumberFallbackIndexes, markInitialLotNumberFallback } from "../service/initialLotNumberProvenance.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import { allowedCategories, assetCategorySpecs } from "../utils/assetCategorySpecs.js";
import { enrichLotListingSpecs } from "../service/lotListingSpecEnrichmentService.js";
import { AUCTION_DESCRIPTION_MAX_LENGTH, normalizeLotsForBusinessRules } from "../utils/previewLotNormalization.js";
import { auctioneerSpecFieldAliases, markPreviewDataSpecsReviewed } from "../utils/auctioneerSpecRows.js";
import { getExplicitCoordinates } from "../utils/auctionLocations.js";
import { setReportGenerationProgress } from "../service/reportGenerationProgressService.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../utils/reportArtifactNames.js";
import { mergeCanonicalAuctioneerSourceLots } from "../service/auctioneerSourceMergeService.js";
import { pushAuctionsoftLotListingIfReady } from "../service/auctionsoftLotListingPush.js";
import {
  buildReportJobOutbox,
  createMongoReportJob,
  endMongoReportJobProgress,
  ensureReportJobOutbox,
  shouldUseMongoReportQueue,
  updateMongoReportJobProgress,
  type ReportJobOutbox,
  type ReportJobExecutionContext,
} from "../utils/reportJobMongoQueue.js";
import { serializeMulterFiles } from "../utils/multerFileSerialization.js";
import {
  enforceLotDamageAnalysisPolicy,
  enforceLotsDamageAnalysisPolicy,
  isLotRecordDamageAnalysisEligible,
} from "../utils/lotDamagePolicy.js";
import {
  applyAuthoritativeBundleLotNumber,
  buildBundleLotNumberPhotoInputs,
  detectBundleLotNumbersFromPhotos,
  getBundleLotAnalysisLimit,
  normalizeDetectedBundleLotNumber,
  reapplyBundleLotNumberDiagnostics,
  resolveBundleLotAnalysisPolicy,
  selectBundleAnalysisImageIndexes,
  selectImagesPreservingEndpoints,
  type BundleLotAnalysisDiagnostic,
} from "../service/bundleLotAnalysisPolicy.js";
import { normalizeLotListingValuationMethods } from "../utils/lotListingValuationMethods.js";
import {
  fillMissingFmvFromAvailableValues,
  getLotEstimatedValueText,
  isEstimatedValueMissing,
  parseEstimatedValue,
} from "../utils/lotListingFmv.js";
import { stageAndPublishLotListingArtifacts } from "../service/lotListingArtifactPublicationService.js";

export type LotListingJobInput = {
  listingId?: string;
  user: { id: string; email: string; name?: string | null };
  images: Express.Multer.File[];
  videos?: Express.Multer.File[];
  details: {
    contract_no: string;
    sales_date: string;
    location: string;
    latitude?: number | string;
    longitude?: number | string;
    language?: string;
    currency?: string;
    include_damage_analysis?: boolean;
    bank_photos_enabled?: boolean | string;
    watermark_images?: boolean | string;
    valuation_methods?: LotListingValuationMethod[];
    mixed_lots?: Array<{
      count: number;
      extra_count?: number;
      video_count?: number;
      cover_index?: number;
      mode: LotListingMode;
      reviewed_lot_number?: string;
      lot_number?: string;
    }>;
    smart_upload_grouping_method?: "black_divider" | "lot_number";
    focus_boxes?: Array<{ imageIndex: number; x: number; y: number; w: number; h: number }>;
    upload_session_id?: string;
    draft_preview?: boolean;
    source_draft_id?: string;
    source_draft_revision?: number;
  };
  progressId?: string;
  /** Present only while a Mongo worker owns this individual queue claim. */
  executionContext?: ReportJobExecutionContext;
  /** Mongo workers defer shared multipart cleanup until their completion CAS wins. */
  deferSourceFileCleanup?: boolean;
  /** Keep report state retryable while this durable job still has attempts. */
  willRetryOnError?: boolean;
  /** Exact embedded outbox handoff already persisted with the report row. */
  reportJobOutboxToken?: string;
};

function lotListingPreviewQueueInput(input: LotListingJobInput) {
  return {
    type: "lot-listing-preview" as const,
    reportId: input.listingId,
    progressId: input.progressId,
    maxAttempts: 3,
    targetStatus: "preview" as const,
    idempotencyKey: input.details?.upload_session_id
      ? `lot-listing-upload:${String(input.details.upload_session_id)}`
      : `lot-listing-preview:${String(input.listingId || "")}:${String(
          input.progressId || ""
        )}`,
    payload: {
      listingId: input.listingId,
      user: input.user,
      images: serializeMulterFiles(input.images),
      videos: serializeMulterFiles(input.videos || []),
      details: input.details,
      progressId: input.progressId,
    },
  };
}

export function buildLotListingPreviewJobOutbox(
  input: LotListingJobInput
): ReportJobOutbox {
  if (!input.listingId || !input.progressId) {
    throw new Error("Lot Listing preview outbox requires listing and progress IDs");
  }
  return buildReportJobOutbox(lotListingPreviewQueueInput(input));
}

export async function queueLotListingJob(input: LotListingJobInput): Promise<any> {
  if (shouldUseMongoReportQueue()) {
    if (input.reportJobOutboxToken && input.listingId) {
      const ensured = await ensureReportJobOutbox(
        "lotListing",
        input.listingId,
        input.reportJobOutboxToken
      );
      if (!ensured) {
        throw Object.assign(
          new Error("The Lot Listing preview outbox is no longer current."),
          { code: "LOT_LISTING_PREVIEW_OUTBOX_CHANGED", statusCode: 409 }
        );
      }
      return ensured;
    }
    return createMongoReportJob(lotListingPreviewQueueInput(input));
  }

  enqueueReportJob(`lot-listing:${input.listingId || input.progressId || "new"}`, async () => {
    await runLotListingJob(input).catch((e) => {
      if (input.progressId)
        endProgress(input.progressId, false, "Error processing request");
      console.error("LotListing job failed:", e);
    });
  });
  return undefined;
}

export type RegenerateLotListingInput = {
  listingId: string;
  user: { id: string; email: string; name?: string | null };
  /** Current durable generation identity. */
  generationToken?: string;
  /** Legacy payload field retained for queued jobs created by older releases. */
  jobId?: string;
  previewDataSnapshot?: any;
  /** Present only while a Mongo worker owns this individual queue claim. */
  executionContext?: ReportJobExecutionContext;
  /** Keep report state retryable while this durable job still has attempts. */
  willRetryOnError?: boolean;
  /** Exact embedded outbox handoff already persisted with the report row. */
  reportJobOutboxToken?: string;
};

async function persistLotListingProgress(
  progressId: string | undefined,
  patch: any,
  executionContext?: ReportJobExecutionContext
) {
  if (!progressId) return;
  await executionContext?.assertOwned();
  updateProgress(progressId, patch);
  await updateMongoReportJobProgress(progressId, patch);
}

async function finishLotListingProgress(
  progressId: string | undefined,
  ok: boolean,
  message: string,
  executionContext?: ReportJobExecutionContext
) {
  if (!progressId) return;
  await executionContext?.assertOwned();
  endProgress(progressId, ok, message);
  await endMongoReportJobProgress(progressId, ok, message);
}

function lotListingGenerationTarget(
  listing: Record<string, any> | null | undefined
): "pending_approval" | "approved" {
  // Preserve the identity of already queued legacy work when reconciling a
  // retry. File publication itself always approves and releases Lot Listings.
  if (listing?.auctioneerWorkItem) return "approved";
  return listing?.generation_target_status === "pending_approval"
    ? "pending_approval"
    : "approved";
}

class LotListingJobExecutionLostError extends Error {
  readonly code = "REPORT_JOB_OWNERSHIP_LOST";

  constructor(listingId: string) {
    super(`Lot Listing ${listingId} is owned by another worker execution.`);
    this.name = "LotListingJobExecutionLostError";
  }
}

function isLotListingExecutionOwnershipLost(
  error: unknown,
  context?: ReportJobExecutionContext
): boolean {
  const code = String((error as any)?.code || "");
  return Boolean(
    context?.signal.aborted ||
      code === "REPORT_JOB_OWNERSHIP_LOST" ||
      error instanceof LotListingJobExecutionLostError
  );
}

function executionTokenOf(
  context: ReportJobExecutionContext | undefined
): string {
  return String(context?.executionToken || "").trim();
}

async function assertLotListingExecutionOwned(input: {
  listingId: string;
  generationToken: string;
  executionContext?: ReportJobExecutionContext;
  finalized?: boolean;
}) {
  if (!input.executionContext) return;
  await input.executionContext.assertOwned();
  const executionToken = executionTokenOf(input.executionContext);
  const reportOwned = await LotListing.exists({
    _id: input.listingId,
    ...(input.generationToken ? { job_id: input.generationToken } : {}),
    ...(executionToken ? { job_execution_token: executionToken } : {}),
    ...(input.finalized ? { job_status: "done" } : {}),
  });
  if (!reportOwned) throw new LotListingJobExecutionLostError(input.listingId);
}

function safeGeneratedMediaExtension(value: unknown): string {
  const extension = String(value || "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

/**
 * Same logical preview job always addresses the same transformed-media key.
 * A reclaimed attempt can overwrite identical bytes, but can never create an
 * unbounded second object merely because its worker execution token changed.
 */
export function buildLotListingInitialMediaKey(input: {
  reportId: string;
  generationToken: string;
  kind: "images" | "videos";
  index: number;
  buffer?: Buffer;
  contentDigest?: string;
  extension: string;
}): string {
  const scope = createHash("sha256")
    .update("lot-listing-initial-media-v1\0")
    .update(input.reportId)
    .update("\0")
    .update(input.generationToken)
    .digest("hex")
    .slice(0, 24);
  const content = String(input.contentDigest || "").trim() ||
    (input.buffer
      ? createHash("sha256").update(input.buffer).digest("hex")
      : "");
  if (!/^[a-f0-9]{64}$/i.test(content)) {
    throw new Error("Lot Listing media key requires a SHA-256 content digest.");
  }
  const position = String(Math.max(0, Math.trunc(input.index))).padStart(6, "0");
  return `uploads/lot-listing/initial/${scope}/${input.kind}/${position}-${content}${safeGeneratedMediaExtension(
    input.extension
  )}`;
}

async function sha256FilePath(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

export function buildLotListingArtifactPrefix(
  reportId: unknown,
  generationToken: string,
  executionToken?: string
): string {
  const safeReportId = String(reportId || "report").replace(
    /[^a-zA-Z0-9._-]/g,
    "-"
  );
  const generationScope = createHash("sha256")
    .update("lot-listing-artifacts-v1\0")
    .update(String(reportId || ""))
    .update("\0")
    .update(generationToken)
    .update("\0")
    // Durable queue reclaims reuse the logical generation token. Give each
    // execution immutable destinations so a copy that finishes after losing
    // its lease cannot overwrite the winning attempt's published objects.
    .update(String(executionToken || "legacy-direct"))
    .digest("hex")
    .slice(0, 24);
  return `lot-listings/generated/${safeReportId}/${generationScope}`;
}

async function updateLotListingForExecution(input: {
  listingId: string;
  generationToken: string;
  executionContext?: ReportJobExecutionContext;
  filter?: Record<string, unknown>;
  set: Record<string, unknown>;
  unset?: Record<string, 1>;
}) {
  await input.executionContext?.assertOwned();
  const executionToken = executionTokenOf(input.executionContext);
  const updated = await LotListing.findOneAndUpdate(
    {
      _id: input.listingId,
      ...(input.generationToken ? { job_id: input.generationToken } : {}),
      ...(executionToken ? { job_execution_token: executionToken } : {}),
      ...(input.filter || {}),
    },
    {
      $set: input.set,
      ...(input.unset && Object.keys(input.unset).length
        ? { $unset: input.unset }
        : {}),
    },
    { returnDocument: "after" }
  );
  if (updated) return updated;
  await input.executionContext?.assertOwned();
  throw new LotListingJobExecutionLostError(input.listingId);
}

async function releaseLotListingExecutionOwnership(input: {
  listingId: string;
  generationToken: string;
  executionContext?: ReportJobExecutionContext;
}) {
  const executionToken = executionTokenOf(input.executionContext);
  if (!executionToken) return;
  await input.executionContext?.assertOwned();
  const released = await LotListing.updateOne(
    {
      _id: input.listingId,
      ...(input.generationToken ? { job_id: input.generationToken } : {}),
      job_execution_token: executionToken,
    },
    { $unset: { job_execution_token: 1 } }
  );
  if (released.matchedCount !== 1) {
    throw new LotListingJobExecutionLostError(input.listingId);
  }
}

export async function regenerateLotListingFiles(input: RegenerateLotListingInput): Promise<any> {
  const generationToken = String(input.generationToken || input.jobId || "").trim();
  const normalizedInput: RegenerateLotListingInput = {
    ...input,
    ...(generationToken
      ? { generationToken, jobId: generationToken }
      : {}),
  };
  if (shouldUseMongoReportQueue()) {
    try {
      let queuedJob: any;
      if (input.reportJobOutboxToken) {
        queuedJob = await ensureReportJobOutbox(
          "lotListing",
          input.listingId,
          input.reportJobOutboxToken
        );
      } else {
        const listing = await LotListing.findById(input.listingId)
          .select("auctioneerWorkItem generation_target_status")
          .lean();
        const targetStatus = lotListingGenerationTarget(listing as any);
        queuedJob = await createMongoReportJob({
          ...lotListingFilesQueueInput(normalizedInput, targetStatus),
        });
      }
      const queuedToken = String(
        queuedJob?.payload?.generationToken ||
          queuedJob?.payload?.jobId ||
          queuedJob?.progressId ||
          ""
      ).trim();
      if (
        !queuedJob ||
        queuedJob.type !== "lot-listing-files" ||
        String(queuedJob.reportId || "") !== input.listingId ||
        String(queuedJob.payload?.listingId || "") !== input.listingId ||
        (generationToken &&
          (queuedToken !== generationToken ||
            String(queuedJob.progressId || "") !== generationToken))
      ) {
        throw Object.assign(
          new Error(
            "The durable Lot Listing job identity does not match this generation. Retry after the active job finishes."
          ),
          { code: "LOT_LISTING_JOB_IDENTITY_CONFLICT", statusCode: 409 }
        );
      }
      return queuedJob;
    } catch (error) {
      if ((error as any)?.code === "REPORT_JOB_IDENTITY_CONFLICT") {
        throw Object.assign(
          new Error(
            "The durable Lot Listing job identity conflicts with the persisted generation. Start a new generation after the active job finishes."
          ),
          {
            code: "LOT_LISTING_JOB_IDENTITY_CONFLICT",
            statusCode: 409,
          }
        );
      }
      throw error;
    }
  }

  enqueueReportJob(`lot-listing-regenerate:${input.listingId}`, async () => {
    await runRegenerateLotListingJob(normalizedInput).catch((e) => {
      console.error("LotListing regenerate job failed:", e);
    });
  });
  return undefined;
}

function lotListingFilesQueueInput(
  input: RegenerateLotListingInput,
  targetStatus: "pending_approval" | "approved"
) {
  const generationToken = String(input.generationToken || input.jobId || "").trim();
  const payload = {
    listingId: input.listingId,
    user: input.user,
    generationToken,
    jobId: generationToken,
    previewDataSnapshot: input.previewDataSnapshot,
  };
  return {
      type: "lot-listing-files" as const,
      reportId: input.listingId,
      progressId: generationToken || undefined,
      maxAttempts: 3,
      targetStatus,
      idempotencyKey: `lot-listing-files:${input.listingId}:${generationToken}`,
      payload,
  };
}

export function buildLotListingFilesJobOutbox(
  input: RegenerateLotListingInput,
  targetStatus: "pending_approval" | "approved"
): ReportJobOutbox {
  if (!String(input.generationToken || input.jobId || "").trim()) {
    throw new Error("Lot Listing file outbox requires a generation token");
  }
  return buildReportJobOutbox(lotListingFilesQueueInput(input, targetStatus));
}

function calculateLotListingTotalValue(lots: any[]): number {
  return (Array.isArray(lots) ? lots : []).reduce(
    (sum, lot) => sum + parseEstimatedValue(getLotEstimatedValueText(lot)),
    0
  );
}

function normalizeLotListingLotsForExport(lots: any[]): any[] {
  // Selections belong to structured CR fields. Descriptions are appraiser-owned;
  // generation must neither append summaries nor strip matching user text.
  return normalizeLotsForReportOrdering(
    Array.isArray(lots) ? lots : [],
    "per_item"
  ).map((lot) => ({
    ...lot,
    condition_report_selections: normalizeAssetConditionReportSelections(
      lot?.condition_report_selections
    ),
  }));
}

function applyLotListingExportDefaults(
  lots: any[],
  defaults: {
    location?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    lottedBy?: unknown;
    includeDamageAnalysis?: boolean;
  }
): any[] {
  const defaultLocation = cleanString(defaults.location);
  const defaultCoordinates = getExplicitCoordinates(defaults);
  const defaultLottedBy = cleanString(defaults.lottedBy);
  return (Array.isArray(lots) ? lots : []).map((lot) => {
    const lotCoordinates = getExplicitCoordinates(lot);
    const { latitude: _latitude, longitude: _longitude, ...lotWithoutCoordinates } = lot || {};
    return {
      ...lotWithoutCoordinates,
      quantity: lot?.quantity ?? 1,
      must_take: lot?.must_take ?? false,
      show_on_website: lot?.show_on_website ?? true,
      item_condition: lot?.item_condition || "Unverified Working Condition",
      ...(defaultLocation && !hasText(lot?.location)
        ? { location: defaultLocation }
        : {}),
      ...(lotCoordinates || defaultCoordinates || {}),
      ...(defaultLottedBy && !hasText(lot?.lotted_by)
        ? { lotted_by: defaultLottedBy }
        : {}),
    };
  });
}

const PREVIEW_EDITABLE_LOT_FIELDS = [
  "title",
  "details",
  "estimated_value",
  "quantity",
  "must_take",
  "categories",
  "serial_number",
  "show_on_website",
  "close_date",
  "bid_increment",
  "opening_bid",
  "item_condition",
  "condition_report_selections",
] as const;

function restoreEditedLotIdentity(lots: any[], sourceLots: any[]): any[] {
  if (!Array.isArray(lots) || lots.length === 0 || !Array.isArray(sourceLots)) {
    return lots;
  }

  const stableId = (lot: any) => cleanString(lot?.lot_id || lot?.id || lot?._id);
  const lotNumber = (lot: any) => cleanString(lot?.lot_number);
  const uniqueSources = (keyFor: (lot: any) => string) => {
    const sources = new Map<string, any>();
    const sourceCounts = new Map<string, number>();
    const outputCounts = new Map<string, number>();
    for (const source of sourceLots) {
      const key = keyFor(source);
      if (key) {
        sources.set(key, source);
        sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
      }
    }
    for (const lot of lots) {
      const key = keyFor(lot);
      if (key) outputCounts.set(key, (outputCounts.get(key) || 0) + 1);
    }
    return new Map([...sources].filter(([key]) =>
      sourceCounts.get(key) === 1 && outputCounts.get(key) === 1));
  };
  const byStableId = uniqueSources(stableId);
  const byLotNumber = uniqueSources(lotNumber);

  return lots.map((lot, index) => {
    if (!lot || typeof lot !== "object") return lot;
    // Legacy/generated ids can repeat. Never restore the final sibling's fields
    // over all siblings; use an unchanged unique lot number, or retain this lot.
    const sourceLot = byStableId.get(stableId(lot)) || byLotNumber.get(lotNumber(lot));
    if (!sourceLot) return lot;
    const editedLotNumber = cleanString(sourceLot?.lot_number);
    const editedLotId = cleanString(sourceLot?.lot_id);
    const hasEditedDamageAnalysis = Object.prototype.hasOwnProperty.call(
      sourceLot || {},
      "damage_analysis"
    );
    const editedDeletedSpecs = mergeDeletedSpecFields(
      lot.condition_report_specs_deleted,
      sourceLot?.condition_report_specs_deleted
    );
    const editedSpecs = sourceLot?.condition_report_specs_reviewed === true
      ? sourceLot.condition_report_specs
      : mergeConditionReportSpecsPreservingEdited(
          lot.condition_report_specs,
          sourceLot?.condition_report_specs,
          editedDeletedSpecs || []
        );
    const editedCustomSpecOrder = Array.isArray(sourceLot?.condition_report_specs_custom_order)
      ? sourceLot.condition_report_specs_custom_order
      : undefined;
    const editedFields = Object.fromEntries(
      PREVIEW_EDITABLE_LOT_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(sourceLot || {}, field))
        .map((field) => [field, sourceLot[field]])
    );
    const hasEditedDescription = Object.prototype.hasOwnProperty.call(
      sourceLot || {},
      "description"
    );
    const restoredLot = {
      ...lot,
      ...editedFields,
      ...(editedLotId ? { lot_id: editedLotId } : {}),
      ...(editedLotNumber ? { lot_number: editedLotNumber } : {}),
      ...(hasEditedDescription ? { description: sourceLot.description } : {}),
      ...(hasEditedDamageAnalysis ? { damage_analysis: sourceLot.damage_analysis } : {}),
      ...(editedSpecs ? { condition_report_specs: editedSpecs } : {}),
      ...(sourceLot?.condition_report_specs_reviewed === true
        ? { condition_report_specs_reviewed: true } : {}),
      ...(sourceLot?.condition_report_specs_manual_overrides
        ? { condition_report_specs_manual_overrides: sourceLot.condition_report_specs_manual_overrides } : {}),
      ...(editedDeletedSpecs ? { condition_report_specs_deleted: editedDeletedSpecs } : {}),
      ...(editedCustomSpecOrder ? { condition_report_specs_custom_order: editedCustomSpecOrder } : {}),
    };
    return enforceLotDamageAnalysisPolicy(restoredLot, { fallbackLotNumber: index + 1 });
  });
}

function buildLotListingExportData(input: {
  contract_no?: unknown;
  sales_date?: unknown;
  location?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  inspector_name?: unknown;
  currency?: unknown;
  lots?: any[];
  videoUrls?: string[];
  total_value?: number;
  include_damage_analysis?: unknown;
  bank_photos_enabled?: unknown;
  watermark_images?: unknown;
  valuation_methods?: unknown;
  cr_disclaimers?: unknown;
  cr_disclaimers_by_lot?: unknown;
  deleted_image_indexes?: unknown;
}) {
  const includeDamageAnalysis = resolveIncludeDamageAnalysis(input.include_damage_analysis, true);
  const valuationMethods = normalizeValuationMethods(input.valuation_methods);
  const inputCoordinates = getExplicitCoordinates(input);
  const inspectorName = cleanString(input.inspector_name);
  const exportLots = enforceLotsDamageAnalysisPolicy(
    applyLotListingExportDefaults(Array.isArray(input.lots) ? input.lots : [], {
      location: input.location,
      latitude: input.latitude,
      longitude: input.longitude,
      lottedBy: inspectorName,
      includeDamageAnalysis,
    }),
    includeDamageAnalysis
  );
  return {
    contract_no: String(input.contract_no || ""),
    sales_date: input.sales_date,
    location: String(input.location || ""),
    ...(inputCoordinates || {}),
    inspector_name: inspectorName,
    grouping_mode: "per_item",
    lots: exportLots,
    videoUrls: Array.isArray(input.videoUrls) ? input.videoUrls : [],
    total_value:
      typeof input.total_value === "number"
        ? input.total_value
        : calculateLotListingTotalValue(input.lots || []),
    currency: String(input.currency || "CAD").toUpperCase(),
    include_damage_analysis: includeDamageAnalysis,
    bank_photos_enabled: input.bank_photos_enabled === true || input.bank_photos_enabled === "true",
    watermark_images: resolvePhotoWatermark(input.watermark_images),
    valuation_methods: valuationMethods,
    cr_disclaimers: input.cr_disclaimers,
    cr_disclaimers_by_lot: input.cr_disclaimers_by_lot,
    deleted_image_indexes: Array.isArray(input.deleted_image_indexes)
      ? input.deleted_image_indexes
      : [],
  };
}

async function generateLotListingFiles(
  reportData: any,
  imageUrls: string[],
  options: { includeMediaArchive?: boolean } = {},
) {
  // Keep the two image-heavy CR generators out of each other's memory peak.
  // The report worker already supplies throughput across independent reports.
  const xlsxBuffer = await generateLotListingXlsxFromReport(reportData);
  const specPdfBuffer = await generateAuctioneerSpecSheetPdfFromReport({
    ...reportData,
    imageUrls,
  }).catch((error) => {
    console.error("[LotListing] CR generation failed; continuing with Excel/images:", error);
    return undefined as Buffer | undefined;
  });
  const crDocxBuffer = await generateAuctioneerSpecSheetDocxFromReport({
    ...reportData,
    imageUrls,
  }).catch((error) => {
    console.error("[LotListing] CR DOCX generation failed; continuing with Excel/images:", error);
    return undefined as Buffer | undefined;
  });
  const includeMediaArchive = options.includeMediaArchive !== false;
  if (!includeMediaArchive) {
    return {
      xlsxBuffer,
      specPdfBuffer,
      crDocxBuffer,
      imagesZip: undefined as Buffer | undefined,
    };
  }

  const { urlRenameMap } = buildLotImageNameMaps(reportData.lots || [], imageUrls);
  const orderedEntries = buildOrderedLotImageZipEntries(
    reportData.lots || [],
    imageUrls,
    reportData?.deleted_image_indexes,
    reportData?.deleted_image_urls
  );
  const activeImageUrls = orderedEntries.map((entry) => entry.url);
  const activeFilenames = orderedEntries.map((entry) => entry.filename);
  const orderedVideos = buildOrderedLotVideoZipEntries(
    reportData.lots || [],
    reportData.videoUrls || []
  );
  const imagesZip = await generateImagesZip(activeImageUrls, urlRenameMap, {
    optimizeSize: true,
    maxSizeKB: 500,
    // imageUrls already point at the normalized/watermarked report media. A
    // second watermark pass is expensive for large reports and visibly stacks
    // the logo when a ZIP is regenerated.
    watermark: false,
    filenames: activeFilenames,
    rawFiles: orderedVideos.map(({ url, filename }) => ({ url, filename })),
  });

  return { xlsxBuffer, specPdfBuffer, crDocxBuffer, imagesZip };
}

function resolveInitialImageConcurrency(imageCount: number): number {
  const configured = getPositiveIntEnv("ASSET_IMAGE_UPLOAD_CONCURRENCY", 8);
  // Sharp holds decoded pixels outside V8's heap. Large batches therefore need
  // a lower bound than ordinary multipart uploads to avoid process-level OOMs.
  const safeLimit = imageCount >= 300 ? 2 : imageCount >= 150 ? 3 : imageCount >= 75 ? 4 : 8;
  return Math.max(1, Math.min(configured, safeLimit));
}

function shouldBuildInitialDeliveryArtifacts(imageCount: number): boolean {
  const maxImages = getPositiveIntEnv(
    "LOT_LISTING_INITIAL_FULL_ARTIFACT_MAX_IMAGES",
    200,
  );
  return imageCount <= maxImages;
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    )
  );
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function hasText(value: unknown): boolean {
  return cleanString(value).length > 0;
}

function normalizeValuationMethods(
  value: unknown,
  fallback: LotListingValuationMethod[] = ["FML"]
): LotListingValuationMethod[] {
  const normalized = normalizeLotListingValuationMethods(value, fallback);
  if (normalized.length > 0) return normalized;
  return normalizeLotListingValuationMethods(undefined, fallback);
}

function resolveIncludeDamageAnalysis(value: unknown, fallback = true): boolean {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasStructuredSpecs(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function structuredSpecsToRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const field = cleanString(entry.field ?? entry.name ?? entry.label ?? entry.key);
      const rawValue = cleanString(entry.value ?? entry.text ?? entry.result);
      if (field && isUsefulExportText(rawValue)) out[field] = rawValue;
    }
    return out;
  }
  if (isPlainObject(value)) {
    for (const [field, rawValue] of Object.entries(value)) {
      const cleanField = cleanString(field);
      const cleanValue = cleanString(rawValue);
      if (cleanField && isUsefulExportText(cleanValue)) out[cleanField] = cleanValue;
    }
  }
  return out;
}

function mergeConditionReportSpecs(existing: unknown, incoming: unknown): Record<string, string> | undefined {
  const existingRecord = structuredSpecsToRecord(existing);
  const incomingRecord = structuredSpecsToRecord(incoming);
  const merged: Record<string, string> = { ...existingRecord };
  const usedKeys = new Set(Object.keys(merged).map(normalizeRegistryKey));

  for (const [field, value] of Object.entries(incomingRecord)) {
    const key = normalizeRegistryKey(field);
    if (!key || usedKeys.has(key)) continue;
    merged[field] = value;
    usedKeys.add(key);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function structuredSpecsToRawRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const field = cleanString(entry.field ?? entry.name ?? entry.label ?? entry.key);
      if (!field) continue;
      out[field] = String(entry.value ?? entry.text ?? entry.result ?? "");
    }
    return out;
  }
  if (isPlainObject(value)) {
    for (const [field, rawValue] of Object.entries(value)) {
      const cleanField = cleanString(field);
      if (!cleanField) continue;
      out[cleanField] = String(rawValue ?? "");
    }
  }
  return out;
}

/**
 * Overlays the appraiser's edited specs on the generated ones, then removes
 * every field the appraiser deliberately deleted. Starting from the generated
 * record is what let an enricher's value survive an overlay that simply never
 * mentioned it; this tombstone pass is the last line of defence before the lot
 * is persisted, and it matches label variants the same way the renderers do
 * (auctioneerSpecFieldAliases). A reviewed spec list does not come through
 * here: restoreEditedLotIdentity keeps it as the appraiser left it.
 */
export function mergeConditionReportSpecsPreservingEdited(
  generated: unknown,
  edited: unknown,
  deletedFields: readonly string[] = []
): Record<string, string> | undefined {
  const generatedRecord = structuredSpecsToRawRecord(generated);
  const editedRecord = structuredSpecsToRawRecord(edited);
  const merged: Record<string, string> = { ...generatedRecord };

  for (const [field, value] of Object.entries(editedRecord)) {
    const key = normalizeRegistryKey(field);
    if (!key) continue;
    const existingKey = Object.keys(merged).find(
      (candidate) => normalizeRegistryKey(candidate) === key
    );
    if (existingKey && existingKey !== field) delete merged[existingKey];
    merged[field] = value;
  }

  const deletedKeys = new Set(
    deletedFields
      .flatMap((field) => auctioneerSpecFieldAliases(field))
      .map(normalizeRegistryKey)
      .filter(Boolean)
  );
  if (deletedKeys.size > 0) {
    for (const field of Object.keys(merged)) {
      const aliases = auctioneerSpecFieldAliases(field).map(normalizeRegistryKey);
      if (aliases.some((alias) => deletedKeys.has(alias))) delete merged[field];
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeDeletedSpecFields(value: unknown): string[] {
  const fields: string[] = [];
  if (Array.isArray(value)) {
    for (const field of value) {
      const text = cleanString(field);
      if (text) fields.push(text);
    }
  } else if (isPlainObject(value)) {
    for (const [field, deleted] of Object.entries(value)) {
      if (!deleted) continue;
      const text = cleanString(field);
      if (text) fields.push(text);
    }
  }
  return fields;
}

export function mergeDeletedSpecFields(generated: unknown, edited: unknown): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const field of [
    ...normalizeDeletedSpecFields(generated),
    ...normalizeDeletedSpecFields(edited),
  ]) {
    const key = normalizeRegistryKey(field);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(field);
  }
  return merged.length > 0 ? merged : undefined;
}

function isPlaceholderTitle(value: unknown): boolean {
  const normalized = cleanString(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
  return (
    /^lot \d+$/.test(normalized) ||
    /^item \d+$/.test(normalized) ||
    /^lot \d+ image \d+$/.test(normalized)
  );
}

function chooseText(existing: unknown, incoming: unknown, options?: { replacePlaceholder?: boolean }): string | undefined {
  const existingText = cleanString(existing);
  const incomingText = cleanString(incoming);
  if (
    existingText &&
    !(options?.replacePlaceholder && isPlaceholderTitle(existingText))
  ) {
    return existingText;
  }
  return incomingText || existingText || undefined;
}

function chooseValue<T>(existing: T | undefined | null, incoming: T | undefined | null): T | undefined {
  if (existing !== undefined && existing !== null && cleanString(existing) !== "") {
    return existing;
  }
  if (incoming !== undefined && incoming !== null && cleanString(incoming) !== "") {
    return incoming;
  }
  return existing ?? incoming ?? undefined;
}

function chooseUsefulText(
  existing: unknown,
  incoming: unknown,
  options?: { replacePlaceholder?: boolean }
): string | undefined {
  const existingText = cleanString(existing);
  const incomingText = cleanString(incoming);
  const existingIsUseful =
    existingText &&
    isUsefulExportText(existingText) &&
    !(options?.replacePlaceholder && isPlaceholderTitle(existingText));
  if (existingIsUseful) return existingText;
  return incomingText || existingText || undefined;
}

function chooseEstimatedValue(existing: unknown, incoming: unknown): string | undefined {
  const existingText = cleanString(existing);
  const incomingText = cleanString(incoming);
  if (existingText && !isEstimatedValueMissing(existingText)) return existingText;
  if (incomingText && !isEstimatedValueMissing(incomingText)) return incomingText;
  return existingText || incomingText || undefined;
}

function chooseCategory(existing: unknown, incoming: unknown): string | undefined {
  const existingText = cleanString(existing);
  const incomingText = cleanString(incoming);
  const existingKey = normalizeRegistryKey(existingText);
  if (existingText && existingKey !== "other" && existingKey !== "uncategorized") {
    return existingText;
  }
  return incomingText || existingText || undefined;
}

function chooseBoolean(existing: unknown, incoming: unknown, fallback?: boolean): boolean | undefined {
  if (typeof existing === "boolean") return existing;
  if (typeof incoming === "boolean") return incoming;
  return fallback;
}

function getLotAnalysisUrls(lot: any, allImageUrls: string[]): string[] {
  const imageIndexes = [
    ...(Array.isArray(lot?.image_indexes) ? lot.image_indexes : []),
    ...(Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []),
  ];
  const urlsFromIndexes = imageIndexes
    .map((index) => {
      const numericIndex = Number(index);
      return Number.isInteger(numericIndex) ? allImageUrls[numericIndex] : "";
    })
    .filter(Boolean);
  return uniqueStrings([
    ...urlsFromIndexes,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ]);
}

function getLotMainAnalysisUrls(lot: any, allImageUrls: string[]): string[] {
  const urlsFromIndexes = (Array.isArray(lot?.image_indexes)
    ? lot.image_indexes
    : []
  )
    .map((index: unknown) => {
      const numericIndex = Number(index);
      return Number.isInteger(numericIndex) ? allImageUrls[numericIndex] : "";
    })
    .filter(Boolean);
  return uniqueStrings([
    ...urlsFromIndexes,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
  ]);
}

function mergeAssetAiLotIntoLot(lot: any, assetLot: any) {
  if (!assetLot) return lot;

  const tags = uniqueStrings([
    ...(Array.isArray(lot?.tags) ? lot.tags : []),
    ...(Array.isArray(assetLot?.tags) ? assetLot.tags : []),
    lot?.sub_mode ? `mode:${lot.sub_mode}` : "",
  ]);

  return {
    ...lot,
    lot_number: chooseValue(lot.lot_number, assetLot.lot_number),
    title: chooseText(lot.title, assetLot.title, { replacePlaceholder: true }),
    description: chooseText(lot.description, assetLot.description) || "",
    details: chooseText(lot.details, assetLot.details ?? assetLot.condition) ?? null,
    damage_analysis: chooseText(lot.damage_analysis, assetLot.damage_analysis) ?? null,
    condition_report_specs: mergeConditionReportSpecs(
      lot.condition_report_specs,
      assetLot.condition_report_specs
    ),
    lotted_by: chooseText(lot.lotted_by, assetLot.lotted_by),
    estimated_value: chooseEstimatedValue(
      getLotEstimatedValueText(lot),
      assetLot.estimated_value ?? assetLot.fmv ?? assetLot.fair_market_value
    ),
    quantity: chooseValue(lot.quantity, assetLot.quantity) ?? 1,
    must_take: chooseBoolean(lot.must_take, assetLot.must_take, false),
    categories: chooseCategory(
      lot.categories,
      assetLot.categories ?? assetLot.category ?? assetLot.child_category
    ),
    serial_number:
      chooseUsefulText(
        lot.serial_number,
        assetLot.serial_number ?? assetLot.serial_no_or_label ?? assetLot.sn_vin
      ),
    show_on_website: chooseBoolean(lot.show_on_website, assetLot.show_on_website, true),
    close_date: chooseText(lot.close_date, assetLot.close_date),
    bid_increment: chooseValue(lot.bid_increment, assetLot.bid_increment),
    location: chooseText(lot.location, assetLot.location),
    opening_bid: chooseValue(lot.opening_bid, assetLot.opening_bid),
    latitude: chooseValue(lot.latitude, assetLot.latitude),
    longitude: chooseValue(lot.longitude, assetLot.longitude),
    item_condition:
      chooseText(lot.item_condition, assetLot.item_condition ?? assetLot.condition) ||
      "Unverified Working Condition",
    tags,
  };
}

function normalizeRegistryKey(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveCategorySpec(category: unknown) {
  const key = normalizeRegistryKey(category);
  return assetCategorySpecs.find((spec) => normalizeRegistryKey(spec.childCategory) === key);
}

function isUsefulExportText(value: unknown): boolean {
  const text = cleanString(value);
  return (
    !!text &&
    !/^(n\/a|na|none|null|unknown|not found|not visible)$/i.test(text) &&
    !isBoilerplateAuctionText(text)
  );
}

function isBoilerplateAuctionText(value: unknown): boolean {
  const text = cleanString(value);
  return (
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text)
  );
}

function hasSpecMatchingGroup(
  specs: Record<string, string>,
  matchers: RegExp[],
  directValues: unknown[] = []
): boolean {
  if (directValues.some(isUsefulExportText)) return true;
  return Object.entries(specs).some(([field, value]) => {
    if (!isUsefulExportText(value)) return false;
    const key = normalizeRegistryKey(field);
    return matchers.some((matcher) => matcher.test(key));
  });
}

function lotMissingKeyExportSpecs(lot: any): boolean {
  const spec = resolveCategorySpec(lot?.categories);
  if (!spec?.fields?.length) return !hasStructuredSpecs(lot?.condition_report_specs);

  const specFieldText = spec.fields.map(normalizeRegistryKey).join(" ");
  const specs = structuredSpecsToRecord(lot?.condition_report_specs);
  const groups: Array<{ name: string; matchers: RegExp[]; directValues?: unknown[] }> = [
    { name: "serial", matchers: [/serial/, /\bvin\b/, /\bsn\b/], directValues: [lot?.serial_number, lot?.serial_no_or_label, lot?.sn_vin] },
    { name: "mileage", matchers: [/mileage/, /odometer/] },
    { name: "engine", matchers: [/engine/] },
    { name: "transmission", matchers: [/transmission/] },
    { name: "drive", matchers: [/drive/] },
    { name: "fuel", matchers: [/fuel/] },
    { name: "color", matchers: [/colour/, /color/] },
    { name: "door", matchers: [/door/] },
  ];
  const relevantGroups = groups.filter((group) =>
    group.matchers.some((matcher) => matcher.test(specFieldText))
  );
  if (relevantGroups.length === 0) return !hasStructuredSpecs(lot?.condition_report_specs);

  const filledCount = relevantGroups.filter((group) =>
    hasSpecMatchingGroup(specs, group.matchers, group.directValues || [])
  ).length;
  const serialGroup = relevantGroups.find((group) => group.name === "serial");
  const missingSerial = serialGroup
    ? !hasSpecMatchingGroup(specs, serialGroup.matchers, serialGroup.directValues || [])
    : false;

  return missingSerial || filledCount < Math.min(4, relevantGroups.length);
}

function lotNeedsFieldCompletion(lot: any, includeDamageAnalysis: boolean): boolean {
  const lotDamageAnalysisRequired =
    includeDamageAnalysis && isLotRecordDamageAnalysisEligible(lot);
  return (
    !hasText(lot?.title) ||
    isPlaceholderTitle(lot?.title) ||
    isEstimatedValueMissing(getLotEstimatedValueText(lot)) ||
    !hasText(lot?.categories) ||
    !hasText(lot?.description) ||
    !hasText(lot?.item_condition) ||
    !hasStructuredSpecs(lot?.condition_report_specs) ||
    lotMissingKeyExportSpecs(lot) ||
    (lotDamageAnalysisRequired && !hasText(lot?.damage_analysis))
  );
}

const lotExportCompletionSchema = {
  type: "object" as const,
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    details: { type: ["string", "null"] },
    estimated_value: { type: "string" },
    categories: { type: "string", enum: allowedCategories },
    serial_number: { type: ["string", "null"] },
    item_condition: { type: "string" },
    condition_report_specs: {
      type: "array",
      items: {
        type: "object" as const,
        properties: {
          field: { type: "string" },
          value: { type: "string" },
        },
        required: ["field", "value"],
        additionalProperties: false,
      },
    },
    damage_analysis: { type: ["string", "null"] },
  },
  required: [
    "title",
    "description",
    "details",
    "estimated_value",
    "categories",
    "serial_number",
    "item_condition",
    "condition_report_specs",
    "damage_analysis",
  ],
  additionalProperties: false,
};

const lotFmvCompletionSchema = {
  type: "object" as const,
  properties: {
    estimated_value: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    basis: { type: "string" },
  },
  required: ["estimated_value", "confidence", "basis"],
  additionalProperties: false,
};

function buildFocusedCompletionInstructions(input: {
  lot: any;
  currency: string;
  language: string;
  includeDamageAnalysis: boolean;
  valuationMethods: string[];
  preservePhotoEndpoints?: boolean;
}): string {
  const includeLotDamageAnalysis =
    input.includeDamageAnalysis && isLotRecordDamageAnalysisEligible(input.lot);
  const existingCategory = cleanString(input.lot?.categories);
  const spec = resolveCategorySpec(existingCategory);
  const specFields = spec?.fields?.length
    ? spec.fields
    : [
        "Serial Number",
        "Showing Mileage",
        "Showing Hours",
        "Engine",
        "Fuel Type",
        "Transmission Type",
        "Drive Type",
        "Colour",
        "Door Count",
        "Other Details",
      ];

  return [
    "You complete auction lot export fields for Asset Insight.",
    `Language: ${input.language}. Currency: ${input.currency}.`,
    `Selected valuation methods: ${input.valuationMethods.join(", ")}.`,
    "For the Excel FMV cell, use FML/FMV if selected. If FML is not selected, use the first selected valuation method as the per-lot auction value. Do not create a valuation comparison table.",
    "FMV is an appraisal estimate, not a visible label. Estimate a practical auction value from the asset type, apparent condition, age/model clues, mileage/hours, visible specifications, and market judgment.",
    "Do not return zero, blank, TBD, unknown, or N/A for estimated_value. If confidence is low, still provide a conservative non-zero auction estimate.",
    "For serial/VIN and structured specs, return visible/provided values when available. Missing category specs will be completed by the shared VIN/web enrichment pipeline.",
    ...(input.preservePhotoEndpoints
      ? ["The first supplied photo is the lot-number reference; the last supplied photo is the serial/VIN reference. Keep the existing lot number. Read serial/VIN only from clear visible evidence, never from the lot-number sticker."]
      : []),
    `estimated_value is required and must never be blank. If exact value is uncertain, provide a conservative auction FMV estimate in ${input.currency}.`,
    "categories must be one exact child category from the schema enum. Prefer the existing category if it is correct. If the item is a sea can, storage container, cargo container, shipping container, or similar container, use the Auctioneer Import Shipping Containers category instead of a car/vehicle category.",
    `description must be one or two plain sentences, maximum ${AUCTION_DESCRIPTION_MAX_LENGTH} characters, saying what the item is and what comes with it (key features, attachments, inclusions). It must not repeat the title; title and description are separate fields. Keep individual spec values in condition_report_specs. Do not include Running Condition, Condition, Completeness, Legal, VIN, or serial text. Do not start with numbering, bullets, "Lot", "Lot #", or "#".`,
    "condition_report_specs must be structured field/value pairs using exact labels from this category. Return the visible or confidently inferable values from these fields in order; do not try to exhaust every missing field in this focused repair:",
    specFields.map((field) => `- ${field}`).join("\n"),
    "If a condition_report_specs value would only say something is visible, return \"Yes\". If it would only say something is not visible, return \"No\".",
    "Do not include Condition/Completeness/Legal radio selections in condition_report_specs.",
    includeLotDamageAnalysis
      ? "damage_analysis is required when visible. Summarize damage briefly."
      : input.includeDamageAnalysis
        ? "damage_analysis must be null because the numeric portion of this lot number is above 1000."
        : "damage_analysis must be null because the user disabled damage analysis.",
    "Preserve useful existing wording and do not invent serial numbers/VINs. Use null when serial/VIN is not visible.",
  ].join("\n\n");
}

async function completeLotFmvWithAI(input: {
  lot: any;
  urls: string[];
  language: "en" | "fr" | "es";
  currency: string;
  valuationMethods: string[];
  preservePhotoEndpoints?: boolean;
}): Promise<string | null> {
  const imageInputs: any[] = [];
  const urls = input.preservePhotoEndpoints
    ? selectImagesPreservingEndpoints(input.urls, 8)
    : input.urls.slice(0, 8);
  for (const [imageIndex, url] of urls.entries()) {
    try {
      const { base64, mime } = await imageUrlToBase64WithMime(url);
      imageInputs.push({
        type: "input_image",
        image_url: `data:${mime};base64,${base64}`,
        detail: "auto",
      });
    } catch (error) {
      // Losing a reference photo would make the surviving first/last image
      // appear to be that reference. Fail this pass instead of relabeling it.
      if (
        input.preservePhotoEndpoints &&
        (imageIndex === 0 || imageIndex === urls.length - 1)
      ) throw error;
      console.warn(`[LotListing] Failed to prepare valuation image for lot ${input.lot?.lot_number || ""}:`, error);
    }
  }

  const currentLot = {
    lot_number: input.lot?.lot_number,
    title: input.lot?.title,
    description: input.lot?.description,
    details: input.lot?.details,
    estimated_value: getLotEstimatedValueText(input.lot),
    categories: input.lot?.categories,
    serial_number: input.lot?.serial_number,
    item_condition: input.lot?.item_condition,
    condition_report_specs: input.lot?.condition_report_specs,
    damage_analysis: input.lot?.damage_analysis,
    condition_report_selections: input.lot?.condition_report_selections,
  };

  const response = await openai.responses.create({
    model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
    reasoning: { effort: "low" },
    instructions: [
      "You are an auction appraiser completing a required FMV cell for a Lot Listing Excel export.",
      `Language: ${input.language}. Currency: ${input.currency}.`,
      `Selected valuation methods: ${input.valuationMethods.join(", ")}.`,
      "Return one conservative non-zero per-lot auction value. Use FML/FMV if selected; otherwise use the first selected valuation method.",
      "This is an estimate from the asset identity, visible condition, specs, mileage/hours, damage, and market judgment. The value does not need to be printed on the asset.",
      "Never return 0, blank, unknown, TBD, N/A, or a range. Return a single formatted value such as CAD 18,500.",
      "If confidence is low, still estimate conservatively and explain the basis briefly.",
    ].join("\n\n"),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Estimate the missing FMV for this Lot Listing lot. Existing lot JSON:\n${JSON.stringify(currentLot, null, 2)}`,
          },
          ...imageInputs,
        ],
      },
    ] as any,
    text: {
      format: {
        type: "json_schema",
        name: "lot_listing_fmv_completion",
        strict: true,
        schema: lotFmvCompletionSchema,
      },
    },
  } as any);

  const content = response?.output_text?.trim();
  if (!content) return null;
  const parsed = JSON.parse(content);
  const estimated = cleanString(parsed?.estimated_value);
  return estimated && !isEstimatedValueMissing(estimated) ? estimated : null;
}

async function completeLotExportFieldsWithAI(input: {
  lot: any;
  urls: string[];
  language: "en" | "fr" | "es";
  currency: string;
  includeDamageAnalysis: boolean;
  valuationMethods: string[];
  preservePhotoEndpoints?: boolean;
}): Promise<any | null> {
  const imageInputs: any[] = [];
  const urls = input.preservePhotoEndpoints
    ? selectImagesPreservingEndpoints(input.urls, 12)
    : input.urls.slice(0, 12);
  for (const [imageIndex, url] of urls.entries()) {
    try {
      const { base64, mime } = await imageUrlToBase64WithMime(url);
      imageInputs.push({
        type: "input_image",
        image_url: `data:${mime};base64,${base64}`,
        detail: "auto",
      });
    } catch (error) {
      if (
        input.preservePhotoEndpoints &&
        (imageIndex === 0 || imageIndex === urls.length - 1)
      ) throw error;
      console.warn(`[LotListing] Failed to prepare repair image for lot ${input.lot?.lot_number || ""}:`, error);
    }
  }

  if (imageInputs.length === 0) return null;

  const currentLot = {
    lot_number: input.lot?.lot_number,
    title: input.lot?.title,
    description: input.lot?.description,
    details: input.lot?.details,
    estimated_value: getLotEstimatedValueText(input.lot),
    categories: input.lot?.categories,
    serial_number: input.lot?.serial_number,
    item_condition: input.lot?.item_condition,
    condition_report_specs: input.lot?.condition_report_specs,
    damage_analysis: input.lot?.damage_analysis,
    condition_report_selections: input.lot?.condition_report_selections,
  };

  const response = await openai.responses.create({
    model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
    reasoning: { effort: "low" },
    instructions: buildFocusedCompletionInstructions(input),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Complete the missing Lot Listing export fields for this lot. Existing lot JSON:\n${JSON.stringify(currentLot, null, 2)}`,
          },
          ...imageInputs,
        ],
      },
    ] as any,
    text: {
      format: {
        type: "json_schema",
        name: "lot_listing_export_completion",
        strict: true,
        schema: lotExportCompletionSchema,
      },
    },
  } as any);

  const content = response?.output_text?.trim();
  if (!content) return null;
  return normalizeAssetAiLot(JSON.parse(content));
}

function applyFinalLotExportFallbacks(lot: any, currency: string): any {
  const textSource = [lot?.title, lot?.description, lot?.details]
    .map(cleanString)
    .filter(Boolean)
    .join(", ");
  const titleFallback =
    cleanString(lot?.title) ||
    cleanString(lot?.description).replace(/^\s*\d+\.\s*/, "").split(",")[0] ||
    `Lot ${lot?.lot_number || ""}`.trim();

  const categoryFallback =
    cleanString(lot?.categories) ||
    (normalizeRegistryKey(textSource).includes("sportutilityvehicle")
      ? "Sport Utility Vehicle"
      : allowedCategories.includes("Other")
        ? "Other"
        : allowedCategories[0]);

  return {
    ...lot,
    title: titleFallback,
    description: cleanString(lot?.description) || titleFallback,
    estimated_value: isEstimatedValueMissing(getLotEstimatedValueText(lot))
      ? `${currency} 0`
      : getLotEstimatedValueText(lot),
    categories: categoryFallback,
    item_condition: cleanString(lot?.item_condition) || "Unverified Working Condition",
    tags: uniqueStrings([
      ...(Array.isArray(lot?.tags) ? lot.tags : []),
      ...(isEstimatedValueMissing(getLotEstimatedValueText(lot)) ? ["needs_value_review"] : []),
    ]),
  };
}

type NormalizedLotListingGroup = {
  count: number;
  extraCount: number;
  videoCount: number;
  coverIndex: number;
  mode: LotListingMode;
  sourceKey?: string;
  /** Set when this lot was split out of a Schedule A line — see delivery. */
  sourceParentKey?: string;
  /**
   * The Auctioneer lot of the Schedule A item an unknown-work lot was linked
   * to (owner 2026-10-28); copied unchanged onto every lot of the group.
   */
  scheduleAParentLotId?: string;
  reviewedLotNumber?: string;
};

function normalizeLotListingGroups(
  mixedLots: unknown,
  totalImages: number,
  allowReviewedNumbers = false,
): NormalizedLotListingGroup[] {
  const rawLots = Array.isArray(mixedLots) ? mixedLots : [];
  if (rawLots.length > 0) {
    assertMixedLotPhotoManifest(rawLots, totalImages, { allowMissingMode: true });
  }
  const requested = rawLots
    .map((lot: any): NormalizedLotListingGroup | null => {
      const count = Math.max(0, parseInt(String(lot?.count ?? 0), 10) || 0);
      const extraCount = Math.max(
        0,
        parseInt(String(lot?.extra_count ?? lot?.extraCount ?? 0), 10) || 0
      );
      const videoCount = Math.max(
        0,
        parseInt(String(lot?.video_count ?? lot?.videoCount ?? 0), 10) || 0
      );
      const rawMode = String(lot?.mode || "").trim();
      const mode: LotListingMode =
        rawMode === "per_item" || rawMode === "per_photo" || rawMode === "single_lot"
          ? (rawMode as LotListingMode)
          : "single_lot";
      const coverIndex = Math.max(
        0,
        parseInt(String(lot?.cover_index ?? lot?.coverIndex ?? 0), 10) || 0
      );
      const sourceKey =
        typeof lot?.source_key === "string"
          ? lot.source_key.trim() || undefined
          : undefined;
      const sourceParentKey =
        typeof lot?.source_parent_key === "string"
          ? lot.source_parent_key.trim() || undefined
          : undefined;
      const scheduleAParentLotId =
        typeof lot?.schedule_a_parent_lot_id === "string"
          ? lot.schedule_a_parent_lot_id.trim() || undefined
          : undefined;
      const reviewedLotNumber = allowReviewedNumbers
        ? normalizeDetectedBundleLotNumber(lot?.reviewed_lot_number)
        : null;
      return count > 0
        ? { count, extraCount, videoCount, coverIndex, mode, sourceKey, sourceParentKey,
          ...(scheduleAParentLotId ? { scheduleAParentLotId } : {}),
          ...(reviewedLotNumber ? { reviewedLotNumber } : {}) }
        : null;
    })
    .filter(Boolean) as NormalizedLotListingGroup[];

  if (requested.length === 0 && totalImages > 0) {
    return [{
      count: totalImages,
      extraCount: 0,
      videoCount: 0,
      coverIndex: 0,
      mode: "single_lot",
    }];
  }

  return requested;
}

function buildFallbackLotsForGroup(input: {
  mode: LotListingMode;
  groupIndex: number;
  mainIndexes: number[];
  extraIndexes: number[];
  coverIndex?: number;
  imageUrls: string[];
  currency: string;
  reason: string;
}): any[] {
  const mainUrls = input.mainIndexes.map((idx) => input.imageUrls[idx]).filter(Boolean);
  const extraUrls = input.extraIndexes.map((idx) => input.imageUrls[idx]).filter(Boolean);
  const common = {
    description: input.reason,
    details: input.reason,
    estimated_value: `${input.currency} 0`,
    damage_analysis: undefined,
    quantity: 1,
    must_take: false,
    show_on_website: true,
    item_condition: "Unverified Working Condition",
    sub_mode: input.mode,
    tags: [`mode:${input.mode}`, "needs_review"],
  };

  if (input.mode === "single_lot") {
    const coverGlobalIndex =
      input.mainIndexes[Math.min(input.coverIndex || 0, input.mainIndexes.length - 1)];
    return [
      {
        ...common,
        title: `Lot ${input.groupIndex + 1}`,
        image_url: input.imageUrls[coverGlobalIndex] || mainUrls[0],
        image_indexes: input.mainIndexes,
        image_urls: mainUrls,
        extra_image_indexes: input.extraIndexes,
        extra_image_urls: extraUrls,
      },
    ];
  }

  return input.mainIndexes.map((globalIndex, localIndex) => ({
    ...common,
    title: `Lot ${input.groupIndex + 1}${input.mainIndexes.length > 1 ? ` Image ${localIndex + 1}` : ""}`,
    image_indexes: [globalIndex],
    image_urls: input.imageUrls[globalIndex] ? [input.imageUrls[globalIndex]] : [],
    extra_image_indexes: localIndex === 0 ? input.extraIndexes : [],
    extra_image_urls: localIndex === 0 ? extraUrls : [],
  }));
}

function mapAssetLotImagesToGlobal(input: {
  assetLot: any;
  mode: LotListingMode;
  resultIndex: number;
  aiLocalIndexes: number[];
  mainIndexes: number[];
  extraIndexes: number[];
  imageUrls: string[];
  attachExtra: boolean;
}): any {
  const { assetLot, mode, resultIndex, aiLocalIndexes, mainIndexes, extraIndexes, imageUrls } = input;
  const localIndexes: number[] = Array.isArray(assetLot?.image_indexes)
    ? Array.from(
        new Set<number>(
          assetLot.image_indexes
            .map((value: any) => parseInt(String(value), 10))
            .filter((value: number) => Number.isFinite(value) && value >= 0 && value < aiLocalIndexes.length)
        )
      )
    : [];
  const mappedIndexes = localIndexes.map((localIndex) => aiLocalIndexes[localIndex]);

  const directIndex = resolveGroupModelImageIndex(assetLot?.image_url, aiLocalIndexes, imageUrls);
  if (directIndex !== undefined) mappedIndexes.push(directIndex);

  let imageIndexes = Array.from(
    new Set(mappedIndexes.filter((value) => Number.isFinite(value) && value >= 0 && value < imageUrls.length))
  );

  if (mode === "single_lot") {
    imageIndexes = mainIndexes;
  } else if (imageIndexes.length === 0 && mainIndexes.length > 0) {
    imageIndexes = [mainIndexes[Math.min(resultIndex, mainIndexes.length - 1)]];
  } else if ((mode === "per_item" || mode === "per_photo") && imageIndexes.length > 1) {
    imageIndexes = [imageIndexes[0]];
  }

  const imageUrlsForLot = imageIndexes.map((idx) => imageUrls[idx]).filter(Boolean);
  const extraUrls = extraIndexes.map((idx) => imageUrls[idx]).filter(Boolean);
  return {
    image_indexes: imageIndexes,
    image_urls: imageUrlsForLot,
    image_url: imageUrlsForLot[0] || undefined,
    extra_image_indexes: input.attachExtra ? extraIndexes : [],
    extra_image_urls: input.attachExtra ? extraUrls : [],
  };
}

export async function analyzeLotListingGroupsWithAssetService(
  mixedLots: unknown,
  imageUrls: string[],
  videoUrls: string[],
  language: "en" | "fr" | "es",
  currency: string,
  includeDamageAnalysis: boolean,
  onGroupComplete?: (completed: number, total: number) => Promise<void> | void,
  onReadingLotNumbers?: (total: number) => Promise<void> | void,
  options: { groupingMethod?: "black_divider" | "lot_number" } = {},
): Promise<{ lots: any[]; analysis: AssetAnalysisResult & { lot_listing_mode: string } }> {
  const groups = normalizeLotListingGroups(mixedLots, imageUrls.length, options.groupingMethod === "lot_number");
  const analyzedLots: any[] = [];
  const analyses: any[] = [];
  const bundleDiagnosticsByGroup = new Map<
    number,
    BundleLotAnalysisDiagnostic
  >();
  const lotNumberPhotoInputs = buildBundleLotNumberPhotoInputs(groups, imageUrls);
  if (lotNumberPhotoInputs.length > 0) {
    await onReadingLotNumbers?.(lotNumberPhotoInputs.length);
    const detectedNumbers =
      await detectBundleLotNumbersFromPhotos(lotNumberPhotoInputs.filter((input) => !groups[input.groupIndex]?.reviewedLotNumber));
    const inputByGroup = new Map(
      lotNumberPhotoInputs.map((input) => [input.groupIndex, input]),
    );
    groups.forEach((group, groupIndex) => {
      if (group.mode !== "single_lot") return;
      bundleDiagnosticsByGroup.set(
        groupIndex,
        resolveBundleLotAnalysisPolicy({
          groupIndex,
          sourceImageIndex: inputByGroup.get(groupIndex)?.sourceImageIndex,
          detectedLotNumber: detectedNumbers.get(groupIndex),
          reviewedLotNumber: group.reviewedLotNumber,
          mainImageCount: group.count,
        }),
      );
    });
  }
  let base = 0;
  let videoBase = 0;
  const groupContexts = groups.map((group, groupIndex) => {
    const end = Math.min(imageUrls.length, base + group.count);
    const extraEnd = Math.min(imageUrls.length, end + group.extraCount);
    const mainIndexes = Array.from(
      { length: Math.max(0, end - base) },
      (_, idx) => base + idx,
    );
    const extraIndexes = Array.from(
      { length: Math.max(0, extraEnd - end) },
      (_, idx) => end + idx,
    );
    const context = {
      group,
      groupIndex,
      mainIndexes,
      extraIndexes,
      bundleDiagnostic: bundleDiagnosticsByGroup.get(groupIndex),
      groupVideoUrls: videoUrls.slice(videoBase, videoBase + group.videoCount),
    };
    base = extraEnd;
    videoBase += group.videoCount;
    return context;
  });

  let completedGroups = 0;
  const aiConcurrency = getPositiveIntEnv("LOT_LISTING_INITIAL_AI_CONCURRENCY", 3);
  const groupResults = await mapWithConcurrency(
    groupContexts,
    aiConcurrency,
    async (context) => {
      const {
        group,
        groupIndex,
        mainIndexes,
        extraIndexes,
        bundleDiagnostic,
        groupVideoUrls,
      } = context;
      const aiLocalIndexes =
        group.mode === "single_lot" && bundleDiagnostic
          ? selectBundleAnalysisImageIndexes(mainIndexes, bundleDiagnostic)
          : mainIndexes.slice(0, Math.min(50, mainIndexes.length));
      const subUrls = aiLocalIndexes.map((idx) => imageUrls[idx]).filter(Boolean);

      if (subUrls.length === 0) {
        completedGroups += 1;
        await onGroupComplete?.(completedGroups, groups.length);
        return null;
      }

      let groupLots: any[] = [];
      try {
        const aiRes = await analyzeAssetImages(
          subUrls,
          group.mode,
          language,
          currency,
          includeDamageAnalysis,
        );
        analyses[groupIndex] = {
          mode: group.mode,
          result: aiRes,
          ...(bundleDiagnostic
            ? { bundle_lot_number_detection: bundleDiagnostic }
            : {}),
        };
        const assetLots = Array.isArray(aiRes?.lots) ? aiRes.lots : [];
        groupLots = assetLots.map((assetLot, resultIndex) => {
          const imageFields = mapAssetLotImagesToGlobal({
            assetLot,
            mode: group.mode,
            resultIndex,
            aiLocalIndexes,
            mainIndexes,
            extraIndexes,
            imageUrls,
            attachExtra: resultIndex === 0,
          });
          if (group.mode === "single_lot" && mainIndexes.length > 0) {
            const coverGlobalIndex =
              mainIndexes[Math.min(group.coverIndex, mainIndexes.length - 1)];
            imageFields.image_url = imageUrls[coverGlobalIndex] || imageFields.image_url;
          }
          let mergedLot = mergeAssetAiLotIntoLot(
            {
              ...imageFields,
              title: `Lot ${groupIndex + resultIndex + 1}`,
              sub_mode: group.mode,
              tags: [`mode:${group.mode}`],
            },
            assetLot,
          );
          if (bundleDiagnostic) {
            mergedLot = applyAuthoritativeBundleLotNumber(
              {
                ...mergedLot,
                analysis_metadata: {
                  ...(mergedLot?.analysis_metadata || {}),
                  bundle_lot_number_detection: bundleDiagnostic,
                },
              },
              bundleDiagnostic,
            );
          }
          return mergedLot;
        });
      } catch (error) {
        console.warn(
          `[LotListing] Asset AI analysis failed for lot group ${groupIndex + 1} (${group.mode}):`,
          error,
        );
      }

      if (groupLots.length === 0) {
        groupLots = buildFallbackLotsForGroup({
          mode: group.mode,
          groupIndex,
          mainIndexes,
          extraIndexes,
          coverIndex: group.coverIndex,
          imageUrls,
          currency,
          reason: "Software analysis failed for this lot. Review and edit before approval.",
        });
      }

      completedGroups += 1;
      await onGroupComplete?.(completedGroups, groups.length);
      return { group, groupLots, groupVideoUrls, bundleDiagnostic };
    },
  );

  let lotCounter = 0;
  for (const result of groupResults) {
    if (!result) continue;
    const { group, groupLots, groupVideoUrls, bundleDiagnostic } = result;
    for (let groupLotIndex = 0; groupLotIndex < groupLots.length; groupLotIndex += 1) {
      const groupLot = markInitialLotNumberFallback(groupLots[groupLotIndex]);
      lotCounter += 1;
      const resolvedLotNumber =
        group.mode === "single_lot" && bundleDiagnostic
          ? bundleDiagnostic.resolvedLotNumber
          : hasText(groupLot.lot_number)
            ? groupLot.lot_number
            : lotCounter;
      const resultSourceKey =
        group.sourceKey && groupLots.length > 1
          ? `${group.sourceKey}:${groupLotIndex + 1}`
          : group.sourceKey;
      analyzedLots.push({
        ...groupLot,
        video_urls: groupLotIndex === 0 ? groupVideoUrls : [],
        lot_id: `lot-${String(lotCounter).padStart(3, "0")}`,
        lot_number: resolvedLotNumber,
        cover_index: groupLot.cover_index ?? group.coverIndex ?? 0,
        quantity: groupLot.quantity ?? 1,
        show_on_website: groupLot.show_on_website ?? true,
        item_condition: groupLot.item_condition || "Unverified Working Condition",
        ...(bundleDiagnostic
          ? {
              analysis_metadata: {
                ...(groupLot?.analysis_metadata || {}),
                bundle_lot_number_detection: bundleDiagnostic,
              },
            }
          : {}),
        ...(resultSourceKey ? { auctioneer_source_key: resultSourceKey } : {}),
        /*
           Carried unsplit. resultSourceKey gains a :n suffix when one group
           produces several lots, but the PARENT is the Schedule A line and does
           not subdivide — Auctioneer resolves commission from it, so a suffixed
           value would match no line and the submission would be refused.
        */
        ...(group.sourceParentKey
          ? { auctioneer_source_parent_key: group.sourceParentKey }
          : {}),
        ...(group.scheduleAParentLotId
          ? { schedule_a_parent_lot_id: group.scheduleAParentLotId }
          : {}),
      });
    }
  }

  return {
    lots: analyzedLots,
    analysis: {
      lot_listing_mode: "asset_openai_service_grouped_by_lot_listing_mode",
      lots: analyzedLots,
      summary: `${analyzedLots.length} lot listing row(s) analyzed with Asset OpenAI service.`,
      language,
      currency,
      lot_analyses: analyses.filter(Boolean),
      bundle_lot_number_detection: Array.from(
        bundleDiagnosticsByGroup.values(),
      ),
    } as any,
  };
}

export async function repairWeakLotListingLotsWithAssetService(
  lots: any[],
  imageUrls: string[],
  language: "en" | "fr" | "es",
  currency: string,
  includeDamageAnalysis: boolean,
  valuationMethods: string[],
  onLotComplete?: (completed: number, total: number) => Promise<void> | void
): Promise<{ lots: any[]; repairAnalyses: any[] }> {
  const aiConcurrency = getPositiveIntEnv("LOT_LISTING_AI_CONCURRENCY", 3);
  const repairAnalyses: any[] = [];
  let completedLots = 0;
  const markComplete = async () => {
    completedLots += 1;
    await onLotComplete?.(completedLots, lots.length);
  };
  const repairedLots = await mapWithConcurrency(
    Array.isArray(lots) ? lots : [],
    aiConcurrency,
    async (lot, index) => {
      const includeLotDamageAnalysis =
        includeDamageAnalysis && isLotRecordDamageAnalysisEligible(lot, index + 1);
      if (!lotNeedsFieldCompletion(lot, includeLotDamageAnalysis)) {
        await markComplete();
        return enforceLotDamageAnalysisPolicy(lot, {
          includeDamageAnalysis: includeLotDamageAnalysis,
          fallbackLotNumber: index + 1,
        });
      }
      const isBundleLot =
        lot?.sub_mode === "single_lot" ||
        (Array.isArray(lot?.tags) && lot.tags.includes("mode:single_lot"));
      const analysisLimit = isBundleLot
        ? getBundleLotAnalysisLimit(lot?.lot_number)
        : 30;
      // Report-only photos stay attached but never enter Bundle repair passes.
      // Reuse the initial Bundle selection, including its final serial/VIN photo.
      const urls = isBundleLot
        ? selectImagesPreservingEndpoints(
            getLotMainAnalysisUrls(lot, imageUrls),
            analysisLimit,
          )
        : getLotAnalysisUrls(lot, imageUrls).slice(0, analysisLimit);
      if (urls.length === 0) {
        await markComplete();
        return enforceLotDamageAnalysisPolicy(
          applyFinalLotExportFallbacks(lot, currency),
          {
            includeDamageAnalysis: includeLotDamageAnalysis,
            fallbackLotNumber: index + 1,
          }
        );
      }
      let repairedLot = lot;
      try {
        const aiRes = await analyzeAssetImages(
          urls,
          "single_lot",
          language,
          currency,
          includeLotDamageAnalysis
        );
        repairAnalyses[index] = aiRes;
        const assetLot = Array.isArray(aiRes?.lots) ? aiRes.lots[0] : null;
        repairedLot = mergeAssetAiLotIntoLot(repairedLot, assetLot);
      } catch (error) {
        console.warn(
          `[LotListing] Asset AI repair failed for lot ${lot?.lot_number || index + 1}:`,
          error
        );
      }

      if (lotNeedsFieldCompletion(repairedLot, includeLotDamageAnalysis)) {
        try {
          const completion = await completeLotExportFieldsWithAI({
            lot: repairedLot,
            urls,
            language,
            currency,
            includeDamageAnalysis,
            valuationMethods,
            preservePhotoEndpoints: isBundleLot,
          });
          repairAnalyses[index] = {
            ...(repairAnalyses[index] || {}),
            focused_completion: completion,
          };
          repairedLot = mergeAssetAiLotIntoLot(repairedLot, completion);
        } catch (error) {
          console.warn(
            `[LotListing] Focused export completion failed for lot ${lot?.lot_number || index + 1}:`,
            error
          );
        }
      }

      if (isEstimatedValueMissing(getLotEstimatedValueText(repairedLot))) {
        try {
          const fmv = await completeLotFmvWithAI({
            lot: repairedLot,
            urls,
            language,
            currency,
            valuationMethods,
            preservePhotoEndpoints: isBundleLot,
          });
          if (fmv) {
            repairAnalyses[index] = {
              ...(repairAnalyses[index] || {}),
              focused_fmv_completion: { estimated_value: fmv },
            };
            repairedLot = {
              ...repairedLot,
              estimated_value: fmv,
              tags: uniqueStrings([
                ...(Array.isArray(repairedLot?.tags) ? repairedLot.tags : []),
                "fmv_repaired",
              ]),
            };
          }
        } catch (error) {
          console.warn(
            `[LotListing] Focused FMV completion failed for lot ${lot?.lot_number || index + 1}:`,
            error
          );
        }
      }

      const completedLot = applyFinalLotExportFallbacks(
        repairedLot,
        currency
      );
      await markComplete();
      return enforceLotDamageAnalysisPolicy(completedLot, {
        includeDamageAnalysis: includeLotDamageAnalysis,
        fallbackLotNumber: index + 1,
      });
    }
  );

  return { lots: repairedLots, repairAnalyses };
}

export async function runLotListingJob({
  listingId,
  user,
  images,
  videos = [],
  details,
  progressId,
  executionContext,
  deferSourceFileCleanup = false,
  willRetryOnError = false,
}: LotListingJobInput) {
  if (progressId) startProgress(progressId);
  let report: any = null;
  let completed = false;
  const generationToken = String(progressId || "").trim();
  const executionToken = executionTokenOf(executionContext);
  const persistProgress = (patch: any) =>
    persistLotListingProgress(progressId, patch, executionContext);
  const finishProgress = (ok: boolean, message: string) =>
    finishLotListingProgress(progressId, ok, message, executionContext);
  const inspectorName = cleanString(user?.name);

  const selectedLanguage: "en" | "fr" | "es" = ((): any => {
    const l = String(details?.language || "").toLowerCase();
    return l === "fr" || l === "es" ? l : "en";
  })();
  const selectedCurrency: string = ((): string => {
    const c = String(details?.currency || "").toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : "CAD";
  })();
  const includeDamageAnalysis = resolveIncludeDamageAnalysis(
    details?.include_damage_analysis,
    true
  );
  const selectedValuationMethods = normalizeValuationMethods(details?.valuation_methods);

  try {
    if (listingId) {
      await executionContext?.assertOwned();
      report = await LotListing.findOneAndUpdate(
        {
          _id: listingId,
          ...(generationToken ? { job_id: generationToken } : {}),
          status: { $in: ["processing", "preview"] },
          job_status: { $in: ["uploading", "queued", "processing"] },
        },
        {
          $set: {
            job_status: "processing",
            ...(executionToken ? { job_execution_token: executionToken } : {}),
            processing_started_at: new Date(),
          },
          $unset: { job_error: 1 },
        },
        { returnDocument: "after" }
      );
      if (!report) {
        const current = await LotListing.findById(listingId);
        if (
          current &&
          (!generationToken || String((current as any).job_id || "") === generationToken) &&
          (current as any).job_status === "done"
        ) {
          if (executionContext) {
            await executionContext.assertOwned();
            await LotListing.updateOne(
              {
                _id: current._id,
                ...(generationToken ? { job_id: generationToken } : {}),
                job_status: "done",
              },
              { $unset: { job_execution_token: 1 } }
            );
          }
          completed = true;
          return current;
        }
        await executionContext?.assertOwned();
        throw new LotListingJobExecutionLostError(listingId);
      }
      await setReportGenerationProgress({
        kind: "lotListing",
        reportId: listingId,
        progressId,
        generationToken: generationToken || undefined,
        executionToken: executionToken || undefined,
        stage: "uploading",
        progressPercent: 5,
        message: "Preparing uploaded images",
      });
    }

    // Upload images to R2
    await persistProgress({ phase: "upload" });

    const total = images.length;
    const imageUploadConcurrency = resolveInitialImageConcurrency(total);
    let uploadedCount = 0;
    const imageUrls = await mapWithConcurrency(
      images,
      imageUploadConcurrency,
      async (file, idx) => {
        const existingR2Url =
          typeof (file as any)?.r2PublicUrl === "string"
            ? String((file as any).r2PublicUrl).trim()
            : "";
        const watermarkImages =
          resolvePhotoWatermark(details?.watermark_images);

        // A direct-R2 upload is already durable. When watermarking is disabled,
        // reuse it rather than downloading, decoding, and uploading hundreds of
        // identical images before analysis can begin.
        // HEIC still needs JPEG compatibility conversion, even without a logo.
        if (existingR2Url && !watermarkImages &&
          !isHeicLikeImage(undefined, file.mimetype, file.originalname)) {
          uploadedCount += 1;
          if (progressId) {
            await persistProgress({
              serverProgress01: (uploadedCount / Math.max(1, total)) * 0.2,
              message: `Prepared ${uploadedCount} of ${total} images`,
            });
          }
          return existingR2Url;
        }

        let inputBuffer: Buffer;
        try {
          inputBuffer = await readMulterFileBuffer(file);
        } catch (error) {
          throw new Error(
            `Missing upload file ${file.originalname || idx + 1}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (!inputBuffer.length) {
          throw new Error(`Missing upload file ${file.originalname || idx + 1}`);
        }

        let outputBuffer = inputBuffer;
        let outputName = String(file.originalname || `image-${idx + 1}`).replace(/[^a-zA-Z0-9._-]/g, "-");
        let outputType = file.mimetype || "image/jpeg";
        try {
          const processed = watermarkImages
            ? {
                ...(await processImageWithLogo(inputBuffer, "public/logoNobg.png")),
                mimetype: "image/jpeg",
                extension: ".jpg",
              }
            : await prepareImageWithoutWatermark(
                inputBuffer,
                file.mimetype,
                file.originalname,
              );
          outputBuffer = processed.buffer;
          outputName = outputName.replace(/\.[^./\\]+$/, "") + processed.extension;
          outputType = processed.mimetype;
        } catch (procErr) {
          if (!watermarkImages) throw procErr;
          console.warn(`Watermark processing failed for image ${idx + 1}; preserving source:`, procErr);
        }

        const fileName = listingId && generationToken
          ? buildLotListingInitialMediaKey({
              reportId: listingId,
              generationToken,
              kind: "images",
              index: idx,
              buffer: outputBuffer,
              extension: outputName.match(/\.[^./\\]+$/)?.[0] || ".bin",
            })
          : `uploads/lot-listing/${Date.now()}-${String(idx + 1).padStart(5, "0")}-${outputName}`;
        await executionContext?.assertOwned();
        await uploadBufferToR2(outputBuffer, outputType, process.env.R2_BUCKET_NAME!, fileName);
        uploadedCount += 1;
        if (progressId) {
          await persistProgress({
            serverProgress01: (uploadedCount / Math.max(1, total)) * 0.2,
            message: `Prepared ${uploadedCount} of ${total} images`,
          });
        }
        return getR2PublicUrl(fileName);
      }
    );

    // Videos are persisted exactly as uploaded. They are report media, not AI
    // inputs, so they must never pass through image watermarking or decoding.
    const videoUploadConcurrency = getPositiveIntEnv(
      "LOT_LISTING_VIDEO_UPLOAD_CONCURRENCY",
      3
    );
    let uploadedVideoCount = 0;
    const videoUrls = await mapWithConcurrency(
      videos,
      videoUploadConcurrency,
      async (file: any, idx) => {
        if (typeof file?.r2PublicUrl === "string" && file.r2PublicUrl.trim()) {
          uploadedVideoCount += 1;
          return file.r2PublicUrl.trim();
        }

        const safeOriginalName = String(file?.originalname || `video-${idx + 1}.mp4`)
          .replace(/[^a-zA-Z0-9._-]/g, "-")
          .slice(-180);
        const contentType = file?.mimetype || "application/octet-stream";
        const extension = safeOriginalName.match(/\.[^./\\]+$/)?.[0] || ".bin";
        let url: string;

        if (typeof file?.path === "string" && file.path) {
          const contentDigest = listingId && generationToken
            ? await sha256FilePath(file.path)
            : "";
          const fileName = listingId && generationToken
            ? buildLotListingInitialMediaKey({
                reportId: listingId,
                generationToken,
                kind: "videos",
                index: idx,
                contentDigest,
                extension,
              })
            : `uploads/lot-listing/videos/${Date.now()}-${String(idx + 1).padStart(5, "0")}-${safeOriginalName}`;
          await executionContext?.assertOwned();
          url = await uploadFilePathToR2(
            file.path,
            contentType,
            process.env.R2_BUCKET_NAME!,
            fileName,
            Number.isFinite(Number(file?.size)) ? Number(file.size) : undefined
          );
        } else {
          const buffer = await readMulterFileBuffer(file);
          if (!buffer.length) {
            throw new Error(`Missing upload video ${file?.originalname || idx + 1}`);
          }
          const fileName = listingId && generationToken
            ? buildLotListingInitialMediaKey({
                reportId: listingId,
                generationToken,
                kind: "videos",
                index: idx,
                buffer,
                extension,
              })
            : `uploads/lot-listing/videos/${Date.now()}-${String(idx + 1).padStart(5, "0")}-${safeOriginalName}`;
          await executionContext?.assertOwned();
          url = await uploadBufferToR2(
            buffer,
            contentType,
            process.env.R2_BUCKET_NAME!,
            fileName
          );
        }

        uploadedVideoCount += 1;
        await persistProgress({
          message: `Prepared ${uploadedVideoCount} of ${videos.length} videos`,
        });
        return url;
      }
    );

    // Process mixed lots through the shared Asset AI modes so Lot Listing gets the same
    // title, FMV, category, VIN/SN, damage, and spec fields as Asset reports.
    const mixedLots = details.mixed_lots || [];

    await persistProgress({ phase: "processing" });

    // Register focus boxes for AI analysis (red rectangle drawn on AI copy only)
    const rawFocusBoxes: any[] = Array.isArray(details?.focus_boxes)
      ? details.focus_boxes
      : [];
    if (rawFocusBoxes.length > 0 && imageUrls.length > 0) {
      const fbEntries: Array<{ url: string; box: FocusBoxRect }> = [];
      for (const fb of rawFocusBoxes) {
        const fbIdx = Number(fb?.imageIndex);
        if (
          Number.isFinite(fbIdx) &&
          fbIdx >= 0 &&
          fbIdx < imageUrls.length &&
          Number.isFinite(fb?.x) &&
          Number.isFinite(fb?.y) &&
          Number.isFinite(fb?.w) &&
          Number.isFinite(fb?.h)
        ) {
          fbEntries.push({
            url: imageUrls[fbIdx],
            box: { x: fb.x, y: fb.y, w: fb.w, h: fb.h },
          });
        }
      }
      if (fbEntries.length > 0) {
        registerFocusBoxes(fbEntries);
        console.log(`🔲 [LotListing] Registered ${fbEntries.length} focus box(es) for AI`);
      }
    }

    // Run AI analysis on lots
    if (progressId) {
      await persistProgress({ phase: "processing", serverProgress01: 0.55 });
    }

    let aiAnalysis: any = null;
    let analyzedLots: any[] = [];

    try {
      await executionContext?.assertOwned();
      console.log(
        `[LotListing] Running Asset OpenAI analysis on ${normalizeLotListingGroups(mixedLots, imageUrls.length).length} lot listing group(s)...`
      );
      const assetAnalysis = await analyzeLotListingGroupsWithAssetService(
        mixedLots,
        imageUrls,
        videoUrls,
        selectedLanguage,
        selectedCurrency,
        includeDamageAnalysis,
        async (completed, groupTotal) => {
          await executionContext?.assertOwned();
          const fraction = groupTotal > 0 ? completed / groupTotal : 1;
          await persistProgress({
            phase: "processing",
            serverProgress01: 0.2 + fraction * 0.35,
            message: `Analyzed ${completed} of ${groupTotal} lot groups`,
          });
          if (listingId) {
            await setReportGenerationProgress({
              kind: "lotListing",
              reportId: listingId,
              progressId,
              generationToken: generationToken || undefined,
              executionToken: executionToken || undefined,
              stage: "analyzing",
              progressPercent: 20 + fraction * 40,
              message: `Analyzed ${completed} of ${groupTotal} lots`,
              currentLot: completed,
              totalLots: groupTotal,
            });
          }
        },
        async (bundleLotTotal) => {
          await executionContext?.assertOwned();
          await persistProgress({
            phase: "processing",
            serverProgress01: 0.19,
            message: "Reading lot numbers",
          });
          if (listingId) {
            await setReportGenerationProgress({
              kind: "lotListing",
              reportId: listingId,
              progressId,
              generationToken: generationToken || undefined,
              executionToken: executionToken || undefined,
              stage: "analyzing",
              progressPercent: 19,
              message: "Reading lot numbers",
              currentLot: 0,
              totalLots: bundleLotTotal,
            });
          }
        },
        { groupingMethod: details.smart_upload_grouping_method },
      );
      analyzedLots = assetAnalysis.lots;
      aiAnalysis = assetAnalysis.analysis;
      await executionContext?.assertOwned();
      console.log(
        `[LotListing] Asset OpenAI analysis complete for ${analyzedLots.length} predefined lot(s).`
      );
    } catch (aiErr) {
      if (isLotListingExecutionOwnershipLost(aiErr, executionContext)) {
        throw aiErr;
      }
      console.warn("[LotListing] Asset OpenAI analysis failed, continuing without AI data:", aiErr);
    }

    // Clean up focus box registry after AI analysis
    clearFocusBoxes();

    if (progressId) {
      await persistProgress({ serverProgress01: 0.70 });
    }

    const repairResult = await repairWeakLotListingLotsWithAssetService(
      analyzedLots,
      imageUrls,
      selectedLanguage,
      selectedCurrency,
      includeDamageAnalysis,
      selectedValuationMethods,
      async (completed, lotTotal) => {
        await executionContext?.assertOwned();
        const fraction = lotTotal > 0 ? completed / lotTotal : 1;
        await persistProgress({
          phase: "processing",
          serverProgress01: 0.55 + fraction * 0.15,
          message: `Completed ${completed} of ${lotTotal} lots`,
        });
      }
    );
    await executionContext?.assertOwned();
    analyzedLots = repairResult.lots;
    if (repairResult.repairAnalyses.some(Boolean)) {
      aiAnalysis = {
        ...(aiAnalysis || {}),
        lot_listing_completion_mode: "asset_openai_service_required_export_field_completion",
        repair_analyses: repairResult.repairAnalyses,
      };
    }

    analyzedLots = applyLotListingExportDefaults(
      normalizeLotListingLotsForExport(analyzedLots),
      {
        location: details.location,
        latitude: details.latitude,
        longitude: details.longitude,
        lottedBy: inspectorName,
        includeDamageAnalysis,
      }
    );
    analyzedLots = normalizeLotsForBusinessRules(analyzedLots, {
      defaultLocation: details.location,
      defaultLatitude: details.latitude,
      defaultLongitude: details.longitude,
    });
    if (listingId) {
      analyzedLots = await mergeCanonicalAuctioneerSourceLots({
        reportId: listingId,
        reportType: "lotListing",
        lots: analyzedLots,
      });
    }
    analyzedLots = fillMissingFmvFromAvailableValues(
      analyzedLots,
      selectedCurrency,
      (details as any)?.total_value
    );
    if (progressId) {
      await persistProgress({ phase: "processing", serverProgress01: 0.73 });
    }
    const enrichmentResult = await enrichLotListingSpecs({
      lots: analyzedLots,
      currency: selectedCurrency,
      location: details.location,
    });
    analyzedLots = normalizeLotsForBusinessRules(enrichmentResult.lots, {
      defaultLocation: details.location,
      defaultLatitude: details.latitude,
      defaultLongitude: details.longitude,
    });
    analyzedLots = reapplyBundleLotNumberDiagnostics(analyzedLots);
    if (listingId) {
      analyzedLots = await allocateInitialAuctioneerLotNumbers({
        reportId: listingId,
        reportType: "lotListing",
        lots: analyzedLots,
        fallbackIndexes: initialLotNumberFallbackIndexes(analyzedLots),
        assertOwned: executionContext ? () => executionContext.assertOwned() : undefined,
      });
    }
    aiAnalysis = {
      ...(aiAnalysis || {}),
      lot_enrichment: enrichmentResult.analyses,
    };
    const totalValue = calculateLotListingTotalValue(analyzedLots);

    // Persist AI-analyzed lots on the existing queued listing when available.
    report =
      report ||
      new LotListing({
        user: user.id,
      });
    const analyzedReportSet = {
      user: user.id,
      contract_no: details.contract_no,
      sales_date: new Date(details.sales_date),
      location: details.location,
      latitude: details.latitude,
      longitude: details.longitude,
      imageUrls,
      videoUrls,
      lots: analyzedLots,
      mixed_lots: mixedLots,
      status: "processing",
      analysis: aiAnalysis,
      total_value: totalValue,
      language: selectedLanguage,
      currency: selectedCurrency,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: details?.bank_photos_enabled === true || details?.bank_photos_enabled === "true",
      watermark_images: resolvePhotoWatermark(details?.watermark_images),
      valuation_methods: selectedValuationMethods,
      job_status: "processing",
    };
    if (listingId) {
      report = await updateLotListingForExecution({
        listingId,
        generationToken,
        executionContext,
        filter: { job_status: "processing" },
        set: analyzedReportSet,
        unset: { job_error: 1, error_message: 1 },
      });
    } else {
      report.set({ ...analyzedReportSet, job_error: undefined });
      await report.save();
    }

    if (progressId) {
      await persistProgress({ serverProgress01: 0.75 });
    }

    const previewData = {
      contract_no: details.contract_no,
      sales_date: details.sales_date,
      location: details.location,
      latitude: details.latitude,
      longitude: details.longitude,
      inspector_name: inspectorName,
      lots: analyzedLots,
      videoUrls,
      currency: selectedCurrency,
      total_value: totalValue,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled:
        details?.bank_photos_enabled === true || details?.bank_photos_enabled === "true",
      watermark_images:
        resolvePhotoWatermark(details?.watermark_images),
      valuation_methods: selectedValuationMethods,
    };

    // The analyzed preview is the durable product of this job. Persist it
    // before optional delivery artifacts so a large media ZIP cannot hide or
    // destroy an otherwise valid 400+ image preview.
    if (listingId) {
      report = await updateLotListingForExecution({
        listingId,
        generationToken,
        executionContext,
        filter: { job_status: "processing" },
        set: {
          preview_data: previewData,
          total_value: totalValue,
          status: "preview",
          job_status: "processing",
        },
        unset: { job_error: 1, error_message: 1 },
      });
    } else {
      report.preview_data = previewData;
      report.total_value = totalValue;
      report.status = "preview";
      report.job_status = "processing";
      report.job_error = undefined;
      await report.save();
    }

    let reportData: any = buildLotListingExportData({
      contract_no: details.contract_no,
      sales_date: details.sales_date,
      location: details.location,
      latitude: details.latitude,
      longitude: details.longitude,
      inspector_name: inspectorName,
      lots: analyzedLots,
      videoUrls,
      total_value: totalValue,
      currency: selectedCurrency,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: details?.bank_photos_enabled === true || details?.bank_photos_enabled === "true",
      watermark_images: resolvePhotoWatermark(details?.watermark_images),
      valuation_methods: selectedValuationMethods,
    });

    const includeInitialDeliveryArtifacts = shouldBuildInitialDeliveryArtifacts(
      imageUrls.length,
    );
    const timestamp = Date.now();
    const artifactNames = buildReportArtifactFilenames({
      kind: "lotListing",
      contractNo: getReportContractNumber(reportData, report._id),
      reportId: report._id,
      fallback: report._id,
      lots: reportData.lots,
    });
    const artifactPrefix = buildLotListingArtifactPrefix(
      report._id,
      generationToken || String(report._id),
      executionToken || undefined
    );
    const artifactKeys = {
      scheduleA: `${artifactPrefix}/${artifactNames.scheduleAPdf}`,
      excel: `${artifactPrefix}/${artifactNames.excel}`,
      specPdf: `${artifactPrefix}/${artifactNames.crPdf}`,
      crDocx: `${artifactPrefix}/${artifactNames.crDocx}`,
      images: `${artifactPrefix}/${artifactNames.imagesZip}`,
    };
    const scheduleABuffer = includeInitialDeliveryArtifacts
      ? await generateScheduleAPdfFromReport({ ...reportData, imageUrls })
      : undefined;
    const scheduleAUrl = scheduleABuffer
      ? `${getR2PublicUrl(artifactKeys.scheduleA)}?v=${timestamp}`
      : undefined;
    reportData = {
      ...reportData,
      imageUrls,
      ...(scheduleAUrl ? { schedule_a_pdf_url: scheduleAUrl } : {}),
    };

    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: String(report._id),
      progressId,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "building_preview",
      progressPercent: 80,
      message: includeInitialDeliveryArtifacts
        ? "Building preview files"
        : "Preview data ready. Building core preview files",
      currentLot: analyzedLots.length,
      totalLots: analyzedLots.length,
    });

    if (progressId) {
      await persistProgress({ serverProgress01: 0.85 });
    }

    // A Bank CR can contain every report photo. Building hundreds of photo
    // pages during the initial preview blocks the worker for minutes and can
    // exhaust the process before the editable preview becomes visible. The
    // saved preview retains Bank=true; final submission/regeneration therefore
    // still creates the complete all-photo CR and media archive.
    const initialArtifactReportData = includeInitialDeliveryArtifacts
      ? reportData
      : { ...reportData, bank_photos_enabled: false };
    const { xlsxBuffer, specPdfBuffer, crDocxBuffer, imagesZip } = await generateLotListingFiles(
      initialArtifactReportData,
      imageUrls,
      { includeMediaArchive: includeInitialDeliveryArtifacts },
    );

    if (progressId) {
      await persistProgress({ serverProgress01: 0.95 });
    }

    const previewFiles = {
      ...(specPdfBuffer
        ? { spec_pdf: `${getR2PublicUrl(artifactKeys.specPdf)}?v=${timestamp}` }
        : {}),
      ...(crDocxBuffer
        ? { cr_docx: `${getR2PublicUrl(artifactKeys.crDocx)}?v=${timestamp}` }
        : {}),
      ...(scheduleAUrl ? { schedule_a_pdf: scheduleAUrl } : {}),
      excel: `${getR2PublicUrl(artifactKeys.excel)}?v=${timestamp}`,
      ...(imagesZip
        ? { images: `${getR2PublicUrl(artifactKeys.images)}?v=${timestamp}` }
        : {}),
    };
    const completedAt = new Date();
    const publicationArtifacts = [
      {
        buffer: xlsxBuffer,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        key: artifactKeys.excel,
      },
      ...(scheduleABuffer
        ? [{ buffer: scheduleABuffer, contentType: "application/pdf", key: artifactKeys.scheduleA }]
        : []),
      ...(imagesZip
        ? [{ buffer: imagesZip, contentType: "application/zip", key: artifactKeys.images }]
        : []),
      ...(specPdfBuffer
        ? [{ buffer: specPdfBuffer, contentType: "application/pdf", key: artifactKeys.specPdf }]
        : []),
      ...(crDocxBuffer
        ? [
            {
              buffer: crDocxBuffer,
              contentType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              key: artifactKeys.crDocx,
            },
          ]
        : []),
    ];

    if (listingId && generationToken) {
      const publication = await stageAndPublishLotListingArtifacts({
        reportId: listingId,
        generationToken,
        executionToken: executionToken || undefined,
        assertOwned: executionContext?.assertOwned,
        claimFilter: { status: "preview", job_status: "processing" },
        waitForPublishLeaseMs: 70 * 1_000,
        artifacts: publicationArtifacts,
        finalizeSet: {
          preview_files: previewFiles,
          status: "preview",
          files_generating: false,
          files_regenerating: false,
          job_status: "done",
          processing_completed_at: completedAt,
          generation_progress: {
            stage: "ready",
            progressPercent: 100,
            message: "Preview ready",
            currentLot: analyzedLots.length,
            totalLots: analyzedLots.length,
            updatedAt: completedAt,
          },
        },
        finalizeUnset: ["job_error", "error_message"],
      });
      if (!publication.published) {
        if (publication.reason === "publish-in-progress") {
          throw Object.assign(
            new Error("Another worker is publishing this Lot Listing preview."),
            {
              code: "LOT_LISTING_ARTIFACT_PUBLISH_IN_PROGRESS",
              retryAfterMs: publication.retryAfterMs,
            }
          );
        }
        return publication.listing || report;
      }
      report = publication.listing;
    } else {
      await Promise.all(
        publicationArtifacts.map((artifact) =>
          uploadBufferToR2(
            artifact.buffer,
            artifact.contentType,
            process.env.R2_BUCKET_NAME!,
            artifact.key
          )
        )
      );
      report.preview_files = previewFiles;
      report.status = "preview";
      report.job_status = "done";
      report.job_error = undefined;
      report.processing_completed_at = completedAt;
      await report.save();
    }
    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: String(report._id),
      progressId,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "ready",
      progressPercent: 100,
      message: "Preview ready",
      currentLot: analyzedLots.length,
      totalLots: analyzedLots.length,
    });
    if (!details.draft_preview) {
      await assertLotListingExecutionOwned({
        listingId: String(report._id),
        generationToken,
        executionContext,
        finalized: true,
      });
      await pushAuctionsoftLotListingIfReady(report, {
        ownership: executionToken
          ? {
              filter: {
                job_id: generationToken,
                job_execution_token: executionToken,
                job_status: "done",
              },
              assertOwned: executionContext?.assertOwned,
            }
          : undefined,
      }).catch((pushErr) => {
        if (isLotListingExecutionOwnershipLost(pushErr, executionContext)) {
          throw pushErr;
        }
        console.error("[Auctionsoft] Failed to push lot listing preview:", pushErr);
      });
    }

    if (progressId) {
      await persistProgress({
        serverProgress01: 1,
        message: "Lot listing preview ready",
        result: {
          reportId: String(report._id),
          reportType: "lotListing",
          status: "preview",
        },
      });
    }

    // Explicit draft previews remain quiet until the user opens/submits them.
    if (!details.draft_preview) {
      await assertLotListingExecutionOwned({
        listingId: String(report._id),
        generationToken,
        executionContext,
        finalized: true,
      });
      try {
      const emailHtml = `
        <h2>Lot Listing Preview Ready</h2>
        <p>Your lot listing for contract <strong>${details.contract_no}</strong> has been processed and is ready for review.</p>
        <p><strong>Location:</strong> ${details.location}</p>
        <p><strong>Sales Date:</strong> ${new Date(details.sales_date).toLocaleDateString()}</p>
        <p><strong>Total Lots:</strong> ${analyzedLots.length}</p>
        <p><strong>Total Images:</strong> ${imageUrls.length}</p>
        ${totalValue > 0 ? `<p><strong>Estimated Total Value:</strong> $${totalValue.toLocaleString()}</p>` : ''}
        <br/>
        <p>Please open the Previews section to review and submit it.</p>
      `;
      await sendEmail(
        user.email,
        `Lot Listing Preview Ready - ${details.contract_no}`,
        emailHtml
      );
      } catch (emailErr) {
        if (isLotListingExecutionOwnershipLost(emailErr, executionContext)) {
          throw emailErr;
        }
        console.warn("Failed to send lot listing preview email:", emailErr);
      }

      await assertLotListingExecutionOwned({
        listingId: String(report._id),
        generationToken,
        executionContext,
        finalized: true,
      });
      await notifyUser({
      userId: String(user?.id || report?.user || ""),
      category: "report",
      type: "lot_listing_preview_ready",
      title: "Lot Listing Preview Ready",
      body: `Your lot listing for contract ${details.contract_no} is ready for review.`,
      data: {
        type: "lot_listing_preview_ready",
        reportId: String(report._id),
        reportType: "LotListing",
      },
      }).catch((pushErr) => {
        if (isLotListingExecutionOwnershipLost(pushErr, executionContext)) {
          throw pushErr;
        }
        console.error("Failed to send lot listing ready notification:", pushErr);
      });
    }

    if (progressId) {
      await finishProgress(true, "Lot listing preview ready");
    }

    await releaseLotListingExecutionOwnership({
      listingId: String(report._id),
      generationToken,
      executionContext,
    });

    console.log(`✅ Lot Listing preview ready: ${report._id}`);
    completed = true;
    return report;
  } catch (error: any) {
    console.error("LotListing job error:", error);
    clearFocusBoxes();
    let executionStillOwned = true;
    if (executionContext) {
      executionStillOwned = await executionContext.assertOwned()
        .then(() => true)
        .catch(() => false);
    }
    if (report || listingId) {
      try {
        const target = report || (await LotListing.findById(listingId));
        if (target && executionStillOwned) {
          const hasDurablePreview =
            Array.isArray((target as any)?.preview_data?.lots) &&
            (target as any).preview_data.lots.length > 0;
          // Artifact generation is recoverable. Once analyzed lot data has
          // been saved, keep the report in Preview so users never lose access
          // to hundreds of processed images because a ZIP/PDF step failed.
          const errorMessage = error.message || "Error processing lot listing";
          const willRetry = Boolean(executionContext && willRetryOnError);
          if (listingId) {
            await LotListing.findOneAndUpdate(
              {
                _id: listingId,
                ...(generationToken ? { job_id: generationToken } : {}),
                ...(executionToken
                  ? { job_execution_token: executionToken }
                  : {}),
                job_status: { $ne: "done" },
              },
              {
                $set: {
                  status: willRetry
                    ? "processing"
                    : hasDurablePreview
                      ? "preview"
                      : "error",
                  error_message: willRetry
                    ? `Retrying after error: ${errorMessage}`
                    : errorMessage,
                  job_status: willRetry ? "queued" : "error",
                  job_error: willRetry
                    ? `Retrying after error: ${errorMessage}`
                    : error.message || String(error),
                  ...(willRetry
                    ? { queued_at: new Date() }
                    : { processing_completed_at: new Date() }),
                  generation_progress: {
                    stage: willRetry ? "queued" : "error",
                    progressPercent: willRetry ? 1 : 100,
                    message: willRetry
                      ? `Retrying after error: ${errorMessage}`
                      : error.message || String(error),
                    updatedAt: new Date(),
                  },
                },
                ...(willRetry
                  ? { $unset: { processing_completed_at: 1 } }
                  : {}),
              }
            );
          } else {
            target.status = hasDurablePreview ? "preview" : "error";
            target.error_message = errorMessage;
            target.job_status = "error";
            target.job_error = error.message || String(error);
            target.processing_completed_at = new Date();
            (target as any).generation_progress = {
              stage: "error",
              progressPercent: 100,
              message: error.message || String(error),
              updatedAt: new Date(),
            };
            await target.save();
          }
        }
      } catch (saveError) {
        console.error("Failed to persist lot listing error state:", saveError);
      }
    }

    if (progressId && executionStillOwned) {
      if (executionContext && willRetryOnError) {
        await persistProgress({
          phase: "processing",
          stage: "queued",
          progressPercent: 1,
          message: `Retrying after error: ${error.message || "Error processing lot listing"}`,
        });
      } else {
        await finishProgress(false, error.message || "Error processing lot listing");
      }
    }

    throw error;
  } finally {
    if (completed && !deferSourceFileCleanup) {
      await cleanupMulterFiles([...images, ...videos]);
    }
  }
}

// Regenerate lot listing files from existing data
export async function runRegenerateLotListingJob({
  listingId,
  user,
  generationToken: generationTokenInput,
  jobId,
  previewDataSnapshot,
  executionContext,
  willRetryOnError = false,
}: RegenerateLotListingInput) {
  const generationToken = String(generationTokenInput || jobId || "").trim();
  const executionToken = executionTokenOf(executionContext);
  let isEditedRegeneration = false;
  let previousStatus: string | undefined;
  const generationTarget = "approved";
  try {
    await executionContext?.assertOwned();
    const foundListing = await LotListing.findById(listingId);
    if (!foundListing) {
      throw new Error("Lot listing not found");
    }
    let listing = foundListing;
    if (generationToken && String((listing as any).job_id || "") !== generationToken) {
      console.warn(`[LotListing] Skipping stale regeneration job ${generationToken} for listing ${listingId}`);
      return listing;
    }
    previousStatus = String(
      (listing as any).generation_progress?.previousStatus || listing.status
    );
    isEditedRegeneration = Boolean((listing as any).files_regenerating);
    const claimedListing = await LotListing.findOneAndUpdate(
      {
        _id: listingId,
        ...(generationToken ? { job_id: generationToken } : {}),
        status: "processing",
        job_status: { $in: ["queued", "processing"] },
      },
      {
        $set: {
          generation_target_status: generationTarget,
          job_status: "processing",
          ...(executionToken ? { job_execution_token: executionToken } : {}),
          processing_started_at: new Date(),
        },
        $unset: { job_error: 1 },
      },
      { returnDocument: "after" }
    );
    if (!claimedListing) {
      const current = await LotListing.findById(listingId);
      if (
        current &&
        (!generationToken || String((current as any).job_id || "") === generationToken) &&
        (current as any).job_status === "done"
      ) {
        if (executionContext) {
          await executionContext.assertOwned();
          await LotListing.updateOne(
            {
              _id: current._id,
              ...(generationToken ? { job_id: generationToken } : {}),
              job_status: "done",
            },
            { $unset: { job_execution_token: 1 } }
          );
        }
        return current;
      }
      await executionContext?.assertOwned();
      console.warn(
        `[LotListing] Skipping generation claim ${generationToken || "without-token"} for listing ${listingId}; ownership or workflow state changed`
      );
      if (executionContext) throw new LotListingJobExecutionLostError(listingId);
      return current || listing;
    }
    listing = claimedListing;
    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: listingId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "generating_files",
      progressPercent: 10,
      message: "Preparing the latest lot data",
    });

    const previewData = markPreviewDataSpecsReviewed(
      previewDataSnapshot && typeof previewDataSnapshot === "object"
        ? previewDataSnapshot
        : (listing.preview_data as any)?.toObject?.() || listing.preview_data || {},
      { reconcileManualOverrides: false }
    );
    // First Save & Generate is reviewed too; files_regenerating controls lifecycle
    // notifications, not whether the saved preview may be enriched again.
    const hasReviewedPreviewLots = Array.isArray(previewData.lots);
    const imageUrls = listing.imageUrls || [];
    const videoUrls = Array.isArray((previewData as any).videoUrls)
      ? (previewData as any).videoUrls.filter((url: unknown) => typeof url === "string" && url)
      : listing.videoUrls || [];
    const selectedLanguage: "en" | "fr" | "es" = ((): any => {
      const language = String((previewData as any).language || listing.language || "").toLowerCase();
      return language === "fr" || language === "es" ? language : "en";
    })();
    const selectedCurrency = String(
      (previewData as any).currency || listing.currency || "CAD"
    ).toUpperCase();
    const includeDamageAnalysis = resolveIncludeDamageAnalysis(
      (previewData as any).include_damage_analysis,
      (listing as any).include_damage_analysis !== false
    );
    const bankPhotosEnabled =
      (previewData as any).bank_photos_enabled === true ||
      (previewData as any).bank_photos_enabled === "true" ||
      ((previewData as any).bank_photos_enabled === undefined &&
        (listing as any).bank_photos_enabled === true);
    const watermarkImages = resolvePhotoWatermark(
      (previewData as any).watermark_images,
      (listing as any).watermark_images
    );
    const valuationMethods = normalizeValuationMethods(
      (previewData as any).valuation_methods,
      normalizeValuationMethods((listing as any).valuation_methods)
    );
    const baseLots = Array.isArray((previewData as any).lots)
      ? (previewData as any).lots
      : listing.lots || [];
    const previewLocation = (previewData as any).location || listing.location;
    const previewLatitude = (previewData as any).latitude;
    const previewLongitude = (previewData as any).longitude;
    const inspectorName = cleanString(user?.name || (previewData as any).inspector_name);
    const repairResult = hasReviewedPreviewLots || isEditedRegeneration
      ? { lots: baseLots, repairAnalyses: [] as any[] }
      : await repairWeakLotListingLotsWithAssetService(
          baseLots,
          imageUrls,
          selectedLanguage,
          selectedCurrency,
          includeDamageAnalysis,
          valuationMethods
        );
    let lots = applyLotListingExportDefaults(
      normalizeLotListingLotsForExport(repairResult.lots),
      {
        location: previewLocation,
        latitude: previewLatitude,
        longitude: previewLongitude,
        lottedBy: inspectorName,
        includeDamageAnalysis,
      }
    );
    lots = restoreEditedLotIdentity(lots, baseLots);
    lots = normalizeLotsForBusinessRules(lots, {
      defaultLocation: previewLocation,
      defaultLatitude: previewLatitude,
      defaultLongitude: previewLongitude,
      preserveDescription: true,
    });
    lots = restoreEditedLotIdentity(lots, baseLots);
    lots = fillMissingFmvFromAvailableValues(
      lots,
      selectedCurrency,
      (previewData as any).total_value ?? listing.total_value
    );
    const enrichmentResult = hasReviewedPreviewLots || isEditedRegeneration
      ? { lots, analyses: [] as any[] }
      : await enrichLotListingSpecs({
          lots,
          currency: selectedCurrency,
          location: previewLocation,
        });
    lots = normalizeLotsForBusinessRules(enrichmentResult.lots, {
      defaultLocation: previewLocation,
      defaultLatitude: previewLatitude,
      defaultLongitude: previewLongitude,
      preserveDescription: true,
    });
    lots = restoreEditedLotIdentity(lots, baseLots);
    lots = reapplyBundleLotNumberDiagnostics(lots, {
      // Preview lot numbers are user-owned. The detector is authoritative only
      // during initial analysis, before this regeneration snapshot exists.
      preserveExistingLotNumber: true,
    });
    const totalValue = calculateLotListingTotalValue(lots);
    let reportData: any = buildLotListingExportData({
      contract_no: previewData.contract_no || listing.contract_no,
      sales_date: previewData.sales_date || listing.sales_date,
      location: previewLocation,
      latitude: previewLatitude,
      longitude: previewLongitude,
      inspector_name: inspectorName,
      lots,
      videoUrls,
      total_value: totalValue,
      currency: selectedCurrency,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: bankPhotosEnabled,
      watermark_images: watermarkImages,
      valuation_methods: valuationMethods,
      cr_disclaimers: (previewData as any).cr_disclaimers,
      cr_disclaimers_by_lot: (previewData as any).cr_disclaimers_by_lot,
      deleted_image_indexes: (previewData as any).deleted_image_indexes,
    });
    const timestamp = Date.now();
    const artifactNames = buildReportArtifactFilenames({
      kind: "lotListing",
      contractNo: getReportContractNumber(reportData, listing._id),
      reportId: listing._id,
      fallback: listing._id,
      lots: reportData.lots,
    });
    const artifactPrefix = buildLotListingArtifactPrefix(
      listing._id,
      generationToken || String(listing._id),
      executionToken || undefined
    );
    const artifactKeys = {
      scheduleA: `${artifactPrefix}/${artifactNames.scheduleAPdf}`,
      excel: `${artifactPrefix}/${artifactNames.excel}`,
      specPdf: `${artifactPrefix}/${artifactNames.crPdf}`,
      crDocx: `${artifactPrefix}/${artifactNames.crDocx}`,
      images: `${artifactPrefix}/${artifactNames.imagesZip}`,
    };
    const scheduleAUrl = `${getR2PublicUrl(artifactKeys.scheduleA)}?v=${timestamp}`;
    const scheduleABuffer = await generateScheduleAPdfFromReport({
      ...reportData,
      imageUrls,
    });
    reportData = {
      ...reportData,
      imageUrls,
      schedule_a_pdf_url: scheduleAUrl,
    };
    await prepareReportYoutubeVideos({
      reportType: "lotListing", reportId: listingId, enabled: listing.youtube_videos_enabled,
      generationToken, lots: reportData.lots || [], assertOwned: () => assertLotListingExecutionOwned({
        listingId, generationToken, executionContext,
      }),
    });
    const { xlsxBuffer, specPdfBuffer, crDocxBuffer, imagesZip } = await generateLotListingFiles(
      reportData,
      imageUrls,
    );
    if (!imagesZip) {
      throw new Error("Lot Listing media archive was not generated");
    }
    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: listingId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "generating_files",
      progressPercent: 72,
      message: "Uploading generated files",
    });

    await assertLotListingExecutionOwned({
      listingId,
      generationToken,
      executionContext,
    });

    const previewFiles = {
      ...(specPdfBuffer
        ? { spec_pdf: `${getR2PublicUrl(artifactKeys.specPdf)}?v=${timestamp}` }
        : {}),
      ...(crDocxBuffer
        ? { cr_docx: `${getR2PublicUrl(artifactKeys.crDocx)}?v=${timestamp}` }
        : {}),
      schedule_a_pdf: scheduleAUrl,
      excel: `${getR2PublicUrl(artifactKeys.excel)}?v=${timestamp}`,
      images: `${getR2PublicUrl(artifactKeys.images)}?v=${timestamp}`,
    };
    const finalizedPreviewData = {
      ...(previewData || {}),
      contract_no: reportData.contract_no,
      sales_date:
        reportData.sales_date instanceof Date
          ? reportData.sales_date.toISOString()
          : String(reportData.sales_date || ""),
      location: reportData.location,
      ...(getExplicitCoordinates(reportData) || {}),
      inspector_name: inspectorName,
      lots,
      videoUrls,
      currency: reportData.currency,
      total_value: totalValue,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: bankPhotosEnabled,
      watermark_images: watermarkImages,
      valuation_methods: valuationMethods,
    };
    const finalizedAnalysis = {
      ...((listing.analysis as any) || {}),
      lot_enrichment: enrichmentResult.analyses,
      ...(repairResult.repairAnalyses.some(Boolean)
        ? {
            lot_listing_repair_mode: "asset_openai_service_missing_field_repair",
            repair_analyses: repairResult.repairAnalyses,
          }
        : {}),
    };
    const completedAt = new Date();
    const publication = await stageAndPublishLotListingArtifacts({
      reportId: listingId,
      generationToken,
      executionToken: executionToken || undefined,
      assertOwned: executionContext?.assertOwned,
      waitForPublishLeaseMs: 70 * 1_000,
      artifacts: [
        {
          buffer: scheduleABuffer,
          contentType: "application/pdf",
          key: artifactKeys.scheduleA,
        },
        {
          buffer: xlsxBuffer,
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          key: artifactKeys.excel,
        },
        {
          buffer: imagesZip,
          contentType: "application/zip",
          key: artifactKeys.images,
        },
        ...(specPdfBuffer
          ? [
              {
                buffer: specPdfBuffer,
                contentType: "application/pdf",
                key: artifactKeys.specPdf,
              },
            ]
          : []),
        ...(crDocxBuffer
          ? [
              {
                buffer: crDocxBuffer,
                contentType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                key: artifactKeys.crDocx,
              },
            ]
          : []),
      ],
      finalizeSet: {
        preview_files: previewFiles,
        files: previewFiles,
        preview_data: finalizedPreviewData,
        lots,
        videoUrls,
        include_damage_analysis: includeDamageAnalysis,
        bank_photos_enabled: bankPhotosEnabled,
        watermark_images: watermarkImages,
        valuation_methods: valuationMethods,
        analysis: finalizedAnalysis,
        total_value: totalValue,
        files_generating: false,
        files_regenerating: false,
        job_status: "done",
        processing_completed_at: completedAt,
        // Release only with the complete, fenced publication of this revision.
        // Legacy pending-approval jobs follow the same Lot Listing policy.
        status: "approved",
        generation_progress: {
          stage: "ready",
          progressPercent: 100,
          message: "Report ready",
          updatedAt: completedAt,
        },
        approval_processed_at: completedAt,
        release_status: "released",
        release_assigned_to: null,
        release_assigned_at: null,
        release_assigned_source: "auto_released",
        release_assignment_email_sent_at: null,
        released_by: null,
        released_at: completedAt,
      },
      finalizeUnset: [
        "job_error",
        "error_message",
        "generation_target_status",
        "approval_assigned_to",
        "approval_assigned_at",
        "approval_assigned_source",
        "approval_assignment_email_sent_at",
      ],
    });
    if (!publication.published) {
      if (publication.reason === "publish-in-progress") {
        throw Object.assign(
          new Error("Another worker is publishing this Lot Listing generation."),
          {
            code: "LOT_LISTING_ARTIFACT_PUBLISH_IN_PROGRESS",
            retryAfterMs: publication.retryAfterMs,
          }
        );
      }
      console.warn(
        `[LotListing] Skipping artifact publication for ${generationToken}: ${publication.reason}`
      );
      return publication.listing || listing;
    }
    listing = publication.listing;
    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: listingId,
      progressId: generationToken || undefined,
      generationToken: generationToken || undefined,
      executionToken: executionToken || undefined,
      stage: "ready",
      progressPercent: 100,
      message: "Report ready",
    }).catch((progressError) => {
      // Publication and report finalization are already durable. Queue
      // completion also records a terminal progress snapshot.
      console.warn("Failed to persist final Lot Listing progress:", progressError);
    });
    await assertLotListingExecutionOwned({
      listingId,
      generationToken,
      executionContext,
      finalized: true,
    });
    await pushAuctionsoftLotListingIfReady(listing, {
      ownership: executionToken
        ? {
            filter: {
              job_id: generationToken,
              job_execution_token: executionToken,
              job_status: "done",
            },
            assertOwned: executionContext?.assertOwned,
          }
        : undefined,
    }).catch((pushErr) => {
      if (isLotListingExecutionOwnershipLost(pushErr, executionContext)) {
        throw pushErr;
      }
      console.error("[Auctionsoft] Failed to push regenerated lot listing:", pushErr);
    });
    if (!isEditedRegeneration) {
      await assertLotListingExecutionOwned({
        listingId,
        generationToken,
        executionContext,
        finalized: true,
      });
      try {
        const emailHtml = `
          <h2>Lot Listing Approved</h2>
          <p>Your lot listing for contract <strong>${reportData.contract_no}</strong> has been approved and is ready to download.</p>
          <p><strong>Location:</strong> ${reportData.location}</p>
          <p><strong>Total Lots:</strong> ${lots.length}</p>
          <br/>
          <p>You can download the Excel and images package from Reports.</p>
        `;
        await sendEmail(
          user.email,
          `Lot Listing Approved - ${reportData.contract_no}`,
          emailHtml
        );
      } catch (emailErr) {
        if (isLotListingExecutionOwnershipLost(emailErr, executionContext)) {
          throw emailErr;
        }
        console.warn("Failed to send lot listing ready email:", emailErr);
      }
    }

    console.log(
      `Lot Listing regenerated and approved: ${listing._id}`
    );
    if (!isEditedRegeneration) {
      await assertLotListingExecutionOwned({
        listingId,
        generationToken,
        executionContext,
        finalized: true,
      });
      await notifyUser({
        userId: String(user?.id || listing?.user || ""),
        category: "report",
        type: "lot_listing_approved",
        title: "Lot Listing Approved",
        body: `Your lot listing for contract ${reportData.contract_no} is ready in Reports.`,
        data: {
          type: "lot_listing_approved",
          reportId: String(listing._id),
          reportType: "LotListing",
        },
      }).catch((pushErr) => {
        if (isLotListingExecutionOwnershipLost(pushErr, executionContext)) {
          throw pushErr;
        }
        console.error("Failed to send regenerated lot listing notification:", pushErr);
      });
    }

    await releaseLotListingExecutionOwnership({
      listingId,
      generationToken,
      executionContext,
    });

    return listing;
  } catch (error: any) {
    console.error("LotListing regenerate job error:", error);

    // Keep the report unavailable for competing edits while the durable job
    // still has retries. Terminal failure is projected only after the queue
    // exhausts its attempts.
    try {
      if (executionContext) {
        await executionContext.assertOwned();
      }
      const willRetry = Boolean(executionContext && willRetryOnError);
      const errorMessage = error.message || String(error);
      await LotListing.findOneAndUpdate(
        {
          _id: listingId,
          ...(generationToken ? { job_id: generationToken } : {}),
          ...(executionToken
            ? { job_execution_token: executionToken }
            : {}),
          job_status: { $ne: "done" },
        },
        {
          $set: {
            // Keep a previously released listing available on terminal error,
            // but never promote preview/pending work after generation fails.
            status: willRetry
              ? "processing"
              : previousStatus === "approved"
                ? "approved"
                : "error",
            error_message: willRetry
              ? `Retrying after error: ${errorMessage}`
              : errorMessage,
            files_generating: willRetry,
            files_regenerating: willRetry,
            job_status: willRetry ? "queued" : "error",
            job_error: willRetry
              ? `Retrying after error: ${errorMessage}`
              : errorMessage,
            ...(willRetry
              ? { queued_at: new Date() }
              : { processing_completed_at: new Date() }),
            generation_target_status: generationTarget,
            "generation_progress.stage": willRetry ? "queued" : "error",
            "generation_progress.progressPercent": willRetry ? 1 : 100,
            "generation_progress.message": willRetry
              ? `Retrying after error: ${errorMessage}`
              : errorMessage,
            "generation_progress.updatedAt": new Date(),
          },
          ...(willRetry
            ? { $unset: { processing_completed_at: 1 } }
            : {}),
        }
      );
    } catch {}

    throw error;
  }
}
