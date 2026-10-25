/** Optional Lot Listing value normalization. These helpers never block submission. */
const cleanString = (value: unknown): string => String(value ?? "").trim();

export function parseEstimatedValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getLotEstimatedValueText(lot: any): string {
  const candidates = [
    lot?.estimated_value, lot?.fmv, lot?.fair_market_value, lot?.asset_insight,
    lot?.value, lot?.market_value, lot?.appraised_value,
    lot?.valuation?.fair_market_value, lot?.valuation?.estimated_value,
  ];
  return candidates.map(cleanString).find((value) => value.length > 0) || "";
}

export function isEstimatedValueMissing(value: unknown): boolean {
  const text = cleanString(value);
  if (!text) return true;
  const numeric = Number(text.replace(/[^0-9.-]+/g, ""));
  return !Number.isFinite(numeric) || numeric <= 0;
}

/** Preserve the existing legacy single-remainder rule, without mutating inputs. */
export function fillMissingFmvFromAvailableValues(lots: any[], currency: string, fallbackTotal?: unknown): any[] {
  const normalized = (Array.isArray(lots) ? lots : []).map((lot) => {
    const valueText = getLotEstimatedValueText(lot);
    return valueText && !isEstimatedValueMissing(valueText) && lot?.estimated_value !== valueText
      ? { ...lot, estimated_value: valueText } : lot;
  });
  const missingIndexes = normalized
    .map((lot, index) => ({ index, missing: isEstimatedValueMissing(getLotEstimatedValueText(lot)) }))
    .filter((entry) => entry.missing).map((entry) => entry.index);
  if (missingIndexes.length === 1) {
    const knownTotal = normalized.reduce((sum, lot, index) =>
      index === missingIndexes[0] ? sum : sum + parseEstimatedValue(getLotEstimatedValueText(lot)), 0);
    const remaining = parseEstimatedValue(fallbackTotal) - knownTotal;
    if (remaining > 0) {
      return normalized.map((lot, index) => index === missingIndexes[0]
        ? { ...lot, estimated_value: `${currency} ${Math.round(remaining).toLocaleString("en-US")}` } : lot);
    }
  }
  return normalized;
}
