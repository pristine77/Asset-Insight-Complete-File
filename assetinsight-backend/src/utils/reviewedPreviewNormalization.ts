import { markPreviewDataSpecsReviewed } from "./auctioneerSpecRows.js";
import { normalizePreviewLotsForBusinessRules } from "./previewLotNormalization.js";

/** Preview mutations accept the supplied spec table as a complete reviewed snapshot. */
export function normalizeReviewedPreviewLotsForBusinessRules<T extends Record<string, any>>(
  previewData: T,
  options: Parameters<typeof normalizePreviewLotsForBusinessRules>[1] = {}
): T {
  const canonical = { ...previewData };
  // GET-only currency CAS marker is transport metadata, never report content or
  // part of an immutable file-generation snapshot.
  delete canonical._currency_base_revision;
  return normalizePreviewLotsForBusinessRules(markPreviewDataSpecsReviewed(canonical), options);
}
