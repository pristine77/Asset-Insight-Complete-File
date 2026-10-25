import { createHash } from "crypto";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import type { IReportJob } from "../models/reportJob.model.js";
import { createMongoReportJob } from "./reportJobMongoQueue.js";
import {
  deleteFromR2Strict,
  resolveCurrentR2ObjectLocationFromUrl,
  resolveR2ObjectLocationFromUrl,
} from "./r2Storage/r2Upload.js";
import { MAX_ASSET_COVER_IMAGES } from "./assetCoverImages.js";

const GLOBAL_INDEX_ARRAY_KEYS = new Set([
  "image_indexes",
  "imageIndexes",
  "extra_image_indexes",
  "extraImageIndexes",
  "photo_indexes",
  "photoIndexes",
  "file_indexes",
  "fileIndexes",
]);

const GLOBAL_INDEX_VALUE_KEYS = new Set([
  "image_index",
  "imageIndex",
  "cover_index",
  "coverIndex",
]);

const IMAGE_URL_ARRAY_KEYS = new Set([
  "image_urls",
  "imageUrls",
  "extra_image_urls",
  "extraImageUrls",
  "photo_urls",
  "photoUrls",
]);

const IMAGE_URL_VALUE_KEYS = new Set([
  "image_url",
  "imageUrl",
  "cover_image_url",
  "coverImageUrl",
]);

function asNonNegativeIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function asUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function visitLotRecords(value: unknown, visitor: (record: Record<string, any>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitLotRecords(item, visitor));
    return;
  }
  const record = value as Record<string, any>;
  visitor(record);
  if (Array.isArray(record.items)) visitLotRecords(record.items, visitor);
  if (Array.isArray(record.lots)) visitLotRecords(record.lots, visitor);
}

function isImageStillReferenced(lots: unknown, imageIndex: number, imageUrl: string): boolean {
  let referenced = false;
  visitLotRecords(lots, (record) => {
    if (referenced) return;
    for (const key of GLOBAL_INDEX_ARRAY_KEYS) {
      if (asNonNegativeIndexes(record[key]).includes(imageIndex)) {
        referenced = true;
        return;
      }
    }
    for (const key of GLOBAL_INDEX_VALUE_KEYS) {
      if (Number(record[key]) === imageIndex) {
        referenced = true;
        return;
      }
    }
    if (!imageUrl) return;
    for (const key of IMAGE_URL_ARRAY_KEYS) {
      if (asUrls(record[key]).includes(imageUrl)) {
        referenced = true;
        return;
      }
    }
    for (const key of IMAGE_URL_VALUE_KEYS) {
      if (String(record[key] || "").trim() === imageUrl) {
        referenced = true;
        return;
      }
    }
  });
  return referenced;
}

function remapIndex(value: unknown, removedIndexes: number[]): number | undefined {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return undefined;
  if (removedIndexes.includes(index)) return undefined;
  const shift = removedIndexes.filter((removed) => removed < index).length;
  return index - shift;
}

function remapLotRecord(value: unknown, removedIndexes: number[]): any {
  if (Array.isArray(value)) {
    return value.map((item) => remapLotRecord(item, removedIndexes));
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, any>;
  const next: Record<string, any> = { ...source };
  for (const key of Object.keys(next)) {
    if (GLOBAL_INDEX_ARRAY_KEYS.has(key)) {
      next[key] = asNonNegativeIndexes(next[key])
        .map((index) => remapIndex(index, removedIndexes))
        .filter((index): index is number => index !== undefined);
      continue;
    }
    if (GLOBAL_INDEX_VALUE_KEYS.has(key)) {
      const mapped = remapIndex(next[key], removedIndexes);
      if (mapped === undefined) delete next[key];
      else next[key] = mapped;
      continue;
    }
    if ((key === "items" || key === "lots") && Array.isArray(next[key])) {
      next[key] = remapLotRecord(next[key], removedIndexes);
    }
  }
  return next;
}

export type CompactReportImagesResult = {
  previewData: Record<string, any>;
  imageUrls: string[];
  removedUrls: string[];
  removedIndexes: number[];
};

/**
 * Applies deletion markers after a successful Save/Submit request. Root image
 * indexes are compacted only when no lot/item still references the image.
 */
export function compactDeletedReportImages(
  previewDataValue: unknown,
  rootImageUrlsValue: unknown
): CompactReportImagesResult {
  // Typed Lot Listing previews arrive as Mongoose subdocuments. Convert them
  // before recursively reading lot fields; spreading a subdocument exposes
  // `_doc`/`$__` internals instead of `image_indexes` and related fields.
  const rawPreviewData =
    previewDataValue &&
    typeof previewDataValue === "object" &&
    typeof (previewDataValue as any).toObject === "function"
      ? (previewDataValue as any).toObject({ depopulate: true, virtuals: false })
      : previewDataValue;
  const previewData =
    rawPreviewData && typeof rawPreviewData === "object"
      ? { ...(rawPreviewData as Record<string, any>) }
      : {};
  const imageUrls = asUrls(rootImageUrlsValue);
  const deletedIndexes = new Set(asNonNegativeIndexes(previewData.deleted_image_indexes));
  const deletedUrls = new Set(asUrls(previewData.deleted_image_urls));
  const deletedCoverUrls = new Set(deletedUrls);

  imageUrls.forEach((url, index) => {
    if (deletedUrls.has(url)) deletedIndexes.add(index);
    if (deletedIndexes.has(index) && url) deletedCoverUrls.add(url);
  });

  const removedIndexes = [...deletedIndexes]
    .filter((index) => index < imageUrls.length)
    .filter((index) => !isImageStillReferenced(previewData.lots, index, imageUrls[index] || ""))
    .sort((left, right) => left - right);
  const removedSet = new Set(removedIndexes);
  const removedRootUrls = removedIndexes
    .map((index) => imageUrls[index])
    .filter((url): url is string => Boolean(url));
  const removedUrlOnlyEntries = [...deletedUrls].filter(
    (url) =>
      !imageUrls.includes(url) &&
      !isImageStillReferenced(previewData.lots, -1, url)
  );
  const removedUrls = [...removedRootUrls, ...removedUrlOnlyEntries];
  const nextImageUrls = imageUrls.filter((_url, index) => !removedSet.has(index));

  const nextPreviewData: Record<string, any> = {
    ...previewData,
    lots: remapLotRecord(previewData.lots, removedIndexes),
    deleted_image_indexes: [],
    deleted_image_urls: [],
  };
  if (Array.isArray(previewData.imageUrls)) nextPreviewData.imageUrls = nextImageUrls;
  if (Array.isArray(previewData.image_urls)) nextPreviewData.image_urls = nextImageUrls;
  if (Array.isArray(previewData.cover_image_urls)) {
    nextPreviewData.cover_image_urls = Array.from(
      new Set(
        asUrls(previewData.cover_image_urls).filter(
          (url) => nextImageUrls.includes(url) && !deletedCoverUrls.has(url)
        )
      )
    ).slice(0, MAX_ASSET_COVER_IMAGES);
  }

  return {
    previewData: nextPreviewData,
    imageUrls: nextImageUrls,
    removedUrls: Array.from(new Set(removedUrls)),
    removedIndexes,
  };
}

export function getOwnedReportImageKey(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const location = resolveCurrentR2ObjectLocationFromUrl(raw);
  if (!location) return null;
  if (!/^uploads\/(?:asset|lot-listing)\//i.test(location.key)) return null;
  return location.key;
}

async function reportStillReferencesImage(url: string): Promise<boolean> {
  const query = {
    $or: [
      { imageUrls: url },
      { "preview_data.imageUrls": url },
      { "preview_data.image_urls": url },
      { "preview_data.cover_image_urls": url },
      { "lots.image_urls": url },
      { "lots.extra_image_urls": url },
      { "lots.image_url": url },
      { "lots.items.image_url": url },
      { "lots.items.image_urls": url },
      { "lots.items.extra_image_urls": url },
      { "preview_data.lots.image_urls": url },
      { "preview_data.lots.extra_image_urls": url },
      { "preview_data.lots.image_url": url },
      { "preview_data.lots.items.image_url": url },
      { "preview_data.lots.items.image_urls": url },
      { "preview_data.lots.items.extra_image_urls": url },
    ],
  };
  const [asset, lotListing] = await Promise.all([
    AssetReport.exists(query as any),
    LotListing.exists(query as any),
  ]);
  return Boolean(asset || lotListing);
}

export async function queueReportImageDeletion(input: {
  url: string;
  sourceKind: "asset" | "lotListing";
  sourceId: string;
  eventId: string;
}) {
  const key = getOwnedReportImageKey(input.url);
  if (!key) return null;
  const digest = createHash("sha256")
    .update(`${input.sourceKind}:${input.sourceId}:${input.eventId}:${key}`)
    .digest("hex");
  return createMongoReportJob({
    type: "report-media-delete",
    payload: {
      url: input.url,
      key,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
    },
    priority: -10,
    maxAttempts: 5,
    idempotencyKey: `report-media-delete:${digest}`,
  });
}

export async function queueReportImageDeletions(input: {
  urls: string[];
  sourceKind: "asset" | "lotListing";
  sourceId: string;
  eventId: string;
}) {
  return Promise.all(
    Array.from(new Set(input.urls)).map((url) =>
      queueReportImageDeletion({ ...input, url })
    )
  );
}

export async function runReportImageDeletionJob(job: IReportJob): Promise<void> {
  const url = String(job.payload?.url || "").trim();
  const suppliedKey = String(job.payload?.key || "").trim();
  const location = resolveCurrentR2ObjectLocationFromUrl(url);
  if (!location) {
    const legacy = resolveR2ObjectLocationFromUrl(url);
    if (
      legacy?.generation === "legacy" &&
      legacy.key === suppliedKey &&
      /^uploads\/(?:asset|lot-listing)\//i.test(legacy.key)
    ) {
      console.log(`[ReportMediaDelete] Retained legacy image ${legacy.key}`);
      return;
    }
    throw new Error("Refusing to delete an unowned or malformed report image URL");
  }
  const key = getOwnedReportImageKey(url);
  if (!key || key !== suppliedKey) {
    throw new Error("Refusing to delete an unowned or malformed report image URL");
  }
  if (await reportStillReferencesImage(url)) {
    console.log(`[ReportMediaDelete] Retained shared image ${key}`);
    return;
  }
  if (!location.bucketName) {
    throw new Error("R2_BUCKET_NAME is required to delete report media");
  }
  await deleteFromR2Strict(location.bucketName, key);
}
