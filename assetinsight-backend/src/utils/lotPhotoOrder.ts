export type OrderedLotPhoto = { url: string; globalIndex?: number };

const cleanUrl = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const validIndex = (value: unknown): number | undefined => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
};

/** Indexes belong to one manifest. Concatenation, filtering and deduplication shift them. */
export function firstReportImageManifest(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(cleanUrl);
  }
  return [];
}

export function deletedLotPhotoUrls(lot: any, globals: string[]): string[] {
  const deleted = new Set<string>(Array.isArray(lot?.deleted_image_urls) ? lot.deleted_image_urls.map(cleanUrl).filter(Boolean) : []);
  if (Array.isArray(lot?.deleted_image_indexes)) lot.deleted_image_indexes.forEach((value: unknown) => {
    const index = validIndex(value);
    if (index !== undefined && globals[index]) deleted.add(globals[index]);
  });
  return [...deleted];
}

/**
 * Saved lot URLs are the displayed order. Their paired indexes can be stale
 * after legacy compaction, so never substitute another photo at that position.
 * Older partial URL arrays may still have trailing index-only photos.
 */
export function createLotPhotoResolver(
  globals: string[],
  reportDeletedIndexes: unknown = [],
  reportDeletedUrls: unknown = [],
): (lot: any) => OrderedLotPhoto[] {
  const indexesByUrl = new Map<string, number[]>();
  globals.forEach((value, index) => {
    const url = cleanUrl(value);
    if (url) {
      const indexes = indexesByUrl.get(url);
      if (indexes) indexes.push(index);
      else indexesByUrl.set(url, [index]);
    }
  });
  const deletedIndexes = new Set<number>();
  if (Array.isArray(reportDeletedIndexes)) reportDeletedIndexes.forEach((value) => {
    const index = validIndex(value);
    if (index !== undefined) deletedIndexes.add(index);
  });
  const deletedUrls = new Set<string>(Array.isArray(reportDeletedUrls) ? reportDeletedUrls.map(cleanUrl).filter(Boolean) : []);
  deletedIndexes.forEach((index) => {
    if (globals[index]) deletedUrls.add(globals[index]);
  });

  return (lot: any): OrderedLotPhoto[] => {
    const results: OrderedLotPhoto[] = [];
    const seen = new Set<string>();
    const excluded = new Set(deletedUrls);
    deletedLotPhotoUrls(lot, globals).forEach((url) => excluded.add(url));
    const append = (value: unknown, candidateIndex?: number) => {
      const url = cleanUrl(value);
      if (!url || excluded.has(url) || seen.has(url)) return;
      seen.add(url);
      const globalIndex = candidateIndex !== undefined && globals[candidateIndex] === url
        ? candidateIndex : indexesByUrl.get(url)?.[0];
      results.push({ url, ...(globalIndex !== undefined ? { globalIndex } : {}) });
    };
    const appendGroup = (urlsValue: unknown, indexesValue: unknown) => {
      const urls = Array.isArray(urlsValue) ? urlsValue : [];
      const indexes = Array.isArray(indexesValue) ? indexesValue : [];
      for (let position = 0; position < Math.max(urls.length, indexes.length); position += 1) {
        const index = validIndex(indexes[position]);
        const explicit = cleanUrl(urls[position]);
        append(explicit || (index !== undefined ? globals[index] : ""), index);
      }
    };
    appendGroup(lot?.image_urls, lot?.image_indexes);
    // image_url commonly mirrors the selected cover, not the first captured photo.
    if (results.length === 0) {
      const index = validIndex(lot?.image_index);
      append(cleanUrl(lot?.image_url) || (index !== undefined ? globals[index] : ""), index);
    }
    appendGroup(lot?.extra_image_urls, lot?.extra_image_indexes);
    for (const item of Array.isArray(lot?.items) ? lot.items : []) {
      const before = results.length;
      appendGroup(item?.image_urls, item?.image_indexes);
      if (results.length === before) {
        const index = validIndex(item?.image_index);
        append(cleanUrl(item?.image_url) || (index !== undefined ? globals[index] : ""), index);
      }
      appendGroup(item?.extra_image_urls, item?.extra_image_indexes);
    }
    return results;
  };
}
