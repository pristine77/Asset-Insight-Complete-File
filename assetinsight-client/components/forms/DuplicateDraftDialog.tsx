"use client";

import { createPortal } from "react-dom";
import { AlertTriangle, FileSearch, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  message: string;
  onClose: () => void;
  onCheckDraft: () => void;
};

export default function DuplicateDraftDialog({
  open,
  message,
  onClose,
  onCheckDraft,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    const focusTimer = window.setTimeout(() => actionRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [onClose, open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--app-overlay)] p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-draft-title"
        aria-describedby="duplicate-draft-description"
        className="w-full max-w-md overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-lg"
      >
        <header className="flex items-start gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--app-warning-soft)] text-[var(--app-warning)]">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="duplicate-draft-title"
              className="text-base font-bold text-[var(--app-text-strong)]"
            >
              Duplicate Detected
            </h2>
            <p
              id="duplicate-draft-description"
              className="mt-1 text-sm leading-6 text-[var(--app-text-muted)]"
            >
              {message}
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--app-text-muted)]">
              Review the existing draft before continuing so the same lot is not
              created twice.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text-strong)]"
            aria-label="Close duplicate warning"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="grid gap-3 p-5 sm:grid-cols-[1fr_auto]">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-md border border-[var(--app-border-strong)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)] sm:order-1"
          >
            Close
          </button>
          <button
            ref={actionRef}
            type="button"
            onClick={onCheckDraft}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 sm:order-2"
          >
            <FileSearch className="h-4 w-4" aria-hidden="true" />
            Check Draft Report
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
