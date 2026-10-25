import { resolvePhotoWatermark } from "./photoWatermarkPolicy.js";
import path from "path";
import { createHash } from "node:crypto";
import { readMulterFileBuffer, cleanupMulterFiles } from "./reportTempFiles.js";
import {
  processImageWithLogo,
  prepareImageWithoutWatermark,
  isHeicLikeImage,
} from "./imageProcessing.js";
import {
  getCurrentR2StorageTarget,
  getR2PublicUrl,
  uploadBufferToR2,
} from "./r2Storage/r2Upload.js";
import { countPreviewLotPhotos, MAX_ASSET_LOT_PHOTOS } from "./assetPhotoLimits.js";

type UploadKind = "asset" | "lot-listing";

export type PreviewLotImageUploadResult = {
  previewData: any;
  imageUrls: string[];
  lotIndex: number;
  added: Array<{ index: number; url: string; name: string }>;
  duplicatesSkipped: number;
};

export function parseMultipartPreviewData(value: unknown): any | undefined {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function collectPreviewImageUploadFiles(files: unknown): Express.Multer.File[] {
  if (Array.isArray(files)) return files as Express.Multer.File[];
  const byField = files as Record<string, Express.Multer.File[]> | undefined;
  if (!byField || typeof byField !== "object") return [];
  return [
    ...(Array.isArray(byField.images) ? byField.images : []),
    ...(Array.isArray(byField["images[]"]) ? byField["images[]"] : []),
  ];
}

export function normalizePreviewLotKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^lot(?:\s+#?\s*|#\s*|[-_:]\s*)/i, "")
    .replace(/^#\s*/, "")
    .trim()
    .toLowerCase();
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

export function findPreviewLotIndex(previewData: any, lotKey: string): number {
  const lots = Array.isArray(previewData?.lots) ? previewData.lots : [];
  const wanted = normalizePreviewLotKey(lotKey);
  if (!wanted) return -1;

  const candidatesFor = (lot: any, index: number) => [
    lot?.lot_id,
    lot?.id,
    lot?._id,
    lot?.lot_number,
    index,
    index + 1,
  ];

  return lots.findIndex((lot: any, index: number) =>
    candidatesFor(lot, index).some((candidate) => normalizePreviewLotKey(candidate) === wanted)
  );
}

type PreparedPreviewImage = {
  buffer: Buffer;
  contentType: string;
  extension: string;
  key: string;
  url: string;
  name: string;
};

function canonicalPreviewImageMedia(buffer: Buffer): {
  extension: string;
  contentType: string;
} {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return { extension: ".png", contentType: "image/png" };
  }
  const asciiPrefix = buffer.subarray(0, Math.min(buffer.length, 16)).toString("ascii");
  if (asciiPrefix.startsWith("GIF87a") || asciiPrefix.startsWith("GIF89a")) {
    return { extension: ".gif", contentType: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    asciiPrefix.startsWith("RIFF") &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", contentType: "image/webp" };
  }
  if (asciiPrefix.startsWith("BM")) {
    return { extension: ".bmp", contentType: "image/bmp" };
  }
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) {
    return { extension: ".tif", contentType: "image/tiff" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(buffer.subarray(8, 12).toString("ascii"))
  ) {
    return { extension: ".avif", contentType: "image/avif" };
  }

  // Unknown bytes retain a non-executable generic representation. The object
  // identity must never depend on a caller-controlled filename or MIME label.
  return { extension: ".img", contentType: "application/octet-stream" };
}

const previewImageDigest = (input: {
  buffer: Buffer;
  watermarkImages: boolean;
}): string =>
  createHash("sha256")
    .update("asset-insight-preview-image-v1\0")
    .update(input.watermarkImages ? "watermarked\0" : "original\0")
    .update(input.buffer)
    .digest("hex");

/**
 * Preview additions use a content-addressed key inside a report-and-lot scope.
 * A browser retry, lost response, or double click therefore resolves to the
 * same R2 object instead of creating a second timestamp-named object. Keeping
 * the scope in the digest avoids sharing a deletion lifecycle across reports
 * or lots that happen to contain the same pixels.
 */
export function buildPreviewImageObjectKey(input: {
  kind: UploadKind;
  reportId: unknown;
  lotKey: unknown;
  buffer: Buffer;
  extension: string;
  watermarkImages: boolean;
}): string {
  const reportId = String(input.reportId || "").trim();
  const lotKey = normalizePreviewLotKey(input.lotKey);
  if (!reportId) throw new Error("Report identity is required for preview image upload.");
  if (!lotKey) throw new Error("Lot identity is required for preview image upload.");

  const scopeDigest = createHash("sha256")
    .update(`${input.kind}\0${reportId}\0${lotKey}`)
    .digest("hex")
    .slice(0, 24);
  const contentDigest = previewImageDigest({
    buffer: input.buffer,
    watermarkImages: input.watermarkImages,
  });
  // Derive the suffix from the bytes, not the mutable filename/Content-Type.
  // An identical upload renamed from .jpeg to .jpg (or mislabeled as .png)
  // must resolve to exactly one object key.
  const { extension } = canonicalPreviewImageMedia(input.buffer);
  const folder =
    input.kind === "asset"
      ? "uploads/asset/preview-additions"
      : "uploads/lot-listing/preview-additions";
  return `${folder}/${scopeDigest}/${contentDigest}${extension}`;
}

async function preparePreviewImageFile(
  file: Express.Multer.File,
  kind: UploadKind,
  sequence: number,
  watermarkImages: boolean,
  reportId: unknown,
  lotKey: unknown
): Promise<PreparedPreviewImage> {
  const inputBuffer = await readMulterFileBuffer(file);
  if (!inputBuffer.length) {
    throw new Error(`Unable to read uploaded image "${file.originalname || `#${sequence + 1}`}".`);
  }

  const safeBase = String(file.originalname || `preview-image-${sequence + 1}`)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.[^./\\]+$/, "")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || `preview-image-${sequence + 1}`;

  let prepared: {
    buffer: Buffer;
    mimetype: string;
    extension: string;
  };
  try {
    prepared = watermarkImages
      ? {
          ...(await processImageWithLogo(inputBuffer, "public/logoNobg.png")),
          mimetype: "image/jpeg",
          extension: ".jpg",
        }
      : await prepareImageWithoutWatermark(
          inputBuffer,
          file.mimetype,
          file.originalname
        );
  } catch (error) {
    // Watermark-disabled uploads must preserve the user's original pixels.
    if (!watermarkImages) throw error;
    if (isHeicLikeImage(inputBuffer, file.mimetype, file.originalname)) {
      throw new Error(`Unable to convert HEIC image "${file.originalname || `#${sequence + 1}`}" to JPEG.`);
    }
    const fallbackExt = path.extname(file.originalname || "") || ".jpg";
    prepared = {
      buffer: inputBuffer,
      mimetype: file.mimetype || "application/octet-stream",
      extension: fallbackExt,
    };
  }

  const key = buildPreviewImageObjectKey({
    kind,
    reportId,
    lotKey,
    buffer: prepared.buffer,
    extension: prepared.extension,
    watermarkImages,
  });
  const canonicalMedia = canonicalPreviewImageMedia(prepared.buffer);
  const storageTarget = getCurrentR2StorageTarget();
  return {
    buffer: prepared.buffer,
    contentType: canonicalMedia.contentType,
    extension: canonicalMedia.extension,
    key,
    url: getR2PublicUrl(key, storageTarget),
    name: `${safeBase}${canonicalMedia.extension}`,
  };
}

export async function appendImagesToPreviewLot(input: {
  kind: UploadKind;
  previewData: any;
  rootImageUrls: unknown;
  /** Stable database report/listing id; scopes content-addressed object keys. */
  reportId: unknown;
  lotKey: string;
  files: Express.Multer.File[];
  watermarkImages?: boolean;
}): Promise<PreviewLotImageUploadResult> {
  const previewData = input.previewData && typeof input.previewData === "object" ? input.previewData : {};
  const lots = Array.isArray(previewData.lots) ? previewData.lots : [];
  const lotIndex = findPreviewLotIndex(previewData, input.lotKey);
  if (lotIndex < 0 || !lots[lotIndex]) {
    throw new Error("Lot not found for image upload.");
  }
  if (!input.files.length) {
    throw new Error("At least one image is required.");
  }

  const imageUrls = compactStringArray(input.rootImageUrls);
  const lot = { ...(lots[lotIndex] || {}) };
  const lotStorageIdentity = String(
    lot?._id || lot?.lot_id || lot?.id || `index-${lotIndex}`
  );
  const extraIndexes = numberArray(lot.extra_image_indexes);
  const extraUrls = compactStringArray(lot.extra_image_urls);
  const added: PreviewLotImageUploadResult["added"] = [];
  let duplicatesSkipped = 0;

  try {
    // Prepare and identify the complete batch before writing any object. This
    // keeps validation failures side-effect free and lets duplicate inputs be
    // excluded from both the photo limit and R2 writes.
    const preparedImages: PreparedPreviewImage[] = [];
    const seenUrls = new Set(imageUrls);
    for (let i = 0; i < input.files.length; i++) {
      const prepared = await preparePreviewImageFile(
        input.files[i]!,
        input.kind,
        i,
        resolvePhotoWatermark(input.watermarkImages),
        input.reportId,
        lotStorageIdentity
      );
      if (seenUrls.has(prepared.url)) {
        duplicatesSkipped += 1;
        continue;
      }
      seenUrls.add(prepared.url);
      preparedImages.push(prepared);
    }

    if (input.kind === "asset") {
      const existingPhotoCount = countPreviewLotPhotos(lot);
      if (existingPhotoCount + preparedImages.length > MAX_ASSET_LOT_PHOTOS) {
        const remaining = Math.max(0, MAX_ASSET_LOT_PHOTOS - existingPhotoCount);
        throw new Error(
          `This lot can accept ${remaining} more photo(s). The maximum is ${MAX_ASSET_LOT_PHOTOS} photos per lot, including main and report-only photos.`
        );
      }
    }

    const storageTarget = getCurrentR2StorageTarget();
    for (const prepared of preparedImages) {
      // The deterministic key makes a retry an overwrite of the same bytes,
      // never a second physical object. Partial failures are therefore safe to
      // resume without accumulating timestamp-named orphans.
      const url = await uploadBufferToR2(
        prepared.buffer,
        prepared.contentType,
        storageTarget.bucketName,
        prepared.key
      );
      const index = imageUrls.length;
      imageUrls.push(url);
      extraIndexes.push(index);
      extraUrls.push(url);
      added.push({ index, url, name: prepared.name });
    }
  } finally {
    await cleanupMulterFiles(input.files);
  }

  const deleted = new Set(numberArray(previewData.deleted_image_indexes));
  const deletedUrls = new Set(compactStringArray(previewData.deleted_image_urls));
  for (const item of added) deleted.delete(item.index);
  for (const item of added) deletedUrls.delete(item.url);

  lot.extra_image_indexes = Array.from(new Set(extraIndexes));
  lot.extra_image_urls = Array.from(new Set(extraUrls));
  lots[lotIndex] = lot;

  return {
    previewData: {
      ...previewData,
      lots,
      deleted_image_indexes: Array.from(deleted),
      deleted_image_urls: Array.from(deletedUrls),
    },
    imageUrls,
    lotIndex,
    added,
    duplicatesSkipped,
  };
}
