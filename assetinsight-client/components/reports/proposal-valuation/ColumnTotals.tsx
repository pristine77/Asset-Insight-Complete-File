import type { ProposalValuationColumnTotals } from "./calculations";

type Props = { totals: ProposalValuationColumnTotals; currency: string };

function scopeLabel(lotCount: number) {
  return `All ${lotCount} ${lotCount === 1 ? "lot" : "lots"}`;
}

// Footer cents match the exported sums; leave the existing row/summary format unchanged.
function formatTotal(value: number, currency: string) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Keep the sums aligned to the same dynamic evaluator columns as the body. */
export function ColumnTotalsFooter({ totals, currency }: Props) {
  return (
    <tfoot
      aria-label="All-lot valuation totals"
      className="text-xs font-bold tabular-nums text-[var(--app-text-strong)] [&>tr>*]:sticky [&>tr>*]:bottom-0 [&>tr>*]:z-[3] [&>tr>*]:border-t-2 [&>tr>*]:border-[var(--app-accent)] [&>tr>*]:bg-[var(--app-panel-alt)] [&>tr>*]:px-2 [&>tr>*]:py-2"
    >
      <tr>
        <th scope="row" className="left-0 !z-[4] text-left">
          Totals
          <span className="mt-0.5 block text-[10px] font-medium text-[var(--app-text-muted)]">{scopeLabel(totals.lotCount)}</span>
        </th>
        <td colSpan={10} className="text-left text-[var(--app-text-muted)]">
          Sum of entered values · all lots, including those hidden by search or pagination
        </td>
        {totals.evaluators.map((column) => (
          <td key={column.id} className="text-right" aria-label={`${column.name} total for all lots`}>
            {formatTotal(column.total, currency)}
          </td>
        ))}
        <td className="text-right" aria-label="Average total for all lots">{formatTotal(totals.average, currency)}</td>
        <td className="text-right" aria-label="Low total for all lots">{formatTotal(totals.low, currency)}</td>
        <td className="text-right" aria-label="High total for all lots">{formatTotal(totals.high, currency)}</td>
        <td className="text-right text-[var(--app-text-muted)]" aria-label="Buyer premium percentages are not summed">—</td>
        <td className="text-right" aria-label="Buyer premium total for all lots">{formatTotal(totals.buyerPremium, currency)}</td>
        <td className="text-right" aria-label="Total expected gross total for all lots">{formatTotal(totals.totalExpectedGross, currency)}</td>
        <td className="text-right" aria-label="Allocated value total for all lots">{formatTotal(totals.allocatedValue, currency)}</td>
        <td aria-hidden="true" />
        <td className="text-right" aria-label="Cleaning total for all lots">{formatTotal(totals.cleaning, currency)}</td>
        <td className="text-right" aria-label="Lien search total for all lots">{formatTotal(totals.lienSearch, currency)}</td>
        <td className="text-right" aria-label="Video cost total for all lots">{formatTotal(totals.videoCost, currency)}</td>
        <td className="text-right" aria-label="Lotting fee total for all lots">{formatTotal(totals.lottingFee, currency)}</td>
        <td className="text-right" aria-label="Advertising total for all lots">{formatTotal(totals.advertising, currency)}</td>
      </tr>
    </tfoot>
  );
}

/** The narrow-screen card layout has the same all-lot totals as the table. */
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
      <h3 className="text-sm font-bold text-[var(--app-text-strong)]">Totals · {scopeLabel(totals.lotCount)}</h3>
      <p className="mt-1 text-xs text-[var(--app-text-muted)]">Sum of entered values. Includes lots hidden by search or pagination.</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        {values.map(({ key, label, value }) => (
          <div key={key} className="min-w-0 border-t border-[var(--app-border)] pt-2">
            <dt className="break-words text-xs text-[var(--app-text-muted)]">{label}</dt>
            <dd className="mt-0.5 break-words text-sm font-bold tabular-nums text-[var(--app-text-strong)]">{formatTotal(value, currency)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
