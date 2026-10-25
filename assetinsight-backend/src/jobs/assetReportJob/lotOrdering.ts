import type { AssetGroupingMode } from "./types.js";

// Extract a numeric lot label from mixed string/number input when present.
export function extractNumericLotNumber(rawLotNumber: unknown): number | null {
  if (typeof rawLotNumber === "number" && Number.isFinite(rawLotNumber)) {
    return rawLotNumber;
  }
  if (typeof rawLotNumber !== "string") {
    return null;
  }
  const numericMatch = rawLotNumber.match(/\d+/);
  if (!numericMatch) {
    return null;
  }
  const parsedNumber = parseInt(numericMatch[0], 10);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}

// Keep report lot output in the current preview/user order; only fill missing Lot # values.
export function normalizeLotsForReportOrdering(
  inputLots: any[],
  groupingMode?: AssetGroupingMode | string
): any[] {
  if (!Array.isArray(inputLots) || inputLots.length === 0) {
    return [];
  }
  if (
    groupingMode !== "per_item" &&
    groupingMode !== "per_photo" &&
    groupingMode !== "single_lot"
  ) {
    return inputLots;
  }
  const usedLotNumbers = new Set(
    inputLots
      .map((lot) => String(lot?.lot_number ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  let nextFallbackLotNumber = 1;
  return inputLots.map((lot: any) => {
    if (!lot || typeof lot !== "object") {
      return lot;
    }
    if (lot.lot_number != null && String(lot.lot_number).trim() !== "") {
      return lot;
    }
    while (usedLotNumbers.has(String(nextFallbackLotNumber).toLowerCase())) {
      nextFallbackLotNumber += 1;
    }
    const lotNumber = String(nextFallbackLotNumber);
    usedLotNumbers.add(lotNumber.toLowerCase());
    nextFallbackLotNumber += 1;
    return {
      ...lot,
      lot_number: lotNumber,
    };
  });
}
