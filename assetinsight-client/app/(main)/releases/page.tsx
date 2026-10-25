"use client";

import { LockOpen, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Loading from "@/components/common/Loading";
import { useAuthContext } from "@/context/AuthContext";
import { ReportsService, type AssignedRelease } from "@/services/reports";

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function reportTitle(item: AssignedRelease) {
  return item.address || item.filename || item.contract_no || "Assigned report";
}

export default function AssignedReleasesPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuthContext();
  const [items, setItems] = useState<AssignedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const pendingCount = useMemo(() => items.length, [items.length]);
  const canViewReleases = Boolean(user?.isReleaseManager);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await ReportsService.getAssignedReleases();
      setItems(data.items || []);
    } catch (loadError: any) {
      setError(
        loadError?.response?.data?.message ||
          loadError?.message ||
          "Failed to load assigned releases"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!canViewReleases) {
      router.replace("/dashboard");
      return;
    }
    void load();
  }, [authLoading, canViewReleases, router]);

  async function release(item: AssignedRelease) {
    setBusyId(item._id);
    setError("");
    setSuccess("");
    try {
      await ReportsService.releaseAssignedReport(item._id);
      setSuccess("Report released. The creator can now download files.");
      await load();
    } catch (releaseError: any) {
      setError(
        releaseError?.response?.data?.message ||
          releaseError?.message ||
          "Failed to release report"
      );
    } finally {
      setBusyId("");
    }
  }

  if (authLoading || !canViewReleases) {
    return (
      <Loading
        message={
          authLoading
            ? "Checking your account..."
            : "Redirecting to dashboard..."
        }
        height={120}
        width={120}
        className="min-h-[50vh]"
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--app-accent)]">
            Release queue
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--app-text)] md:text-3xl">
            Assigned releases
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--app-text-muted)]">
            Release approved reports once payment or internal clearance is
            complete.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3.5 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      <span
        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
          pendingCount
            ? "bg-[var(--app-warning-soft)] text-[var(--app-warning)]"
            : "bg-[var(--app-success-soft)] text-[var(--app-success)]"
        }`}
      >
        {pendingCount} awaiting release
      </span>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-3 text-sm text-[var(--app-danger)]"
        >
          {error}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="rounded-lg border border-[var(--app-success-border)] bg-[var(--app-success-soft)] px-4 py-3 text-sm text-[var(--app-success)]"
        >
          {success}
        </div>
      ) : null}

      {loading ? (
        <div
          className="grid min-h-64 place-items-center"
          role="status"
          aria-label="Loading assigned releases"
        >
          <RefreshCw className="size-5 animate-spin text-[var(--app-accent)]" />
        </div>
      ) : items.length === 0 ? (
        <section className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-5 py-10">
          <h2 className="font-semibold text-[var(--app-text)]">
            No assigned releases
          </h2>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">
            Approved reports waiting for your release will appear here.
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div className="hidden grid-cols-[minmax(260px,1fr)_180px_160px] gap-4 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-5 py-3 text-xs font-bold uppercase tracking-wide text-[var(--app-text-muted)] md:grid">
            <span>Report</span>
            <span>Submitted</span>
            <span className="text-right">Action</span>
          </div>
          <ul className="divide-y divide-[var(--app-border)]">
            {items.map((item) => (
              <li
                key={item._id}
                className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(260px,1fr)_180px_160px] md:items-center md:px-5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[var(--app-accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--app-accent)]">
                      {item.reportType}
                    </span>
                    <span className="rounded-md bg-[var(--app-warning-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--app-warning)]">
                      Awaiting release
                    </span>
                  </div>
                  <h2 className="mt-2 break-words font-semibold text-[var(--app-text)]">
                    {reportTitle(item)}
                  </h2>
                  <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
                    {item.contract_no ? `Contract ${item.contract_no} · ` : ""}
                    {item.fairMarketValue || "Value not set"}
                  </p>
                </div>
                <div className="text-sm text-[var(--app-text-muted)]">
                  <span className="block text-[var(--app-text)]">
                    {item.user?.username || item.user?.email || "User"}
                  </span>
                  <span>{formatDate(item.createdAt)}</span>
                </div>
                <div className="md:text-right">
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--app-accent)] px-4 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busyId === item._id}
                    onClick={() => void release(item)}
                  >
                    <LockOpen className="size-4" />
                    {busyId === item._id ? "Releasing..." : "Release"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
