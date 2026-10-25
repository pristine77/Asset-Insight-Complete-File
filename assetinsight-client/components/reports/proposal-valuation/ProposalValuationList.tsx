"use client";

import Link from "next/link";
import { BarChart3, RefreshCw, Search, Users } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ProposalValuationService } from "@/services/proposalValuation";
import ProposalValuationExcelButton from "./ProposalValuationExcelButton";
import type { ProposalValuationListItem } from "./types";

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recently updated"
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export default function ProposalValuationList() {
  const [items, setItems] = useState<ProposalValuationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setItems(await ProposalValuationService.list(signal));
    } catch (loadError) {
      if (!signal?.aborted) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load Proposal Valuations."
        );
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!deferredQuery) return items;
    return items.filter((item) =>
      [item.title, item.contractNo, item.status, item.role]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(deferredQuery)
    );
  }, [deferredQuery, items]);

  return (
    <div className="app-page app-page-stack">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="app-kicker">Collaborative workspace</p>
          <h1 className="app-title">Proposal Valuations</h1>
          <p className="app-muted mt-1 text-sm">
            Open valuations you own or have been invited to evaluate.
          </p>
        </div>
        <label className="relative block w-full sm:w-80">
          <span className="sr-only">Search Proposal Valuations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--app-text-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title or contract"
            className="h-10 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-input)] pl-9 pr-3 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]"
          />
        </label>
      </header>

      {loading ? (
        <div className="app-surface grid min-h-56 place-items-center" role="status">
          <div className="text-center">
            <RefreshCw className="mx-auto size-6 animate-spin text-[var(--app-accent)]" />
            <p className="mt-2 text-sm font-semibold">Loading Proposal Valuations…</p>
          </div>
        </div>
      ) : error ? (
        <div className="app-surface app-section text-center" role="alert">
          <p className="font-semibold text-[var(--app-danger)]">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="app-button app-button-secondary mt-4"
          >
            Try again
          </button>
        </div>
      ) : filtered.length ? (
        <div className="grid gap-2">
          {filtered.map((item) => (
            <article
              key={item.reportId}
              className="app-surface group flex min-w-0 flex-col gap-3 p-4 transition-colors hover:border-[var(--app-accent)] sm:flex-row sm:items-center"
            >
              <Link
                href={`/proposal-valuations/${encodeURIComponent(item.reportId)}`}
                className="flex min-w-0 flex-1 items-center gap-3 rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)]"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-md bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
                  <BarChart3 className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold text-[var(--app-text-strong)]">
                    {item.title || "Asset report"}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--app-text-muted)]">
                    {[item.contractNo, item.status, formatDate(item.updatedAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs font-semibold text-[var(--app-accent)] group-hover:underline md:inline">
                  Open PV
                </span>
              </Link>
              <div className="flex shrink-0 items-center justify-between gap-2 pl-[52px] sm:justify-end sm:pl-0">
                <span className="flex items-center gap-2 text-xs font-semibold">
                  <span className="app-chip capitalize">{item.role}</span>
                  <span className="inline-flex items-center gap-1 text-[var(--app-text-muted)]">
                    <Users className="size-3.5" /> {item.participantCount}
                  </span>
                </span>
                <ProposalValuationExcelButton
                  compact
                  reportId={item.reportId}
                  title={item.title || item.contractNo || "Proposal Valuation"}
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="app-surface app-section py-14 text-center">
          <BarChart3 className="mx-auto size-8 text-[var(--app-text-muted)]" />
          <h2 className="mt-3 font-bold text-[var(--app-text-strong)]">
            {query ? "No matching valuations" : "No Proposal Valuations yet"}
          </h2>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">
            {query
              ? "Try a different title, contract, or status."
              : "Owned and assigned valuations will appear here."}
          </p>
        </div>
      )}
    </div>
  );
}
