// Older Lot documents hydrate a preview containing only Mongoose defaults even
// when analysis saved its rows only at the root. Do not mistake that shell for
// an explicitly edited preview (including an explicitly cleared lots array).
export function getCanonicalLotListingPreview(report: any): any {
  const preview = report?.preview_data;
  const plain = preview?.toObject?.() ?? preview;
  const defaultsOnly = report?.status === "error" && plain &&
    plain.include_damage_analysis === true && plain.bank_photos_enabled === false &&
    JSON.stringify(plain.valuation_methods) === '["FML"]' &&
    Object.entries(plain).every(([key, value]) => {
      if (["include_damage_analysis", "bank_photos_enabled", "valuation_methods"].includes(key)) return true;
      return value === undefined ||
        (["lots", "deleted_image_indexes", "deleted_image_urls", "videoUrls"].includes(key) && Array.isArray(value) && value.length === 0);
    });
  return defaultsOnly ? undefined : preview;
}

// Preview availability is independent of generation/approval/download readiness.
// A failed worker must not lock the owner out of data already saved for review.
export function hasSavedReportPreview(kind: "asset" | "lotListing", report: any): boolean {
  const preview = kind === "lotListing" ? getCanonicalLotListingPreview(report) : report?.preview_data;
  // An explicit (even empty) canonical preview wins over legacy root data.
  const lots = preview != null
    ? preview.lots
    : kind === "lotListing" ? report?.lots : undefined;
  return Array.isArray(lots) && lots.length > 0 && lots.every(
    (lot) => lot && typeof lot === "object" && !Array.isArray(lot) && Object.keys(lot).length > 0,
  );
}

export function hasRecoverableFailedPreview(kind: "asset" | "lotListing", report: any): boolean {
  return report?.status === "error" && hasSavedReportPreview(kind, report);
}
