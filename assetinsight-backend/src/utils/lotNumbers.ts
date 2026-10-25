export type LotNumberValidationResult = {
  data?: any;
  message?: string;
};

export function normalizeEditableLotNumber(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^(?:lot\s*#\s*|lot\s+|#\s*)/i, "")
    .trim();
}

function normalizeLotNumberKey(value: unknown): string {
  return normalizeEditableLotNumber(value).toLowerCase();
}

function getFallbackLotNumber(lot: any): string {
  const candidates = [lot?.lot_id, lot?.lot, lot?.id];
  for (const candidate of candidates) {
    const text = normalizeEditableLotNumber(candidate);
    if (text) {
      return text;
    }
  }
  return "";
}

function resolvePreviousLot(previousLots: any[], lot: any, index: number): any | undefined {
  const stableKeys = [lot?.lot_id, lot?.id, lot?._id]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (stableKeys.length > 0) {
    const matched = previousLots.find((candidate) => {
      const candidateKeys = [candidate?.lot_id, candidate?.id, candidate?._id]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
      return candidateKeys.some((key) => stableKeys.includes(key));
    });
    if (matched) return matched;
  }
  return previousLots[index];
}

function getDisplayLotNumber(lot: any, index: number): string {
  return (
    normalizeEditableLotNumber(lot?.lot_number) ||
    getFallbackLotNumber(lot) ||
    String(index + 1)
  );
}

export function havePreviewLotNumbersChanged(previousPreviewData: any, nextPreviewData: any): boolean {
  const previousLots = Array.isArray(previousPreviewData?.lots) ? previousPreviewData.lots : [];
  const nextLots = Array.isArray(nextPreviewData?.lots) ? nextPreviewData.lots : [];
  if (previousLots.length === 0 || nextLots.length === 0) return false;

  for (let index = 0; index < nextLots.length; index++) {
    const nextLot = nextLots[index] || {};
    const previousLot = resolvePreviousLot(previousLots, nextLot, index);
    if (!previousLot) continue;
    const previousNumber = normalizeLotNumberKey(getDisplayLotNumber(previousLot, index));
    const nextNumber = normalizeLotNumberKey(getDisplayLotNumber(nextLot, index));
    if (previousNumber && nextNumber && previousNumber !== nextNumber) {
      return true;
    }
  }

  return false;
}

export function normalizePreviewLotNumbers(
  previewData: any,
  previousPreviewData?: any
): LotNumberValidationResult {
  if (!previewData || typeof previewData !== "object" || !Array.isArray(previewData.lots)) {
    return { data: previewData };
  }

  const seen = new Map<string, string>();
  const lots: any[] = [];
  const previousLots = Array.isArray(previousPreviewData?.lots) ? previousPreviewData.lots : [];

  for (let index = 0; index < previewData.lots.length; index++) {
    const lot = previewData.lots[index];
    const nextLot = lot && typeof lot === "object" ? { ...lot } : {};
    const previousLot = resolvePreviousLot(previousLots, nextLot, index);
    const rawLotNumber = normalizeEditableLotNumber(nextLot.lot_number);
    const previousDisplayLotNumber =
      normalizeEditableLotNumber(previousLot?.lot_number) || getFallbackLotNumber(previousLot);
    const fallbackLotNumber = getFallbackLotNumber(nextLot) || previousDisplayLotNumber;

    const lotNumber = rawLotNumber || fallbackLotNumber || String(index + 1);
    const duplicateKey = normalizeLotNumberKey(lotNumber);
    const existing = seen.get(duplicateKey);
    if (existing) {
      return { message: `Lot numbers must be unique: ${lotNumber}` };
    }
    seen.set(duplicateKey, lotNumber);

    lots.push({
      ...nextLot,
      lot_number: lotNumber,
    });
  }

  return {
    data: {
      ...previewData,
      lots,
    },
  };
}

export function normalizePreviewLotNumbersOrThrow(previewData: any, previousPreviewData?: any): any {
  const result = normalizePreviewLotNumbers(previewData, previousPreviewData);
  if (result.message) {
    throw new Error(result.message);
  }
  return result.data;
}
