const SERVER_OWNED_PREVIEW_FIELDS = ["admin_schedule_sheet"] as const;

/**
 * Generic preview editors predate Proposal Valuation and submit the complete
 * Mixed preview_data object. Keep PV-owned nested state authoritative from the
 * latest database document so a stale preview tab cannot replace or remove it.
 */
export function preserveAssetProposalValuationPreviewState(
  candidate: any,
  current: any
): any {
  const next =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? { ...candidate }
      : {};
  for (const field of SERVER_OWNED_PREVIEW_FIELDS) {
    if (
      current &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, field)
    ) {
      next[field] = current[field];
    } else {
      delete next[field];
    }
  }
  return next;
}
