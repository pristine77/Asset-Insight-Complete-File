/**
 * The Description row of every condition report (PDF and DOCX, Asset and Lot
 * Listing) shows the saved Title, including reviewed line breaks. The stored
 * narrative remains independent and is only a fallback for legacy untitled lots.
 *
 * Owner decision 2026-10-14 supersedes description-first output: Title is the
 * single editable summary shown under Description in Excel/PDF/Word. This is
 * an export projection, never a rewrite of the separately stored narrative.
 * Auctioneer/provider payloads and reviewed specification fields are unchanged.
 */
export function resolveCrLotDescription(lot: any, fallbackTitle: string): string {
  return String(lot?.title ?? "").trim() || String(lot?.description ?? "").trim() || fallbackTitle;
}
