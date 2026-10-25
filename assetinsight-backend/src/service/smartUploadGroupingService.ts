/**
 * Implements deterministic Smart Upload ordering and black-divider grouping. Image
 * classification is bounded by byte/pixel limits and concurrency controls; validation
 * records unresolved inspection errors instead of silently changing groups, while the
 * algorithm version makes persisted grouping decisions auditable across deployments.
 */
import sharp from "sharp";
import ReportUploadSession, {
  type SmartUploadGroup,
} from "../models/reportUploadSession.model.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";
import {
  readR2ObjectBuffer,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import { updateMongoReportJobProgress } from "../utils/reportJobMongoQueue.js";
import { resolveSmartUploadOrderReviewState } from "../utils/smartUploadReviewState.js";
import { SMART_UPLOAD_MAX_FILE_BYTES } from "../utils/smartUploadLimits.js";
import { syncSmartUploadReportDraft } from "./reportDraftService.js";
import type { ReportJobExecutionContext } from "../utils/reportJobMongoQueue.js";
import { buildLotNumberUploadGroups, isLotNumberUpload, LOT_NUMBER_UPLOAD_ALGORITHM_VERSION, lotNumberUploadWarnings } from "./lotNumberUploadGrouping.js";
import { detectLotNumberUploadBatch, prepareLotNumberUploadPhoto } from "./lotNumberUploadDetector.js";

export const SMART_UPLOAD_ALGORITHM_VERSION = "black-divider-capture-order-v2";
export const SMART_UPLOAD_MAX_IMAGES_PER_LOT = 200;
export const SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES =
  SMART_UPLOAD_MAX_FILE_BYTES;
export const SMART_UPLOAD_CLASSIFY_MAX_PIXELS = 80_000_000;

type SessionFile = {
  fileId: string;
  key: string;
  fieldname: "images" | "videos";
  captureTimestamp?: number;
  captureOrder?: number;
  originalOrder?: number;
};

export type SmartUploadMetric = {
  fileId: string;
  meanLuminance?: number;
  darkPixelRatio?: number;
  variance?: number;
  isDivider: boolean;
  error?: string;
  kind?: "lot_start" | "photo" | "uncertain";
  lotNumber?: string | null;
};

export type SmartUploadInspectionError = {
  fileId: string;
  error: string;
};

/**
 * Inspection errors are blockers only while the image remains part of the
 * report. Reviewers can intentionally exclude an unreadable/non-report image
 * by marking it as a divider; retain its raw metric for auditability without
 * blocking the confirmed lot payload.
 */
export function getSmartUploadActiveInspectionErrors(
  metrics: Array<Pick<SmartUploadMetric, "fileId" | "error">> | null | undefined,
  dividerFileIds: Iterable<string>
): SmartUploadInspectionError[] {
  const excluded = new Set(
    Array.from(dividerFileIds, (fileId) => String(fileId))
  );
  return (Array.isArray(metrics) ? metrics : [])
    .filter(
      (metric) =>
        Boolean(metric?.error) && !excluded.has(String(metric.fileId))
    )
    .map((metric) => ({
      fileId: String(metric.fileId),
      error: String(metric.error),
    }));
}

const readNumberEnv = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const thresholds = () => ({
  meanLuminance: readNumberEnv("SMART_UPLOAD_BLACK_MEAN_MAX", 12),
  darkPixelRatio: readNumberEnv("SMART_UPLOAD_BLACK_PIXEL_RATIO_MIN", 0.985),
  variance: readNumberEnv("SMART_UPLOAD_BLACK_VARIANCE_MAX", 100),
  darkPixelLimit: readNumberEnv("SMART_UPLOAD_BLACK_PIXEL_MAX", 24),
});

type SmartUploadOrderable = {
  fileId?: string;
  fieldname?: "images" | "videos";
  captureOrder?: number;
  originalOrder?: number;
};

export type SmartUploadSortOptions = {
  preferOriginalOrder?: boolean;
};

const finiteOrder = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Desktop file pickers are allowed to return a multi-selection in filename or
 * UI sort order instead of the order in which files were clicked. The client
 * therefore sends captureOrder as a canonical sequential rank after its own
 * ordering/review step. It must never be a raw File.lastModified timestamp: a
 * reusable divider can be much older than the lot photos. Falling back for the
 * whole batch avoids mixing capture ranks and manifest indexes.
 */
export function sortSmartUploadFiles<T extends SmartUploadOrderable>(
  files: T[],
  options: SmartUploadSortOptions = {}
): T[] {
  const hasCompleteCaptureOrder =
    !options.preferOriginalOrder &&
    files.length > 0 &&
    files.every((file) => finiteOrder(file.captureOrder) !== undefined);

  return files
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftOriginalOrder =
        finiteOrder(left.file.originalOrder) ?? left.index;
      const rightOriginalOrder =
        finiteOrder(right.file.originalOrder) ?? right.index;
      const leftOrder = hasCompleteCaptureOrder
        ? finiteOrder(left.file.captureOrder)!
        : leftOriginalOrder;
      const rightOrder = hasCompleteCaptureOrder
        ? finiteOrder(right.file.captureOrder)!
        : rightOriginalOrder;
      return (
        leftOrder - rightOrder ||
        leftOriginalOrder - rightOriginalOrder ||
        left.index - right.index
      );
    })
    .map(({ file }) => file);
}

/**
 * Divider files terminate the current group and are never included in a lot.
 * Empty groups from leading, trailing, or consecutive dividers are discarded.
 */
export function buildSmartUploadGroups(
  files: SessionFile[],
  dividerFileIds: Iterable<string>,
  maxImagesPerLot = SMART_UPLOAD_MAX_IMAGES_PER_LOT,
  sortOptions: SmartUploadSortOptions = {}
): SmartUploadGroup[] {
  const dividers = new Set(dividerFileIds);
  const groups: SmartUploadGroup[] = [];
  let current: string[] = [];

  const flush = () => {
    if (!current.length) return;
    groups.push({
      groupIndex: groups.length,
      imageCount: current.length,
      fileIds: current,
      coverFileId: current[0],
      overLimit: current.length > maxImagesPerLot,
    });
    current = [];
  };

  for (const file of sortSmartUploadFiles(files, sortOptions).filter(
    (entry) => entry.fieldname === "images"
  )) {
    if (dividers.has(file.fileId)) flush();
    else current.push(file.fileId);
  }
  flush();
  return groups;
}

export function evaluateSmartUploadGrouping(
  files: SessionFile[],
  dividerFileIds: Iterable<string>,
  maxImagesPerLot = SMART_UPLOAD_MAX_IMAGES_PER_LOT,
  sortOptions: SmartUploadSortOptions = {}
): { groups: SmartUploadGroup[]; warnings: string[] } {
  const orderedImages = sortSmartUploadFiles(files, sortOptions).filter(
    (file) => file.fieldname === "images"
  );
  const dividerIds = Array.from(
    new Set(Array.from(dividerFileIds, (fileId) => String(fileId)))
  );
  const dividerSet = new Set(dividerIds);
  const groups = buildSmartUploadGroups(
    files,
    dividerIds,
    maxImagesPerLot,
    sortOptions
  );
  const warnings: string[] = [];

  for (const group of groups) {
    if (group.overLimit) {
      warnings.push(
        `Lot ${group.groupIndex + 1} contains ${group.imageCount} photos. Add a divider so every lot has ${maxImagesPerLot} or fewer.`
      );
    }
  }

  if (!groups.length) {
    warnings.push(
      "Every selected image is marked as a divider. Keep at least one report photo."
    );
    return { groups, warnings };
  }

  if (orderedImages.length && dividerSet.has(String(orderedImages[0].fileId))) {
    warnings.push(
      "The first image is a divider, so it cannot separate two lots. Move it between lot photos or turn off Divider."
    );
  }
  if (
    orderedImages.length > 1 &&
    dividerSet.has(String(orderedImages[orderedImages.length - 1].fileId))
  ) {
    warnings.push(
      "The last image is a divider, so it cannot separate two lots. Move it between lot photos or turn off Divider."
    );
  }
  const hasConsecutiveDividers = orderedImages.some(
    (file, index) =>
      index > 0 &&
      dividerSet.has(String(file.fileId)) &&
      dividerSet.has(String(orderedImages[index - 1].fileId))
  );
  if (hasConsecutiveDividers) {
    warnings.push(
      "Two or more divider images are consecutive. Keep exactly one divider between each pair of lots."
    );
  }

  const expectedGroupCount = dividerIds.length + 1;
  if (groups.length < expectedGroupCount) {
    warnings.push(
      `${dividerIds.length} divider image(s) should create ${expectedGroupCount} non-empty lots, but only ${groups.length} were found. Place every divider between two lot photos.`
    );
  }

  return { groups, warnings };
}

export type SmartUploadOrderValidation = {
  valid: boolean;
  orderedFileIds: string[];
  duplicateFileIds: string[];
  missingFileIds: string[];
  unknownFileIds: string[];
};

export function validateSmartUploadOrderedFileIds(
  files: Array<Pick<SessionFile, "fileId" | "fieldname">>,
  orderedFileIds: unknown[]
): SmartUploadOrderValidation {
  const validFileIds = files
    .filter((file) => file.fieldname === "images")
    .map((file) => String(file.fileId));
  const validSet = new Set(validFileIds);
  const normalized = orderedFileIds.map((fileId) => String(fileId).trim());
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fileId of normalized) {
    if (seen.has(fileId)) duplicates.add(fileId);
    seen.add(fileId);
  }
  const unknownFileIds = Array.from(seen).filter(
    (fileId) => !validSet.has(fileId)
  );
  const missingFileIds = validFileIds.filter((fileId) => !seen.has(fileId));
  const duplicateFileIds = Array.from(duplicates);

  return {
    valid:
      normalized.length === validFileIds.length &&
      duplicateFileIds.length === 0 &&
      missingFileIds.length === 0 &&
      unknownFileIds.length === 0,
    orderedFileIds: normalized,
    duplicateFileIds,
    missingFileIds,
    unknownFileIds,
  };
}

export type SmartUploadGroupsValidation = {
  valid: boolean;
  groups: SmartUploadGroup[];
  duplicateFileIds: string[];
  missingFileIds: string[];
  unknownFileIds: string[];
  dividerFileIdsInGroups: string[];
  emptyGroupIndexes: number[];
  overLimitGroupIndexes: number[];
};

export function validateSmartUploadGroups(
  files: Array<Pick<SessionFile, "fileId" | "fieldname">>,
  dividerFileIds: Iterable<string>,
  rawGroups: unknown[],
  maxImagesPerLot = SMART_UPLOAD_MAX_IMAGES_PER_LOT
): SmartUploadGroupsValidation {
  const validImageIds = files
    .filter((file) => file.fieldname === "images")
    .map((file) => String(file.fileId));
  const validSet = new Set(validImageIds);
  const dividerSet = new Set(
    Array.from(dividerFileIds, (fileId) => String(fileId))
  );
  const invalidDividerIds = Array.from(dividerSet).filter(
    (fileId) => !validSet.has(fileId)
  );
  const expectedNonDividerIds = validImageIds.filter(
    (fileId) => !dividerSet.has(fileId)
  );
  const normalizedGroupIds: string[][] = [];
  const emptyGroupIndexes: number[] = [];
  const malformedGroupIndexes: number[] = [];

  rawGroups.forEach((candidate, index) => {
    const rawFileIds = Array.isArray(candidate)
      ? candidate
      : candidate &&
          typeof candidate === "object" &&
          Array.isArray((candidate as { fileIds?: unknown[] }).fileIds)
        ? (candidate as { fileIds: unknown[] }).fileIds
        : null;
    if (!rawFileIds) {
      malformedGroupIndexes.push(index);
      normalizedGroupIds.push([]);
      return;
    }
    const fileIds = rawFileIds.map((fileId) => String(fileId).trim());
    if (!fileIds.length) emptyGroupIndexes.push(index);
    normalizedGroupIds.push(fileIds);
  });

  const flattened = normalizedGroupIds.flat();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fileId of flattened) {
    if (seen.has(fileId)) duplicates.add(fileId);
    seen.add(fileId);
  }
  const unknownFileIds = Array.from(
    new Set([
      ...invalidDividerIds,
      ...Array.from(seen).filter((fileId) => !validSet.has(fileId)),
    ])
  );
  const dividerFileIdsInGroups = Array.from(seen).filter((fileId) =>
    dividerSet.has(fileId)
  );
  const missingFileIds = expectedNonDividerIds.filter(
    (fileId) => !seen.has(fileId)
  );
  const overLimitGroupIndexes = normalizedGroupIds.flatMap(
    (fileIds, index) => (fileIds.length > maxImagesPerLot ? [index] : [])
  );
  const duplicateFileIds = Array.from(duplicates);
  const invalidGroupIndexes = Array.from(
    new Set([...emptyGroupIndexes, ...malformedGroupIndexes])
  );
  const valid =
    rawGroups.length > 0 &&
    invalidGroupIndexes.length === 0 &&
    duplicateFileIds.length === 0 &&
    missingFileIds.length === 0 &&
    unknownFileIds.length === 0 &&
    dividerFileIdsInGroups.length === 0 &&
    overLimitGroupIndexes.length === 0;
  const groups = normalizedGroupIds.map((fileIds, groupIndex) => ({
    groupIndex,
    imageCount: fileIds.length,
    fileIds,
    coverFileId: fileIds[0],
    overLimit: fileIds.length > maxImagesPerLot,
  }));

  return {
    valid,
    groups,
    duplicateFileIds,
    missingFileIds,
    unknownFileIds,
    dividerFileIdsInGroups,
    emptyGroupIndexes: invalidGroupIndexes,
    overLimitGroupIndexes,
  };
}

export function validatePersistedSmartUploadGroups(
  files: Array<Pick<SessionFile, "fileId" | "fieldname">>,
  dividerFileIds: Iterable<string>,
  groups: SmartUploadGroup[],
  maxImagesPerLot = SMART_UPLOAD_MAX_IMAGES_PER_LOT
): SmartUploadGroupsValidation {
  return validateSmartUploadGroups(
    files,
    dividerFileIds,
    groups,
    maxImagesPerLot
  );
}

export async function classifyBlackDivider(
  fileId: string,
  input: Buffer
): Promise<SmartUploadMetric> {
  if (input.length > SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES) {
    throw new Error(
      `Image exceeds the ${SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES}-byte Smart Upload classifier limit`
    );
  }
  const limit = thresholds();
  const normalized = await normalizeHeicToJpegBuffer(input, {
    maxInputPixels: SMART_UPLOAD_CLASSIFY_MAX_PIXELS,
  });
  if (normalized.length > SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES) {
    throw new Error(
      `Normalized image exceeds the ${SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES}-byte Smart Upload classifier limit`
    );
  }
  const pixels = await sharp(normalized, {
    failOn: "error",
    limitInputPixels: SMART_UPLOAD_CLASSIFY_MAX_PIXELS,
  })
    .rotate()
    // Transparent pixels must not look like a black separator.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(40, 40, { fit: "inside", withoutEnlargement: false })
    .grayscale()
    .raw()
    .toBuffer();

  if (!pixels.length) throw new Error("Image contains no readable pixels");
  let total = 0;
  let dark = 0;
  for (const value of pixels) {
    total += value;
    if (value <= limit.darkPixelLimit) dark += 1;
  }
  const meanLuminance = total / pixels.length;
  let squaredDifference = 0;
  for (const value of pixels) {
    squaredDifference += (value - meanLuminance) ** 2;
  }
  const variance = squaredDifference / pixels.length;
  const darkPixelRatio = dark / pixels.length;

  return {
    fileId,
    meanLuminance,
    darkPixelRatio,
    variance,
    isDivider:
      meanLuminance <= limit.meanLuminance &&
      darkPixelRatio >= limit.darkPixelRatio &&
      variance <= limit.variance,
  };
}

/** Paid detection checkpoints each bounded batch; a worker retry resumes it. */
async function classifyLotNumberSession(
  session: any,
  ownershipFilter: Record<string, any>,
  progressId?: string,
  executionContext?: ReportJobExecutionContext,
) {
  const sessionId = String(session._id);
  const images = sortSmartUploadFiles((session.files || []).filter((file: any) => file.fieldname === "images")) as any[];
  if (!images.length) throw new Error("Lot Number Upload contains no images");
  const imageIds = new Set(images.map((file) => String(file.fileId)));
  const completed = new Map<string, SmartUploadMetric>();
  for (const metric of session.smartGrouping?.metrics || []) {
    if (imageIds.has(String(metric.fileId)) && ["lot_start", "photo", "uncertain"].includes(metric.kind)) {
      completed.set(String(metric.fileId), { fileId: String(metric.fileId), isDivider: false,
        kind: metric.kind, lotNumber: metric.lotNumber ?? null, ...(metric.error ? { error: String(metric.error) } : {}) });
    }
  }
  const assertOwned = async () => {
    await executionContext?.assertOwned();
    if (!await ReportUploadSession.exists(ownershipFilter)) throw new Error("Lot-number scanning no longer owns this upload.");
  };
  const bucketName = resolvePersistedR2StorageTarget(session).bucketName;
  const pending = images.filter((file) => !completed.has(String(file.fileId)));
  for (let offset = 0; offset < pending.length; offset += 10) {
    await assertOwned();
    const batch = pending.slice(offset, offset + 10);
    // Only one provider batch in flight. Four decodes maximum, no all-photo buffers.
    const prepared = await mapWithConcurrency(batch, 4, async (file) => {
      const input = await readR2ObjectBuffer(bucketName, String(file.key), SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES);
      try {
        return await prepareLotNumberUploadPhoto(String(file.fileId), input);
      } catch {
        completed.set(String(file.fileId), { fileId: String(file.fileId), isDivider: false,
          kind: "uncertain", lotNumber: null, error: "This image could not be read. Replace it before creating a preview." });
        return null;
      }
    });
    const readable = prepared.filter((photo): photo is NonNullable<typeof photo> => photo !== null);
    await assertOwned();
    if (readable.length) {
      const observations = await detectLotNumberUploadBatch(readable);
      await assertOwned();
      for (const metric of observations) completed.set(metric.fileId, { ...metric, isDivider: false });
    }
    const metrics = images.flatMap((file) => completed.has(String(file.fileId)) ? [completed.get(String(file.fileId))!] : []);
    const progressPercent = Math.round(metrics.length / images.length * 100);
    const saved = await ReportUploadSession.findOneAndUpdate(ownershipFilter, { $set: {
      "smartGrouping.metrics": metrics, "smartGrouping.progressPercent": progressPercent,
    } }, { new: false }).select("_id");
    if (!saved) return ReportUploadSession.findById(sessionId);
    await updateMongoReportJobProgress(progressId, { phase: "processing", stage: "classifying_upload",
      progressPercent, serverProgress01: progressPercent / 100, message: `Checking image ${metrics.length} of ${images.length}` });
  }
  await assertOwned();
  const metrics = images.map((file) => completed.get(String(file.fileId))!);
  const groups = buildLotNumberUploadGroups(images, metrics);
  const unresolvedLotNumberFileIds = metrics.filter((metric) => metric.kind === "uncertain").map((metric) => metric.fileId);
  const updated = await ReportUploadSession.findOneAndUpdate(ownershipFilter, { $set: {
    smartGrouping: { method: "lot_number", status: "review_ready", progressPercent: 100,
      revision: Number(session.smartGrouping?.revision || 0), algorithmVersion: LOT_NUMBER_UPLOAD_ALGORITHM_VERSION,
      classificationJobId: session.smartGrouping?.classificationJobId,
      orderSource: images.every((file) => finiteOrder(file.captureOrder) !== undefined) ? "capture" : "manifest",
      orderReviewRequired: resolveSmartUploadOrderReviewState({
        orderReviewRequired: session.smartGrouping?.orderReviewRequired, dividerFileIds: [],
        detailsOrderAmbiguous: session.details?.smart_upload_order_ambiguous }).orderReviewRequired,
      unresolvedDividerIds: [], dividerFileIds: [], unresolvedLotNumberFileIds, groups, metrics,
      warnings: lotNumberUploadWarnings(groups), classifiedAt: new Date(),
    },
  } }, { new: true });
  if (updated) {
    try { await syncSmartUploadReportDraft(updated); }
    catch { console.error("[LotNumberUpload] Draft projection needs retry; grouping remains committed", { sessionId }); }
  }
  return updated || ReportUploadSession.findById(sessionId);
}

export async function classifySmartUploadSession(
  sessionId: string,
  progressId?: string,
  expectedOwnership?: {
    classificationJobId?: string;
    revision?: number;
  },
  executionContext?: ReportJobExecutionContext,
) {
  await executionContext?.assertOwned();
  const initialSession = await ReportUploadSession.findById(sessionId).select("+smartGrouping.classificationExecutionToken");
  if (!initialSession || !initialSession.smartUpload) {
    throw new Error("Smart Upload session was not found");
  }

  // A queue retry can arrive after a prior attempt already committed the
  // result (for example, if only the draft projection failed). Treat that as
  // success instead of resetting a review that the user may already be editing.
  if (
    ["review_ready", "confirmed"].includes(
      initialSession.smartGrouping?.status || ""
    )
  ) {
    return initialSession;
  }
  const expectedClassificationJobId = String(
    expectedOwnership?.classificationJobId || ""
  );
  const initialRevision = Number.isFinite(
    Number(initialSession.smartGrouping?.revision)
  )
    ? Number(initialSession.smartGrouping?.revision)
    : 0;
  if (
    expectedClassificationJobId &&
    initialSession.smartGrouping?.status !== "classifying" &&
    ["uploading", "failed"].includes(
      initialSession.smartGrouping?.status || "uploading"
    ) &&
    initialRevision === Number(expectedOwnership?.revision || 0)
  ) {
    // The durable job can be leased in the narrow interval between job insert
    // and the controller's ownership CAS. Throwing makes the queue retry; a
    // successful no-op here would leave the session classifying forever.
    throw new Error("Smart Upload classification ownership is not committed yet");
  }
  if (initialSession.smartGrouping?.status !== "classifying") {
    // This job no longer owns the session. Returning is intentionally a no-op:
    // throwing would let the worker's legacy error handler rewrite newer state.
    return initialSession;
  }

  const classificationJobId = String(
    initialSession.smartGrouping?.classificationJobId || ""
  );
  if (
    expectedClassificationJobId &&
    classificationJobId !== expectedClassificationJobId
  ) {
    return initialSession;
  }
  if (!classificationJobId) {
    // Legacy/corrupt ownership cannot safely write a whole grouping. Let the
    // maintenance/requeue path establish a fresh job id instead of throwing
    // into an error handler that could mutate newer state.
    return initialSession;
  }
  const expectedRevision = initialRevision;
  if (
    Number.isFinite(Number(expectedOwnership?.revision)) &&
    Number(expectedOwnership?.revision) !== expectedRevision
  ) {
    return initialSession;
  }
  const revisionFilter =
    expectedRevision === 0
      ? {
          $or: [
            { "smartGrouping.revision": 0 },
            { "smartGrouping.revision": { $exists: false } },
            { "smartGrouping.revision": null },
          ],
        }
      : { "smartGrouping.revision": expectedRevision };
  const ownershipFilter: any = {
    _id: sessionId,
    smartUpload: true,
    status: { $nin: ["completed", "queued", "processed"] },
    cleanupStartedAt: { $exists: false },
    "smartGrouping.status": "classifying",
    "smartGrouping.classificationJobId": classificationJobId,
    ...revisionFilter,
  };

  // A newer queue attempt can claim this session while an older attempt waits
  // after its initial read. Match the observed token as well as job/revision:
  // a stale attempt must never overwrite the newer worker's token/checkpoints.
  const observedExecutionToken = initialSession.smartGrouping?.classificationExecutionToken;
  const claimFilter = {
    ...ownershipFilter,
    "smartGrouping.classificationExecutionToken": observedExecutionToken === undefined
      ? { $exists: false }
      : observedExecutionToken,
  };
  await executionContext?.assertOwned();
  const session = await ReportUploadSession.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        "smartGrouping.algorithmVersion": isLotNumberUpload(initialSession) ? LOT_NUMBER_UPLOAD_ALGORITHM_VERSION : SMART_UPLOAD_ALGORITHM_VERSION,
        ...(executionContext ? { "smartGrouping.classificationExecutionToken": executionContext.executionToken } : {}),
      },
      $unset: { "smartGrouping.error": 1 },
    },
    { new: true }
  );
  if (!session) {
    return ReportUploadSession.findById(sessionId);
  }

  if (isLotNumberUpload(session)) {
    if (executionContext) ownershipFilter["smartGrouping.classificationExecutionToken"] = executionContext.executionToken;
    return classifyLotNumberSession(session, ownershipFilter, progressId, executionContext);
  }

  const images = sortSmartUploadFiles(
    session.files.filter((file) => file.fieldname === "images") as any
  ) as any[];
  if (!images.length) throw new Error("Smart Upload contains no images");
  const orderSource = images.every(
    (file) => finiteOrder(file.captureOrder) !== undefined
  )
    ? "capture"
    : "manifest";
  const orderReviewState = resolveSmartUploadOrderReviewState({
    orderReviewRequired: session.smartGrouping?.orderReviewRequired,
    unresolvedDividerIds: session.smartGrouping?.unresolvedDividerIds,
    dividerFileIds: session.smartGrouping?.dividerFileIds || [],
    detailsOrderAmbiguous:
      session.details?.smart_upload_order_ambiguous,
  });

  const bucketName = resolvePersistedR2StorageTarget(session).bucketName;
  // One 50 MiB compressed image plus decode can consume far more memory than
  // its object size. The safe default prevents simultaneous full-buffer
  // decodes; operators can explicitly raise the env after capacity testing.
  const concurrency = getPositiveIntEnv("SMART_UPLOAD_CLASSIFY_CONCURRENCY", 1);
  const checkpointEvery = Math.max(5, Math.ceil(images.length / 100));
  let completed = 0;
  let lastCheckpoint = 0;
  let ownershipLost = false;
  let checkpointQueue: Promise<unknown> = Promise.resolve();

  const metrics = await mapWithConcurrency(images, concurrency, async (file) => {
    // R2/object-stream failures are infrastructure failures, not evidence that
    // the user's image is corrupt. Let them reject the durable job so its
    // retry/lease recovery policy can fetch the object again.
    const input = await readR2ObjectBuffer(
      bucketName,
      String(file.key),
      SMART_UPLOAD_CLASSIFY_MAX_INPUT_BYTES
    );
    let metric: SmartUploadMetric;
    try {
      metric = await classifyBlackDivider(
        String(file.fileId),
        input
      );
    } catch (error) {
      metric = {
        fileId: String(file.fileId),
        isDivider: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    completed += 1;
    if (
      completed === images.length ||
      completed - lastCheckpoint >= checkpointEvery
    ) {
      const checkpoint = completed;
      lastCheckpoint = checkpoint;
      const progressPercent = Math.round((checkpoint / images.length) * 100);
      // Serialize sparse checkpoints. This keeps restart-safe progress without
      // issuing one pair of Mongo writes for every image in a large upload.
      checkpointQueue = checkpointQueue.then(async () => {
        if (ownershipLost) return;
        const checkpointSession = await ReportUploadSession.findOneAndUpdate(
          ownershipFilter,
          {
            $set: {
              "smartGrouping.progressPercent": progressPercent,
            },
          },
          { new: false }
        ).select("_id");
        if (!checkpointSession) {
          ownershipLost = true;
          return;
        }
        await updateMongoReportJobProgress(progressId, {
          phase: "processing",
          stage: "classifying_upload",
          progressPercent,
          serverProgress01: progressPercent / 100,
          message: `Checking image ${checkpoint} of ${images.length}`,
        });
      });
      await checkpointQueue;
    }
    return metric;
  });
  await checkpointQueue;
  if (ownershipLost) {
    return ReportUploadSession.findById(sessionId);
  }

  const dividerFileIds = Array.from(
    new Set(
      metrics
        .filter((metric) => metric.isDivider)
        .map((metric) => metric.fileId)
    )
  );
  const classifiedDividerSet = new Set(dividerFileIds);
  const unresolvedDividerIds = orderReviewState.orderReviewRequired
    ? dividerFileIds
    : orderReviewState.unresolvedDividerIds.filter((fileId) =>
        classifiedDividerSet.has(fileId)
      );
  const evaluated = evaluateSmartUploadGrouping(images, dividerFileIds);
  const groups = evaluated.groups;
  const warnings = getSmartUploadActiveInspectionErrors(
    metrics,
    dividerFileIds
  ).map(
    ({ fileId, error }) => `Could not inspect ${fileId}: ${error}`
  );
  warnings.push(...evaluated.warnings);

  const updated = await ReportUploadSession.findOneAndUpdate(
    ownershipFilter,
    {
      $set: {
        smartGrouping: {
          status: "review_ready",
          progressPercent: 100,
          revision: Number(session.smartGrouping?.revision || 0),
          algorithmVersion: SMART_UPLOAD_ALGORITHM_VERSION,
          classificationJobId: session.smartGrouping?.classificationJobId,
          orderSource,
          orderReviewRequired: orderReviewState.orderReviewRequired,
          unresolvedDividerIds,
          dividerFileIds,
          groups,
          warnings,
          metrics,
          classifiedAt: new Date(),
        },
      },
    },
    { new: true }
  );
  if (!updated) {
    return ReportUploadSession.findById(sessionId);
  }
  try {
    await syncSmartUploadReportDraft(updated);
  } catch (error) {
    // The upload-session transition is authoritative. A projection failure
    // must not fail the queue attempt and let its catch handler reset the now
    // review-ready session back to classifying.
    console.error(
      "[SmartUpload] classification draft projection sync failed; classification remains committed",
      {
        sessionId,
        classificationJobId,
        revision: expectedRevision,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
  return updated;
}
