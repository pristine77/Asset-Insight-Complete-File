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

/*
   WHERE AN APPRAISAL'S LOT NUMBERS COME FROM (owner, 2026-11-03)

   Tanner's appraisal 95131 came out with random and repeated lot numbers. The
   AI wrote a number for every lot from anything number-like in the photos
   (stickers, decals, unit numbers), the prompt's examples carried "101" and
   "102", and nothing checked for repeats. The owner chose: "Use a number only
   when a lot-number card is photographed; every other lot gets the next
   number in capture order. Never two lots with the same number in one
   report."

   Then, asked about stickers: "Yes, lot stickers count". A lot-number
   sticker or tag staff put on the item is a lot card too; the item's own
   decals, unit, model and serial numbers never are.

   So, at the first analysis only, before any number is filled in:
   - a number is kept when it came from a lot-number card. That means the
     bundle lot-number photo or a reviewed Lot Number Upload (the diagnostic's
     numberSource), or the AI saying it read a lot card
     (lot_number_source = "lot_card");
   - the first lot to use a number keeps it; a later repeat is cleared;
   - every other number is cleared, and the lot is then numbered in capture
     order. normalizeLotsForReportOrdering fills it here; on an Auctioneer 2.0
     work item, allocateInitialAuctioneerLotNumbers replaces it with the next
     free number in the sale.
   A cleared number is kept in analysis_metadata.lot_number_dropped, so
   anyone can see what the photos said.
*/
const LOT_CARD_NUMBER_SOURCES = new Set(["first_main_photo", "last_main_photo", "reviewed_upload"]);

/** Whether a lot's number came from a lot-number card. */
export function lotNumberIsFromLotCard(lot: any): boolean {
  const detected = lot?.analysis_metadata?.bundle_lot_number_detection?.numberSource;
  if (LOT_CARD_NUMBER_SOURCES.has(detected)) return true;
  if (detected === "sequential_fallback") return false;
  return lot?.lot_number_source === "lot_card";
}

/** First analysis only: keep lot-card numbers, once each; clear the rest. */
export function keepLotCardNumbersOnly(inputLots: any[]): any[] {
  if (!Array.isArray(inputLots)) return [];
  const used = new Set<string>();
  return inputLots.map((lot: any) => {
    if (!lot || typeof lot !== "object") return lot;
    // The AI's evidence is recorded here, never sent on as a lot field.
    const { lot_number_source: aiSource, ...rest } = lot;
    const value = String(rest.lot_number ?? "").trim();
    if (!value) return rest;
    const fromCard = lotNumberIsFromLotCard(lot);
    const key = value.toLowerCase();
    if (fromCard && !used.has(key)) {
      used.add(key);
      return rest;
    }
    return {
      ...rest,
      lot_number: null,
      analysis_metadata: {
        ...(rest.analysis_metadata || {}),
        lot_number_dropped: {
          version: 1,
          value,
          reason: fromCard ? "repeated" : "not_a_lot_card",
          ai_source: typeof aiSource === "string" ? aiSource : null,
        },
      },
    };
  });
}

/** The grouping modes whose lots are numbered in capture order when they have no lot card. */
export const CAPTURE_ORDER_NUMBERED_MODES = new Set(["per_item", "per_photo", "single_lot", "mixed"]);

// Keep report lot output in the current preview/user order; only fill missing Lot # values.
export function normalizeLotsForReportOrdering(
  inputLots: any[],
  groupingMode?: AssetGroupingMode | string,
  options: { includeMixed?: boolean } = {}
): any[] {
  if (!Array.isArray(inputLots) || inputLots.length === 0) {
    return [];
  }
  // Mixed reports are filled only at the first analysis (includeMixed), so
  // regenerating files never renumbers a mixed report someone has reviewed.
  if (
    groupingMode !== "per_item" &&
    groupingMode !== "per_photo" &&
    groupingMode !== "single_lot" &&
    !(groupingMode === "mixed" && options.includeMixed === true)
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
