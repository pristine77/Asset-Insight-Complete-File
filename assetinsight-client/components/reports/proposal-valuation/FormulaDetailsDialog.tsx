"use client";

import { Calculator, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatMoney, formatPercent } from "./calculations";
import type { ProposalValuationCalculation } from "./types";

function labelFromKey(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function displayInput(
  key: string,
  value: number | string | null,
  currency: string
) {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  if (/percent|roi/i.test(key)) return formatPercent(value);
  if (/risk.?score/i.test(key)) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  return formatMoney(value, currency);
}

function displayResult(
  calculation: ProposalValuationCalculation,
  currency: string
) {
  if (typeof calculation.value === "string") return calculation.value;
  if (calculation.key === "weighted_average_risk_score") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
      calculation.value ?? 0
    );
  }
  if (
    calculation.key.endsWith("roi") ||
    calculation.key === "capped.risk" ||
    calculation.key.endsWith("_percent")
  ) {
    return formatPercent(calculation.value);
  }
  return formatMoney(calculation.value, currency);
}

export default function FormulaDetailsDialog({
  calculation,
  currency,
  onClose,
}: {
  calculation: ProposalValuationCalculation;
  currency: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center bg-[var(--app-overlay)] p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pv-formula-title"
        className="flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-modal)] sm:max-w-xl sm:rounded-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
              <Calculator className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--app-text-muted)]">
                Calculation details
              </p>
              <h2 id="pv-formula-title" className="truncate text-base font-bold text-[var(--app-text-strong)]">
                {calculation.label}
              </h2>
            </div>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-md border border-[var(--app-border)] text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)]"
            aria-label="Close calculation details"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">
          <div className="rounded-lg border border-[var(--app-info-border)] bg-[var(--app-accent-soft)] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--app-accent)]">
              Formula
            </p>
            <p className="mt-1 text-sm font-semibold leading-6 text-[var(--app-text-strong)]">
              {calculation.formula}
            </p>
          </div>
          <div className="mt-4">
            <h3 className="text-xs font-bold uppercase tracking-[0.06em] text-[var(--app-text-muted)]">
              Inputs used
            </h3>
            <dl className="mt-2 divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-border)]">
              {Object.entries(calculation.inputs).map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-4 px-3 py-2.5 text-sm">
                  <dt className="text-[var(--app-text-muted)]">{labelFromKey(key)}</dt>
                  <dd className="text-right font-bold tabular-nums text-[var(--app-text)]">
                    {displayInput(key, value, currency)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="mt-4">
            <h3 className="text-xs font-bold uppercase tracking-[0.06em] text-[var(--app-text-muted)]">
              Calculation steps
            </h3>
            <ol className="mt-2 list-decimal space-y-2 rounded-lg border border-[var(--app-border)] px-8 py-3 text-xs leading-5 text-[var(--app-text)]">
              <li>
                Substitute the current inputs: {Object.entries(calculation.inputs)
                  .map(([key, value]) => `${labelFromKey(key)} = ${displayInput(key, value, currency)}`)
                  .join("; ") || "no variable inputs"}.
              </li>
              <li>Apply the formula: {calculation.formula}.</li>
              <li>Use the calculated result shown below.</li>
            </ol>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-panel-alt)] px-3 py-3">
            <span className="text-sm font-bold text-[var(--app-text-muted)]">Result</span>
            <strong className="text-lg tabular-nums text-[var(--app-accent)]">
              {displayResult(calculation, currency)}
            </strong>
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--app-text-muted)]">
            Values reflect the current workspace. The server validates the same calculation model when changes are saved.
          </p>
        </div>
      </section>
    </div>
  );
}
