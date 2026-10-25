import { parsePreviewPhotoIndex } from "./previewLotPhotos";

export type LotPhotoReference = {
  globalIndex: number | null;
  url: string;
};

type PhotoDeletionState = {
  deleted_image_indexes?: number[];
  deleted_image_urls?: string[];
};

export const removeLotPhotoReference = <T>(
  previewData: T,
  lotIndex: number,
  photo: LotPhotoReference
): T & PhotoDeletionState => {
  if (!previewData || typeof previewData !== "object") {
    return previewData as T & PhotoDeletionState;
  }
  const data = previewData as any;
  if (!Array.isArray(data.lots) || !data.lots[lotIndex]) {
    return previewData as T & PhotoDeletionState;
  }

  const globalIndex = parsePreviewPhotoIndex(photo.globalIndex);
  const imageUrl = photo.url.trim();
  const hasGlobalIndex = globalIndex !== null;
  const lots = [...data.lots];
  const lot = { ...lots[lotIndex] };
  const cleanUrl = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const removeRepresentation = (indexKey: string, urlKey: string) => {
    const indexes = Array.isArray(lot[indexKey]) ? lot[indexKey] : [];
    const urls = Array.isArray(lot[urlKey]) ? lot[urlKey] : [];
    const removedPositions = new Set<number>();
    for (let position = 0; position < Math.max(indexes.length, urls.length); position += 1) {
      const pairedUrl = cleanUrl(urls[position]);
      if ((imageUrl && pairedUrl === imageUrl) ||
        (!pairedUrl && hasGlobalIndex && parsePreviewPhotoIndex(indexes[position]) === globalIndex)) {
        removedPositions.add(position);
      }
    }
    if (Array.isArray(lot[indexKey])) {
      lot[indexKey] = indexes.filter((_value: unknown, position: number) => !removedPositions.has(position));
    }
    if (Array.isArray(lot[urlKey])) {
      lot[urlKey] = urls.filter((_value: unknown, position: number) => !removedPositions.has(position));
    }
  };
  removeRepresentation("image_indexes", "image_urls");
  removeRepresentation("extra_image_indexes", "extra_image_urls");
  const removesScalarUrl = Boolean(imageUrl && cleanUrl(lot.image_url) === imageUrl);
  if (removesScalarUrl || (!cleanUrl(lot.image_url) && hasGlobalIndex && parsePreviewPhotoIndex(lot.image_index) === globalIndex)) {
    delete lot.image_index;
  }
  if ((imageUrl && cleanUrl(lot.cover_url) === imageUrl) ||
    (!cleanUrl(lot.cover_url) && (removesScalarUrl ||
      (hasGlobalIndex && parsePreviewPhotoIndex(lot.cover_index) === globalIndex)))) {
    delete lot.cover_index;
  }
  if (imageUrl) {
    if (removesScalarUrl) delete lot.image_url;
    if (cleanUrl(lot.cover_url) === imageUrl) delete lot.cover_url;
  }
  lots[lotIndex] = lot;

  const stillReferenced = lots.some((candidate: any) => {
    const indexRefs = [
      ...(Array.isArray(candidate?.image_indexes) ? candidate.image_indexes : []),
      ...(Array.isArray(candidate?.extra_image_indexes)
        ? candidate.extra_image_indexes
        : []),
      ...(candidate?.image_index !== undefined ? [candidate.image_index] : []),
      ...(candidate?.cover_index !== undefined ? [candidate.cover_index] : []),
    ];
    const urlRefs = [
      ...(Array.isArray(candidate?.image_urls) ? candidate.image_urls : []),
      ...(Array.isArray(candidate?.extra_image_urls)
        ? candidate.extra_image_urls
        : []),
      candidate?.image_url,
      candidate?.cover_url,
    ].filter(Boolean);
    return (
      (hasGlobalIndex &&
        indexRefs.some((value) => parsePreviewPhotoIndex(value) === globalIndex)) ||
      urlRefs.some((value) => cleanUrl(value) === imageUrl)
    );
  });

  const deletedIndexes = Array.isArray(data.deleted_image_indexes)
    ? data.deleted_image_indexes
        .map(parsePreviewPhotoIndex)
        .filter((value: number | null): value is number => value !== null)
    : [];
  const nextDeletedIndexes =
    !hasGlobalIndex ||
    stillReferenced ||
    deletedIndexes.includes(Number(globalIndex))
      ? deletedIndexes
      : [...deletedIndexes, Number(globalIndex)];
  const deletedUrls = Array.isArray(data.deleted_image_urls)
    ? data.deleted_image_urls.filter(
        (value: unknown): value is string => typeof value === "string"
      )
    : [];
  const nextDeletedUrls =
    stillReferenced || !imageUrl || deletedUrls.includes(imageUrl)
      ? deletedUrls
      : [...deletedUrls, imageUrl];

  return {
    ...data,
    lots,
    deleted_image_indexes: nextDeletedIndexes,
    deleted_image_urls: nextDeletedUrls,
  } as T & PhotoDeletionState;
};

export const removeGalleryPhotoEntry = <
  T extends LotPhotoReference & { lotIndex: number | null },
>(
  entries: T[],
  currentIdx: number,
  target: LotPhotoReference & { lotIndex: number }
) => {
  const nextEntries = entries.filter(
    (entry) =>
      !(
        entry.lotIndex === target.lotIndex &&
        entry.url === target.url &&
        entry.globalIndex === target.globalIndex
      )
  );
  return {
    entries: nextEntries,
    currentIdx: nextEntries.length
      ? Math.min(currentIdx, nextEntries.length - 1)
      : 0,
  };
};
