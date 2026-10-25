import { markPreviewDataSpecsReviewed } from "./auctioneerSpecRows.js";
import { normalizePreviewLotsForBusinessRules } from "./previewLotNormalization.js";

/** Preview mutations accept the supplied spec table as a complete reviewed snapshot. */
export function normalizeReviewedPreviewLotsForBusinessRules<T extends Record<string, any>>(
  previewData: T,
  options: Parameters<typeof normalizePreviewLotsForBusinessRules>[1] = {}
): T {
  return normalizePreviewLotsForBusinessRules(markPreviewDataSpecsReviewed(previewData), options);
}
