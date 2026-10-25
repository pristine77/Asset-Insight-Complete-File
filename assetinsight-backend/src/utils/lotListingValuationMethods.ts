import type { LotListingValuationMethod } from "../models/lotListing.model.js";

const SUPPORTED_LOT_LISTING_VALUATION_METHODS = new Set<LotListingValuationMethod>([
  "FML",
  "TKV",
  "OLV",
  "FLV",
]);

function normalizeValues(value: unknown): LotListingValuationMethod[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return Array.from(
    new Set(
      values
        .map((entry) => String(entry ?? "").trim().toUpperCase())
        .filter((entry): entry is LotListingValuationMethod =>
          SUPPORTED_LOT_LISTING_VALUATION_METHODS.has(
            entry as LotListingValuationMethod
          )
        )
    )
  );
}

/**
 * Normalize user-selected Lot Listing valuation methods without silently
 * inventing a selection when the caller supplied an explicit invalid/empty list.
 * The fallback is used only when the value is absent (legacy reports default to FML).
 */
export function normalizeLotListingValuationMethods(
  value: unknown,
  fallback: LotListingValuationMethod[] = ["FML"]
): LotListingValuationMethod[] {
  if (value !== undefined && value !== null) return normalizeValues(value);

  const normalizedFallback = normalizeValues(fallback);
  return normalizedFallback.length > 0 ? normalizedFallback : ["FML"];
}
