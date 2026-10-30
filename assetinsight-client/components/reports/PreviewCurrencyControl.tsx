"use client";

import { useState } from "react";
import CurrencySelect from "@/components/forms/CurrencySelect";
import type { CurrencyQuote } from "@/services/reportCurrency";

export default function PreviewCurrencyControl({ currency, disabled, busy, quote, onConvert }: {
  currency: string;
  disabled: boolean;
  busy: boolean;
  quote: CurrencyQuote | null;
  onConvert: (currency: string) => Promise<void>;
}) {
  const [target, setTarget] = useState(currency);
  let sourceUrl = "";
  try {
    const parsed = new URL(quote?.sourceUrl || "");
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) sourceUrl = parsed.href;
  } catch {}
  return (
    <div className="space-y-2">
      <label htmlFor="preview-currency" className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)]">Currency</label>
      <CurrencySelect id="preview-currency" value={target} onChange={event => setTarget(event.target.value)}
        disabled={disabled || busy} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-input)] px-3 py-2 text-sm text-[var(--app-text)]" />
      <button type="button" onClick={() => void onConvert(target)} disabled={disabled || busy || target === currency}
        className="app-button w-full rounded border border-[var(--app-border)] px-3 py-2 text-sm disabled:opacity-50">
        {busy ? "Converting currency…" : "Convert amounts"}
      </button>
      <p className="text-xs text-[var(--app-text-muted)]">Convert report amounts using a current exchange rate. Photos are not re-analyzed.</p>
      <p className="text-xs text-[var(--app-text-muted)]">Existing valuation percentages and fee rules still apply.</p>
      {quote && sourceUrl ? <p className="text-xs text-[var(--app-text-muted)]" role="status">
        1 {quote.fromCurrency} = {quote.rate} {quote.toCurrency} · {quote.asOf} ·{" "}
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{quote.sourceTitle || "Rate source"}</a>
      </p> : null}
    </div>
  );
}
