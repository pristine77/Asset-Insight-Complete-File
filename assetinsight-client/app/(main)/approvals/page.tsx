"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Loading from "@/components/common/Loading";
import { useAuthContext } from "@/context/AuthContext";
import { ReportsService, type AssignedApproval } from "@/services/reports";

const PreviewModal = dynamic(() => import("@/components/reports/PreviewModal"), {
  ssr: false,
});
const RealEstatePreviewModal = dynamic(
  () => import("@/components/reports/RealEstatePreviewModal"),
  { ssr: false }
);
const LotListingPreviewModal = dynamic(
  () => import("@/components/reports/LotListingPreviewModal"),
  { ssr: false }
);

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function reportTitle(item: AssignedApproval) {
  return item.address || item.filename || item.contract_no || "Assigned report";
}

export default function AssignedApprovalsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuthContext();
  const [items, setItems] = useState<AssignedApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rejectTarget, setRejectTarget] = useState<AssignedApproval | null>(null);
  const [reviewTarget, setReviewTarget] = useState<AssignedApproval | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const rejectDialogRef = useRef<HTMLDialogElement>(null);

  const pendingCount = useMemo(() => items.length, [items.length]);
  const canViewApprovals = Boolean(user?.isReportApprover);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await ReportsService.getAssignedApprovals();
      setItems(data.items || []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load assigned approvals"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!canViewApprovals) {
      router.replace("/dashboard");
      return;
    }
    void load();
  }, [authLoading, canViewApprovals, router]);

  useEffect(() => {
    const dialog = rejectDialogRef.current;
    if (!dialog) return;
    if (rejectTarget && !dialog.open) dialog.showModal();
    if (!rejectTarget && dialog.open) dialog.close();
  }, [rejectTarget]);

  async function approve(item: AssignedApproval) {
    setBusyId(item._id);
    setError("");
    setSuccess("");
    try {
      await ReportsService.approveAssignedApproval(item._id);
      setSuccess("Report approved.");
      await load();
    } catch (approveError) {
      setError(
        approveError instanceof Error
          ? approveError.message
          : "Failed to approve report"
      );
    } finally {
      setBusyId("");
    }
  }

  async function reject() {
    if (!rejectTarget) return;
    if (!rejectNote.trim()) {
      setError("Rejection note is required.");
      return;
    }
    setBusyId(rejectTarget._id);
    setError("");
    setSuccess("");
    try {
      await ReportsService.rejectAssignedApproval(
        rejectTarget._id,
        rejectNote.trim()
      );
      setSuccess("Report rejected.");
      setRejectTarget(null);
      setRejectNote("");
      await load();
    } catch (rejectError) {
      setError(
        rejectError instanceof Error
          ? rejectError.message
          : "Failed to reject report"
      );
    } finally {
      setBusyId("");
    }
  }

  if (authLoading || !canViewApprovals) {
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
            Review queue
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--app-text)] md:text-3xl">
            Assigned approvals
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--app-text-muted)]">
            Review reports assigned to you without admin access.
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

      <div className="flex items-center gap-2">
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
            pendingCount
              ? "bg-[var(--app-warning-soft)] text-[var(--app-warning)]"
              : "bg-[var(--app-success-soft)] text-[var(--app-success)]"
          }`}
        >
          {pendingCount} pending
        </span>
      </div>

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
          aria-label="Loading assigned approvals"
        >
          <RefreshCw className="size-5 animate-spin text-[var(--app-accent)]" />
        </div>
      ) : items.length === 0 ? (
        <section className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-5 py-10">
          <h2 className="font-semibold text-[var(--app-text)]">
            No assigned approvals
          </h2>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">
            Reports assigned to you will appear here.
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div className="hidden grid-cols-[minmax(260px,1fr)_170px_240px] gap-4 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-5 py-3 text-xs font-bold uppercase tracking-wide text-[var(--app-text-muted)] md:grid">
            <span>Report</span>
            <span>Submitted</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y divide-[var(--app-border)]">
            {items.map((item) => (
              <li
                key={item._id}
                className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(260px,1fr)_170px_240px] md:items-center md:px-5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[var(--app-accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--app-accent)]">
                      {item.reportType}
                    </span>
                    <span className="rounded-md border border-[var(--app-border)] px-2 py-0.5 text-xs font-medium text-[var(--app-text-muted)]">
                      Pending
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
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {item.isAssetReport ||
                  item.isRealEstateReport ||
                  item.isLotListing ? (
                    <button
                      type="button"
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)] disabled:opacity-50"
                      disabled={busyId === item._id}
                      onClick={() => setReviewTarget(item)}
                    >
                      <Pencil className="size-3.5" />
                      Review
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--app-accent)] px-3 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90 disabled:opacity-50"
                    disabled={busyId === item._id}
                    onClick={() => void approve(item)}
                  >
                    <Check className="size-3.5" />
                    Approve
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-danger-border)] px-3 text-sm font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] disabled:opacity-50"
                    disabled={busyId === item._id}
                    onClick={() => {
                      setRejectTarget(item);
                      setRejectNote("");
                    }}
                  >
                    <X className="size-3.5" />
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <dialog
        ref={rejectDialogRef}
        aria-labelledby="reject-report-title"
        className="m-auto w-[min(92vw,520px)] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-0 text-[var(--app-text)] shadow-[var(--app-shadow-modal)] backdrop:bg-[var(--app-overlay)]"
        onCancel={(event) => {
          if (busyId) event.preventDefault();
          else setRejectTarget(null);
        }}
        onClose={() => {
          if (rejectTarget && !busyId) setRejectTarget(null);
        }}
      >
        <form
          method="dialog"
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void reject();
          }}
        >
          <h2 id="reject-report-title" className="text-lg font-bold">
            Reject report
          </h2>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">
            Add a clear note so the report creator knows what to fix.
          </p>
          <label className="mt-5 block text-sm font-semibold" htmlFor="reject-note">
            Rejection note
          </label>
          <textarea
            id="reject-note"
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            rows={5}
            autoFocus
            className="mt-2 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm outline-none ring-[var(--app-accent)] focus:ring-2"
          />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="min-h-10 rounded-lg border border-[var(--app-border)] px-4 text-sm font-semibold hover:bg-[var(--app-panel-alt)] disabled:opacity-50"
              onClick={() => setRejectTarget(null)}
              disabled={Boolean(busyId)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="min-h-10 rounded-lg bg-[var(--app-danger)] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              disabled={Boolean(busyId) || !rejectNote.trim()}
            >
              {busyId ? "Rejecting..." : "Reject report"}
            </button>
          </div>
        </form>
      </dialog>

      {reviewTarget?.isAssetReport ? (
        <PreviewModal
          reportId={reviewTarget._id}
          isOpen={Boolean(reviewTarget)}
          onClose={() => setReviewTarget(null)}
          onSuccess={() => {
            setReviewTarget(null);
            void load();
          }}
          isResubmitMode
          isAssignedApprovalMode
          loadPreviewDataOverride={ReportsService.getAssignedPreview}
          updatePreviewDataOverride={ReportsService.updateAssignedPreview}
          resubmitReportOverride={ReportsService.resubmitAssignedPreview}
          uploadPreviewLotImagesOverride={
            ReportsService.uploadAssignedPreviewLotImages
          }
          refreshAssetSpecPdfOverride={
            ReportsService.refreshAssignedPreviewSpecPdf
          }
        />
      ) : null}
      {reviewTarget?.isRealEstateReport ? (
        <RealEstatePreviewModal
          reportId={reviewTarget._id}
          isOpen={Boolean(reviewTarget)}
          onClose={() => setReviewTarget(null)}
          onSuccess={() => {
            setReviewTarget(null);
            void load();
          }}
          isResubmitMode
          isAssignedApprovalMode
          loadPreviewDataOverride={ReportsService.getAssignedPreview}
          updatePreviewDataOverride={ReportsService.updateAssignedPreview}
          resubmitReportOverride={ReportsService.resubmitAssignedPreview}
        />
      ) : null}
      {reviewTarget?.isLotListing ? (
        <LotListingPreviewModal
          reportId={reviewTarget._id}
          isOpen={Boolean(reviewTarget)}
          onClose={() => setReviewTarget(null)}
          onSuccess={() => {
            setReviewTarget(null);
            void load();
          }}
          isResubmitMode
          isAssignedApprovalMode
          loadPreviewDataOverride={ReportsService.getAssignedPreview}
          updatePreviewDataOverride={ReportsService.updateAssignedPreview}
          resubmitReportOverride={ReportsService.resubmitAssignedPreview}
          uploadPreviewLotImagesOverride={
            ReportsService.uploadAssignedPreviewLotImages
          }
          refreshSpecPdfOverride={ReportsService.refreshAssignedPreviewSpecPdf}
        />
      ) : null}
    </main>
  );
}
