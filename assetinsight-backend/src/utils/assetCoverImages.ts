export const MAX_ASSET_COVER_IMAGES = 4;

function stringUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function deletedCoverImageUrls(
  previewData: Record<string, any>,
  ownedImageUrls: string[]
): Set<string> {
  const deleted = new Set(stringUrls(previewData.deleted_image_urls));
  if (Array.isArray(previewData.deleted_image_indexes)) {
    for (const value of previewData.deleted_image_indexes) {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= ownedImageUrls.length) {
        continue;
      }
      const url = ownedImageUrls[index];
      if (url) deleted.add(url);
    }
  }
  return deleted;
}

/**
 * Canonicalize the user's ordered cover-photo choice against the report's
 * authoritative root media list. The preview may contain arbitrary editable
 * data, so it must never authorize a new remote URL for server-side fetching.
 */
export function normalizeAssetCoverImageUrls(
  value: unknown,
  ownedImageUrlsValue: unknown,
  excludedUrlsValue: unknown = []
): string[] {
  const owned = new Set(stringUrls(ownedImageUrlsValue));
  const excluded = new Set(stringUrls(excludedUrlsValue));
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const url of stringUrls(value)) {
    if (!owned.has(url) || excluded.has(url) || seen.has(url)) continue;
    seen.add(url);
    selected.push(url);
    if (selected.length === MAX_ASSET_COVER_IMAGES) break;
  }

  return selected;
}

/**
 * Preserve the absence of a cover selection for legacy automatic behavior,
 * while making an explicit selection ordered, unique, owned, and deletion-safe.
 */
export function normalizeAssetPreviewCoverImages<T extends Record<string, any>>(
  previewData: T,
  ownedImageUrlsValue: unknown
): T {
  if (
    !previewData ||
    typeof previewData !== "object" ||
    !Object.prototype.hasOwnProperty.call(previewData, "cover_image_urls")
  ) {
    return previewData;
  }

  const ownedImageUrls = stringUrls(ownedImageUrlsValue);
  const excluded = deletedCoverImageUrls(previewData, ownedImageUrls);
  return {
    ...previewData,
    cover_image_urls: normalizeAssetCoverImageUrls(
      previewData.cover_image_urls,
      ownedImageUrls,
      Array.from(excluded)
    ),
  };
}
