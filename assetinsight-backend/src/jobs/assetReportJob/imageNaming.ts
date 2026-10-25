import { createLotPhotoResolver, deletedLotPhotoUrls } from "../../utils/lotPhotoOrder.js";

function sanitizeTitleForFilename(value: unknown): string {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!text) {
    return "";
  }

  return text.slice(0, 120).trim();
}

function getLotTitleBase(lot: any, lotIndex: number): string {
  const candidates = [
    lot?.title,
    lot?.asset_title,
    lot?.lot_title,
    lot?.name,
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeTitleForFilename(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  const fallbackLotNumber =
    lot?.lot_number != null && String(lot.lot_number).trim() !== ""
      ? String(lot.lot_number).trim()
      : String(lotIndex + 1);

  return `Lot ${fallbackLotNumber}`;
}

function getLotNumberSuffix(lot: any, lotIndex: number): string {
  const rawLotNumber =
    lot?.lot_number != null && String(lot.lot_number).trim() !== ""
      ? String(lot.lot_number).trim()
      : String(lotIndex + 1);
  const sanitizedLotNumber = sanitizeTitleForFilename(rawLotNumber);
  return sanitizedLotNumber ? `Lot #${sanitizedLotNumber}` : "";
}

function appendLotNumberToTitle(baseTitle: string, lot: any, lotIndex: number): string {
  const lotSuffix = getLotNumberSuffix(lot, lotIndex);
  if (!lotSuffix) return baseTitle;

  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedTitle = normalize(baseTitle);
  const normalizedSuffix = normalize(lotSuffix);
  if (normalizedTitle.includes(normalizedSuffix)) {
    return baseTitle;
  }

  return `${baseTitle} - ${lotSuffix}`;
}

function getUniqueLotTitleBase(
  lot: any,
  lotIndex: number,
  titleUsage: Map<string, number>
): string {
  const baseTitle = appendLotNumberToTitle(getLotTitleBase(lot, lotIndex), lot, lotIndex);
  const currentCount = titleUsage.get(baseTitle) || 0;
  titleUsage.set(baseTitle, currentCount + 1);
  return currentCount === 0 ? baseTitle : `${baseTitle} - ${currentCount + 1}`;
}

const padOrder = (value: number) => String(value).padStart(3, "0");

const toImageIndexArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value
        .filter((entry) => typeof entry === "number" || (typeof entry === "string" && entry.trim() !== ""))
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0)
    : [];

const toDeletedIndexSet = (value: unknown): Set<number> =>
  new Set(toImageIndexArray(value));

function buildSortSafeImageName(
  lotTitleBase: string,
  lotIndex: number,
  photoIndex: number
): string {
  return `Lot-${padOrder(lotIndex + 1)}_Photo-${padOrder(photoIndex)}_${lotTitleBase}.jpg`;
}

function inferVideoExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    const extension = match?.[1]?.toLowerCase();
    if (extension && ["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(extension)) {
      return extension;
    }
  } catch {
    // Legacy records may contain non-URL paths. Fall through to a safe default.
  }
  return "mp4";
}

function buildSortSafeVideoName(
  lotTitleBase: string,
  lotIndex: number,
  videoIndex: number,
  url: string
): string {
  return `Lot-${padOrder(lotIndex + 1)}_Video-${padOrder(videoIndex)}_${lotTitleBase}.${inferVideoExtension(url)}`;
}

export type OrderedLotImageZipEntry = {
  url: string;
  filename: string;
  lotIndex: number;
  photoIndex: number;
  globalIndex?: number;
};

export type OrderedLotVideoZipEntry = {
  url: string;
  filename: string;
  lotIndex: number;
  videoIndex: number;
};

/**
 * Videos stay outside image indexes because they are never analyzed or
 * watermarked. Their saved per-lot arrays are authoritative, with the report
 * manifest used only as a legacy/unassigned fallback.
 */
export function buildOrderedLotVideoZipEntries(
  lots: any[],
  allVideoUrls: string[]
): OrderedLotVideoZipEntry[] {
  const entries: OrderedLotVideoZipEntry[] = [];
  const titleUsage = new Map<string, number>();
  const seenUrls = new Set<string>();
  const safeLots = Array.isArray(lots) ? lots : [];
  const safeVideoUrls = Array.isArray(allVideoUrls) ? allVideoUrls : [];

  for (let lotIndex = 0; lotIndex < safeLots.length; lotIndex += 1) {
    const lot = safeLots[lotIndex];
    const lotTitleBase = getUniqueLotTitleBase(lot, lotIndex, titleUsage);
    const lotVideos = Array.isArray(lot?.video_urls) ? lot.video_urls : [];
    let videoIndex = 0;

    for (const value of lotVideos) {
      if (typeof value !== "string" || !value.trim()) continue;
      const url = value.trim();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      videoIndex += 1;
      entries.push({
        url,
        filename: buildSortSafeVideoName(lotTitleBase, lotIndex, videoIndex, url),
        lotIndex,
        videoIndex,
      });
    }
  }

  let unassignedIndex = 0;
  for (const value of safeVideoUrls) {
    if (typeof value !== "string" || !value.trim()) continue;
    const url = value.trim();
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    unassignedIndex += 1;
    entries.push({
      url,
      filename: `Lot-${padOrder(safeLots.length + 1)}_Video-${padOrder(unassignedIndex)}_Unassigned-Video.${inferVideoExtension(url)}`,
      lotIndex: safeLots.length,
      videoIndex: unassignedIndex,
    });
  }

  return entries;
}

export function buildOrderedLotImageZipEntries(
  lots: any[],
  allImageUrls: string[],
  deletedImageIndexes?: unknown,
  deletedImageUrls?: unknown
): OrderedLotImageZipEntry[] {
  const entries: OrderedLotImageZipEntry[] = [];
  const titleUsage = new Map<string, number>();
  const deletedIndexes = toDeletedIndexSet(deletedImageIndexes);
  const seen = new Set<string>();
  const safeLots = Array.isArray(lots) ? lots : [];
  const safeImageUrls = Array.isArray(allImageUrls) ? allImageUrls : [];

  const deletedUrls = new Set<string>(Array.isArray(deletedImageUrls)
    ? deletedImageUrls.filter((url): url is string => typeof url === "string").map((url) => url.trim()) : []);
  const resolvePhotos = createLotPhotoResolver(safeImageUrls, deletedImageIndexes, deletedImageUrls);
  // A locally deleted photo must not reappear as an unassigned ZIP entry.
  // Explicit references from another lot remain valid and resolve independently.
  safeLots.forEach((lot) => deletedLotPhotoUrls(lot, safeImageUrls).forEach((url) => deletedUrls.add(url)));

  for (let lotIndex = 0; lotIndex < safeLots.length; lotIndex++) {
    const lot = safeLots[lotIndex];
    const lotTitleBase = getUniqueLotTitleBase(lot, lotIndex, titleUsage);
    resolvePhotos(lot).forEach((photo, index) => {
      seen.add(photo.url);
      entries.push({ ...photo, filename: buildSortSafeImageName(lotTitleBase, lotIndex, index + 1), lotIndex, photoIndex: index + 1 });
    });
  }

  if (entries.length > 0) {
    let unassignedPhotoIndex = 0;
    for (let globalIndex = 0; globalIndex < safeImageUrls.length; globalIndex++) {
      const url = safeImageUrls[globalIndex];
      if (typeof url !== "string" || !url.trim() || deletedIndexes.has(globalIndex)) {
        continue;
      }
      const normalizedUrl = url.trim();
      if (seen.has(normalizedUrl) || deletedUrls.has(normalizedUrl)) {
        continue;
      }
      unassignedPhotoIndex += 1;
      seen.add(normalizedUrl);
      entries.push({
        url: normalizedUrl,
        filename: `Lot-${padOrder(safeLots.length + 1)}_Photo-${padOrder(unassignedPhotoIndex)}_Unassigned-Image.jpg`,
        lotIndex: safeLots.length,
        photoIndex: unassignedPhotoIndex,
        globalIndex,
      });
    }
    return entries;
  }

  return safeImageUrls
    .map((url, index) => ({ url, index }))
    .filter(({ url, index }) => typeof url === "string" && url.trim() && !deletedIndexes.has(index) && !deletedUrls.has(url.trim()))
    .map(({ url, index }) => ({
      url: url.trim(),
      filename: `Lot-001_Photo-${padOrder(index + 1)}_Image.jpg`,
      lotIndex: 0,
      photoIndex: index + 1,
      globalIndex: index,
    }));
}

export function buildLotImageNameMaps(
  lots: any[],
  allImageUrls: string[]
): {
  urlRenameMap: Record<string, string>;
  imageIndexNames: Map<number, string>;
} {
  const urlRenameMap: Record<string, string> = {};
  const imageIndexNames = new Map<number, string>();

  for (const entry of buildOrderedLotImageZipEntries(lots, allImageUrls)) {
    urlRenameMap[entry.url] = entry.filename;
    if (typeof entry.globalIndex === "number" && !imageIndexNames.has(entry.globalIndex)) {
      imageIndexNames.set(entry.globalIndex, entry.filename);
    }
  }

  return { urlRenameMap, imageIndexNames };
}
