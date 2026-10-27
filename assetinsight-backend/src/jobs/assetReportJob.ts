import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import {
  getR2PublicUrl,
  uploadToR2,
  uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";
import {
  isHeicLikeImage,
  prepareImageWithoutWatermark,
  processImageWithLogo,
} from "../utils/imageProcessing.js";
import AssetReport from "../models/asset.model.js";
import PdfReport from "../models/pdfReport.model.js";
import { analyzeAssetImages } from "../service/assetOpenAIService.js";
import { normalizeAssetReportValuationMethods } from "../utils/assetValuationSelection.js";
import {
  registerFocusBoxes,
  clearFocusBoxes,
  type FocusBoxRect,
} from "../service/assetOpenAIService/imageUtils.js";
import { generateAssetDocxFromReport } from "../service/assetDocxService.js";
import User from "../models/user.model.js";
import { generateAssetPdfFromReport } from "../service/assetPdfService.js";
import { generateAssetXlsxFromReport } from "../service/xlsx/assetXlsxService.js";
import { generateAndUploadScheduleAPdf } from "../service/scheduleAReportPdfService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../service/auctioneerSpecSheetPdfService.js";
import {
  startProgress,
  updateProgress,
  endProgress,
  type StepRec as StoreStepRec,
} from "../utils/progressStore.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import fs from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";
import archiver from "archiver";
import { enrichLotsWithVin } from "../service/vehicleApiService.js";
import { enrichAuctioneerImportSpecs } from "../service/lotListingSpecEnrichmentService.js";
import {
  assignReportApprover,
  sendAssignedApprovalEmail,
} from "../service/approvalAssignmentService.js";
import { buildReportDamageAnalysis } from "../utils/assetDamageAnalysis.js";
import { normalizeLotsForReportOrdering } from "./assetReportJob/lotOrdering.js";
import { buildLotImageNameMaps, buildOrderedLotImageZipEntries } from "./assetReportJob/imageNaming.js";
import type { AssetGroupingMode, AssetJobInput } from "./assetReportJob/types.js";
import { enqueueReportJob } from "../utils/reportJobQueue.js";
import { remapBundleItemImages, runAssetPreviewJob } from "./assetReportJob/previewJob.js";
import {
  applyAuthoritativeBundleLotNumber,
  buildBundleLotNumberPhotoInputs,
  detectBundleLotNumbersFromPhotos,
  normalizeDetectedBundleLotNumber,
  reapplyBundleLotNumberDiagnostics,
  resolveBundleLotAnalysisPolicy,
  selectBundleAnalysisImageIndexes,
  type BundleLotAnalysisDiagnostic,
} from "../service/bundleLotAnalysisPolicy.js";
import {
  buildReportJobOutbox,
  createMongoReportJob,
  ensureReportJobOutbox,
  type ReportJobOutbox,
  shouldUseMongoReportQueue,
} from "../utils/reportJobMongoQueue.js";
import { serializeMulterFiles } from "../utils/multerFileSerialization.js";
import { buildReportArtifactFilenames } from "../utils/reportArtifactNames.js";
import { assignAssetLotVideos, buildAssetVideoZipInputs, uploadAssetPreviewVideos } from "./assetReportJob/videos.js";
import { readMulterFileBuffer } from "../utils/reportTempFiles.js";
import { assertMixedLotPhotoManifest, resolveGroupModelImageIndex } from "../utils/mixedLotPhotoManifest.js";

export type { AssetGroupingMode, AssetJobInput } from "./assetReportJob/types.js";
export { generateImagesZip } from "./assetReportJob/imagesZip.js";
export {
  buildAssetPreviewFilesJobOutbox,
  queuePreviewFilesJob,
  runPreviewFilesJob,
} from "./assetReportJob/previewFilesJob.js";
export { runAssetPreviewJob };
export { queueDocxGenerationJob, runDocxGenerationJob } from "./assetReportJob/docxGenerationJob.js";

function assetPreviewQueueInput(input: AssetJobInput) {
  const submissionAttemptId = String(input.submissionAttemptId || "").trim();
  const idempotencyKey = input.details?.upload_session_id
    ? `asset-upload:${String(input.details.upload_session_id)}`
    : input.reportId && input.details?.client_submission_id
      ? `asset-preview:${String(input.reportId)}:${String(input.details.client_submission_id)}${
          submissionAttemptId ? `:${submissionAttemptId}` : ""
        }`
      : input.reportId && input.progressId
        ? `asset-preview:${String(input.reportId)}:${String(input.progressId)}`
        : undefined;
  return {
    type: "asset-preview" as const,
    reportId: input.reportId,
    progressId: input.progressId,
    // Temp files live on the same persistent server volume, so both direct
    // and multipart submissions can safely resume after a PM2 restart.
    maxAttempts: 3,
    targetStatus: "preview" as const,
    idempotencyKey,
    payload: {
      reportId: input.reportId,
      user: input.user,
      images: serializeMulterFiles(input.images),
      videos: serializeMulterFiles(input.videos),
      details: input.details,
      progressId: input.progressId,
      ...(submissionAttemptId ? { submissionAttemptId } : {}),
    },
  };
}

export function buildAssetPreviewJobOutbox(
  input: AssetJobInput
): ReportJobOutbox {
  if (!input.reportId || !input.progressId) {
    throw new Error("Asset preview outbox requires report and progress IDs");
  }
  const queueInput = assetPreviewQueueInput(input);
  if (!queueInput.idempotencyKey) {
    throw new Error("Asset preview outbox requires an idempotency key");
  }
  return buildReportJobOutbox({
    ...queueInput,
    idempotencyKey: queueInput.idempotencyKey,
  });
}

export async function queueAssetPreviewJob(input: AssetJobInput): Promise<any> {
  if (shouldUseMongoReportQueue()) {
    if (input.reportJobOutboxToken && input.reportId) {
      const ensured = await ensureReportJobOutbox(
        "asset",
        input.reportId,
        input.reportJobOutboxToken
      );
      if (!ensured) {
        throw Object.assign(
          new Error("The Asset preview outbox is no longer current."),
          { code: "ASSET_PREVIEW_OUTBOX_CHANGED", statusCode: 409 }
        );
      }
      return ensured;
    }
    return createMongoReportJob(assetPreviewQueueInput(input));
  }

  enqueueReportJob(`asset-preview:${input.reportId || input.progressId || "new"}`, () =>
    runAssetPreviewJob(input).catch((e) => {
      if (input.progressId)
        endProgress(input.progressId, false, "Error processing request");
      console.error("Asset preview job failed:", e);
    }),
  );
  return undefined;
}

export function queueAssetReportJob(input: AssetJobInput) {
  // Run in background without awaiting response lifecycle
  enqueueReportJob("asset-report", () =>
    runAssetReportJob(input).catch((e) => {
      if (input.progressId)
        endProgress(input.progressId, false, "Error processing request");
      console.error("Asset job failed:", e);
    }),
  );
}

export async function runAssetReportJob({
  user,
  images,
  videos = [],
  details,
  progressId,
}: AssetJobInput) {
  type StepRec = {
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  };
  const steps: StepRec[] = [];

  if (progressId) startProgress(progressId);
  const syncStoreSteps = () => {
    if (!progressId) return;
    updateProgress(progressId, { steps: steps as unknown as StoreStepRec[] });
  };
  const setServerProg01 = (v: number) => {
    if (!progressId) return;
    const clamped = Math.max(0, Math.min(1, v));
    updateProgress(progressId, { serverProgress01: clamped });
  };
  const SERVER_WEIGHTS = {
    r2_upload: 0.18,
    ai_analysis: 0.48,
    rename_images_by_lot: 0.04,
    generate_pdf: 0.12,
    generate_spec_pdf: 0.04,
    generate_docx: 0.12,
    generate_xlsx: 0.06,
    save_pdf_file: 0.02,
    save_spec_pdf_file: 0.01,
    save_docx_file: 0.02,
    save_xlsx_file: 0.01,
    save_images_folder: 0.02,
    zip_images: 0.02,
    create_pdf_record: 0.0,
    create_spec_pdf_record: 0.0,
    create_docx_record: 0.0,
    create_xlsx_record: 0.0,
    create_images_record: 0.0,
    finalize: 0,
  } as const;
  let serverAccum = 0;
  const startStep = (key: string, label: string) => {
    steps.push({ key, label, startedAt: new Date().toISOString() });
    syncStoreSteps();
  };
  const endStep = (key: string) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.key === key && !s.endedAt) {
        s.endedAt = new Date().toISOString();
        const start = s.startedAt
          ? new Date(s.startedAt).getTime()
          : Date.now();
        s.durationMs = new Date(s.endedAt).getTime() - start;
        break;
      }
    }
    syncStoreSteps();
    if ((SERVER_WEIGHTS as any)[key] != null) {
      serverAccum = Math.min(1, serverAccum + (SERVER_WEIGHTS as any)[key]);
      setServerProg01(serverAccum);
    }
  };

  async function withStep<T>(
    key: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    startStep(key, label);
    try {
      return await fn();
    } finally {
      endStep(key);
    }
  }

  try {
    const groupingMode: AssetGroupingMode =
      details?.grouping_mode === "per_item" ||
      details?.grouping_mode === "per_photo" ||
      details?.grouping_mode === "catalogue" ||
      details?.grouping_mode === "combined" ||
      details?.grouping_mode === "mixed"
        ? details.grouping_mode
        : "single_lot";

    const imageUrls: string[] = [];
    const selectedLanguage: "en" | "fr" | "es" = ((): any => {
      const l = String(details?.language || "").toLowerCase();
      return l === "fr" || l === "es" ? l : "en";
    })();
    const selectedCurrency: string = ((): string => {
      const c = String(details?.currency || "").toUpperCase();
      return /^[A-Z]{3}$/.test(c) ? c : "CAD";
    })();
    // Check if image enhancement is enabled
    const shouldEnhance = details?.enhance_images === true;
    const watermarkImages =
      resolvePhotoWatermark(details?.watermark_images);
    if (shouldEnhance) {
      console.log(`🎨 Image enhancement ENABLED`);
    }

    if (images?.length) {
      startStep("r2_upload", "Uploading images to storage");
      const total = images.length;
      for (let idx = 0; idx < images.length; idx++) {
        const file = images[idx];
        const timestamp = Date.now();
        // Resolve original buffer robustly
        const anyFile = file as any;
        let inputBuffer: Buffer | null = null;
        if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
          inputBuffer = anyFile.buffer as Buffer;
        } else if (typeof anyFile?.path === "string") {
          try {
            inputBuffer = await fs.readFile(anyFile.path);
          } catch {}
        }

        let fileUrl: string;
        if (inputBuffer) {
          try {
            // Add logo watermark - preserve original quality (no resize/compression)
            // Compression is done later in admin gallery with custom settings
            const prepared = watermarkImages
              ? {
                  ...(await processImageWithLogo(
                    inputBuffer,
                    "public/logoNobg.png",
                  )),
                  mimetype: "image/jpeg",
                  extension: ".jpg",
                }
              : await prepareImageWithoutWatermark(
                  inputBuffer,
                  file.mimetype,
                  file.originalname,
                );
            const safeBase = String(file.originalname || `image-${idx + 1}`)
              .replace(/[^a-zA-Z0-9._-]/g, "-")
              .replace(/\.[^./\\]+$/, "");
            const fileName = `uploads/asset/${timestamp}-${safeBase}${prepared.extension}`;
            await uploadBufferToR2(
              prepared.buffer,
              prepared.mimetype,
              process.env.R2_BUCKET_NAME!,
              fileName,
            );
            fileUrl = getR2PublicUrl(fileName);
            console.log(
              `${watermarkImages ? "✅ Watermark added to" : "✅ Original stored for"} image ${idx + 1}/${total}`,
            );
          } catch (procErr) {
            if (isHeicLikeImage(inputBuffer, file.mimetype, file.originalname)) {
              throw new Error(
                `Unable to convert HEIC image "${file.originalname || `#${idx + 1}`}" to JPEG.`
              );
            }
            if (!watermarkImages) throw procErr;
            console.warn(
              `⚠️  Logo processing failed for image ${idx + 1}, using original:`,
              procErr,
            );
            const fileName = `uploads/asset/${timestamp}-${file.originalname}`;
            await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
            fileUrl = getR2PublicUrl(fileName);
          }
        } else {
          // Fallback to original upload method
          const fileName = `uploads/asset/${timestamp}-${file.originalname}`;
          await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
          fileUrl = getR2PublicUrl(fileName);
        }
        imageUrls.push(fileUrl);
        if (progressId) {
          const partial = (idx + 1) / total;
          const current = serverAccum + partial * SERVER_WEIGHTS.r2_upload;
          setServerProg01(current);
        }
      }
      endStep("r2_upload");
    }

    // Register focus boxes for AI analysis (red rectangle drawn on AI copy only)
    const rawFocusBoxes: any[] = Array.isArray(details?.focus_boxes)
      ? details.focus_boxes
      : [];
    if (rawFocusBoxes.length > 0 && imageUrls.length > 0) {
      const entries: Array<{ url: string; box: FocusBoxRect }> = [];
      for (const fb of rawFocusBoxes) {
        const idx = Number(fb?.imageIndex);
        if (
          Number.isFinite(idx) &&
          idx >= 0 &&
          idx < imageUrls.length &&
          Number.isFinite(fb?.x) &&
          Number.isFinite(fb?.y) &&
          Number.isFinite(fb?.w) &&
          Number.isFinite(fb?.h)
        ) {
          entries.push({
            url: imageUrls[idx],
            box: { x: fb.x, y: fb.y, w: fb.w, h: fb.h },
          });
        }
      }
      if (entries.length > 0) {
        registerFocusBoxes(entries);
        console.log(`🔲 Registered ${entries.length} focus box(es) for AI`);
      }
    }

    let analysis: any = null;
    let lots: any[] = [];
    const bundleDiagnosticsByGroup = new Map<number, BundleLotAnalysisDiagnostic>();
    const includeDamageAnalysis = details?.include_damage_analysis !== false;

    if (groupingMode === "catalogue") {
      // Parse mapping from details
      const rawLots: any[] = Array.isArray(details?.catalogue_lots)
        ? details.catalogue_lots
        : [];
      type LotMap = { count: number; cover_index?: number };
      const mappings: LotMap[] = rawLots
        .map((x: any) => ({
          count: Math.max(0, parseInt(String(x?.count ?? 0), 10) || 0),
          cover_index:
            typeof x?.cover_index === "number"
              ? x.cover_index
              : typeof x?.coverIndex === "number"
                ? x.coverIndex
                : 0,
        }))
        .filter((m: LotMap) => Number.isFinite(m.count) && m.count > 0);

      // Fallback: if mapping missing/invalid, treat all as one lot
      const totalImages = imageUrls.length;
      const sum = mappings.reduce((s, m) => s + m.count, 0);
      const useMappings: LotMap[] =
        mappings.length > 0 && sum <= totalImages
          ? mappings
          : totalImages > 0
            ? [{ count: Math.min(20, totalImages), cover_index: 0 }]
            : [];

      // Adjust last mapping to consume remaining images (if any shortfall)
      const mappedSum = useMappings.reduce((s, m) => s + m.count, 0);
      if (mappedSum < totalImages && useMappings.length > 0) {
        useMappings[useMappings.length - 1].count += totalImages - mappedSum;
      }

      // Analyze each lot independently using catalogue prompt
      startStep("ai_analysis", "Software analysis of images (catalogue)");
      let base = 0;
      for (let lotIdx = 0; lotIdx < useMappings.length; lotIdx++) {
        const { count, cover_index } = useMappings[lotIdx];
        // End of this lot in GLOBAL terms must always respect the original count
        const end = Math.min(imageUrls.length, base + Math.max(0, count));

        // For AI, we can limit the number of images to analyze (performance),
        // but we will still assign the FULL range of indexes to the lot below.
        const aiEnd = Math.min(end, base + Math.max(0, Math.min(50, count)));
        const aiLocalIdxs = Array.from(
          { length: Math.max(0, aiEnd - base) },
          (_, i) => base + i,
        );
        const subUrls = aiLocalIdxs.map((i) => imageUrls[i]);

        if (subUrls.length === 0) {
          base = end;
          continue;
        }

        try {
          const aiRes = await analyzeAssetImages(
            subUrls,
            "catalogue",
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis,
          );
          if (!analysis) analysis = { per_lot: [] };
          analysis.per_lot.push(aiRes);

          const lotResults = Array.isArray(aiRes?.lots) ? aiRes.lots : [];
          for (const lot of lotResults as any[]) {
            // Build FULL global index range for this lot (not limited by AI subset)
            const mappedIdxs = Array.from(
              { length: Math.max(0, end - base) },
              (_, i) => base + i,
            );
            const urlsFromIdx = mappedIdxs
              .map((gi) => imageUrls[gi])
              .filter(Boolean);

            // Determine cover image: client-provided within lot range; default 0
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

            // Ensure unique, sequential lot IDs across the whole report
            const uniqueLotId = `lot-${String(lotIdx + 1).padStart(3, "0")}`;

            // Map per-item image references (if provided) from local index -> global index/url
            let itemsOut: any[] | undefined = undefined;
            if (Array.isArray(lot?.items)) {
              itemsOut = (lot.items as any[]).map(
                (it: any, itemIdx: number) => {
                  const {
                    image_local_index,
                    image_url: aiItemUrl,
                    ...rest
                  } = it || {};
                  let globalIdx: number | undefined = undefined;
                  if (Number.isFinite(image_local_index)) {
                    const local = Math.max(0, Math.floor(image_local_index));
                    // image_local_index is relative to subUrls order
                    if (local >= 0 && local < aiLocalIdxs.length) {
                      globalIdx = aiLocalIdxs[local];
                    }
                  }
                  // Fallback: assign a distinct-ish index from the full mapped range
                  if (globalIdx == null && mappedIdxs.length > 0) {
                    // Distribute items across available images in a round-robin fashion
                    globalIdx = mappedIdxs[itemIdx % mappedIdxs.length];
                  }
                  const resolvedUrl: string | undefined =
                    typeof aiItemUrl === "string" && aiItemUrl
                      ? aiItemUrl
                      : globalIdx != null
                        ? imageUrls[globalIdx]
                        : undefined;
                  return {
                    ...rest,
                    image_index: globalIdx,
                    image_url: resolvedUrl,
                  };
                },
              );
            }

            lots.push({
              ...lot,
              lot_id: uniqueLotId,
              image_url: coverUrl || lot?.image_url || urls[0] || undefined,
              image_indexes: mappedIdxs,
              image_urls: urls,
              ...(itemsOut ? { items: itemsOut } : {}),
            });
          }
        } catch (e) {
          console.error(
            `AI analysis failed for catalogue lot #${lotIdx + 1}:`,
            e,
          );
        }

        // Partial progress update within AI phase
        if (progressId) {
          const partial = (lotIdx + 1) / useMappings.length;
          const current = serverAccum + partial * SERVER_WEIGHTS.ai_analysis;
          setServerProg01(current);
        }

        // Advance base by the ORIGINAL count to keep subsequent lots aligned
        base = end;
      }
      endStep("ai_analysis");
    } else if (groupingMode === "mixed") {
      assertMixedLotPhotoManifest(details?.mixed_lots, imageUrls.length);
      // Mixed mode: multiple lots with specified sub-mode each
      type MixedMap = {
        count: number;
        extraCount: number;
        cover_index?: number;
        mode: "single_lot" | "per_item" | "per_photo";
        reviewedLotNumber?: string;
      };
      const rawLots: any[] = Array.isArray(details?.mixed_lots)
        ? details.mixed_lots
        : [];
      const mappings: MixedMap[] = rawLots
        .map((x: any) => {
          const m = String(x?.mode || "").trim();
          const mode =
            m === "per_item" || m === "per_photo" || m === "single_lot"
              ? (m as any)
              : undefined;
          const reviewedLotNumber = details?.smart_upload_grouping_method === "lot_number"
            ? normalizeDetectedBundleLotNumber(x?.reviewed_lot_number)
            : null;
          return {
            count: Math.max(0, parseInt(String(x?.count ?? 0), 10) || 0),
            extraCount: Math.max(
              0,
              parseInt(String(x?.extra_count ?? x?.extraCount ?? 0), 10) || 0,
            ),
            cover_index:
              typeof x?.cover_index === "number"
                ? x.cover_index
                : typeof x?.coverIndex === "number"
                  ? x.coverIndex
                  : 0,
            mode,
            ...(reviewedLotNumber ? { reviewedLotNumber } : {}),
          } as MixedMap;
        })
        .filter(
          (m: MixedMap) => Number.isFinite(m.count) && m.count > 0 && !!m.mode,
        );

      const useMappings: MixedMap[] = mappings;

      if (useMappings.length > 0)
        startStep("ai_analysis", "Software analysis of images (mixed)");
      const detectorInputs = buildBundleLotNumberPhotoInputs(useMappings, imageUrls);
      const detectedNumbers = await detectBundleLotNumbersFromPhotos(detectorInputs.filter((input) => !useMappings[input.groupIndex]?.reviewedLotNumber));
      const detectorInputByGroup = new Map(detectorInputs.map((input) => [input.groupIndex, input]));
      useMappings.forEach((mapping, groupIndex) => {
        if (mapping.mode !== "single_lot") return;
        bundleDiagnosticsByGroup.set(groupIndex, resolveBundleLotAnalysisPolicy({
          groupIndex,
          sourceImageIndex: detectorInputByGroup.get(groupIndex)?.sourceImageIndex,
          detectedLotNumber: detectedNumbers.get(groupIndex),
          reviewedLotNumber: mapping.reviewedLotNumber,
          mainImageCount: mapping.count,
        }));
      });
      let base = 0;
      let lotCounter = 0;
      for (let lotIdx = 0; lotIdx < useMappings.length; lotIdx++) {
        const {
          count,
          extraCount,
          cover_index,
          mode: subMode,
        } = useMappings[lotIdx];
        const end = Math.min(imageUrls.length, base + Math.max(0, count));
        const extraEnd = Math.min(
          imageUrls.length,
          end + Math.max(0, extraCount),
        );

        const mainImageIndexes = Array.from(
          { length: Math.max(0, end - base) },
          (_, i) => base + i,
        );
        const bundleDiagnostic = bundleDiagnosticsByGroup.get(lotIdx);
        const aiLocalIdxs = bundleDiagnostic
          ? selectBundleAnalysisImageIndexes(mainImageIndexes, bundleDiagnostic)
          : mainImageIndexes.slice(0, 50);
        const subUrls = aiLocalIdxs.map((i) => imageUrls[i]);

        // Collect extra images (not sent to AI)
        const extraImageIdxs = Array.from(
          { length: Math.max(0, extraEnd - end) },
          (_, i) => end + i,
        );
        const extraImageUrls = extraImageIdxs
          .map((i) => imageUrls[i])
          .filter(Boolean);

        if (subUrls.length === 0 || !subMode) {
          base = extraEnd;
          continue;
        }

        const buildFallbackMixedLots = (reason: string): any[] => {
          const mainIdxs = Array.from(
            { length: Math.max(0, end - base) },
            (_, i) => base + i,
          );
          const coverLocal = Math.max(
            0,
            Math.min(
              Math.max(0, count) - 1,
              typeof cover_index === "number" ? cover_index : 0,
            ),
          );
          const coverGlobal = base + coverLocal;
          const coverUrl = imageUrls[coverGlobal] || imageUrls[mainIdxs[0]];

          const common = {
            description: reason,
            condition: "Needs manual review",
            estimated_value: `${selectedCurrency} 0`,
            damage_analysis: undefined,
            extra_image_indexes: extraImageIdxs,
            extra_image_urls: extraImageUrls,
            tags: [`mode:${subMode}`, "needs_review"],
            mixed_group_index: lotIdx + 1,
            sub_mode: subMode,
          };

          if (subMode === "single_lot") {
            const urls = Array.from(
              new Set(mainIdxs.map((idx) => imageUrls[idx]).filter(Boolean)),
            );
            return [
              {
                ...common,
                title: `Lot ${lotIdx + 1}`,
                image_url: coverUrl || urls[0],
                image_indexes: mainIdxs,
                image_urls: urls,
              },
            ];
          }

          return mainIdxs.map((globalIdx, localIdx) => {
            const url = imageUrls[globalIdx];
            return {
              ...common,
              title: `Lot ${lotIdx + 1}${mainIdxs.length > 1 ? ` Image ${localIdx + 1}` : ""}`,
              image_url: url,
              image_indexes: [globalIdx],
              image_urls: url ? [url] : [],
            };
          });
        };

        const pushFallbackMixedLots = (reason: string) => {
          const fallbackLots = buildFallbackMixedLots(reason);
          for (const fallback of fallbackLots) {
            lotCounter += 1;
            const nextLot = {
              ...fallback,
              lot_id: `lot-${String(lotCounter).padStart(3, "0")}`,
              ...(bundleDiagnostic ? {
                analysis_metadata: { bundle_lot_number_detection: bundleDiagnostic },
              } : {}),
            };
            lots.push(bundleDiagnostic
              ? applyAuthoritativeBundleLotNumber(nextLot, bundleDiagnostic)
              : nextLot);
          }
        };

        try {
          const aiRes = await analyzeAssetImages(
            subUrls,
            subMode,
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis,
          );
          if (!analysis) analysis = { mixed: [] };
          if (!Array.isArray(analysis.mixed)) analysis.mixed = [];
          analysis.mixed.push({ mode: subMode, result: aiRes,
            ...(bundleDiagnostic ? { bundle_lot_number_detection: bundleDiagnostic } : {}),
          });

          const lotResults = Array.isArray(aiRes?.lots) ? aiRes.lots : [];
          if (lotResults.length === 0) {
            pushFallbackMixedLots("Software did not return details for this lot. Review and edit before approval.");
          }
          for (const resultLot of lotResults as any[]) {
            const lot = subMode === "single_lot"
              ? remapBundleItemImages(resultLot, aiLocalIdxs, imageUrls)
              : resultLot;
            // Map local image_indexes (0..sub-1) to global indexes via aiLocalIdxs
            const localIdxs: number[] = Array.isArray(lot?.image_indexes)
              ? Array.from(
                  new Set<number>(
                    (lot.image_indexes as any[])
                      .map((n: any) => parseInt(String(n), 10))
                      .filter(
                        (n: number) =>
                          Number.isFinite(n) &&
                          n >= 0 &&
                          n < aiLocalIdxs.length,
                      ),
                  ),
                )
              : [];
            const mappedIdxs: number[] = localIdxs.map((li) => aiLocalIdxs[li]);

            // A shared URL still refers to its position within this exact group.
            const directIndex = resolveGroupModelImageIndex(lot?.image_url, aiLocalIdxs, imageUrls);
            const directUrl = directIndex === undefined ? undefined : imageUrls[directIndex];
            if (directIndex !== undefined) mappedIdxs.push(directIndex);
            const idxs = Array.from(new Set(mappedIdxs)).filter(
              (n) => Number.isFinite(n) && n >= 0 && n < imageUrls.length,
            );
            const urlsFromIdx = idxs.map((i) => imageUrls[i]).filter(Boolean);

            // Determine cover image within this segment
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

            lotCounter += 1;
            const uniqueLotId = `lot-${String(lotCounter).padStart(3, "0")}`;

            // Resolve primary image for this lot
            const primaryIdx =
              Array.isArray(idxs) && idxs.length ? idxs[0] : undefined;
            const primaryFromIdx =
              primaryIdx != null ? imageUrls[primaryIdx] : undefined;
            const primaryUrl =
              directUrl || primaryFromIdx || urls[0] || coverUrl || undefined;

            const out = {
              ...lot,
              lot_id: uniqueLotId,
              image_url:
                subMode === "per_item"
                  ? primaryUrl
                  : coverUrl || directUrl || urls[0] || undefined,
              image_indexes:
                subMode === "per_item"
                  ? ((): number[] => {
                      if (primaryIdx != null && Number.isFinite(primaryIdx))
                        return [primaryIdx];
                      if (directIndex !== undefined) return [directIndex];
                      return [];
                    })()
                  : subMode === "single_lot" ? mainImageIndexes : idxs,
              image_urls:
                subMode === "per_item"
                  ? primaryUrl
                    ? [primaryUrl]
                    : []
                  : subMode === "single_lot" ? mainImageIndexes.map((index) => imageUrls[index]) : urls,
              extra_image_indexes: extraImageIdxs,
              extra_image_urls: extraImageUrls,
              // For traceability, include sub-mode tag
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
              ...(bundleDiagnostic ? {
                analysis_metadata: {
                  ...(lot?.analysis_metadata || {}),
                  bundle_lot_number_detection: bundleDiagnostic,
                },
              } : {}),
            } as any;

            if (process.env.DEBUG_PER_ITEM === "1" && subMode === "per_item") {
              try {
                console.log("[PerItemDebug][mixed:lot:final]", {
                  lot_id: out?.lot_id,
                  title: typeof out?.title === "string" ? out.title : undefined,
                  chosenUrl: out?.image_url,
                  image_url_in:
                    typeof lot?.image_url === "string"
                      ? lot.image_url
                      : undefined,
                  mappedIdxs: idxs,
                  primaryIdx,
                  primaryFromIdx,
                  directUrl,
                });
              } catch {}
            }

            lots.push(bundleDiagnostic ? applyAuthoritativeBundleLotNumber(out, bundleDiagnostic) : out);
          }
        } catch (e) {
          console.error(
            `AI analysis failed for mixed lot #${lotIdx + 1} (${subMode}):`,
            e,
          );
          pushFallbackMixedLots("Software analysis failed for this lot. Review and edit before approval.");
        }

        // Partial progress update within AI phase
        if (progressId) {
          const partial = (lotIdx + 1) / useMappings.length;
          const current = serverAccum + partial * SERVER_WEIGHTS.ai_analysis;
          setServerProg01(current);
        }

        base = extraEnd; // Advance past both main and extra images
      }
      analysis = {
        ...(analysis || {}),
        bundle_lot_number_detection: [...bundleDiagnosticsByGroup.values()],
      };
      if (useMappings.length > 0) endStep("ai_analysis");
    } else if (groupingMode === "combined") {
      // Combined mode: run per_item once, then derive per_photo and single_lot views from the SAME items
      const urlsForAI = imageUrls.slice(0, 50); // cap for cost/perf
      if (urlsForAI.length > 0) {
        try {
          startStep(
            "ai_analysis",
            "Software analysis of images (combined -> per_item primary)",
          );
          const perItemRes = await analyzeAssetImages(
            urlsForAI,
            "per_item",
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis,
          );
          endStep("ai_analysis");
          analysis = perItemRes;
          // Normalize items to include a canonical image_index if available (first index)
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

          // Derive per_photo: one row per original image index, mapping to the first per_item lot referencing that image index
          const perPhotoLots: any[] = [];
          for (let i = 0; i < imageUrls.length; i++) {
            const match = perItemLots.find(
              (l: any) =>
                Array.isArray(l?.image_indexes) && l.image_indexes.includes(i),
            );
            if (match) {
              perPhotoLots.push({
                ...match,
                image_index: i,
              });
            } else {
              // optional: include placeholders for images without detected items
              // per requirements, we can skip unmatched to keep table concise
            }
          }

          // Respect requested combined modes from details
          const rawModes = Array.isArray(details?.combined_modes)
            ? (details.combined_modes as any[])
            : ["single_lot", "per_item", "per_photo"];
          const selectedModes: ("single_lot" | "per_item" | "per_photo")[] =
            Array.from(
              new Set(
                rawModes
                  .map((m) => {
                    const s = String(m);
                    return s === "per_lot" ? "per_photo" : s;
                  })
                  .filter(
                    (m) =>
                      m === "single_lot" ||
                      m === "per_item" ||
                      m === "per_photo",
                  ),
              ),
            ) as any;
          // Choose primary lots for totals depending on selection
          if (selectedModes.includes("per_item")) {
            lots = perItemLots;
          } else if (selectedModes.includes("single_lot")) {
            lots = perItemLots; // single_lot view is consolidated items
          } else if (selectedModes.includes("per_photo")) {
            lots = perPhotoLots;
          } else {
            lots = perItemLots;
          }

          // Attach a combined payload that builders can use
          (analysis as any).combined = {
            per_item: perItemLots,
            per_photo: perPhotoLots,
            single_lot: perItemLots, // single-lot view as consolidated items
          };
          (analysis as any).combined_modes = selectedModes;
        } catch (e) {
          console.error("Error during combined AI analysis:", e);
          if (progressId) endStep("ai_analysis");
        }
      }
    } else {
      const mainImageIndexes = imageUrls.map((_, index) => index);
      let bundleDiagnostic: BundleLotAnalysisDiagnostic | undefined;
      if (groupingMode === "single_lot") {
        const detectorInputs = buildBundleLotNumberPhotoInputs(
          [{ count: imageUrls.length, mode: "single_lot" }], imageUrls,
        );
        const detectedNumbers = await detectBundleLotNumbersFromPhotos(detectorInputs);
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
          startStep("ai_analysis", "Software analysis of images");
          analysis = await analyzeAssetImages(
            urlsForAI,
            groupingMode,
            selectedLanguage,
            selectedCurrency,
            includeDamageAnalysis,
          );
          endStep("ai_analysis");
        } catch (e) {
          console.error("Error during asset AI analysis:", e);
          if (progressId) endStep("ai_analysis");
        }
      }

      // Clean up focus box registry after all AI analysis is done
      clearFocusBoxes();

      lots = (analysis?.lots || []).map((lot: any, idx: number) => {
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
                  .map((n: any) => parseInt(String(n), 10))
                  .filter(
                    (n: number) => Number.isFinite(n) && n >= 0 && n < total,
                  ),
              ),
            )
          : [];
        // In per_item mode, each item should have only its own primary image index
        if (groupingMode === "per_item" && idxs.length > 1) {
          idxs.splice(1); // keep only the first index
        }
        if (groupingMode === "per_photo" && idxs.length === 0 && imageUrls[idx])
          idxs.push(idx);
        const urlsFromIdx = idxs.map((i) => imageUrls[i]).filter(Boolean);
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
          const primaryUrl = directUrl || urlsFromIdx[0] || undefined;
          urls = primaryUrl ? [primaryUrl] : [];
        } else {
          const urlsSet = new Set<string>([
            ...urlsFromIdx,
            ...(directUrl ? [directUrl] : []),
          ]);
          urls = Array.from(urlsSet);
        }
        return { ...lot, image_indexes: idxs, image_urls: urls };
      });
      if (bundleDiagnostic) {
        analysis = { ...(analysis || {}), bundle_lot_number_detection: [bundleDiagnostic] };
      }

      if (process.env.DEBUG_PER_ITEM === "1" && groupingMode === "per_item") {
        try {
          const dbgList = (lots as any[]).map((l: any) => ({
            lot_id: l?.lot_id,
            title: typeof l?.title === "string" ? l.title : undefined,
            image_url:
              typeof l?.image_url === "string" ? l.image_url : undefined,
            image_indexes: Array.isArray(l?.image_indexes)
              ? l.image_indexes
              : [],
            image_urls: Array.isArray(l?.image_urls) ? l.image_urls : [],
          }));
          const previewImageUrls = imageUrls.slice(0, 20);
          console.log("[PerItemDebug][job:final]", {
            imageUrlsCount: imageUrls.length,
            imageUrlsPreviewCount: previewImageUrls.length,
            imageUrlsPreview: previewImageUrls,
            lotsCount: dbgList.length,
            lots: dbgList,
          });
        } catch {}
      }
    }

    // Preserve preview/user row order; fill any missing user-facing Lot # values.
    lots = normalizeLotsForReportOrdering(lots, groupingMode);

    // VIN-based enrichment (uses NHTSA vPIC) — only if we have lots
    if (Array.isArray(lots) && lots.length > 0) {
      try {
        lots = await withStep(
          "vin_enrichment",
          "Enriching lots with VIN data (vPIC)",
          async () => {
            return await enrichLotsWithVin(lots, groupingMode);
          },
        );
      } catch (e) {
        console.error("VIN enrichment failed:", e);
      }
    }

    if (Array.isArray(lots) && lots.length > 0) {
      try {
        lots = await withStep(
          "auctioneer_import_spec_enrichment",
          "Enriching Auctioneer Import specifications",
          async () => {
            const enrichment = await enrichAuctioneerImportSpecs({
              lots,
              currency: selectedCurrency,
              location: details?.location || details?.inspection_location,
              mode: "pictureOnly",
            });
            analysis = {
              ...(analysis || {}),
              auctioneer_import_enrichment: enrichment.analyses,
            };
            return enrichment.lots;
          },
        );
      } catch (e) {
        console.error("Auctioneer Import spec enrichment failed:", e);
      }
    }

    lots = reapplyBundleLotNumberDiagnostics(lots);

    // Rename images based on lot titles (e.g., "2014 Dodge Ram (1).jpg")
    if (Array.isArray(lots) && lots.length > 0 && imageUrls.length > 0) {
      try {
        await withStep(
          "rename_images_by_lot",
          "Renaming images based on lot titles",
          async () => {
            type ImageRenameInfo = {
              oldUrl: string;
              newName: string;
              imageIndexInLot: number;
              globalIndex: number;
            };
            const renameMap: ImageRenameInfo[] = [];
            const { imageIndexNames } = buildLotImageNameMaps(lots, imageUrls);
            for (const [globalIndex, newName] of imageIndexNames.entries()) {
              const oldUrl = imageUrls[globalIndex];
              if (!oldUrl) {
                continue;
              }
              renameMap.push({
                oldUrl,
                newName,
                imageIndexInLot: renameMap.length + 1,
                globalIndex,
              });
            }

            // Copy images to new names in R2 storage
            const timestamp = Date.now();
            const originalImageUrls = [...imageUrls];
            const newImageUrls: string[] = [...imageUrls]; // Clone

            for (const info of renameMap) {
              try {
                // Download old image from R2
                const response = await fetch(info.oldUrl);
                if (!response.ok) {
                  console.warn(
                    `Failed to fetch image for rename: ${info.oldUrl}`,
                  );
                  continue;
                }
                const buffer = Buffer.from(await response.arrayBuffer());

                // Upload with the title-based display name
                const newFileName = `uploads/asset/${timestamp}-${info.newName}`;
                await uploadBufferToR2(
                  buffer,
                  "image/jpeg",
                  process.env.R2_BUCKET_NAME!,
                  newFileName,
                );
                const newUrl = getR2PublicUrl(newFileName);

                // Update imageUrls array at global index
                newImageUrls[info.globalIndex] = newUrl;

                console.log(
                  `Renamed image: ${info.oldUrl.split("/").pop()} -> ${info.newName}`,
                );
              } catch (err) {
                console.error(
                  `Failed to rename image ${info.oldUrl} to ${info.newName}:`,
                  err,
                );
              }
            }

            // Update imageUrls array
            imageUrls.length = 0;
            imageUrls.push(...newImageUrls);

            // Update all lots with new image URLs
            for (const lot of lots) {
              const coverIndex = originalImageUrls.indexOf(lot.image_url);
              if (Array.isArray(lot?.image_indexes)) {
                // Update image_urls array
                lot.image_urls = lot.image_indexes
                  .map((idx: number) => imageUrls[idx])
                  .filter(Boolean);

                // Retain the selected cover when renaming Bundle media.
                if (lot.image_urls.length > 0) {
                  lot.image_url = lot.sub_mode === "single_lot" && coverIndex >= 0
                    ? imageUrls[coverIndex]
                    : lot.image_urls[0];
                }
              }
              // Update extra_image_urls if present
              if (Array.isArray((lot as any)?.extra_image_indexes)) {
                (lot as any).extra_image_urls = (lot as any).extra_image_indexes
                  .map((idx: number) => imageUrls[idx])
                  .filter(Boolean);
              }
              // Update catalogue items if present
              if (Array.isArray(lot?.items)) {
                for (const item of lot.items) {
                  if (typeof item?.image_index === "number") {
                    item.image_url = imageUrls[item.image_index];
                  }
                }
              }
            }

            console.log(
              `Successfully renamed ${renameMap.length} images based on lot titles`,
            );
          },
        );
      } catch (e) {
        console.error("Image renaming failed:", e);
      }
    }

    const parseDate = (val: any): Date | undefined => {
      if (!val) return undefined;
      const d = new Date(val);
      return isNaN(d.getTime()) ? undefined : d;
    };

    // Process valuation comparison table if requested (multiple methods)
    let valuationData: any = undefined;
    const includeValuationTable = details?.include_valuation_table === true;
    const valuationMethods = normalizeAssetReportValuationMethods(details);

    console.log(
      "[AssetReportJob] includeValuationTable:",
      includeValuationTable,
    );
    console.log("[AssetReportJob] valuationMethods:", valuationMethods);

    if (valuationMethods.length > 0 && (includeValuationTable || valuationMethods.some(method => method !== "FML"))) {
      try {
        await withStep(
          "calculate_valuations",
          "Generating AI valuation comparison table",
          async () => {
            const { generateComparisonTableWithAI } = await import(
              "../service/assetValuationService.js"
            );

            // Calculate total FMV from all lots
            const totalFMV = lots.reduce((sum, lot) => {
              const valStr = String(lot.estimated_value || "0");
              const num = parseFloat(valStr.replace(/[^0-9.-]/g, ""));
              return sum + (isNaN(num) ? 0 : num);
            }, 0);

            console.log("[AssetReportJob] Total FMV calculated:", totalFMV);

            if (totalFMV > 0) {
              // Get asset information for AI analysis
              const firstLot = lots[0];
              const assetTitle = firstLot?.title || "General Assets";
              const assetDescription = firstLot?.description || "";
              const assetCondition = firstLot?.condition || "Unknown";
              const industry = details?.industry || "General";

              console.log("[AssetReportJob] Generating valuation table with:", {
                totalFMV,
                methods: valuationMethods,
                assetTitle,
                industry,
              });

              // Generate comparison table with AI explanations for all selected methods
              valuationData = await generateComparisonTableWithAI(
                totalFMV,
                valuationMethods as any,
                assetTitle,
                assetDescription,
                assetCondition,
                industry,
              );

              console.log(
                `[AssetReportJob] Generated valuation comparison table with AI explanations for ${valuationMethods.length} methods, total FMV: $${totalFMV}`,
              );
              console.log(
                "[AssetReportJob] valuationData:",
                JSON.stringify(valuationData, null, 2),
              );
            } else {
              console.warn(
                "[AssetReportJob] Total FMV is 0, skipping valuation table generation",
              );
            }
          },
        );
      } catch (error) {
        console.error("[AssetReportJob] Valuation calculation failed:", error);
        // Continue without valuation data
      }
    } else {
      console.log(
        "[AssetReportJob] Valuation table not requested or no methods selected",
      );
    }

    const videoUrls = await uploadAssetPreviewVideos(videos, {
      reportId: String(user.id),
      generationToken: String(progressId || details?.client_submission_id || "legacy"),
    });
    lots = assignAssetLotVideos(lots, videos, videoUrls, { ...details, grouping_mode: groupingMode });
    const newReport = new AssetReport({
      user: user.id,
      grouping_mode: groupingMode,
      imageUrls: imageUrls,
      videoUrls,
      lots,
      analysis,
      client_name: details?.client_name,
      effective_date: parseDate(details?.effective_date),
      appraisal_purpose: details?.appraisal_purpose,
      owner_name: details?.owner_name,
      appraiser: details?.appraiser || user?.name || undefined,
      appraisal_company: details?.appraisal_company,
      industry: details?.industry,
      inspection_date: parseDate(details?.inspection_date),
      contract_no: details?.contract_no,
      language: selectedLanguage,
      currency: selectedCurrency,
      include_valuation_table: includeValuationTable,
      // The methods choose which values the report prints; the table only adds the
      // comparison. Keep them when the table is off, defaulting to Fair Market Value.
      valuation_methods: valuationMethods,
      valuation_data: valuationData,
      prepared_for: details?.prepared_for,
      factors_age_condition: details?.factors_age_condition,
      factors_quality: details?.factors_quality,
      factors_analysis: details?.factors_analysis,
      include_damage_analysis: includeDamageAnalysis,
      bank_photos_enabled: details?.bank_photos_enabled === true,
      watermark_images: watermarkImages,
      damage_analysis: buildReportDamageAnalysis(lots, includeDamageAnalysis),
    });

    await withStep("save_report", "Persisting report to database", async () => {
      await newReport.save();
      console.log("[AssetReportJob] Report saved with valuation data:", {
        include_valuation_table: newReport.include_valuation_table,
        valuation_methods: newReport.valuation_methods,
        hasValuationData: !!newReport.valuation_data,
      });
    });

    const reportObject = newReport.toObject();
    console.log("[AssetReportJob] Report object for generation:", {
      include_valuation_table: reportObject.include_valuation_table,
      valuation_methods: reportObject.valuation_methods,
      hasValuationData: !!reportObject.valuation_data,
    });
    // Keep the two Chromium renders and image-heavy DOCX work out of each
    // other's memory peaks. Independent reports still run across worker
    // processes, while one large report receives predictable resources.
    const pdfBuffer = await withStep("generate_pdf", "Generating PDF", async () => {
      const t0 = Date.now();
      console.log(
        `[AssetReportJob] PDF generation start for report ${newReport._id} at ${new Date(t0).toISOString()}`,
      );
      const buf = await generateAssetPdfFromReport({
        ...reportObject,
        inspector_name: user?.name || "",
        user_email: user?.email || "",
        language: selectedLanguage,
      });
      const t1 = Date.now();
      console.log(
        `[AssetReportJob] PDF generation finished in ${t1 - t0}ms for report ${newReport._id}`,
      );
      return buf;
    });
    const specPdfBuffer = await withStep(
      "generate_spec_pdf",
      "Generating CR",
      async () => {
        const t0 = Date.now();
        console.log(
          `[AssetReportJob] CR generation start for report ${newReport._id} at ${new Date(t0).toISOString()}`,
        );
        const buf = await generateAuctioneerSpecSheetPdfFromReport({
          ...reportObject,
          inspector_name: user?.name || "",
          user_email: user?.email || "",
          language: (reportObject as any)?.language || details?.language || "en",
        }).catch((error) => {
          console.error(
            `[AssetReportJob] CR generation failed for report ${newReport._id}; continuing without CR:`,
            error,
          );
          return undefined as Buffer | undefined;
        });
        const t1 = Date.now();
        console.log(
          `[AssetReportJob] CR generation ${buf ? "finished" : "skipped"} in ${t1 - t0}ms for report ${newReport._id}`,
        );
        return buf;
      },
    );
    const docxBuffer = await withStep("generate_docx", "Generating DOCX", async () => {
      const t0 = Date.now();
      console.log(
        `[AssetReportJob] DOCX generation start for report ${newReport._id} at ${new Date(t0).toISOString()}`,
      );
      let userCvUrl: string | undefined;
      let userCvFilename: string | undefined;
      try {
        const u = await User.findById(user.id).select("cvUrl cvFilename");
        userCvUrl = (u as any)?.cvUrl || undefined;
        userCvFilename = (u as any)?.cvFilename || undefined;
      } catch {}
      const buf = await generateAssetDocxFromReport({
        ...reportObject,
        inspector_name: user?.name || "",
        user_email: user?.email || "",
        user_cv_url: userCvUrl,
        user_cv_filename: userCvFilename,
        language: ((): "en" | "fr" | "es" => {
          const l = String(
            (reportObject as any)?.language || details?.language || "",
          ).toLowerCase();
          return l === "fr" || l === "es" ? (l as any) : "en";
        })(),
        ...(groupingMode === "combined" && analysis?.combined
          ? {
              grouping_mode: "combined",
              combined: (analysis as any).combined,
              combined_modes: Array.isArray((analysis as any).combined_modes)
                ? (analysis as any).combined_modes
                : undefined,
            }
          : {}),
      });
      const t1 = Date.now();
      console.log(
        `[AssetReportJob] DOCX generation finished in ${t1 - t0}ms for report ${newReport._id}`,
      );
      return buf;
    });
    let xlsxReportData: any = {
      ...reportObject,
      inspector_name: user?.name || "",
      language: (reportObject as any)?.language || details?.language || "en",
    };
    const scheduleA = await withStep(
      "generate_schedule_a_pdf",
      "Generating Schedule A PDF",
      async () =>
        generateAndUploadScheduleAPdf({
          reportData: xlsxReportData,
          kind: "asset",
          reportId: newReport._id,
          folder: "previews",
        }),
    );
    xlsxReportData = {
      ...xlsxReportData,
      schedule_a_pdf_url: scheduleA.url,
    };
    (newReport as any).preview_files = {
      ...((newReport as any).preview_files || {}),
      schedule_a_pdf: scheduleA.url,
    };
    await newReport.save();

    const xlsxBuffer = await withStep("generate_xlsx", "Generating Excel", async () => {
      const t0 = Date.now();
      console.log(
        `[AssetReportJob] XLSX generation start for report ${newReport._id} at ${new Date(t0).toISOString()}`,
      );
      const buf = await generateAssetXlsxFromReport(xlsxReportData);
      const t1 = Date.now();
      console.log(
        `[AssetReportJob] XLSX generation finished in ${t1 - t0}ms for report ${newReport._id}`,
      );
      return buf;
    });

    const reportsDir = path.resolve(process.cwd(), "reports");
    await fs.mkdir(reportsDir, { recursive: true });

    // Build filename base: asset-mixed-<contract>-<YYYYMMDD-HHMMSS>-<uniq>
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "-");
    const cnRaw = String(
      (reportObject as any)?.contract_no || details?.contract_no || "nocn",
    );
    const cn = sanitize(cnRaw.trim() || "nocn");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dtStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const uniq = Math.random().toString(36).slice(2, 8);
    const baseName = `asset-mixed-${cn}-${dtStr}-${uniq}`;
    const artifactNames = buildReportArtifactFilenames({
      kind: "asset",
      contractNo: cnRaw,
      reportId: newReport._id,
      fallback: baseName,
      lots: (reportObject as any)?.lots,
    });

    const pdfFilename = `${baseName}.pdf`;
    const specPdfFilename = artifactNames.crPdf;
    const docxFilename = artifactNames.docx;
    const xlsxFilename = artifactNames.excel;
    const imagesFolderName = artifactNames.imagesFolder;
    const imagesZipFilename = artifactNames.imagesZip;

    const pdfPath = path.join(reportsDir, pdfFilename);
    const specPdfPath = path.join(reportsDir, specPdfFilename);
    const docxPath = path.join(reportsDir, docxFilename);
    const xlsxPath = path.join(reportsDir, xlsxFilename);
    const imagesDirPath = path.join(reportsDir, imagesFolderName);
    const imagesZipPath = path.join(reportsDir, imagesZipFilename);

    await Promise.all([
      withStep("save_pdf_file", "Saving PDF file", async () => {
        const t0 = Date.now();
        await fs.writeFile(pdfPath, pdfBuffer);
        const t1 = Date.now();
        console.log(
          `[AssetReportJob] PDF saved to ${pdfPath} in ${t1 - t0}ms (size=${pdfBuffer.length} bytes)`,
        );
      }),
      ...(specPdfBuffer
        ? [
            withStep("save_spec_pdf_file", "Saving CR file", async () => {
              const t0 = Date.now();
              await fs.writeFile(specPdfPath, specPdfBuffer);
              const t1 = Date.now();
              console.log(
                `[AssetReportJob] CR saved to ${specPdfPath} in ${t1 - t0}ms (size=${specPdfBuffer.length} bytes)`,
              );
            }),
          ]
        : []),
      withStep("save_docx_file", "Saving DOCX file", async () => {
        const t0 = Date.now();
        await fs.writeFile(docxPath, docxBuffer);
        const t1 = Date.now();
        console.log(
          `[AssetReportJob] DOCX saved to ${docxPath} in ${t1 - t0}ms (size=${docxBuffer.length} bytes)`,
        );
      }),
      withStep("save_xlsx_file", "Saving XLSX file", async () => {
        const t0 = Date.now();
        await fs.writeFile(xlsxPath, xlsxBuffer);
        const t1 = Date.now();
        console.log(
          `[AssetReportJob] XLSX saved to ${xlsxPath} in ${t1 - t0}ms (size=${xlsxBuffer.length} bytes)`,
        );
      }),
    ]);

    const imageFilePathsByGlobalIndex = new Map<number, string>();
    const videoZipEntries: Array<{ path: string; name: string }> = [];

    // Save original uploaded media (images + videos) into a folder and zip it
    await withStep(
      "save_images_folder",
      "Saving original images/videos to folder",
      async () => {
        await fs.mkdir(imagesDirPath, { recursive: true });
        const extFromMime = (m?: string) => {
          if (!m) return "";
          if (m.includes("jpeg")) return ".jpg";
          if (m.includes("png")) return ".png";
          if (m.includes("webp")) return ".webp";
          if (m.includes("heic")) return ".heic";
          if (m.includes("heif")) return ".heif";
          if (m.includes("gif")) return ".gif";
          if (m.includes("bmp")) return ".bmp";
          if (m.includes("tiff")) return ".tiff";
          // videos
          if (m.includes("mp4")) return ".mp4";
          if (m.includes("quicktime")) return ".mov";
          if (m.includes("webm")) return ".webm";
          if (m.includes("x-matroska")) return ".mkv";
          if (m.includes("x-msvideo")) return ".avi";
          if (m.includes("x-m4v")) return ".m4v";
          if (m.includes("3gpp")) return ".3gp";
          return "";
        };

        const { imageIndexNames } = buildLotImageNameMaps(lots, imageUrls);

        // Save images with title-based names, respecting the upload watermark choice.
        for (let i = 0; i < images.length; i++) {
          const file = images[i];
          const lotBasedName = imageIndexNames.get(i);
          const finalName =
            lotBasedName || `image-${String(i + 1).padStart(3, "0")}.jpg`;
          const filePath = path.join(imagesDirPath, finalName);

          // Resolve input buffer
          const anyFile = file as any;
          let inputBuffer: Buffer | null = null;
          if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
            inputBuffer = anyFile.buffer as Buffer;
          } else if (typeof anyFile?.path === "string") {
            try {
              inputBuffer = await fs.readFile(anyFile.path);
            } catch {
              if (isHeicLikeImage(inputBuffer, file.mimetype, file.originalname)) {
                throw new Error(
                  `Unable to convert HEIC image "${file.originalname || `#${i + 1}`}" to JPEG.`
                );
              }
            }
          }

          if (inputBuffer) {
            try {
              const buffer = watermarkImages
                ? (
                    await processImageWithLogo(
                      inputBuffer,
                      "public/logoNobg.png",
                      { maxBytes: 500 * 1024 },
                    )
                  ).buffer
                : (
                    await prepareImageWithoutWatermark(
                      inputBuffer,
                      file.mimetype,
                      file.originalname,
                    )
                  ).buffer;
              // Use lot-based name
              await fs.writeFile(filePath, buffer);
              imageFilePathsByGlobalIndex.set(i, filePath);
              continue;
            } catch {}
          }
          // Fallback: write original file with lot-based name
          await fs.writeFile(filePath, file.buffer);
          imageFilePathsByGlobalIndex.set(i, filePath);
        }
        // Stable, per-lot names cannot overwrite clips with duplicate camera names.
        const videoNames = new Map(buildAssetVideoZipInputs(lots, videoUrls).map((entry) => [entry.url, entry.filename]));
        for (let i = 0; i < videos.length; i++) {
          const file = videos[i];
          const base = videoNames.get(videoUrls[i]) || `Video-${String(i + 1).padStart(3, "0")}.mp4`;
          const filePath = path.join(imagesDirPath, base);
          if (file.path && !file.buffer?.length) await fs.copyFile(file.path, filePath);
          else await fs.writeFile(filePath, await readMulterFileBuffer(file));
          videoZipEntries.push({ path: filePath, name: base });
        }
      },
    );

    await withStep("zip_images", "Zipping media folder", async () => {
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(imagesZipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        output.on("close", () => resolve());
        archive.on("error", (err: any) => reject(err));
        archive.pipe(output);
        const orderedEntries = buildOrderedLotImageZipEntries(lots, imageUrls);
        const archivedIndexes = new Set<number>();
        for (const entry of orderedEntries) {
          if (typeof entry.globalIndex !== "number") continue;
          const filePath = imageFilePathsByGlobalIndex.get(entry.globalIndex);
          if (!filePath) continue;
          archivedIndexes.add(entry.globalIndex);
          archive.file(filePath, { name: entry.filename });
        }
        for (let index = 0; index < images.length; index++) {
          if (archivedIndexes.has(index)) continue;
          const filePath = imageFilePathsByGlobalIndex.get(index);
          if (!filePath) continue;
          archive.file(filePath, {
            name: `Lot-001_Photo-${String(index + 1).padStart(3, "0")}_Image.jpg`,
          });
        }
        for (const video of videoZipEntries) {
          archive.file(video.path, { name: video.name });
        }
        archive.finalize();
      });
      console.log(`[AssetReportJob] Media zipped to ${imagesZipPath}`);
    });

    const parseEstimated = (val: unknown): number => {
      if (!val) return 0;
      let s = String(val).trim();
      s = s.replace(/[\u2012\u2013\u2014\u2212]/g, "-");
      const matches = s.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g);
      if (!matches) return 0;
      const nums = matches
        .map((m) => parseFloat(m.replace(/,/g, "")))
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (nums.length === 0) return 0;
      if (nums.length >= 2) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        return (min + max) / 2;
      }
      return nums[0];
    };

    const totalValue = (lots || []).reduce(
      (sum: number, lot: any) => sum + parseEstimated(lot?.estimated_value),
      0,
    );
    const fairMarketValue =
      totalValue > 0
        ? `${selectedCurrency} ${Math.round(totalValue).toLocaleString("en-CA")}`
        : "N/A";

    // Create approval records (pending by default)
    const cnLabel = String(
      (reportObject as any)?.contract_no || details?.contract_no || "",
    ).trim();
    const displayAddress = cnLabel ? `Asset - ${cnLabel}` : `Asset`;
    console.log(
      "[AssetReportJob] Creating PdfReport records with valuation data:",
      {
        include_valuation_table: (reportObject as any)?.include_valuation_table,
        valuation_methods: (reportObject as any)?.valuation_methods,
        valuation_data_methods: (
          reportObject as any
        )?.valuation_data?.methods?.map((m: any) => m.method),
      },
    );

    const pdfRec = new PdfReport({
      filename: pdfFilename,
      fileType: "pdf",
      filePath: path.join("reports", pdfFilename),
      user: user.id,
      report: newReport._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      address: displayAddress,
      fairMarketValue,
      contract_no:
        (reportObject as any)?.contract_no || details?.contract_no || "",
      valuation_methods: (reportObject as any)?.valuation_methods,
      valuation_data: (reportObject as any)?.valuation_data,
    });
    const specPdfRec = specPdfBuffer
      ? new PdfReport({
          filename: specPdfFilename,
          fileType: "spec_pdf",
          filePath: path.join("reports", specPdfFilename),
          user: user.id,
          report: newReport._id,
          reportType: "Asset",
          reportModel: "AssetReport",
          address: displayAddress,
          fairMarketValue,
          contract_no:
            (reportObject as any)?.contract_no || details?.contract_no || "",
          valuation_methods: (reportObject as any)?.valuation_methods,
          valuation_data: (reportObject as any)?.valuation_data,
        })
      : null;
    const docxRec = new PdfReport({
      filename: docxFilename,
      fileType: "docx",
      filePath: path.join("reports", docxFilename),
      user: user.id,
      report: newReport._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      address: displayAddress,
      fairMarketValue,
      contract_no:
        (reportObject as any)?.contract_no || details?.contract_no || "",
      valuation_methods: (reportObject as any)?.valuation_methods,
      valuation_data: (reportObject as any)?.valuation_data,
    });
    const xlsxRec = new PdfReport({
      filename: xlsxFilename,
      fileType: "xlsx",
      filePath: path.join("reports", xlsxFilename),
      user: user.id,
      report: newReport._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      address: displayAddress,
      fairMarketValue,
      contract_no:
        (reportObject as any)?.contract_no || details?.contract_no || "",
      valuation_methods: (reportObject as any)?.valuation_methods,
      valuation_data: (reportObject as any)?.valuation_data,
    });
    const imagesRec = new PdfReport({
      filename: imagesZipFilename,
      fileType: "images",
      filePath: path.join("reports", imagesZipFilename),
      imagesFolderPath: path.join("reports", imagesFolderName),
      user: user.id,
      report: newReport._id,
      reportType: "Asset",
      reportModel: "AssetReport",
      address: displayAddress,
      fairMarketValue,
      contract_no:
        (reportObject as any)?.contract_no || details?.contract_no || "",
      valuation_methods: (reportObject as any)?.valuation_methods,
      valuation_data: (reportObject as any)?.valuation_data,
    });
    await Promise.all(
      [pdfRec, specPdfRec, docxRec, xlsxRec, imagesRec]
        .filter(Boolean)
        .map((record: any) => assignReportApprover(record, { userId: user.id }))
    );
    await sendAssignedApprovalEmail(pdfRec, {
      reportType: "Asset",
      creatorUserId: user.id,
      title: displayAddress,
      summary: (reportObject as any)?.contract_no || details?.contract_no || fairMarketValue,
    });
    await Promise.all([
      withStep(
        "create_pdf_record",
        "Creating PDF record (pending approval)",
        async () => {
          await pdfRec.save();
        },
      ),
      ...(specPdfRec
        ? [
            withStep(
              "create_spec_pdf_record",
              "Creating CR record (pending approval)",
              async () => {
                await specPdfRec.save();
              },
            ),
          ]
        : []),
      withStep(
        "create_docx_record",
        "Creating DOCX record (pending approval)",
        async () => {
          await docxRec.save();
        },
      ),
      withStep(
        "create_xlsx_record",
        "Creating XLSX record (pending approval)",
        async () => {
          await xlsxRec.save();
        },
      ),
      withStep(
        "create_images_record",
        "Creating IMAGES record (pending approval)",
        async () => {
          await imagesRec.save();
        },
      ),
    ]);

    if (progressId) {
      setServerProg01(1);
      endProgress(progressId, true, "Completed");
    }

    // Send notification email (submitted for approval)
    const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
    const subject = "Your Asset reports were submitted for approval";
    const html = `
      <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px">Asset Reports Submitted</h2>
        <p>Hello${user?.name ? ` ${user.name}` : ""},</p>
        <p>Your Asset report outputs (PDF, DOCX, Excel, and Images ZIP) have been generated and submitted for admin approval.</p>
        <ul>
          <li>PDF: ${pdfFilename}</li>
          <li>CR: ${specPdfFilename}</li>
          <li>DOCX: ${docxFilename}</li>
          <li>Excel: ${xlsxFilename}</li>
          <li>Images ZIP: ${imagesZipFilename}</li>
        </ul>
        <p>You will receive an email when your reports are approved and ready to download.</p>
        <p><a href="${webUrl}/reports" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Go to Reports</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
        <p style="font-size:12px;color:#777">Asset Insight</p>
      </div>
    `;
    try {
      if (user?.email) {
        await sendEmail(user.email, subject, html);
      }
    } catch (e) {
      console.error("Failed to send completion email:", e);
    }
  } catch (error) {
    console.error("Error processing asset data (bg job):", error);
    if (progressId) endProgress(progressId, false, "Error processing request");
  }
}
