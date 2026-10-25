import sharp from "sharp";
import { fetchImageBuffer } from "./utils.js";
import {
  MAX_ASSET_COVER_IMAGES,
  normalizeAssetCoverImageUrls,
} from "../../../utils/assetCoverImages.js";

/**
 * Owns cover-image selection and raster preparation. Slot count and dimensions
 * are a template contract; limiting and deduplicating before download bounds
 * network work, memory use, and final DOCX size.
 */
export const COVER_TEMPLATE_PHOTO_SLOTS = [
  { path: "word/media/image2.png", width: 1632, height: 431 },
  { path: "word/media/image3.png", width: 1632, height: 367 },
  { path: "word/media/image4.png", width: 2015, height: 1017 },
  { path: "word/media/image5.png", width: 2040, height: 1022 },
] as const;

export type CoverPhotoSlotSource<T> = T | null;

function addUniqueUrl(
  value: unknown,
  urls: string[],
  seen: Set<string>
): void {
  const url = String(value ?? "").trim();
  if (!url || seen.has(url)) return;
  seen.add(url);
  urls.push(url);
}

function addUrlArray(
  value: unknown,
  urls: string[],
  seen: Set<string>
): void {
  if (!Array.isArray(value)) return;
  for (const url of value) addUniqueUrl(url, urls, seen);
}

/**
 * Prefer the selected/primary image from each lot before filling remaining
 * cover positions from the report-level image collection.
 */
export function collectCoverPhotoUrls(
  reportData: any,
  limit = COVER_TEMPLATE_PHOTO_SLOTS.length
): string[] {
  const boundedLimit = Math.min(
    MAX_ASSET_COVER_IMAGES,
    Math.max(0, Math.floor(Number(limit) || 0))
  );
  if (boundedLimit === 0) return [];

  const requestedCoverUrls = Array.isArray(reportData?.cover_image_urls)
    ? reportData.cover_image_urls
    : reportData?.preview_data?.cover_image_urls;
  const selectedCoverUrls = normalizeAssetCoverImageUrls(
    requestedCoverUrls,
    reportData?.imageUrls
  );
  if (selectedCoverUrls.length > 0) {
    return selectedCoverUrls.slice(0, boundedLimit);
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];

  // First pass gives each lot's reviewed primary image priority. Later passes
  // fill remaining slots without allowing one lot's gallery to crowd out peers.
  for (const lot of lots) {
    addUniqueUrl(lot?.image_url, urls, seen);
  }
  for (const lot of lots) {
    addUrlArray(lot?.image_urls, urls, seen);
    addUrlArray(lot?.extra_image_urls, urls, seen);
    const items = Array.isArray(lot?.items) ? lot.items : [];
    for (const item of items) {
      addUniqueUrl(item?.image_url, urls, seen);
      addUrlArray(item?.image_urls, urls, seen);
    }
  }

  addUrlArray(reportData?.imageUrls, urls, seen);
  addUrlArray(reportData?.image_urls, urls, seen);
  addUrlArray(reportData?.preview_data?.imageUrls, urls, seen);
  addUrlArray(reportData?.preview_data?.image_urls, urls, seen);

  return urls.slice(0, boundedLimit);
}

/**
 * A cover choice is explicit only when at least one requested URL survives the
 * report-ownership check. Empty or wholly invalid arrays intentionally retain
 * the historical automatic-cover behavior.
 */
export function hasExplicitCoverPhotoSelection(reportData: any): boolean {
  const requestedCoverUrls = Array.isArray(reportData?.cover_image_urls)
    ? reportData.cover_image_urls
    : reportData?.preview_data?.cover_image_urls;
  return normalizeAssetCoverImageUrls(
    requestedCoverUrls,
    reportData?.imageUrls
  ).length > 0;
}

/**
 * Resolve fixed cover slots without duplicating an explicit user selection.
 * Automatic covers retain their legacy modulo repetition so older reports keep
 * the same four-panel artwork.
 */
export function resolveCoverPhotoSlotSources<T>(
  sources: T[],
  slotCount: number,
  repeatPhotos: boolean
): Array<CoverPhotoSlotSource<T>> {
  const count = Math.max(0, Math.floor(Number(slotCount) || 0));
  if (count === 0) return [];
  if (sources.length === 0) return Array.from({ length: count }, () => null);

  return Array.from({ length: count }, (_, index) =>
    repeatPhotos ? sources[index % sources.length] : sources[index] ?? null
  );
}

export async function loadCoverPhotoBuffers(
  reportData: any,
  limit = COVER_TEMPLATE_PHOTO_SLOTS.length
): Promise<Buffer[]> {
  // Fetch the bounded set concurrently, preserve input order, and discard failed
  // downloads; the collage has a neutral fallback for a completely empty set.
  const buffers = await Promise.all(
    collectCoverPhotoUrls(reportData, limit).map((url) =>
      fetchImageBuffer(url)
    )
  );
  return buffers.filter((buffer): buffer is Buffer => Boolean(buffer));
}

export async function prepareCoverPhoto(
  source: Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .resize(width, height, {
      fit: "cover",
      position: "attention",
    })
    .grayscale()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function buildNeutralCoverPhoto(
  width: number,
  height: number
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#D7D7D7",
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function buildCoverCollage(
  photoBuffers: Buffer[],
  width = 1224,
  height = 870,
  options: { repeatPhotos?: boolean } = {}
): Promise<Buffer> {
  const sources = await Promise.all(
    resolveCoverPhotoSlotSources(
      photoBuffers,
      4,
      options.repeatPhotos !== false
    ).map((source) => source ?? buildNeutralCoverPhoto(width, height))
  );
  const topHeight = Math.round(height * 0.34);
  const middleTop = Math.round(height * 0.31);
  const middleHeight = Math.round(height * 0.36);
  const bottomTop = Math.round(height * 0.64);
  const bottomHeight = height - bottomTop;
  const halfWidth = Math.ceil(width / 2);
  const prepared = await Promise.all([
    prepareCoverPhoto(sources[0], width, topHeight),
    prepareCoverPhoto(sources[1], halfWidth, middleHeight),
    prepareCoverPhoto(sources[2], width - halfWidth, middleHeight),
    prepareCoverPhoto(sources[3], width, bottomHeight),
  ]);
  const separators = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="0,${middleTop - 12} ${width},${middleTop + 24} ${width},${middleTop + 42} 0,${middleTop + 8}" fill="#ffffff"/>
      <polygon points="0,${bottomTop - 18} ${width},${bottomTop + 8} ${width},${bottomTop + 28} 0,${bottomTop + 2}" fill="#ffffff"/>
    </svg>
  `);

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#FFFFFF",
    },
  })
    .composite([
      { input: prepared[0], top: 0, left: 0 },
      { input: prepared[1], top: middleTop, left: 0 },
      { input: prepared[2], top: middleTop, left: halfWidth },
      { input: prepared[3], top: bottomTop, left: 0 },
      { input: separators, top: 0, left: 0 },
    ])
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
