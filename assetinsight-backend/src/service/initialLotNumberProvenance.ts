/** Track missing numbers before generic normalization fills report-local labels. */
export function markInitialLotNumberFallback(lot: any): any {
  if (!lot || typeof lot !== "object" || String(lot.lot_number ?? "").trim()) return lot;
  return {
    ...lot,
    analysis_metadata: {
      ...(lot.analysis_metadata || {}),
      initial_lot_number: { version: 1, source: "sequential_fallback" },
    },
  };
}

/** Initial analysis only: a literal "1" is not evidence of automatic numbering. */
export function initialLotNumberFallbackIndexes(lots: any[]): number[] {
  return lots.flatMap((lot, index) => {
    // A number the lot-card rule cleared (not a lot card, or a repeat) was
    // refilled in capture order, so it takes the next number in the sale too
    // (owner 2026-11-03, jobs/assetReportJob/lotOrdering.ts). Checked before the
    // capture identity: a phone number that repeated another lot is refilled too.
    if (lot?.analysis_metadata?.lot_number_dropped) return [index];
    if (lot?.analysis_metadata?.capture_lot_identity?.applied === true) return [];
    const diagnostic = lot?.analysis_metadata?.bundle_lot_number_detection;
    if (["first_main_photo", "last_main_photo", "reviewed_upload", "capture_form"].includes(diagnostic?.numberSource)) return [];
    const automatic = diagnostic?.numberSource === "sequential_fallback"
      || lot?.analysis_metadata?.initial_lot_number?.source === "sequential_fallback"
      || !String(lot?.lot_number ?? "").trim();
    return automatic ? [index] : [];
  });
}
