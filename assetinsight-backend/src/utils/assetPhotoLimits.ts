export const MAX_ASSET_LOT_PHOTOS = 200;

const toCount = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function getMixedLotPhotoLimitMessage(details: any): string | null {
  if (!Array.isArray(details?.mixed_lots)) return null;
  const badLot = details.mixed_lots.find((lot: any, index: number) => {
    const total = toCount(lot?.count) + toCount(lot?.extra_count);
    return total > MAX_ASSET_LOT_PHOTOS
      ? { index, lot_number: lot?.lot_number, total }
      : false;
  });

  if (!badLot) return null;
  const total = toCount(badLot?.count) + toCount(badLot?.extra_count);
  const label = badLot?.lot_number ? `Lot ${badLot.lot_number}` : `Lot ${details.mixed_lots.indexOf(badLot) + 1}`;
  return `${label} has ${total} photo(s). The maximum is ${MAX_ASSET_LOT_PHOTOS} photos per lot, including main and report-only photos.`;
}

export function countPreviewLotPhotos(lot: any): number {
  const indexes = Array.isArray(lot?.image_indexes) ? lot.image_indexes.length : 0;
  const urls = Array.isArray(lot?.image_urls) ? lot.image_urls.length : 0;
  const extraIndexes = Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes.length : 0;
  const extraUrls = Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls.length : 0;
  return Math.max(indexes, urls) + Math.max(extraIndexes, extraUrls);
}

export function getPreviewLotPhotoLimitMessage(previewData: any): string | null {
  const lots = Array.isArray(previewData?.lots) ? previewData.lots : [];
  for (let index = 0; index < lots.length; index += 1) {
    const lot = lots[index];
    const total = countPreviewLotPhotos(lot);
    if (total > MAX_ASSET_LOT_PHOTOS) {
      const label = lot?.lot_number ? `Lot ${lot.lot_number}` : `Lot ${index + 1}`;
      return `${label} has ${total} photo(s). The maximum is ${MAX_ASSET_LOT_PHOTOS} photos per lot, including main and report-only photos.`;
    }
  }
  return null;
}
