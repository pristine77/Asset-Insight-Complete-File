"use client";

import { Check } from "lucide-react";

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  /** Kept for callers; every section is always open. */
  defaultOpen?: boolean;
  filledCount?: number;
  totalCount?: number;
  /** Kept for callers; sections share one neutral look. */
  variant?: "default" | "success" | "warning" | "info";
  required?: boolean;
  /** The section's place in the form, shown instead of the icon. */
  step?: number;
  /** One line under the title saying what the section is for. */
  description?: string;
  /** Shows "Optional" where a progress count would be. */
  optional?: boolean;
}

/*
   A section of the Real Estate form (owner, 2026-11-01: "Make the Real Estate
   UI professional and easy usability"): a plain card with its step number,
   title, one line of purpose and how much of it is filled. The earlier
   gradients had been flattened to white, which also turned white-on-dark
   buttons invisible; everything here uses the app's colour tokens.
*/
export default function CollapsibleSection({
  title,
  icon,
  children,
  filledCount = 0,
  totalCount = 0,
  required = false,
  step,
  description,
  optional = false,
}: CollapsibleSectionProps) {
  const isComplete = totalCount > 0 && filledCount === totalCount;

  return (
    <section className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-card)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          {step ? (
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--app-accent-soft)] text-xs font-bold text-[var(--app-accent)]" aria-hidden="true">
              {step}
            </span>
          ) : (
            <span className="mt-0.5 shrink-0 text-[var(--app-text-muted)] [&>svg]:size-4" aria-hidden="true">{icon}</span>
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-6 text-[var(--app-text-strong)]">
              {title}
              {required ? <span className="sr-only"> (required)</span> : null}
            </h3>
            {description ? <p className="mt-0.5 text-xs leading-5 text-[var(--app-text-muted)]">{description}</p> : null}
          </div>
        </div>
        <div className="shrink-0 pt-0.5">
          {optional ? (
            <span className="app-chip">Optional</span>
          ) : totalCount > 0 ? (
            isComplete ? (
              <span className="app-chip app-chip--success inline-flex items-center gap-1"><Check className="size-3" aria-hidden="true" />Complete</span>
            ) : (
              <span className="app-chip tabular-nums">{filledCount} of {totalCount} filled</span>
            )
          ) : null}
        </div>
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}
