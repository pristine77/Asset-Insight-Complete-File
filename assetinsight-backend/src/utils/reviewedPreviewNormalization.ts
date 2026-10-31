import { markPreviewDataSpecsReviewed } from "./auctioneerSpecRows.js";
import { normalizePreviewLotsForBusinessRules } from "./previewLotNormalization.js";

/** Preview mutations accept the supplied spec table as a complete reviewed snapshot. */
export function normalizeReviewedPreviewLotsForBusinessRules<T extends Record<string, any>>(
  previewData: T,
  options: Parameters<typeof normalizePreviewLotsForBusinessRules>[1] = {}
): T {
  const canonical = { ...previewData };
  // Fields of the removed preview currency conversion (owner, 2026-10-31). A
  // page still open from before the removal may send them; they are never
  // report content or part of an immutable file-generation snapshot.
  delete canonical._currency_base_revision;
  delete canonical.currency_conversion;
  return normalizePreviewLotsForBusinessRules(markPreviewDataSpecsReviewed(canonical), options);
}
