import API from "@/lib/api";

export type CurrencyQuote = {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  asOf: string;
  sourceUrl: string;
  sourceTitle: string;
  quotedAt: string;
};

export type CurrencyConversion = { preview_data: Record<string, unknown>; quote: CurrencyQuote };

export async function convertPreviewCurrency(
  kind: "asset" | "lot-listing",
  reportId: string,
  targetCurrency: string,
  previewData: Record<string, unknown>,
  options: { assignedApproval?: boolean; signal?: AbortSignal } = {},
): Promise<CurrencyConversion> {
  const prefix = options.assignedApproval ? "reports/assigned-approvals" : kind;
  const response = await API.post<{ data: CurrencyConversion }>(
    `/${prefix}/${encodeURIComponent(reportId)}/preview/currency-conversion`,
    { targetCurrency, preview_data: previewData },
    { signal: options.signal, timeout: 65_000 },
  );
  const converted = response.data?.data;
  const quote = converted?.quote;
  if (!converted?.preview_data || converted.preview_data.currency !== targetCurrency ||
    !converted.preview_data.currency_conversion || typeof converted.preview_data.currency_conversion !== "object" ||
    Array.isArray(converted.preview_data.currency_conversion) ||
    quote?.fromCurrency !== String(previewData.currency || "CAD").trim().toUpperCase() || quote?.toCurrency !== targetCurrency ||
    !Number.isFinite(quote?.rate) || quote.rate <= 0) {
    throw new Error("The currency conversion could not be verified. Your values have not changed.");
  }
  return converted;
}
