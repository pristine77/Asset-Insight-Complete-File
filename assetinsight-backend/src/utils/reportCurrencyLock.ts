/**
 * A report's currency is decided when the report is created, and stays.
 *
 * OWNER, 2026-10-31: the preview currency conversion was removed ("The software
 * has to do its valuation in the correct currency"; "remove completely"). The
 * currency is chosen at creation — the Auctioneer 2.0 sale's currency, else the
 * inspection address — and the valuation is produced in it (utils/assetPrompts.ts
 * asks for every value in the report's currency). Changing it afterwards would
 * either relabel values valued in another currency or need a conversion, so a
 * preview save never changes it: whatever currency a save carries, the report
 * keeps the one it was valued in.
 */

type CurrencyHolder = { currency?: unknown } | null | undefined;

/** The currency the report was valued in: its saved preview's, else its own, else CAD. */
export function savedReportCurrency(report: CurrencyHolder, previousPreview?: CurrencyHolder): string {
  return String(previousPreview?.currency || report?.currency || "CAD").trim().toUpperCase();
}

/** The preview with the report's currency filled in, for screens that show it. */
export function previewWithReportCurrency<T extends Record<string, any>>(
  report: CurrencyHolder,
  preview: T | null | undefined,
): T & { currency: string } {
  return { ...(preview || ({} as T)), currency: savedReportCurrency(report, preview) };
}

/**
 * Applied to every preview save: the saved currency, and none of the removed
 * conversion's fields (a page still open from before the removal may send them).
 */
export function keepSavedReportCurrency(
  report: CurrencyHolder,
  previousPreview: CurrencyHolder,
  nextPreview: Record<string, any>,
): void {
  nextPreview.currency = savedReportCurrency(report, previousPreview);
  delete nextPreview.currency_conversion;
  delete nextPreview._currency_base_revision;
}
