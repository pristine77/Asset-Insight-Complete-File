import { isDeepStrictEqual } from "node:util";

/** Preview currency conversion is retired. Creation chooses the valuation currency. */
type CurrencyHolder = { currency?: unknown; currency_conversion?: unknown } | null | undefined;

function currencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** The saved preview takes precedence; legacy previews fall back to the root. */
export function savedReportCurrency(report: CurrencyHolder, previousPreview?: CurrencyHolder): string {
  return currencyCode(previousPreview?.currency) || currencyCode(report?.currency) || "CAD";
}

/** Refreshed clients must not echo retired conversion transport metadata. */
export function previewWithReportCurrency<T extends Record<string, any>>(
  report: CurrencyHolder,
  preview: T | null | undefined,
): T & { currency: string } {
  const result = { ...(preview || ({} as T)), currency: savedReportCurrency(report, preview) };
  delete result.currency_conversion;
  delete result._currency_base_revision;
  return result;
}

/**
 * Check the raw request before normalizing or changing root/preview money.
 * A pending old-client conversion already contains converted numbers, so merely
 * replacing its label would corrupt them. An unchanged historical receipt is
 * harmless on an ordinary same-currency edit; a read marker alone is not a conversion.
 */
export function assertSavedReportCurrency(
  report: CurrencyHolder,
  previousPreview: CurrencyHolder,
  nextPreview: Record<string, any>,
): void {
  const savedCurrency = savedReportCurrency(report, previousPreview);
  const requested = nextPreview?.currency;
  const changedCurrency = requested !== undefined && currencyCode(requested) !== savedCurrency;
  const conversion = nextPreview?.currency_conversion;
  const pendingConversion = conversion != null &&
    (previousPreview?.currency_conversion == null ||
      !isDeepStrictEqual(conversion, previousPreview.currency_conversion));
  if (changedCurrency || pendingConversion) {
    throw Object.assign(new Error(
      `This report was valued in ${savedCurrency}. Preview currency conversion is no longer available. Reload the preview to restore its saved amounts, then review and re-enter any unsaved edits in ${savedCurrency}. No changes were saved.`
    ), { code: "REPORT_CURRENCY_LOCKED", statusCode: 409 });
  }
}

/** Applied again at persistence, after raw-request validation in each controller. */
export function keepSavedReportCurrency(
  report: CurrencyHolder,
  previousPreview: CurrencyHolder,
  nextPreview: Record<string, any>,
): void {
  assertSavedReportCurrency(report, previousPreview, nextPreview);
  nextPreview.currency = savedReportCurrency(report, previousPreview);
  delete nextPreview.currency_conversion;
  delete nextPreview._currency_base_revision;
}
