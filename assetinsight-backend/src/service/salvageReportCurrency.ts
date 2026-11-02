import { isSalvageAssessmentV2 } from "./salvageAssessment.js";

/** Canonical research is CAD; legacy saved amounts keep their denomination. No FX. */
export function salvageReportCurrency(report: Record<string, any>): string {
  if (isSalvageAssessmentV2(report.assessment)) return "CAD";
  const currency = typeof report.currency === "string" ? report.currency.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(currency) ? currency : "CAD";
}

export function salvageCurrencyName(currency: string): string {
  return ({ CAD: "Canadian dollars", USD: "US dollars", EUR: "euros", GBP: "British pounds" } as Record<string, string>)[currency] || currency;
}
