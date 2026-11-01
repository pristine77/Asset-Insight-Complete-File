import { markPreviewDataSpecsReviewed } from "./auctioneerSpecRows.js";
import { normalizePreviewLotsForBusinessRules } from "./previewLotNormalization.js";

/** Preview mutations accept the supplied spec table as a complete reviewed snapshot. */
export function normalizeReviewedPreviewLotsForBusinessRules<T extends Record<string, any>>(
  previewData: T,
  options: Parameters<typeof normalizePreviewLotsForBusinessRules>[1] = {}
): T {
  const canonical = { ...previewData };
  // Raw request currency/receipt validation must run before this normalization.
  // Retired transport fields are not report content or generation snapshots.
  delete canonical._currency_base_revision;
  delete canonical.currency_conversion;
  return normalizePreviewLotsForBusinessRules(markPreviewDataSpecsReviewed(canonical), options);
}
