"use client";

import { createPortal } from "react-dom";
import { AlertTriangle, CopyPlus, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  reportLabel: string;
  onResume: () => void;
  onCreateSeparate: () => void;
  onCancel: () => void;
  allowCreateSeparate?: boolean;
};

export default function ActiveReportConflictDialog({
  open,
  reportLabel,
  onResume,
  onCreateSeparate,
  onCancel,
  allowCreateSeparate = true,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--app-overlay)] p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="active-report-title"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-sm"
      >
        <header className="flex items-start gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--app-warning-soft)] text-[var(--app-warning)]">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="active-report-title" className="text-base font-bold text-[var(--app-text-strong)]">
              Report already processing
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--app-text-muted)]">
              A {reportLabel} with this contract is already queued or processing.{" "}
              {allowCreateSeparate
                ? "Check it in another tab to avoid a duplicate, or explicitly create a separate report."
                : "Check it in My Reports to avoid a duplicate."}
              {" "}Your current form and selected media stay open.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text-strong)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div
          className={`grid gap-3 p-5 ${
            allowCreateSeparate ? "sm:grid-cols-2" : ""
          }`}
        >
          <a
            href="/reports"
            target="_blank"
            rel="noopener noreferrer"
            onClick={onResume}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700"
          >
            <ExternalLink className="h-4 w-4" />
            Open My Reports (new tab)
          </a>
          {allowCreateSeparate ? (
            <button
              type="button"
              onClick={onCreateSeparate}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[var(--app-border-strong)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)]"
            >
              <CopyPlus className="h-4 w-4" />
              Create Separate Report
            </button>
          ) : null}
        </div>
      </section>
    </div>,
    document.body
  );
}
