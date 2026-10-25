export type PreviewLotPhotoEntry = {
  globalIndex: number | null;
  url: string;
};

export const parsePreviewPhotoIndex = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
};

const indexSlots = (value: unknown): (number | null)[] =>
  Array.isArray(value) ? value.map(parsePreviewPhotoIndex) : [];

const urlSlots = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((url) => typeof url === "string" ? url.trim() : "")
    : [];

const entriesFromRepresentations = (
  urls: string[],
  indexes: (number | null)[],
  rootImageUrls: string[]
): PreviewLotPhotoEntry[] => {
  const entries: PreviewLotPhotoEntry[] = [];
  for (let position = 0; position < Math.max(urls.length, indexes.length); position += 1) {
    const pairedIndex = indexes[position] ?? null;
    const localUrl = urls[position];
    if (localUrl) {
      // A conflicting pair may be a compacted preview against an old root list.
      // Keep the URL, but never turn that uncertain index into a deletion marker.
      const matchedIndex = pairedIndex === null
        ? rootImageUrls.indexOf(localUrl)
        : rootImageUrls[pairedIndex] === localUrl ? pairedIndex : -1;
      entries.push({ url: localUrl, globalIndex: matchedIndex >= 0 ? matchedIndex : null });
    } else if (pairedIndex !== null && rootImageUrls[pairedIndex]) {
      entries.push({ url: rootImageUrls[pairedIndex], globalIndex: pairedIndex });
    }
  }
  return entries;
};

/**
 * Lot-local URLs retain durable association and ordering. A global index is
 * exposed only when its root URL agrees; mismatches stay URL-only. Sparse
 * representations retain their positions, including legacy trailing indexes.
 */
export const getPreviewLotPhotoEntries = (
  lot: any,
  rootImageUrlsValue: unknown
): PreviewLotPhotoEntry[] => {
  const rootImageUrls = urlSlots(rootImageUrlsValue);
  const mainIndexes = indexSlots(
    Array.isArray(lot?.image_indexes) && lot.image_indexes.length
      ? lot.image_indexes
      : [lot?.image_index]
  );
  const extraIndexes = indexSlots(lot?.extra_image_indexes);
  const mainUrls = urlSlots(lot?.image_urls);
  const extraUrls = urlSlots(lot?.extra_image_urls);
  const scalarMainUrl = typeof lot?.image_url === "string" ? lot.image_url.trim() : "";
  const authoritativeMainUrls = mainUrls.length ? mainUrls : scalarMainUrl ? [scalarMainUrl] : [];
  const entries = [
    ...entriesFromRepresentations(authoritativeMainUrls, mainIndexes, rootImageUrls),
    ...entriesFromRepresentations(extraUrls, extraIndexes, rootImageUrls),
  ];
  const seen = new Set<string>();
  return entries.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
};
