"use client";

import { Plus, RefreshCw, Trash2, UserRound, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { ProposalValuationService } from "@/services/proposalValuation";
import type {
  ProposalValuationCandidate,
  ProposalValuationEvaluator,
} from "./types";

function evaluatorLabel(candidate: ProposalValuationCandidate) {
  return candidate.username || candidate.companyName || candidate.email;
}

export default function EvaluatorPicker({
  reportId,
  evaluators,
  ownerUserId,
  disabled,
  saving,
  onAdd,
  onRemove,
}: {
  reportId: string;
  evaluators: ProposalValuationEvaluator[];
  ownerUserId?: string;
  disabled?: boolean;
  saving?: boolean;
  onAdd: (user: ProposalValuationCandidate) => void;
  onRemove: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ProposalValuationCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const listboxId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const linked = useMemo(
    () => evaluators.filter((evaluator) => evaluator.user_id),
    [evaluators]
  );
  const legacy = useMemo(
    () => evaluators.filter((evaluator) => !evaluator.user_id),
    [evaluators]
  );
  const selected = useMemo(
    () => new Set([...linked.map((evaluator) => evaluator.user_id), ownerUserId]),
    [linked, ownerUserId]
  );
  const available = options.filter((candidate) => !selected.has(candidate.id));
  const limitReached = linked.filter((evaluator) => evaluator.user_id !== ownerUserId).length >= 4;

  useEffect(() => {
    if (disabled || saving) setOpen(false);
  }, [disabled, saving]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        setOptions(
          await ProposalValuationService.evaluatorOptions(
            reportId,
            deferredQuery,
            controller.signal
          )
        );
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load users."
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [deferredQuery, open, reportId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="min-w-0" ref={panelRef}>
      <div className="flex max-w-full flex-wrap items-center gap-1.5">
        {legacy.map((evaluator) => (
          <span
            key={evaluator.id}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-xs font-semibold text-[var(--app-text-muted)]"
            title="Legacy evaluator label; select a user account to invite collaborators"
          >
            <UserRound className="size-3.5" /> {evaluator.name}
            <span className="text-[10px] font-medium">legacy</span>
          </span>
        ))}
        {linked.map((evaluator) => (
          <span
            key={evaluator.id}
            className="inline-flex min-w-0 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel)]"
          >
            <span className="min-w-0 px-2 py-1 text-xs leading-tight">
              <span className="block max-w-36 truncate font-bold text-[var(--app-text)]">
                {evaluator.name}
              </span>
              {evaluator.email ? (
                <span className="block max-w-36 truncate text-[10px] text-[var(--app-text-muted)]">
                  {evaluator.email}
                </span>
              ) : null}
              {evaluator.user_id === ownerUserId ? (
                <span className="block text-[10px] font-semibold text-[var(--app-accent)]">Report owner</span>
              ) : null}
            </span>
            {evaluator.user_id !== ownerUserId ? <button
              type="button"
              onClick={() => onRemove(evaluator.user_id!)}
              disabled={disabled || saving}
              className="grid size-8 place-items-center border-l border-[var(--app-border)] text-[var(--app-danger)]"
              aria-label={`Remove ${evaluator.name}`}
            >
              <Trash2 className="size-3.5" />
            </button> : null}
          </span>
        ))}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            disabled={disabled || saving || limitReached}
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel)] px-2.5 text-xs font-bold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)]"
          >
            {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {limitReached ? (ownerUserId ? "4 additional evaluators added" : "4 evaluators added") : "Add evaluator"}
          </button>
          {open ? (
            <div className="absolute left-0 top-full z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow-[var(--app-shadow-modal)]">
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setOpen(false);
                  }}
                  role="combobox"
                  aria-controls={listboxId}
                  aria-expanded="true"
                  placeholder="Search users by name or email"
                  className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-input)] px-2.5 text-sm outline-none focus:border-[var(--app-accent)]"
                />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="grid size-9 place-items-center rounded-md text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)]"
                  aria-label="Close evaluator list"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div
                id={listboxId}
                role="listbox"
                aria-label="Eligible evaluator accounts"
                className="mt-2 max-h-64 overflow-y-auto"
              >
                {loading ? (
                  <p className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--app-text-muted)]">
                    <RefreshCw className="size-3.5 animate-spin" /> Loading users…
                  </p>
                ) : error ? (
                  <p className="px-2 py-3 text-xs text-[var(--app-danger)]">{error}</p>
                ) : available.length ? (
                  available.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onClick={() => {
                        onAdd(candidate);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--app-accent-soft)]"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--app-panel-alt)] text-[var(--app-accent)]">
                        <UserRound className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-[var(--app-text)]">
                          {evaluatorLabel(candidate)}
                        </span>
                        <span className="block truncate text-xs text-[var(--app-text-muted)]">
                          {candidate.email}
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-3 text-xs text-[var(--app-text-muted)]">
                    No eligible users match this search.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-[10px] text-[var(--app-text-muted)]">
        {ownerUserId ? "The report owner is included automatically. Add up to four additional user accounts." : "Add up to four user accounts."} Invited evaluators can edit only their own value column.
      </p>
    </div>
  );
}
