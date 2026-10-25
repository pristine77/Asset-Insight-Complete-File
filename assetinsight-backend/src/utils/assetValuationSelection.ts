export type AssetValuationCode = "FMV" | "FLV" | "OLV" | "TKV";

export function resolveAssetValuationCode(value: unknown): AssetValuationCode | null {
  const name = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ");
  if (name === "FMV" || name === "FML" || name.includes("FAIR MARKET")) return "FMV";
  if (name === "FLV" || name.includes("FORCED LIQUIDATION") || name.includes("FORCED SALE")) return "FLV";
  if (name === "OLV" || name.includes("ORDERLY LIQUIDATION")) return "OLV";
  if (name === "TKV" || name.includes("TRADE IN") || name.includes("TRADE VALUE")) return "TKV";
  return null;
}

export function valuationRecordCode(record: any): AssetValuationCode | null {
  return resolveAssetValuationCode(record?.method || record?.code || record?.name || record?.fullName);
}

/** Saved selection is authoritative, including an explicit empty selection.
 * Older method records can supply a selection only when the field is absent.
 * Never union stale calculated methods back into a user's selected methods.
 */
export function resolveAssetValuationCodes(
  report: any,
  legacyFallback: readonly AssetValuationCode[] = [],
): AssetValuationCode[] {
  const explicit = Array.isArray(report?.valuation_methods);
  const values = explicit ? report.valuation_methods : (
    Array.isArray(report?.valuation_data?.methods)
      ? report.valuation_data.methods.map(valuationRecordCode)
      : legacyFallback
  );
  const codes = values.map(resolveAssetValuationCode).filter(Boolean) as AssetValuationCode[];
  return Array.from(new Set(!explicit && codes.length === 0 ? legacyFallback : codes));
}
