const MODES = new Set(["single_lot", "per_item", "per_photo"]);

function count(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/**
 * Explicit lot boundaries must describe the complete photo stream. Dropping an
 * empty group or clipping counts moves later photos into the wrong physical lot.
 * Legacy ungrouped Lot Listing intake is checked by its caller separately.
 */
export function assertMixedLotPhotoManifest(
  mixedLots: unknown,
  totalImages: number,
  options: { allowMissingMode?: boolean } = {},
): void {
  const fail = (reason = "Check that every lot has main photos and a supported grouping mode.") => {
    throw Object.assign(new Error(
      `The lot photo mapping is incomplete or inconsistent. ${reason} Reopen the saved draft and review the lot photos before submitting again. No lots were combined.`,
    ), { code: "INVALID_LOT_PHOTO_MAPPING", statusCode: 400 });
  };
  if (!Array.isArray(mixedLots) || mixedLots.length === 0) return fail();
  let expected = 0;
  for (const [index, lot] of mixedLots.entries()) {
    const main = count(lot?.count);
    const extra = count(lot?.extra_count ?? lot?.extraCount ?? 0);
    const mode = String(lot?.mode ?? "").trim();
    if (!Number.isFinite(main) || main < 1 || !Number.isFinite(extra) ||
      !(MODES.has(mode) || (options.allowMissingMode && !mode))) return fail(`Lot position ${index + 1} needs at least one main photo, valid photo counts and a supported grouping mode.`);
    expected += main + extra;
  }
  if (expected !== totalImages) fail(`The lot groups describe ${expected} photos, but the upload contains ${totalImages}. Report-only photos must be counted separately from main photos.`);
}

/** Same admission policy as the workers, before accepting uploads or removing drafts. */
export function assertReportLotPhotoManifest(type: "asset" | "lotListing", details: any, totalImages: number): void {
  if (type === "asset" && (details?.grouping_mode || "mixed") === "mixed") {
    assertMixedLotPhotoManifest(details.mixed_lots, totalImages);
  } else if (type === "lotListing" && Array.isArray(details?.mixed_lots) && details.mixed_lots.length) {
    assertMixedLotPhotoManifest(details.mixed_lots, totalImages, { allowMissingMode: true });
  }
}

/** Model references may only identify a photo supplied for this exact group. */
export function resolveGroupModelImageIndex(
  value: unknown,
  analyzedIndexes: readonly number[],
  imageUrls: readonly string[],
): number | undefined {
  return typeof value === "string"
    ? analyzedIndexes.find((index) => imageUrls[index] === value)
    : undefined;
}

export function resolveGroupModelImageUrl(
  value: unknown,
  analyzedIndexes: readonly number[],
  imageUrls: readonly string[],
): string | undefined {
  const index = resolveGroupModelImageIndex(value, analyzedIndexes, imageUrls);
  return index === undefined ? undefined : imageUrls[index];
}
