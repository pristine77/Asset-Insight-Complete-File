export const DAMAGE_ANALYSIS_MAXIMUM_LOT_NUMBER = 1000;

export const parseLotNumberNumericPortion = (value: unknown): number | null => {
  const match = String(value ?? "").match(/\d[\d,]*/);
  if (!match) return null;

  const numericText = match[0].replace(/,/g, "");
  if (!/^\d+$/.test(numericText)) return null;

  const parsed = Number(numericText);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const isDamageAnalysisEligibleForLot = (lotNumber: unknown): boolean => {
  const numericPortion = parseLotNumberNumericPortion(lotNumber);
  return (
    numericPortion === null ||
    numericPortion <= DAMAGE_ANALYSIS_MAXIMUM_LOT_NUMBER
  );
};

export const getLotNumberForDamagePolicy = (lot: any): unknown =>
  lot?.lot_number ?? lot?.lot_id ?? lot?.lot ?? lot?.id;

export const applyDamageAnalysisLotPolicy = <T>(previewData: T): T => {
  if (!previewData || typeof previewData !== "object") return previewData;

  const data = previewData as any;
  if (!Array.isArray(data.lots)) return previewData;

  let changed = false;
  const lots = data.lots.map((lot: any) => {
    if (
      !lot ||
      typeof lot !== "object" ||
      isDamageAnalysisEligibleForLot(getLotNumberForDamagePolicy(lot)) ||
      !String(lot.damage_analysis ?? "").trim()
    ) {
      return lot;
    }

    changed = true;
    return { ...lot, damage_analysis: "" };
  });

  return changed ? ({ ...data, lots } as T) : previewData;
};
