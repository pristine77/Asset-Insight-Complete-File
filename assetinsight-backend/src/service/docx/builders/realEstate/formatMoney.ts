/** Display an already saved conclusion without adding a second currency symbol. */
export function formatRealEstateMoney(value: unknown, currency = "CAD"): string {
  const text = String(value ?? "").trim();
  if (!text || text === "N/A" || text === "—") return text || "—";
  const numeric = /^[+-]?[\d,]+(?:\.\d+)?$/.test(text);
  let amount = text;
  if (numeric) {
    try {
      amount = new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(text.replace(/,/g, "")));
    } catch { amount = text; }
  }
  return amount.toUpperCase().includes(currency.toUpperCase()) ? amount : `${amount} ${currency}`;
}
