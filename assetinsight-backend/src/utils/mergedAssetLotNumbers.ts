function cleanSourceLotNumber(value: unknown, index: number): string {
  return (
    String(value ?? "")
      .trim()
      .replace(/^(?:lot\s*#?\s*|#\s*)/i, "") || String(index + 1)
  );
}

/**
 * A merged Asset report is a new report, so its visible lot sequence must not
 * inherit duplicate or non-contiguous numbers from its source reports. Keep
 * the original value as provenance while assigning one canonical sequence for
 * Preview, CR, Excel, and both Asset DOCX renderers.
 */
export function assignSequentialMergedLotNumbers(lots: any[]): any[] {
  if (!Array.isArray(lots)) return [];

  return lots.map((lot, index) => ({
    ...(lot && typeof lot === "object" ? lot : {}),
    merge_source_lot_number: cleanSourceLotNumber(
      lot?.merge_source_lot_number ?? lot?.lot_number ?? lot?.lot_id,
      index
    ),
    // Output renderers already add the localized "Lot" label.
    lot_number: String(index + 1),
  }));
}
