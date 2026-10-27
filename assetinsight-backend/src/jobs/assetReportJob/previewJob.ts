import { resolvePhotoWatermark } from "../../utils/photoWatermarkPolicy.js";
import { normalizeAssetReportValuationMethods } from "../../utils/assetValuationSelection.js";
import AssetReport from "../../models/asset.model.js";
import { createHash } from "node:crypto";
import {
  analyzeAssetImages,
  type AssetAnalysisResult,
} from "../../service/assetOpenAIService.js";
import {
  registerFocusBoxes,
  clearFocusBoxes,
  type FocusBoxRect,
} from "../../service/assetOpenAIService/imageUtils.js";
import {
  isHeicLikeImage,
  prepareImageWithoutWatermark,
  processImageWithLogo,
} from "../../utils/imageProcessing.js";
import {
  getR2PublicUrl,
  resolvePersistedR2StorageTarget,
  resolveR2ObjectLocationFromUrl,
  uploadBufferToR2,
} from "../../utils/r2Storage/r2Upload.js";
import { enrichLotsWithVin } from "../../service/vehicleApiService.js";
import { enrichAuctioneerImportSpecs } from "../../service/lotListingSpecEnrichmentService.js";
import { startProgress, endProgress, updateProgress } from "../../utils/progressStore.js";
import { normalizeLotsForReportOrdering } from "./lotOrdering.js";
import type { AssetGroupingMode, AssetJobInput } from "./types.js";
import { buildPolicySafeReportDamageAnalysis } from "../../utils/assetDamageAnalysis.js";
import { normalizeAuctioneerLotSpecs } from "../../utils/auctioneerSpecRows.js";
import { normalizeLotsForBusinessRules } from "../../utils/previewLotNormalization.js";
import {
  getExplicitCoordinates,
  getAuctionLocationCoordinates,
  resolveAuctionLocation,
} from "../../utils/auctionLocations.js";
import {
  cleanupMulterFiles,
  readMulterFileBuffer,
} from "../../utils/reportTempFiles.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../../utils/concurrency.js";
import {
  endMongoReportJobProgress,
  type ReportJobExecutionContext,
  updateMongoReportJobProgress,
} from "../../utils/reportJobMongoQueue.js";
import { setReportGenerationProgress } from "../../service/reportGenerationProgressService.js";
import { mergeCanonicalAuctioneerSourceLots } from "../../service/auctioneerSourceMergeService.js";
import { allocateInitialAuctioneerLotNumbers } from "../../service/auctioneerLotNumberAllocationService.js";
import { initialLotNumberFallbackIndexes, markInitialLotNumberFallback } from "../../service/initialLotNumberProvenance.js";
import {
  applyAuthoritativeBundleLotNumber,
  buildBundleLotNumberPhotoInputs,
  detectBundleLotNumbersFromPhotos,
  normalizeDetectedBundleLotNumber,
  resolveBundleLotAnalysisPolicy,
  selectBundleAnalysisImageIndexes,
  type BundleLotAnalysisDiagnostic,
} from "../../service/bundleLotAnalysisPolicy.js";
import { analyzeMixedAssetGroupWithFallback } from "./mixedGroupAnalysis.js";
import { assignAssetLotVideos, uploadAssetPreviewVideos } from "./videos.js";
import { assertMixedLotPhotoManifest, resolveGroupModelImageIndex } from "../../utils/mixedLotPhotoManifest.js";

export type AssetPreviewJobRunOptions = {
  /** Durable handlers defer shared source cleanup until the queue completion CAS wins. */
  deferSourceFileCleanup?: boolean;
  executionContext?: ReportJobExecutionContext;
  willRetryOnError?: boolean;
};

/** Bundle model indexes address only its sampled inputs, never the media manifest. */
export function remapBundleItemImages(
  lot: any,
  analyzedImageIndexes: number[],
  imageUrls: string[],
): any {
  if (!Array.isArray(lot?.items)) return lot;
  return {
    ...lot,
    items: lot.items.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const rawIndex = item.image_local_index ?? item.image_index;
      const localIndex = rawIndex === null || rawIndex === undefined || rawIndex === ""
        ? Number.NaN : Number(rawIndex);
      const indexedImage = Number.isInteger(localIndex) && localIndex >= 0
        ? analyzedImageIndexes[localIndex]
        : undefined;
      const globalIndex = indexedImage ?? analyzedImageIndexes.find(
        (index) => typeof item.image_url === "string" && imageUrls[index] === item.image_url,
      );
      const { image_local_index: _local, image_index: _index, image_url: _url, ...rest } = item;
      return globalIndex === undefined
        ? rest
        : { ...rest, image_index: globalIndex, image_url: imageUrls[globalIndex] };
    }),
  };
}

class AssetPreviewExecutionOwnershipLostError extends Error {
  readonly code = "ASSET_PREVIEW_EXECUTION_OWNERSHIP_LOST";

  constructor(reportId: string) {
    super(`Asset preview execution no longer owns report ${reportId}`);
    this.name = "AssetPreviewExecutionOwnershipLostError";
  }
}

function isExecutionOwnershipLost(
  error: unknown,
  context?: ReportJobExecutionContext
): boolean {
  const code = String((error as any)?.code || "");
  return Boolean(
    context?.signal.aborted ||
      code === "REPORT_JOB_OWNERSHIP_LOST" ||
      code === "ASSET_PREVIEW_EXECUTION_OWNERSHIP_LOST"
  );
}

function safeGeneratedImageExtension(value: unknown): string {
  const extension = String(value || "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".img";
}

/**
 * Stable within one logical report job and manifest position. The byte digest
 * prevents an altered retry payload from overwriting the accepted image while
 * exact retries overwrite identical bytes at one key instead of leaking a new
 * timestamp-named object per attempt.
 */
export function buildAssetInitialPreviewImageObjectKey(input: {
  reportId: string;
  generationToken: string;
  imageIndex: number;
  buffer: Buffer;
  extension: string;
}): string {
  const scope = createHash("sha256")
    .update("asset-initial-preview-v1\0")
    .update(input.reportId)
    .update("\0")
    .update(input.generationToken)
    .digest("hex")
    .slice(0, 24);
  const content = createHash("sha256").update(input.buffer).digest("hex");
  const position = String(Math.max(0, Math.trunc(input.imageIndex))).padStart(
    6,
    "0"
  );
  return `uploads/asset/initial/${scope}/${position}-${content}${safeGeneratedImageExtension(
    input.extension
  )}`;
}

// Upload all preview images with bounded concurrency while preserving original order.
async function uploadPreviewImages(
  images: Express.Multer.File[],
  watermarkImages: boolean,
  options: {
    reportId: string;
    generationToken: string;
    assertOwned?: () => Promise<void>;
  },
): Promise<string[]> {
  const concurrency = getPositiveIntEnv("ASSET_IMAGE_UPLOAD_CONCURRENCY", 8);
  const outputUrls = await mapWithConcurrency(
    images,
    concurrency,
    async (imageFile, imageIndex) => {
      await options.assertOwned?.();
      const image = imageFile as any;
      if (!image) {
        return "";
      }
      // Upload-session/draft producers persist the verified R2 key, generation
      // and URL together. Reuse only that exact object, never an arbitrary URL
      // or a URL competing with supplied local bytes. HEIC and explicit
      // watermark opt-ins still need the existing conversion/upload path.
      if (
        !watermarkImages &&
        !image.buffer?.length &&
        !image.path &&
        typeof image.r2Key === "string" &&
        image.r2Key &&
        typeof image.r2PublicUrl === "string" &&
        !isHeicLikeImage(undefined, image.mimetype, image.originalname)
      ) {
        const location = resolveR2ObjectLocationFromUrl(image.r2PublicUrl);
        if (location && location.key === image.r2Key) {
          const source = resolvePersistedR2StorageTarget({ r2Bucket: image.r2Bucket });
          if (location.bucketName === source.bucketName) {
            return image.r2PublicUrl;
          }
        }
      }
      const sanitizedName = String(
        image.originalname || `image-${imageIndex + 1}.jpg`,
      )
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/--+/g, "-")
        .replace(/^-|-$/g, "");
      const inputBuffer = await readMulterFileBuffer(image);
      if (!inputBuffer.length) {
        throw new Error(`Missing upload file ${image.originalname || imageIndex + 1}`);
      }

      try {
        const prepared = watermarkImages
          ? {
              ...(await processImageWithLogo(inputBuffer, "public/logoNobg.png")),
              mimetype: "image/jpeg",
              extension: ".jpg",
            }
          : await prepareImageWithoutWatermark(
              inputBuffer,
              image.mimetype,
              image.originalname,
            );
        const outputFile = buildAssetInitialPreviewImageObjectKey({
          reportId: options.reportId,
          generationToken: options.generationToken,
          imageIndex,
          buffer: prepared.buffer,
          extension: prepared.extension,
        });
        await options.assertOwned?.();
        await uploadBufferToR2(
          prepared.buffer,
          prepared.mimetype,
          process.env.R2_BUCKET_NAME!,
          outputFile,
        );
        return getR2PublicUrl(outputFile);
      } catch (error) {
        if (isExecutionOwnershipLost(error)) throw error;
        if (isHeicLikeImage(inputBuffer, image.mimetype, image.originalname)) {
          throw new Error(
            `Unable to convert HEIC image "${image.originalname || `#${imageIndex + 1}`}" to JPEG.`
          );
        }
        if (!watermarkImages) throw error;
        const fallbackName = buildAssetInitialPreviewImageObjectKey({
          reportId: options.reportId,
          generationToken: options.generationToken,
          imageIndex,
          buffer: inputBuffer,
          extension: safeGeneratedImageExtension(
            sanitizedName.match(/\.[^./\\]+$/)?.[0] || ".img"
          ),
        });
        await options.assertOwned?.();
        await uploadBufferToR2(
          inputBuffer,
          image.mimetype || "image/jpeg",
          process.env.R2_BUCKET_NAME!,
          fallbackName,
        );
        return getR2PublicUrl(fallbackName);
      }
    }
  );
  return outputUrls.filter(Boolean);
}

// Register preview focus boxes so AI only analyzes the requested image regions.
function registerPreviewFocusBoxes(imageUrls: string[], details: any): void {
  const rawFocusBoxes: any[] = Array.isArray(details?.focus_boxes)
    ? details.focus_boxes
    : [];
  if (rawFocusBoxes.length === 0 || imageUrls.length === 0) {
    return;
  }

  const entries: Array<{ url: string; box: FocusBoxRect }> = [];
  for (const focusBox of rawFocusBoxes) {
    const imageIndex = Number(focusBox?.imageIndex);
    if (
      Number.isFinite(imageIndex) &&
      imageIndex >= 0 &&
      imageIndex < imageUrls.length &&
      Number.isFinite(focusBox?.x) &&
      Number.isFinite(focusBox?.y) &&
      Number.isFinite(focusBox?.w) &&
      Number.isFinite(focusBox?.h)
    ) {
      entries.push({
        url: imageUrls[imageIndex],
        box: { x: focusBox.x, y: focusBox.y, w: focusBox.w, h: focusBox.h },
      });
    }
  }

  if (entries.length > 0) {
    registerFocusBoxes(entries);
    console.log(
      `🔲 [PreviewJob] Registered ${entries.length} focus box(es) for AI`,
    );
  }
}

// Persist the preview report and user-editable preview_data payload.
async function savePreviewReport(params: {
  reportId?: string;
  user: AssetJobInput["user"];
  details: any;
  uploadedImageUrls: string[];
  videoUrls: string[];
  lots: any[];
  analysis: AssetAnalysisResult | any;
  valuationData: any;
  executionClaim?: {
    generationToken: string;
    executionToken: string;
  };
}): Promise<any> {
  const { reportId, user, details, uploadedImageUrls, analysis, valuationData } =
    params;
  const valuationMethods = normalizeAssetReportValuationMethods(details);
  const reportLocation = resolveAuctionLocation(
    details?.location || details?.inspection_location
  );
  const reportCoordinates =
    getExplicitCoordinates(details) || getAuctionLocationCoordinates(reportLocation);
  const lots = normalizeLotsForBusinessRules(params.lots || [], {
    defaultLocation: reportLocation,
    defaultLatitude: reportCoordinates?.latitude,
    defaultLongitude: reportCoordinates?.longitude,
  });
  const totalValue = (lots || []).reduce((sum: number, lot: any) => {
    const raw =
      typeof lot?.estimated_value === "string" ? lot.estimated_value : "";
    const numericValue = parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
    return sum + (Number.isFinite(numericValue) ? numericValue : 0);
  }, 0);

  const existingReport = reportId ? await AssetReport.findById(reportId) : null;
  if (reportId && !existingReport) {
    throw new Error(`Report ${reportId} not found`);
  }
  const report = existingReport || new AssetReport({ user: user.id });

  report.set({
    user: user.id,
    grouping_mode: details.grouping_mode || "mixed",
    imageUrls: uploadedImageUrls,
    videoUrls: params.videoUrls,
    lots,
    status: "preview",
    job_status: "done",
    job_error: undefined,
    processing_completed_at: new Date(),
    prepared_for: details.prepared_for,
    factors_age_condition: details.factors_age_condition,
    factors_quality: details.factors_quality,
    factors_analysis: details.factors_analysis,
    include_damage_analysis: details.include_damage_analysis !== false,
    bank_photos_enabled: details.bank_photos_enabled === true,
    watermark_images: resolvePhotoWatermark(details.watermark_images),
    damage_analysis:
      details.include_damage_analysis === false
        ? undefined
        : buildPolicySafeReportDamageAnalysis(
            lots,
            details.damage_analysis,
            details.include_damage_analysis !== false
          ),
    preview_data: {
      lots,
      videoUrls: params.videoUrls,
      client_name: details.client_name,
      contract_no: details.contract_no,
      effective_date: details.effective_date,
      appraisal_purpose: details.appraisal_purpose,
      owner_name: details.owner_name,
      appraiser: details.appraiser,
      appraisal_company: details.appraisal_company,
      industry: details.industry,
      inspection_date: details.inspection_date,
      location: reportLocation,
      ...(reportCoordinates
        ? {
            latitude: reportCoordinates.latitude,
            longitude: reportCoordinates.longitude,
          }
        : {}),
      currency: details.currency || "CAD",
      language: details.language || "en",
      include_valuation_table: details.include_valuation_table,
      valuation_methods: valuationMethods,
      valuation_data: valuationData,
      prepared_for: details.prepared_for,
      factors_age_condition: details.factors_age_condition,
      factors_quality: details.factors_quality,
      factors_analysis: details.factors_analysis,
      include_damage_analysis: details.include_damage_analysis !== false,
      bank_photos_enabled: details.bank_photos_enabled === true,
      watermark_images: resolvePhotoWatermark(details.watermark_images),
      damage_analysis:
        details.include_damage_analysis === false
          ? undefined
          : buildPolicySafeReportDamageAnalysis(
              lots,
              details.damage_analysis,
              details.include_damage_analysis !== false
            ),
      total_appraised_value: totalValue,
      total_value: totalValue,
      ...(analysis && typeof analysis === "object"
        ? {
            market_overview: (analysis as any).market_overview,
            comparable_sales: (analysis as any).comparable_sales,
            valuation_explanation: (analysis as any).valuation_explanation,
            condition_notes: (analysis as any).condition_notes,
            recommendations: (analysis as any).recommendations,
          }
        : {}),
    },
    client_name: details.client_name,
    effective_date: details.effective_date,
    appraisal_purpose: details.appraisal_purpose,
    owner_name: details.owner_name,
    appraiser: details.appraiser,
    appraisal_company: details.appraisal_company,
    industry: details.industry,
    currency: details.currency || "CAD",
    language: details.language || "en",
    include_valuation_table: details.include_valuation_table,
    valuation_methods: valuationMethods,
    valuation_data: valuationData,
    analysis,
  });

  if (params.executionClaim && reportId) {
    report.$where = {
      job_id: params.executionClaim.generationToken,
      job_execution_token: params.executionClaim.executionToken,
      job_status: "processing",
    };
  }
  try {
    await report.save();
  } catch (error: any) {
    if (
      params.executionClaim &&
      (error?.name === "DocumentNotFoundError" || error?.name === "VersionError")
    ) {
      throw new AssetPreviewExecutionOwnershipLostError(String(reportId || ""));
    }
    throw error;
  }
  return report;
}

// Run the preview workflow that saves AI output for later approval and file generation.
export async function runAssetPreviewJob(
  {
    reportId,
    user,
    images,
    videos = [],
    details,
    progressId,
  }: AssetJobInput,
  options: AssetPreviewJobRunOptions = {}
) {
  let completed = false;
  const executionContext = options.executionContext;
  const generationToken = String(progressId || "").trim();
  const executionToken = String(executionContext?.executionToken || "").trim();
  const assertAttemptOwned = async (allowCompletedReport = false) => {
    if (!executionContext) return;
    if (!reportId || !generationToken || !executionToken) {
      throw new AssetPreviewExecutionOwnershipLostError(String(reportId || ""));
    }
    await executionContext.assertOwned();
    const ownsReport = await AssetReport.exists({
      _id: reportId,
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: allowCompletedReport
        ? { $in: ["processing", "done"] }
        : "processing",
    });
    if (!ownsReport) {
      throw new AssetPreviewExecutionOwnershipLostError(reportId);
    }
  };
  try {
    if (executionContext && (!reportId || !generationToken || !executionToken)) {
      throw new AssetPreviewExecutionOwnershipLostError(String(reportId || ""));
    }
    if (progressId) {
      if (!executionContext) startProgress(progressId);
      await updateMongoReportJobProgress(progressId, {
        phase: "processing",
        serverProgress01: 0,
        message: "Processing",
        result: reportId
          ? { reportId, reportType: "asset", status: "processing" }
          : undefined,
      });
    }
    if (reportId) {
      if (executionContext) {
        if (!generationToken || !executionToken) {
          throw new AssetPreviewExecutionOwnershipLostError(reportId);
        }
        await executionContext.assertOwned();
        const claimed = await AssetReport.findOneAndUpdate(
          {
            _id: reportId,
            job_id: generationToken,
            job_status: { $in: ["queued", "processing"] },
          },
          {
            $set: {
              job_status: "processing",
              job_execution_token: executionToken,
              processing_started_at: new Date(),
            },
            $unset: { job_error: 1 },
          },
          { new: true }
        );
        if (!claimed) {
          const alreadyCompleted = await AssetReport.exists({
            _id: reportId,
            job_id: generationToken,
            job_status: "done",
          });
          if (alreadyCompleted) {
            await executionContext.assertOwned();
            return;
          }
          throw new AssetPreviewExecutionOwnershipLostError(reportId);
        }
        await assertAttemptOwned();
      } else {
        await AssetReport.findByIdAndUpdate(reportId, {
          job_status: "processing",
          job_error: undefined,
          processing_started_at: new Date(),
        });
      }
      await setReportGenerationProgress({
        kind: "asset",
        reportId,
        progressId,
        generationToken: executionContext ? generationToken : undefined,
        executionToken: executionContext ? executionToken : undefined,
        stage: "uploading",
        progressPercent: 5,
        message: "Preparing uploaded images",
      });
    }

    console.log(
      `[PreviewJob] Uploading ${images.length} images for user ${user.id}`,
    );

    const shouldEnhance = details?.enhance_images === true;
    if (shouldEnhance) {
      console.log("🎨 [PreviewJob] Image enhancement ENABLED");
    }

    const watermarkImages =
      resolvePhotoWatermark(details?.watermark_images);
    const uploadedImageUrls = await uploadPreviewImages(images, watermarkImages, {
      reportId: String(reportId || user.id),
      generationToken: generationToken || String(details?.client_submission_id || "legacy"),
      assertOwned: executionContext ? () => assertAttemptOwned() : undefined,
    });
    const videoUrls = await uploadAssetPreviewVideos(videos, {
      reportId: String(reportId || user.id),
      generationToken: generationToken || String(details?.client_submission_id || "legacy"),
      assertOwned: executionContext ? () => assertAttemptOwned() : undefined,
    });

    await assertAttemptOwned();

    if (reportId) {
      await setReportGenerationProgress({
        kind: "asset",
        reportId,
        progressId,
        generationToken: executionContext ? generationToken : undefined,
        executionToken: executionContext ? executionToken : undefined,
        stage: "analyzing",
        progressPercent: 25,
        message: "Analyzing report images",
      });
    }

    console.log("[PreviewJob] Starting AI analysis");
    const groupingMode: AssetGroupingMode =
      (details.grouping_mode as any) || "mixed";
    const selectedLanguage = details.language || "en";
    const selectedCurrency = details.currency || "CAD";
    let lots: any[] = [];
    let analysis: any = null;
    const bundleDiagnosticsByGroup = new Map<
      number,
      BundleLotAnalysisDiagnostic
    >();
    const imageUrls = uploadedImageUrls;
    const includeDamageAnalysis = details.include_damage_analysis !== false;

    registerPreviewFocusBoxes(imageUrls, details);

    if (groupingMode === "mixed") {
      assertMixedLotPhotoManifest(details?.mixed_lots, imageUrls.length);
      type MixedMap = {
        count: number;
        extraCount: number;
        cover_index?: number;
        mode: "single_lot" | "per_item" | "per_photo";
        sourceKey?: string;
        /** The Schedule A line a split lot descends from — carried unsuffixed. */
        sourceParentKey?: string;
        reviewedLotNumber?: string;
      };
      const rawLots: any[] = Array.isArray(details?.mixed_lots)
        ? details.mixed_lots
        : [];
      const mappings: MixedMap[] = rawLots
        .map((entry: any) => {
          const modeText = String(entry?.mode || "").trim();
          const mode =
            modeText === "per_item" ||
            modeText === "per_photo" ||
            modeText === "single_lot"
              ? (modeText as any)
              : undefined;
          const reviewedLotNumber = details?.smart_upload_grouping_method === "lot_number"
            ? normalizeDetectedBundleLotNumber(entry?.reviewed_lot_number)
            : null;
          return {
            count: Math.max(0, parseInt(String(entry?.count ?? 0), 10) || 0),
            ...(reviewedLotNumber ? { reviewedLotNumber } : {}),
            extraCount: Math.max(
              0,
              parseInt(String(entry?.extra_count ?? entry?.extraCount ?? 0), 10) || 0,
            ),
            cover_index:
              typeof entry?.cover_index === "number"
                ? entry.cover_index
                : typeof entry?.coverIndex === "number"
                  ? entry.coverIndex
                  : 0,
            mode,
            sourceKey:
              typeof entry?.source_key === "string"
                ? entry.source_key.trim() || undefined
                : undefined,
            sourceParentKey:
              typeof entry?.source_parent_key === "string"
                ? entry.source_parent_key.trim() || undefined
                : undefined,
          } as MixedMap;
        })
        .filter(
          (mapping: MixedMap) =>
            Number.isFinite(mapping.count) &&
            mapping.count > 0 &&
            !!mapping.mode,
        );

      const useMappings: MixedMap[] = mappings;

      const lotNumberPhotoInputs = buildBundleLotNumberPhotoInputs(
        useMappings,
        imageUrls,
      );
      if (lotNumberPhotoInputs.length > 0) {
        if (reportId) {
          await setReportGenerationProgress({
            kind: "asset",
            reportId,
            progressId,
            generationToken: executionContext ? generationToken : undefined,
            executionToken: executionContext ? executionToken : undefined,
            stage: "analyzing",
            progressPercent: 24,
            message: "Reading lot numbers",
            currentLot: 0,
            totalLots: lotNumberPhotoInputs.length,
          });
        }
        if (progressId) {
          await updateMongoReportJobProgress(progressId, {
            phase: "processing",
            serverProgress01: 0.24,
            message: "Reading lot numbers",
          });
        }

        await assertAttemptOwned();
        const detectedNumbers =
          await detectBundleLotNumbersFromPhotos(lotNumberPhotoInputs.filter((input) => !useMappings[input.groupIndex]?.reviewedLotNumber));
        await assertAttemptOwned();
        const inputByGroup = new Map(
          lotNumberPhotoInputs.map((input) => [input.groupIndex, input]),
        );
        useMappings.forEach((mapping, groupIndex) => {
          if (mapping.mode !== "single_lot") return;
          bundleDiagnosticsByGroup.set(
            groupIndex,
            resolveBundleLotAnalysisPolicy({
              groupIndex,
              sourceImageIndex: inputByGroup.get(groupIndex)?.sourceImageIndex,
              detectedLotNumber: detectedNumbers.get(groupIndex),
              reviewedLotNumber: mapping.reviewedLotNumber,
              mainImageCount: mapping.count,
            }),
          );
        });
      }

      let base = 0;
      let lotCounter = 0;
      const mixedTrace: any[] = [];
      for (let lotIdx = 0; lotIdx < useMappings.length; lotIdx++) {
        const {
          count,
          extraCount,
          cover_index,
          mode: subMode,
          sourceKey,
          sourceParentKey,
        } = useMappings[lotIdx];
        const end = Math.min(imageUrls.length, base + Math.max(0, count));
        const extraEnd = Math.min(
          imageUrls.length,
          end + Math.max(0, extraCount),
        );
        const mainImageIdxs = Array.from(
          { length: Math.max(0, end - base) },
          (_, index) => base + index,
        );
        const bundleDiagnostic = bundleDiagnosticsByGroup.get(lotIdx);
        const aiLocalIdxs =
          subMode === "single_lot" && bundleDiagnostic
            ? selectBundleAnalysisImageIndexes(
                mainImageIdxs,
                bundleDiagnostic,
              )
            : mainImageIdxs.slice(0, Math.min(30, mainImageIdxs.length));
        const subUrls = aiLocalIdxs.map((index) => imageUrls[index]);
        const extraImageIdxs = Array.from(
          { length: Math.max(0, extraEnd - end) },
          (_, index) => end + index,
        );
        const extraImageUrls = extraImageIdxs
          .map((index) => imageUrls[index])
          .filter(Boolean);
        if (subUrls.length === 0 || !subMode) {
          base = extraEnd;
          continue;
        }
        const pushFallbackMixedLots = (fallbackLots: any[]) => {
          for (const fallbackLot of fallbackLots) {
            lotCounter += 1;
            let nextLot = {
              ...fallbackLot,
              lot_id: `lot-${String(lotCounter).padStart(3, "0")}`,
              ...(bundleDiagnostic
                ? {
                    analysis_metadata: {
                      ...(fallbackLot?.analysis_metadata || {}),
                      bundle_lot_number_detection: bundleDiagnostic,
                    },
                  }
                : {}),
            };
            if (bundleDiagnostic) {
              nextLot = applyAuthoritativeBundleLotNumber(
                nextLot,
                bundleDiagnostic,
              );
            }
            lots.push(nextLot);
          }
        };
        try {
          const groupAnalysis = await analyzeMixedAssetGroupWithFallback({
            analyze: async () => {
              await assertAttemptOwned();
              const result = await analyzeAssetImages(
                subUrls,
                subMode,
                selectedLanguage,
                selectedCurrency,
                includeDamageAnalysis,
              );
              await assertAttemptOwned();
              return result;
            },
            fallbackContext: {
              groupIndex: lotIdx,
              subMode,
              sourceKey,
              sourceParentKey,
              currency: selectedCurrency,
              imageUrls,
              mainImageIndexes: mainImageIdxs,
              extraImageIndexes: extraImageIdxs,
              coverIndex: cover_index,
            },
          });

          if (groupAnalysis.outcome !== "failed") {
            if (!analysis) analysis = { mixed: [] };
            if (!Array.isArray(analysis.mixed)) analysis.mixed = [];
            mixedTrace.push({
              mode: subMode,
              result: groupAnalysis.result,
              ...(bundleDiagnostic
                ? { bundle_lot_number_detection: bundleDiagnostic }
                : {}),
            });
          }
          if (groupAnalysis.outcome === "empty") {
            console.warn(
              `[PreviewJob] AI returned no lot rows for mixed lot #${lotIdx + 1}; preserving submitted lot mapping as fallback.`
            );
          }
          if (groupAnalysis.outcome === "failed") {
            console.error(
              `[PreviewJob] AI analysis failed for mixed lot #${lotIdx + 1} (${subMode}); preserving submitted lot mapping as fallback:`,
              groupAnalysis.error,
            );
          }
          if (groupAnalysis.fallbackLots.length > 0) {
            pushFallbackMixedLots(groupAnalysis.fallbackLots);
          }

          const lotResults = Array.isArray(groupAnalysis.result?.lots)
            ? groupAnalysis.result.lots
            : [];
          for (
            let resultIndex = 0;
            resultIndex < lotResults.length;
            resultIndex += 1
          ) {
            const lot = subMode === "single_lot"
              ? remapBundleItemImages(lotResults[resultIndex], aiLocalIdxs, imageUrls)
              : lotResults[resultIndex] as any;
            const resultSourceKey =
              sourceKey && lotResults.length > 1
                ? `${sourceKey}:${resultIndex + 1}`
                : sourceKey;
            const localIdxs: number[] = Array.isArray(lot?.image_indexes)
              ? Array.from(
                  new Set<number>(
                    (lot.image_indexes as any[])
                      .map((value: any) => parseInt(String(value), 10))
                      .filter(
                        (value: number) =>
                          Number.isFinite(value) &&
                          value >= 0 &&
                          value < aiLocalIdxs.length,
                      ),
                  ),
                )
              : [];
            const mappedIdxs: number[] = localIdxs.map(
              (value) => aiLocalIdxs[value],
            );
            const directIndex = resolveGroupModelImageIndex(lot?.image_url, aiLocalIdxs, imageUrls);
            const directUrl = directIndex === undefined ? undefined : imageUrls[directIndex];
            if (directIndex !== undefined) mappedIdxs.push(directIndex);
            const idxs = Array.from(new Set(mappedIdxs)).filter(
              (value) =>
                Number.isFinite(value) &&
                value >= 0 &&
                value < imageUrls.length,
            );
            const urlsFromIdx = idxs
              .map((index) => imageUrls[index])
              .filter(Boolean);
            const coverLocal = Math.max(
              0,
              Math.min(
                Math.max(0, count) - 1,
                typeof cover_index === "number" ? cover_index : 0,
              ),
            );
            const coverGlobal = base + coverLocal;
            const coverUrl = imageUrls[coverGlobal];
            const urlsSet = new Set<string>([
              ...urlsFromIdx,
              ...(coverUrl ? [coverUrl] : []),
            ]);
            const urls = Array.from(urlsSet);

            if (subMode === "per_photo" && idxs.length > 0) {
              for (const idx of idxs) {
                const photoUrl = imageUrls[idx];
                lotCounter += 1;
                const splitLotId = `lot-${String(lotCounter).padStart(3, "0")}`;
                lots.push({
                  ...lot,
                  lot_id: splitLotId,
                  image_url: photoUrl,
                  image_indexes: [idx],
                  image_urls: [photoUrl],
                  extra_image_indexes: [],
                  extra_image_urls: [],
                  tags: Array.isArray(lot?.tags)
                    ? Array.from(
                        new Set([
                          ...(lot.tags as any[]).map(String),
                          `mode:${subMode}`,
                        ]),
                      )
                    : [`mode:${subMode}`],
                  mixed_group_index: lotIdx + 1,
                  sub_mode: subMode,
                  ...(resultSourceKey
                    ? {
                        auctioneer_source_key: `${resultSourceKey}:photo:${
                          idx + 1
                        }`,
                      }
                    : {}),
                  /*
                     Unsuffixed, unlike the key beside it. Each photo becomes
                     its own lot and needs its own reference, but they all
                     descend from ONE Schedule A line — a suffixed parent would
                     match no line and Auctioneer would refuse the submission.
                  */
                  ...(sourceParentKey
                    ? { auctioneer_source_parent_key: sourceParentKey }
                    : {}),
                });
              }
            } else {
              lotCounter += 1;
              const uniqueLotId = `lot-${String(lotCounter).padStart(3, "0")}`;
              const primaryIdx =
                Array.isArray(idxs) && idxs.length ? idxs[0] : undefined;
              const primaryFromIdx =
                primaryIdx != null ? imageUrls[primaryIdx] : undefined;
              const primaryUrl =
                directUrl || primaryFromIdx || urls[0] || coverUrl || undefined;
              const savedMainIndexes =
                subMode === "single_lot" ? mainImageIdxs : idxs;
              const savedMainUrls = savedMainIndexes
                .map((index) => imageUrls[index])
                .filter(Boolean);
              let nextLot = {
                ...lot,
                lot_id: uniqueLotId,
                image_url:
                  subMode === "per_item"
                    ? primaryUrl
                    : coverUrl || directUrl || urls[0] || undefined,
                image_indexes:
                  subMode === "per_item"
                    ? (() => {
                        if (primaryIdx != null && Number.isFinite(primaryIdx))
                          return [primaryIdx];
                        if (directIndex !== undefined) return [directIndex];
                        return [] as number[];
                      })()
                    : savedMainIndexes,
                image_urls:
                  subMode === "per_item"
                    ? primaryUrl
                      ? [primaryUrl]
                      : []
                    : savedMainUrls,
                extra_image_indexes: extraImageIdxs,
                extra_image_urls: extraImageUrls,
                tags: Array.isArray(lot?.tags)
                  ? Array.from(
                      new Set([
                        ...(lot.tags as any[]).map(String),
                        `mode:${subMode}`,
                      ]),
                    )
                  : [`mode:${subMode}`],
                mixed_group_index: lotIdx + 1,
                sub_mode: subMode,
                ...(resultSourceKey
                  ? { auctioneer_source_key: resultSourceKey }
                  : {}),
                ...(sourceParentKey
                  ? { auctioneer_source_parent_key: sourceParentKey }
                  : {}),
                ...(bundleDiagnostic
                  ? {
                      analysis_metadata: {
                        ...(lot?.analysis_metadata || {}),
                        bundle_lot_number_detection: bundleDiagnostic,
                      },
                    }
                  : {}),
              };
              if (bundleDiagnostic) {
                nextLot = applyAuthoritativeBundleLotNumber(
                  nextLot,
                  bundleDiagnostic,
                );
              }
              lots.push(nextLot);
            }
          }
        } catch (error) {
          if (isExecutionOwnershipLost(error, executionContext)) throw error;
          console.error(
            `[PreviewJob] AI analysis failed for mixed lot #${lotIdx + 1} (${subMode}):`,
            error,
          );
        }
        if (reportId) {
          const completedLots = lotIdx + 1;
          await setReportGenerationProgress({
            kind: "asset",
            reportId,
            progressId,
            generationToken: executionContext ? generationToken : undefined,
            executionToken: executionContext ? executionToken : undefined,
            stage: "analyzing",
            progressPercent: 25 + (completedLots / Math.max(1, useMappings.length)) * 50,
            message: `Analyzed ${completedLots} of ${useMappings.length} lots`,
            currentLot: completedLots,
            totalLots: useMappings.length,
          });
        }
        base = extraEnd;
      }
      analysis = {
        ...(analysis || {}),
        mixed: mixedTrace,
        bundle_lot_number_detection: Array.from(
          bundleDiagnosticsByGroup.values(),
        ),
      };
    } else if (groupingMode === "combined") {
      const urlsForAI = imageUrls.slice(0, 50);
      if (urlsForAI.length > 0) {
        try {
          await assertAttemptOwned();
          const perItemRes = await analyzeAssetImages(
            urlsForAI,
            "per_item",
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis
          );
          await assertAttemptOwned();
          analysis = perItemRes;
          const perItemLots: any[] = (perItemRes?.lots || []).map(
            (lot: any) => {
              const firstIdx =
                Array.isArray(lot?.image_indexes) && lot.image_indexes.length
                  ? lot.image_indexes[0]
                  : undefined;
              return {
                ...lot,
                image_index: Number.isFinite(firstIdx) ? firstIdx : undefined,
              };
            },
          );
          const perPhotoLots: any[] = [];
          for (
            let imageIndex = 0;
            imageIndex < imageUrls.length;
            imageIndex++
          ) {
            const match = perItemLots.find(
              (lot: any) =>
                Array.isArray(lot?.image_indexes) &&
                lot.image_indexes.includes(imageIndex),
            );
            if (match) perPhotoLots.push({ ...match, image_index: imageIndex });
          }
          lots = perItemLots;
          (analysis as any).combined = {
            per_item: perItemLots,
            per_photo: perPhotoLots,
            single_lot: perItemLots,
          };
          (analysis as any).combined_modes = [
            "single_lot",
            "per_item",
            "per_photo",
          ];
        } catch (error) {
          if (isExecutionOwnershipLost(error, executionContext)) throw error;
          console.error(
            "[PreviewJob] Error during combined AI analysis:",
            error,
          );
        }
      }
    } else {
      const mainImageIndexes = imageUrls.map((_, index) => index);
      let bundleDiagnostic: BundleLotAnalysisDiagnostic | undefined;
      if (groupingMode === "single_lot") {
        const detectorInputs = buildBundleLotNumberPhotoInputs(
          [{ count: imageUrls.length, mode: "single_lot" }],
          imageUrls,
        );
        await assertAttemptOwned();
        const detectedNumbers = await detectBundleLotNumbersFromPhotos(detectorInputs);
        await assertAttemptOwned();
        bundleDiagnostic = resolveBundleLotAnalysisPolicy({
          groupIndex: 0,
          sourceImageIndex: detectorInputs[0]?.sourceImageIndex,
          detectedLotNumber: detectedNumbers.get(0),
          mainImageCount: imageUrls.length,
        });
        bundleDiagnosticsByGroup.set(0, bundleDiagnostic);
      }
      const analyzedImageIndexes = bundleDiagnostic
        ? selectBundleAnalysisImageIndexes(mainImageIndexes, bundleDiagnostic)
        : mainImageIndexes.slice(0, 50);
      const urlsForAI = analyzedImageIndexes.map((index) => imageUrls[index]);
      if (urlsForAI.length > 0) {
        try {
          await assertAttemptOwned();
          const baseRes = await analyzeAssetImages(
            urlsForAI,
            groupingMode,
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis
          );
          await assertAttemptOwned();
          analysis = baseRes;
          lots = (baseRes?.lots || []).map((lot: any) => {
            if (bundleDiagnostic) {
              const coverIndex = Number(details.cover_index ?? details.coverIndex ?? 0);
              const coverUrl = imageUrls[Number.isInteger(coverIndex) ? coverIndex : 0] || imageUrls[0];
              return applyAuthoritativeBundleLotNumber({
                ...remapBundleItemImages(lot, analyzedImageIndexes, imageUrls),
                image_url: coverUrl,
                image_indexes: mainImageIndexes,
                image_urls: [...imageUrls],
                sub_mode: "single_lot",
                mixed_group_index: 1,
                analysis_metadata: {
                  ...(lot?.analysis_metadata || {}),
                  bundle_lot_number_detection: bundleDiagnostic,
                },
              }, bundleDiagnostic);
            }
            const total = imageUrls.length;
            const idxs: number[] = Array.isArray(lot?.image_indexes)
              ? Array.from(
                  new Set<number>(
                    (lot.image_indexes as any[])
                      .map((value: any) => parseInt(String(value), 10))
                      .filter(
                        (value: number) =>
                          Number.isFinite(value) && value >= 0 && value < total,
                      ),
                  ),
                )
              : [];
            const directUrl: string | undefined =
              typeof lot?.image_url === "string" && lot.image_url
                ? lot.image_url
                : undefined;
            if (groupingMode === "per_item" && directUrl) {
              const inferred = imageUrls.indexOf(directUrl);
              if (inferred >= 0) {
                if (idxs.length === 0 || idxs[0] !== inferred) {
                  idxs.splice(0, idxs.length, inferred);
                }
              }
            }
            if (idxs.length === 0 && directUrl) {
              const inferred = imageUrls.indexOf(directUrl);
              if (inferred >= 0) idxs.push(inferred);
            }
            let urls: string[] = [];
            if (groupingMode === "per_item") {
              const primaryUrl =
                directUrl || (idxs[0] != null ? imageUrls[idxs[0]] : undefined);
              urls = primaryUrl ? [primaryUrl] : [];
            } else {
              const urlsSet = new Set<string>([
                ...idxs.map((index) => imageUrls[index]).filter(Boolean),
                ...(directUrl ? [directUrl] : []),
              ]);
              urls = Array.from(urlsSet);
            }
            return { ...lot, image_indexes: idxs, image_urls: urls };
          });
          if (bundleDiagnostic) {
            analysis = {
              ...(analysis || {}),
              bundle_lot_number_detection: [bundleDiagnostic],
            };
          }
        } catch (error) {
          if (isExecutionOwnershipLost(error, executionContext)) throw error;
          console.error("[PreviewJob] Error during asset AI analysis:", error);
        }
      }
    }

    clearFocusBoxes();

    lots = normalizeLotsForReportOrdering(lots.map(markInitialLotNumberFallback), groupingMode);
    if (reportId) {
      lots = await mergeCanonicalAuctioneerSourceLots({
        reportId,
        reportType: "asset",
        lots,
      });
    }

    if (Array.isArray(lots) && lots.length) {
      try {
        await assertAttemptOwned();
        lots = await enrichLotsWithVin(lots);
        await assertAttemptOwned();
      } catch (error) {
        if (isExecutionOwnershipLost(error, executionContext)) throw error;
        console.error("[PreviewJob] VIN enrichment failed:", error);
      }
    }

    if (reportId) {
      await setReportGenerationProgress({
        kind: "asset",
        reportId,
        progressId,
        generationToken: executionContext ? generationToken : undefined,
        executionToken: executionContext ? executionToken : undefined,
        stage: "building_preview",
        progressPercent: 86,
        message: "Building preview",
        currentLot: lots.length,
        totalLots: lots.length,
      });
    }

    if (Array.isArray(lots) && lots.length) {
      try {
        if (progressId) {
          await updateMongoReportJobProgress(progressId, {
            phase: "processing",
            serverProgress01: 0.82,
            message: "Enriching auction specs",
          });
        }
        await assertAttemptOwned();
        const enrichment = await enrichAuctioneerImportSpecs({
          lots,
          currency: selectedCurrency,
          location: details?.location || details?.inspection_location,
          mode: "pictureOnly",
        });
        await assertAttemptOwned();
        lots = enrichment.lots;
        analysis = {
          ...(analysis || {}),
          auctioneer_import_enrichment: enrichment.analyses,
        };
      } catch (error) {
        if (isExecutionOwnershipLost(error, executionContext)) throw error;
        console.error("[PreviewJob] Auctioneer Import spec enrichment failed:", error);
        lots = lots.map((lot) => normalizeAuctioneerLotSpecs(lot));
      }
    }

    // Later normalization/enrichment may copy an AI lot number. Reapply the
    // dedicated lot-number-photo identity so general enrichment cannot replace it.
    if (bundleDiagnosticsByGroup.size > 0) {
      lots = lots.map((lot) => {
        if (lot?.sub_mode !== "single_lot") return lot;
        const groupIndex = Number(lot?.mixed_group_index) - 1;
        const diagnostic = bundleDiagnosticsByGroup.get(groupIndex);
        if (!diagnostic) return lot;
        return applyAuthoritativeBundleLotNumber(
          {
            ...lot,
            analysis_metadata: {
              ...(lot?.analysis_metadata || {}),
              bundle_lot_number_detection: diagnostic,
            },
          },
          diagnostic,
        );
      });
    }

    // Assign event-scoped numbers only during initial analysis, after enrichment
    // has finished. Saves, file retries and delivery retain reviewed identities.
    lots = assignAssetLotVideos(lots, videos, videoUrls, details);
    if (reportId) {
      lots = await allocateInitialAuctioneerLotNumbers({
        reportId,
        reportType: "asset",
        lots,
        fallbackIndexes: initialLotNumberFallbackIndexes(lots),
        assertOwned: assertAttemptOwned,
      });
    }

    let valuationData = null;
    if (
      details.include_valuation_table &&
      details.valuation_methods?.length > 0
    ) {
      const { generateComparisonTableWithAI } = await import(
        "../../service/assetValuationService.js"
      );
      const totalFMV = (lots || []).reduce((sum, lot) => {
        const value = lot.estimated_value?.replace(/[^0-9.-]+/g, "") || "0";
        return sum + parseFloat(value);
      }, 0);
      await assertAttemptOwned();
      valuationData = await generateComparisonTableWithAI(
        totalFMV,
        details.valuation_methods,
        (lots?.[0]?.title as any) || "Asset",
        (lots?.[0]?.description as any) || "",
        (lots?.[0]?.condition as any) || "Good",
        details.industry || "General",
      );
      await assertAttemptOwned();
    }

    await assertAttemptOwned();
    const newReport = await savePreviewReport({
      reportId,
      user,
      details,
      uploadedImageUrls,
      videoUrls,
      lots,
      analysis,
      valuationData,
      ...(executionContext
        ? {
            executionClaim: {
              generationToken,
              executionToken,
            },
          }
        : {}),
    });
    await assertAttemptOwned(true);
    await setReportGenerationProgress({
      kind: "asset",
      reportId: String(newReport._id),
      progressId,
      generationToken: executionContext ? generationToken : undefined,
      executionToken: executionContext ? executionToken : undefined,
      stage: "ready",
      progressPercent: 100,
      message: "Preview ready",
      currentLot: lots.length,
      totalLots: lots.length,
    });

    console.log(
      `[PreviewJob] Report saved with ID: ${newReport._id}, Status: preview`,
    );
    if (progressId) {
      const progressPatch = {
        serverProgress01: 1,
        message: "Preview ready",
        result: {
          reportId: String(newReport._id),
          reportType: "asset",
          status: "preview",
        },
      };
      if (!executionContext) updateProgress(progressId, progressPatch);
      await updateMongoReportJobProgress(progressId, progressPatch);
    }

    if (!details?.draft_preview) {
      await assertAttemptOwned(true);
      console.log(`[PreviewJob] Sending preview ready email to ${user.email}...`);
      try {
      const { sendPreviewReadyEmail } = await import(
        "../../service/assetEmailService.js"
      );
      await sendPreviewReadyEmail(
        user.email,
        user.name || "User",
        String(newReport._id),
      );
      console.log(`📧 Preview ready email sent to ${user.email}`);
      } catch (emailError) {
        if (isExecutionOwnershipLost(emailError, executionContext)) {
          throw emailError;
        }
        console.error(
          "[PreviewJob] Failed to send preview ready email:",
          emailError,
        );
      }
    }

    if (progressId) {
      if (!executionContext) endProgress(progressId, true, "Preview ready");
      await endMongoReportJobProgress(progressId, true, "Preview ready");
    }

    if (executionContext) {
      await executionContext.assertOwned();
      const released = await AssetReport.updateOne(
        {
          _id: String(newReport._id),
          job_id: generationToken,
          job_execution_token: executionToken,
          job_status: "done",
        },
        { $unset: { job_execution_token: 1 } }
      );
      if (released.matchedCount !== 1) {
        throw new AssetPreviewExecutionOwnershipLostError(String(newReport._id));
      }
    }

    console.log(
      `[PreviewJob] Completed successfully for report ${newReport._id}`,
    );
    completed = true;
  } catch (error) {
    console.error("[PreviewJob] Error:", error);
    clearFocusBoxes();
    const ownershipLost = isExecutionOwnershipLost(error, executionContext);
    if (reportId && !ownershipLost) {
      try {
        const message = error instanceof Error ? error.message : String(error);
        const willRetry = options.willRetryOnError === true;
        await AssetReport.findOneAndUpdate(
          {
            _id: reportId,
            ...(executionContext
              ? {
                  job_id: generationToken,
                  job_execution_token: executionToken,
                  job_status: { $ne: "done" },
                }
              : {}),
          },
          {
            $set: {
              status: willRetry ? "processing" : "error",
              job_status: willRetry ? "queued" : "error",
              job_error: willRetry ? `Retrying after error: ${message}` : message,
              ...(willRetry
                ? { queued_at: new Date() }
                : { processing_completed_at: new Date() }),
              "generation_progress.stage": willRetry ? "queued" : "error",
              "generation_progress.progressPercent": willRetry ? 1 : 100,
              "generation_progress.message": willRetry
                ? `Retrying after error: ${message}`
                : message,
              "generation_progress.updatedAt": new Date(),
            },
          }
        );
      } catch (saveError) {
        console.error("[PreviewJob] Failed to persist error state:", saveError);
      }
    }
    if (progressId && !ownershipLost) {
      if (!executionContext) endProgress(progressId, false, "Error processing request");
      await endMongoReportJobProgress(progressId, false, "Error processing request");
    }
    throw error;
  } finally {
    // Durable handlers defer this until completeJob's execution-token CAS wins.
    // A stale successful attempt must leave shared local inputs for its winner.
    if (completed && !options.deferSourceFileCleanup) {
      await cleanupMulterFiles([...images, ...videos]);
    }
  }
}
