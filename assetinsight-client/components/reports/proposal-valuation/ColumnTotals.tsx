import type { ProposalValuationColumnTotals } from "./calculations";

type Props = { totals: ProposalValuationColumnTotals; currency: string };

export function columnTotalsScopeLabel(lotCount: number) {
  return `All ${lotCount} ${lotCount === 1 ? "lot" : "lots"}`;
}

// Footer cents match the exported sums; leave the existing row/summary format unchanged.
export function formatColumnTotal(value: number, currency: string) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** The narrow-screen card layout has the same all-lot totals as the desktop sheet's footer. */
export function MobileColumnTotals({ totals, currency }: Props) {
  const values = [
    ...totals.evaluators.map((column) => ({ key: `evaluator-${column.id}`, label: column.name, value: column.total })),
    { key: "average", label: "Average", value: totals.average },
    { key: "low", label: "Low", value: totals.low },
    { key: "high", label: "High", value: totals.high },
    { key: "premium", label: "Buyer premium ($)", value: totals.buyerPremium },
    { key: "gross", label: "Total expected gross", value: totals.totalExpectedGross },
    { key: "allocated", label: "Allocated value", value: totals.allocatedValue },
    { key: "cleaning", label: "Cleaning", value: totals.cleaning },
    { key: "lien", label: "Lien search", value: totals.lienSearch },
    { key: "video", label: "Video cost", value: totals.videoCost },
    { key: "lotting", label: "Lotting fee", value: totals.lottingFee },
    { key: "advertising", label: "Advertising", value: totals.advertising },
  ];
  return (
    <section aria-label="All-lot valuation totals" className="mt-2 rounded-lg border border-[var(--app-border)] border-t-2 border-t-[var(--app-accent)] bg-[var(--app-panel-alt)] p-3">
      <h3 className="text-sm font-bold text-[var(--app-text-strong)]">Totals · {columnTotalsScopeLabel(totals.lotCount)}</h3>
      <p className="mt-1 text-xs text-[var(--app-text-muted)]">Sum of entered values. Includes lots hidden by search or pagination.</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        {values.map(({ key, label, value }) => (
          <div key={key} className="min-w-0 border-t border-[var(--app-border)] pt-2">
            <dt className="break-words text-xs text-[var(--app-text-muted)]">{label}</dt>
            <dd className="mt-0.5 break-words text-sm font-bold tabular-nums text-[var(--app-text-strong)]">{formatColumnTotal(value, currency)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
