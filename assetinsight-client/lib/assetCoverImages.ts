export const MAX_ASSET_COVER_IMAGES = 4;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringUrls = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const integerIndexes = (value: unknown): number[] =>
  Array.isArray(value)
    ? value
        .map(Number)
        .filter(
          (index, position, indexes) =>
            Number.isInteger(index) &&
            index >= 0 &&
            indexes.indexOf(index) === position
        )
    : [];

const uniqueUrls = (value: unknown): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of stringUrls(value)) {
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
};

/**
 * Collect every active, report-owned Asset photo in root upload order. The root
 * media list is also the backend ownership boundary, so the picker never offers
 * a preview-only URL that would be rejected when the edited preview is saved.
 * Deleted preview references are excluded without mutating the report snapshot.
 */
export function collectAssetCoverImageUrls(
  previewDataValue: unknown,
  rootImageUrlsValue: unknown = []
): string[] {
  const previewData = isRecord(previewDataValue) ? previewDataValue : {};
  const rootImageUrls = stringUrls(rootImageUrlsValue);
  const deletedUrls = new Set(stringUrls(previewData.deleted_image_urls));

  for (const index of integerIndexes(previewData.deleted_image_indexes)) {
    const url = rootImageUrls[index];
    if (url) deletedUrls.add(url);
  }

  return uniqueUrls(rootImageUrls).filter((url) => !deletedUrls.has(url));
}

/**
 * Normalize a persisted cover selection while retaining the user's order.
 * Unknown, deleted, duplicate, and excess URLs are pruned.
 */
export function normalizeAssetCoverImageUrls(
  selectedUrlsValue: unknown,
  candidateUrlsValue: unknown,
  limit = MAX_ASSET_COVER_IMAGES
): string[] {
  const candidates = new Set(uniqueUrls(candidateUrlsValue));
  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : MAX_ASSET_COVER_IMAGES;
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const url of stringUrls(selectedUrlsValue)) {
    if (normalized.length >= safeLimit) break;
    if (!candidates.has(url) || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }

  return normalized;
}
