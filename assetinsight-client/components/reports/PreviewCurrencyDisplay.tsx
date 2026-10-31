"use client";

import { reportCurrencyLabel } from "@/lib/reportCurrency";

/**
 * The report's currency on a preview, shown and never changed.
 *
 * Owner, 2026-10-31: the preview currency conversion was removed ("The software
 * has to do its valuation in the correct currency"). The currency is chosen
 * when the report is created and the valuation is produced in it; the server
 * keeps it on every save (assetinsight-backend/src/utils/reportCurrencyLock.ts).
 */
export default function PreviewCurrencyDisplay({ currency }: { currency: string }) {
  const code = String(currency || "CAD").trim().toUpperCase();
  return (
    <div>
      <span id="preview-currency-label" className="block text-xs sm:text-sm font-medium text-[var(--app-text-muted)] mb-1.5">
        Currency
      </span>
      <p
        aria-labelledby="preview-currency-label"
        data-testid="preview-currency"
        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2 text-sm text-[var(--app-text)]"
      >
        {reportCurrencyLabel(code)}
      </p>
      <p className="mt-1 text-xs text-[var(--app-text-muted)]">
        Set when the report was created. All values are in this currency.
      </p>
    </div>
  );
}
