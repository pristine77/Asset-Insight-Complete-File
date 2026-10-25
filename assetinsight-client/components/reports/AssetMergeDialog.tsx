"use client";

import { CircleAlert, Info, Merge, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  getAssetMergeCandidates,
  mergeAssetReports,
  type AssetMergeCandidate,
  type AssetMergeResult,
} from "@/services/assets";

type Props = {
  open: boolean;
  anchorReportId: string | null;
  onClose: () => void;
  onCreated: (result: AssetMergeResult) => void;
};

const MAX_MERGE_SOURCES = 20;

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatStatus(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function AssetMergeDialog({
  open,
  anchorReportId,
  onClose,
  onCreated,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestIdRef = useRef("");
  const [candidates, setCandidates] = useState<AssetMergeCandidate[]>([]);
  const [contractNo, setContractNo] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !anchorReportId) return;
    let active = true;
    const requestStorageKey = `asset-merge-request:${anchorReportId}`;
    const retainedRequestId = window.localStorage.getItem(requestStorageKey);
    requestIdRef.current = retainedRequestId || createRequestId();
    if (!retainedRequestId) {
      window.localStorage.setItem(requestStorageKey, requestIdRef.current);
    }
    setLoading(true);
    setError(null);
    setCandidates([]);
    setSelectedIds([]);
    setPrimaryId("");
    void getAssetMergeCandidates(anchorReportId)
      .then((response) => {
        if (!active) return;
        setContractNo(response.contractNo);
        setCandidates(response.candidates);
        const anchor = response.candidates.find(
          (candidate) => candidate.id === anchorReportId && candidate.eligible
        );
        if (anchor) {
          setSelectedIds([anchor.id]);
          setPrimaryId(anchor.id);
        }
      })
      .catch((requestError: any) => {
        if (!active) return;
        setError(
          requestError?.response?.data?.message ||
            requestError?.message ||
            "Unable to load matching Asset reports."
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [anchorReportId, open]);

  const selected = useMemo(
    () => candidates.filter((candidate) => selectedIds.includes(candidate.id)),
    [candidates, selectedIds]
  );
  const eligibleCount = useMemo(
    () => candidates.filter((candidate) => candidate.eligible).length,
    [candidates]
  );
  const totals = useMemo(
    () => ({
      reports: selected.length,
      lots: selected.reduce((sum, candidate) => sum + candidate.lotCount, 0),
      images: selected.reduce((sum, candidate) => sum + candidate.imageCount, 0),
    }),
    [selected]
  );

  const toggleCandidate = (candidate: AssetMergeCandidate) => {
    if (!candidate.eligible) return;
    if (
      !selectedIds.includes(candidate.id) &&
      selectedIds.length >= MAX_MERGE_SOURCES
    ) {
      setError(`Select no more than ${MAX_MERGE_SOURCES} Asset reports.`);
      return;
    }
    setError(null);
    setSelectedIds((current) => {
      if (current.includes(candidate.id)) {
        const next = current.filter((id) => id !== candidate.id);
        if (primaryId === candidate.id) setPrimaryId(next[0] || "");
        return next;
      }
      const next = [...current, candidate.id];
      if (!primaryId) setPrimaryId(candidate.id);
      return next;
    });
  };

  const submit = async () => {
    if (selectedIds.length < 2 || !primaryId) return;
    try {
      setSubmitting(true);
      setError(null);
      const result = await mergeAssetReports({
        sourceReportIds: selectedIds,
        primaryReportId: primaryId,
        mergeRequestId: requestIdRef.current,
      });
      if (anchorReportId) {
        window.localStorage.removeItem(`asset-merge-request:${anchorReportId}`);
      }
      toast.success("Merged Asset preview created with sequential lot numbers.");
      onCreated(result);
    } catch (requestError: any) {
      setError(
        requestError?.response?.data?.message ||
          requestError?.message ||
          "Unable to merge Asset reports."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      aria-labelledby="asset-merge-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
      style={{
        width: "min(840px, calc(100% - 32px))",
        maxHeight: "min(90vh, 800px)",
        padding: 0,
        color: "var(--app-text)",
      }}
    >
      <header
        className="app-dialog__header"
        style={{ position: "relative", paddingRight: 64 }}
      >
        <h2
          id="asset-merge-title"
          style={{ margin: 0, fontSize: "1.08rem", fontWeight: 760 }}
        >
          Merge Asset reports
        </h2>
        <p className="app-muted" style={{ margin: "5px 0 0", fontSize: 13 }}>
          Contract {contractNo || "—"}. Source reports remain unchanged.
        </p>
        <button
          type="button"
          className="app-button app-button--icon"
          aria-label="Close merge reports dialog"
          onClick={onClose}
          disabled={submitting}
          style={{ position: "absolute", top: 14, right: 16 }}
        >
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className="app-dialog__body">
        {loading ? (
          <div
            role="status"
            className="app-muted"
            style={{ minHeight: 360, display: "grid", placeItems: "center" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span className="app-spinner" aria-hidden />
              Loading matching reports…
            </span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {error ? (
              <div className="app-alert app-alert--error" role="alert">
                <CircleAlert
                  size={18}
                  aria-hidden
                  style={{ flex: "0 0 auto", color: "var(--app-danger)" }}
                />
                <span>{error}</span>
              </div>
            ) : null}

            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 1,
                margin: 0,
                border: "1px solid var(--app-border)",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--app-border)",
              }}
            >
              {[
                ["Reports", totals.reports],
                ["Lots", totals.lots],
                ["Images", totals.images],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    padding: 12,
                    textAlign: "center",
                    background: "var(--app-panel)",
                  }}
                >
                  <dd style={{ margin: 0, fontSize: 20, fontWeight: 760 }}>
                    {value}
                  </dd>
                  <dt
                    className="app-muted"
                    style={{ marginTop: 2, fontSize: 12, fontWeight: 650 }}
                  >
                    {label}
                  </dt>
                </div>
              ))}
            </dl>

            {selected.length >= 2 ? (
              <div className="app-alert">
                <Info
                  size={18}
                  aria-hidden
                  style={{ flex: "0 0 auto", color: "var(--app-info)" }}
                />
                <span>
                  The merged report will be ordered and renumbered automatically
                  as Lot 1 through Lot {totals.lots}.
                </span>
              </div>
            ) : null}
            {eligibleCount < 2 ? (
              <div className="app-alert">
                <Info
                  size={18}
                  aria-hidden
                  style={{ flex: "0 0 auto", color: "var(--app-info)" }}
                />
                <span>
                  No other eligible Asset reports use this exact contract number.
                </span>
              </div>
            ) : null}

            <div
              role="list"
              aria-label="Asset reports available to merge"
              style={{ display: "grid", gap: 10 }}
            >
              {candidates.map((candidate) => {
                const checked = selectedIds.includes(candidate.id);
                return (
                  <article
                    key={candidate.id}
                    role="listitem"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto auto minmax(0, 1fr)",
                      gap: 12,
                      alignItems: "center",
                      padding: 14,
                      border: `1px solid ${
                        checked ? "var(--app-accent)" : "var(--app-border)"
                      }`,
                      borderRadius: 8,
                      background: checked
                        ? "var(--app-accent-soft)"
                        : "var(--app-panel)",
                      opacity: candidate.eligible ? 1 : 0.58,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!candidate.eligible}
                      onChange={() => toggleCandidate(candidate)}
                      aria-label={`Include ${candidate.clientName}`}
                      style={{ width: 18, height: 18, accentColor: "var(--app-accent)" }}
                    />
                    <input
                      type="radio"
                      name="primary-asset-report"
                      checked={primaryId === candidate.id}
                      disabled={!checked}
                      onChange={() => setPrimaryId(candidate.id)}
                      aria-label={`Use ${candidate.clientName} as primary report`}
                      style={{ width: 18, height: 18, accentColor: "var(--app-accent)" }}
                    />
                    <div
                      style={{
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 64,
                          height: 52,
                          flex: "0 0 auto",
                          display: "grid",
                          placeItems: "center",
                          overflow: "hidden",
                          border: "1px solid var(--app-border)",
                          borderRadius: 7,
                          background: "var(--app-panel-alt)",
                          color: "var(--app-text-muted)",
                        }}
                      >
                        {candidate.thumbnailUrl ? (
                          // External candidate images are already served by the API.

                          <img
                            src={candidate.thumbnailUrl}
                            alt=""
                            width={64}
                            height={52}
                            loading="lazy"
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <Merge size={20} />
                        )}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 7,
                          }}
                        >
                          <strong>{candidate.clientName}</strong>
                          <span className="app-chip">
                            {formatStatus(candidate.status)}
                          </span>
                          {candidate.isMergedReport ? (
                            <span className="app-chip app-chip--info">Merged</span>
                          ) : null}
                          {primaryId === candidate.id ? (
                            <span className="app-chip app-chip--accent">Primary</span>
                          ) : null}
                        </div>
                        <p
                          className="app-muted"
                          style={{
                            margin: "5px 0 0",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: 13,
                          }}
                        >
                          {new Date(candidate.createdAt).toLocaleDateString()} ·{" "}
                          {candidate.lotCount} lots · {candidate.imageCount} images
                        </p>
                        {candidate.owner?.email || candidate.owner?.name ? (
                          <p
                            className="app-muted"
                            style={{
                              margin: "3px 0 0",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: 12,
                            }}
                          >
                            Created by {candidate.owner.email || candidate.owner.name}
                          </p>
                        ) : null}
                        <p
                          className="app-muted"
                          style={{
                            margin: "3px 0 0",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: 12,
                          }}
                        >
                          {candidate.lotNumbers.length
                            ? candidate.lotNumbers
                                .map((value) => `Lot ${value}`)
                                .join(", ")
                            : "No lot numbers"}
                        </p>
                        {!candidate.eligible ? (
                          <p
                            style={{
                              margin: "4px 0 0",
                              color: "var(--app-danger)",
                              fontSize: 12,
                            }}
                          >
                            {candidate.disabledReason}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <p className="app-muted" style={{ margin: 0, fontSize: 13 }}>
              The Primary report supplies shared client, appraisal, date, location,
              signature, and report settings.
            </p>
          </div>
        )}
      </div>

      <footer className="app-dialog__footer">
        <button
          type="button"
          className="app-button app-button--secondary"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-button app-button--primary"
          disabled={
            loading || submitting || selectedIds.length < 2 || !primaryId
          }
          onClick={() => void submit()}
        >
          {submitting ? (
            <span className="app-spinner" aria-hidden />
          ) : (
            <Merge size={17} aria-hidden />
          )}
          {submitting ? "Creating merged preview…" : "Create merged preview"}
        </button>
      </footer>
    </dialog>
  );
}
