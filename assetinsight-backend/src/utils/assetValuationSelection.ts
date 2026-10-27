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

/** Persist the default independently of the optional comparison table.
 * Preserve an explicit empty selection when the method picker was available.
 * Never mutate the immutable submission details or share its methods array.
 */
export function normalizeAssetReportValuationMethods(details: any): string[] {
  const explicit = Array.isArray(details?.valuation_methods);
  const methods = explicit ? [...details.valuation_methods] : [];
  return methods.length > 0 || (explicit && details?.include_valuation_table === true) ? methods : ["FML"];
}

/** Saved selection is authoritative, including an empty selection made with the
 * valuation table on; an empty selection saved with it off means Fair Market Value.
 * Older method records can supply a selection only when the field is absent.
 * Never union stale calculated methods back into a user's selected methods.
 */
export function resolveAssetValuationCodes(
  report: any,
  legacyFallback: readonly AssetValuationCode[] = [],
): AssetValuationCode[] {
  const explicit = Array.isArray(report?.valuation_methods);
  // The app and website show the method picker only with the valuation table, so a
  // report made with the table off was saved with no methods although Fair Market
  // Value was preselected. Without a method its Appraisal report printed no dollar
  // values at all (contract 94770, 2026-10-27). An empty choice is honoured only
  // when the person could see and clear it.
  if (explicit && report.valuation_methods.length === 0 && report?.include_valuation_table !== true) return ["FMV"];
  const values = explicit ? report.valuation_methods : (
    Array.isArray(report?.valuation_data?.methods)
      ? report.valuation_data.methods.map(valuationRecordCode)
      : legacyFallback
  );
  const codes = values.map(resolveAssetValuationCode).filter(Boolean) as AssetValuationCode[];
  return Array.from(new Set(!explicit && codes.length === 0 ? legacyFallback : codes));
}
