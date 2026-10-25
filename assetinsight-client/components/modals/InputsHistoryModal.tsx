"use client";

import {
  Cloud,
  FileText,
  HardDrive,
  HelpCircle,
  History,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthContext } from "@/context/AuthContext";
import {
  deleteScopedDraft,
  listScopedDrafts,
  type ScopedDraftSummary,
} from "@/components/forms/drafts/storage";
import { deleteSmartUploadDraft } from "@/components/forms/smartUpload/storage";
import {
  ReportDraftService,
  draftKindForRecord,
  type ReportDraftRecord,
} from "@/services/reportDrafts";
import { navigateToReportForm } from "@/services/reportFormNavigation";
import {
  SavedInputService,
  type AssetFormData,
  type FormType,
  type RealEstateFormData,
  type SavedInput,
} from "@/services/savedInputs";
import { toast } from "@/components/ui/toast";
import styles from "./InputsHistoryModal.module.css";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onLoadInput: (savedInput: SavedInput) => void;
  formType?: FormType;
};

const DRAFT_STORAGE_NOTICE_KEY = "clearvalue:draft-storage-notice:v1";

export default function InputsHistoryModal({
  isOpen,
  onClose,
  onLoadInput,
  formType,
}: Props) {
  const router = useRouter();
  const { user } = useAuthContext();
  const userId = user?._id || user?.id || null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [localDrafts, setLocalDrafts] = useState<ScopedDraftSummary[]>([]);
  const [reportDrafts, setReportDrafts] = useState<ReportDraftRecord[]>([]);
  const [savedInputs, setSavedInputs] = useState<SavedInput[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showStorageNotice, setShowStorageNotice] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!isOpen && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [isOpen]);

  const fetchSavedInputs = useCallback(async () => {
    try {
      setLoading(true);
      const reportKind = formType === "asset" ? "asset" : undefined;
      const [localResult, reportResult, serverResult] = await Promise.allSettled([
        userId
          ? listScopedDrafts(userId, { includeScoped: true })
          : Promise.resolve([]),
        formType === "realEstate"
          ? Promise.resolve([])
          : ReportDraftService.list(reportKind),
        SavedInputService.getAll(formType),
      ]);

      const local = localResult.status === "fulfilled" ? localResult.value : [];
      const filteredLocal =
        formType === "asset"
          ? local.filter((draft) => draft.kind === "asset")
          : formType === "realEstate"
            ? []
            : local;
      const cloud =
        reportResult.status === "fulfilled" ? reportResult.value : [];
      const cloudKeys = new Set(
        cloud.map((draft) => `${draftKindForRecord(draft)}:${draft.clientDraftId}`)
      );
      setReportDrafts(cloud);
      setLocalDrafts(
        filteredLocal.filter(
          (draft) =>
            !cloudKeys.has(`${draft.kind}:${draft.scopeId || ""}`)
        )
      );
      setSavedInputs(
        serverResult.status === "fulfilled" ? serverResult.value : []
      );

      if (localResult.status === "rejected") {
        toast.error("Local drafts are unavailable in this browser.");
      } else if (
        reportResult.status === "rejected" &&
        serverResult.status === "rejected" &&
        local.length === 0
      ) {
        const error = serverResult.reason as any;
        toast.error(error?.response?.data?.message || "Failed to load drafts");
      }
    } finally {
      setLoading(false);
    }
  }, [formType, userId]);

  useEffect(() => {
    if (isOpen) void fetchSavedInputs();
  }, [fetchSavedInputs, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      if (window.localStorage.getItem(DRAFT_STORAGE_NOTICE_KEY) !== "seen") {
        setShowStorageNotice(true);
      }
    } catch {
      // Privacy modes may disable storage; the explanation remains available.
      setShowStorageNotice(true);
    }
  }, [isOpen]);

  const acknowledgeStorageNotice = () => {
    try {
      window.localStorage.setItem(DRAFT_STORAGE_NOTICE_KEY, "seen");
    } catch {
      // Closing the notice must not depend on localStorage availability.
    }
    setShowStorageNotice(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      setDeleting(id);
      await SavedInputService.delete(id);
      setSavedInputs((prev) => prev.filter((item) => item._id !== id));
      toast.success("Deleted successfully");
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Failed to delete");
    } finally {
      setDeleting(null);
    }
  };

  const handleLoad = (savedInput: SavedInput) => {
    onLoadInput(savedInput);
    onClose();
    if (savedInput.formType === "asset") {
      navigateToReportForm(router, {
        kind: "asset",
        savedInput,
        returnTo: "/dashboard",
      });
      return;
    }
    router.push("/dashboard");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("load-realestate-input", { detail: savedInput })
      );
    }, 300);
  };

  const handleResumeLocal = (draft: ScopedDraftSummary) => {
    onClose();
    navigateToReportForm(router, {
      kind: draft.kind,
      resumeLocalDraftScopeId: draft.scopeId,
      returnTo: "/dashboard",
    });
  };

  const handleResumeReportDraft = (draft: ReportDraftRecord) => {
    onClose();
    navigateToReportForm(router, {
      kind: draftKindForRecord(draft),
      resumeDraft: draft,
      returnTo: "/dashboard",
    });
  };

  const handleDeleteReportDraft = async (draft: ReportDraftRecord) => {
    const kind = draftKindForRecord(draft);
    const label = draft.contractNo || draft.title || "Untitled draft";
    if (!confirm(`Delete "${label}"?`)) return;
    const deleteKey = `report:${draft._id}`;
    try {
      setDeleting(deleteKey);
      await ReportDraftService.delete(draft._id);
      if (userId) {
        await Promise.allSettled([
          deleteScopedDraft(userId, kind, draft.clientDraftId),
          deleteSmartUploadDraft(userId, kind, draft.clientDraftId),
        ]);
      }
      setReportDrafts((current) =>
        current.filter((item) => item._id !== draft._id)
      );
      toast.success("Draft deleted");
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Failed to delete draft");
    } finally {
      setDeleting(null);
    }
  };

  const handleDeleteLocal = async (draft: ScopedDraftSummary) => {
    const label = draft.contractNo || (draft.kind === "asset" ? "Asset draft" : "Lot Listing draft");
    if (!confirm(`Delete "${label}"?`)) return;
    const deleteKey = `local:${draft.kind}:${draft.scopeId || "default"}`;
    try {
      setDeleting(deleteKey);
      await deleteScopedDraft(draft.userId, draft.kind, draft.scopeId);
      setLocalDrafts((current) =>
        current.filter(
          (item) =>
            item.kind !== draft.kind || item.scopeId !== draft.scopeId
        )
      );
      toast.success("Draft deleted");
    } catch {
      toast.error("Failed to delete the local draft");
    } finally {
      setDeleting(null);
    }
  };

  const totalLabel = useMemo(
    () =>
      `${reportDrafts.length + localDrafts.length + savedInputs.length} saved ${
        reportDrafts.length + localDrafts.length + savedInputs.length === 1 ? "entry" : "entries"
      }`,
    [localDrafts.length, reportDrafts.length, savedInputs.length]
  );

  const formatDateTime = (value: string) => {
    try {
      return new Date(value).toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return value;
    }
  };

  const renderSummary = (item: SavedInput) => {
    const asset = item.formData as AssetFormData;
    const realEstate = item.formData as RealEstateFormData;
    return (
      <div style={{ display: "grid", gap: 3 }}>
        {asset.clientName ? (
          <span className="app-muted">Client: {asset.clientName}</span>
        ) : null}
        {asset.contractNo ? (
          <span className="app-muted">Contract: {asset.contractNo}</span>
        ) : null}
        {realEstate.property_details?.address ? (
          <span className="app-muted">
            Address: {realEstate.property_details.address}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className={`app-dialog ${styles.dialog}`}
      aria-labelledby="drafts-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        padding: 0,
        color: "var(--app-text)",
      }}
    >
      <header
        className="app-dialog__header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden
            style={{
              width: 44,
              height: 44,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              background: "var(--app-accent-soft)",
              color: "var(--app-accent)",
            }}
          >
            <History size={21} />
          </span>
          <div>
            <h2
              id="drafts-dialog-title"
              style={{ margin: 0, fontSize: "1.05rem", fontWeight: 750 }}
            >
              Drafts
            </h2>
            <p className="app-muted" style={{ margin: "3px 0 0", fontSize: 13 }}>
              {totalLabel}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`app-button ${styles.helpButton}`}
            onClick={() => setShowStorageNotice(true)}
            aria-label="How draft storage works"
          >
            <HelpCircle size={17} aria-hidden />
            <span>How drafts work</span>
          </button>
          <button
            type="button"
            className="app-button app-button--icon"
            onClick={onClose}
            aria-label="Close drafts"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>

      <div className="app-dialog__body" style={{ padding: 16 }}>
        {loading ? (
          <div
            className="app-muted"
            role="status"
            style={{ minHeight: 180, display: "grid", placeItems: "center" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span className="app-spinner" aria-hidden />
              Loading saved drafts...
            </span>
          </div>
        ) : reportDrafts.length === 0 &&
          localDrafts.length === 0 &&
          savedInputs.length === 0 ? (
          <div
            style={{
              minHeight: 260,
              display: "grid",
              placeItems: "center",
              textAlign: "center",
            }}
          >
            <div>
              <span
                aria-hidden
                style={{
                  width: 56,
                  height: 56,
                  display: "grid",
                  placeItems: "center",
                  margin: "0 auto 14px",
                  borderRadius: 8,
                  background: "var(--app-panel-alt)",
                  color: "var(--app-text-muted)",
                }}
              >
                <FileText size={25} />
              </span>
              <h3 style={{ margin: 0, fontSize: "1rem" }}>No saved drafts yet</h3>
              <p className="app-muted" style={{ margin: "7px 0 0" }}>
                Drafts will appear here so you can resume work quickly.
              </p>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 18 }}>
            {reportDrafts.length ? (
              <section aria-labelledby="report-drafts-heading">
                <h3
                  id="report-drafts-heading"
                  style={{ margin: "0 0 9px", fontSize: 13, fontWeight: 750 }}
                >
                  Report drafts
                </h3>
                <ul
                  aria-label="Report drafts"
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  {reportDrafts.map((draft) => {
                    const deleteKey = `report:${draft._id}`;
                    const kind = draftKindForRecord(draft);
                    const label =
                      draft.contractNo ||
                      draft.title ||
                      (kind === "asset"
                        ? "Untitled asset draft"
                        : "Untitled lot listing draft");
                    const lotCount =
                      draft.smartUploadSummary?.groups?.length || draft.lots.length;
                    const mediaCount =
                      draft.smartUploadSummary?.groups?.reduce(
                        (total, group) => total + group.imageCount,
                        0
                      ) || draft.media.length;

                    return (
                      <li
                        key={draft._id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          alignItems: "stretch",
                          border: "1px solid var(--app-border)",
                          borderRadius: 8,
                          background: "var(--app-panel)",
                          overflow: "hidden",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handleResumeReportDraft(draft)}
                          style={{
                            minWidth: 0,
                            padding: 14,
                            border: 0,
                            background: "transparent",
                            color: "inherit",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: 8,
                            }}
                          >
                            <strong>{label}</strong>
                            <span className="app-chip app-chip--info">
                              {kind === "asset" ? "Asset" : "Lot Listing"}
                            </span>
                            <span className="app-chip">
                              {draft.storageMode === "smart_upload"
                                ? "Smart Upload"
                                : "Manual media"}
                            </span>
                          </span>
                          <span
                            style={{
                              display: "grid",
                              gap: 5,
                              marginTop: 9,
                              fontSize: 13,
                            }}
                          >
                            <span className="app-muted">
                              {lotCount} {lotCount === 1 ? "lot" : "lots"}
                              {mediaCount > 0
                                ? ` - ${mediaCount} media ${mediaCount === 1 ? "file" : "files"}`
                                : ""}
                            </span>
                            <span className="app-muted">
                              Saved {formatDateTime(draft.updatedAt)}
                            </span>
                            {draft.storageMode === "local_media" && mediaCount > 0 ? (
                              <span className="app-muted">
                                Original media restores on the browser where it was saved.
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="app-button app-button--icon app-button--danger"
                          onClick={() => void handleDeleteReportDraft(draft)}
                          disabled={deleting === deleteKey}
                          aria-label={`Delete ${label}`}
                          style={{
                            alignSelf: "center",
                            marginRight: 12,
                            borderColor: "transparent",
                          }}
                        >
                          {deleting === deleteKey ? (
                            <span className="app-spinner" aria-hidden />
                          ) : (
                            <Trash2 size={17} aria-hidden />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {localDrafts.length ? (
              <section aria-labelledby="local-drafts-heading">
                <h3
                  id="local-drafts-heading"
                  style={{ margin: "0 0 9px", fontSize: 13, fontWeight: 750 }}
                >
                  Local drafts
                </h3>
                <ul
                  aria-label="Local drafts"
                  style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}
                >
                  {localDrafts.map((draft) => {
                    const deleteKey = `local:${draft.kind}:${draft.scopeId || "default"}`;
                    const label = draft.contractNo ||
                      (draft.kind === "asset" ? "Untitled asset draft" : "Untitled lot listing draft");
                    return (
                      <li
                        key={`${draft.kind}:${draft.scopeId || "default"}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          alignItems: "stretch",
                          border: "1px solid var(--app-border)",
                          borderRadius: 8,
                          background: "var(--app-panel)",
                          overflow: "hidden",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handleResumeLocal(draft)}
                          style={{
                            minWidth: 0,
                            padding: 14,
                            border: 0,
                            background: "transparent",
                            color: "inherit",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                            <strong>{label}</strong>
                            <span className="app-chip app-chip--info">
                              {draft.kind === "asset" ? "Asset" : "Lot Listing"}
                            </span>
                          </span>
                          <span style={{ display: "grid", gap: 5, marginTop: 9, fontSize: 13 }}>
                            <span className="app-muted">
                              {draft.lotCount} {draft.lotCount === 1 ? "lot" : "lots"}
                              {draft.mediaCount > 0 ? ` - ${draft.mediaCount} media files` : ""}
                            </span>
                            <span className="app-muted">
                              Saved {formatDateTime(draft.savedAt)}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="app-button app-button--icon app-button--danger"
                          onClick={() => void handleDeleteLocal(draft)}
                          disabled={deleting === deleteKey}
                          aria-label={`Delete ${label}`}
                          style={{ alignSelf: "center", marginRight: 12, borderColor: "transparent" }}
                        >
                          {deleting === deleteKey ? (
                            <span className="app-spinner" aria-hidden />
                          ) : (
                            <Trash2 size={17} aria-hidden />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {savedInputs.length ? (
              <section aria-labelledby="saved-inputs-heading">
                <h3
                  id="saved-inputs-heading"
                  style={{ margin: "0 0 9px", fontSize: 13, fontWeight: 750 }}
                >
                  Saved inputs
                </h3>
                <ul
                  aria-label="Saved inputs"
                  style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}
                >
            {savedInputs.map((item) => (
              <li
                key={item._id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  alignItems: "stretch",
                  border: "1px solid var(--app-border)",
                  borderRadius: 8,
                  background: "var(--app-panel)",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => handleLoad(item)}
                  style={{
                    minWidth: 0,
                    padding: 14,
                    border: 0,
                    background: "transparent",
                    color: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <strong>{item.name}</strong>
                    <span
                      className={`app-chip ${
                        item.formType === "realEstate"
                          ? "app-chip--success"
                          : "app-chip--info"
                      }`}
                    >
                      {item.formType === "realEstate" ? "Real Estate" : "Asset"}
                    </span>
                  </span>
                  <span
                    style={{
                      display: "grid",
                      gap: 7,
                      marginTop: 9,
                      fontSize: 13,
                    }}
                  >
                    {renderSummary(item)}
                    <span className="app-muted">
                      Saved {formatDateTime(item.createdAt)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="app-button app-button--icon app-button--danger"
                  onClick={() => void handleDelete(item._id, item.name)}
                  disabled={deleting === item._id}
                  aria-label={`Delete ${item.name}`}
                  style={{
                    alignSelf: "center",
                    marginRight: 12,
                    borderColor: "transparent",
                  }}
                >
                  {deleting === item._id ? (
                    <span className="app-spinner" aria-hidden />
                  ) : (
                    <Trash2 size={17} aria-hidden />
                  )}
                </button>
              </li>
            ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>

      {showStorageNotice ? (
        <div
          className={styles.noticeBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) acknowledgeStorageNotice();
          }}
        >
          <section
            className={styles.noticePanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-storage-notice-title"
          >
            <header className={styles.noticeHeader}>
              <div>
                <span className={styles.noticeEyebrow}>Draft recovery</span>
                <h3 id="draft-storage-notice-title">How your drafts are saved</h3>
                <p>
                  Your work is protected in two places so large photo drafts stay fast
                  and reliable.
                </p>
              </div>
              <button
                type="button"
                className="app-button app-button--icon"
                onClick={acknowledgeStorageNotice}
                aria-label="Close draft storage information"
              >
                <X size={18} aria-hidden />
              </button>
            </header>

            <div className={styles.noticeItems}>
              <article className={styles.noticeItem}>
                <span className={styles.noticeIcon} aria-hidden>
                  <Cloud size={20} />
                </span>
                <div>
                  <h4>Report details sync to your account</h4>
                  <p>
                    Contract details, lots, selections, specifications, and other text
                    are saved to the server and appear in Drafts after you sign in.
                  </p>
                </div>
              </article>

              <article className={styles.noticeItem}>
                <span className={styles.noticeIcon} aria-hidden>
                  <HardDrive size={20} />
                </span>
                <div>
                  <h4>Manual photos stay on this device</h4>
                  <p>
                    Original manual-upload photos are stored securely in this browser.
                    Open the draft on this same device to restore every photo. On another
                    device, the report details return but those local originals do not.
                  </p>
                </div>
              </article>

              <article className={styles.noticeItem}>
                <span className={styles.noticeIcon} aria-hidden>
                  <FileText size={20} />
                </span>
                <div>
                  <h4>Smart Upload can resume from the server</h4>
                  <p>
                    Smart Upload images and grouping progress are server-backed, so that
                    workflow can continue from another signed-in device.
                  </p>
                </div>
              </article>
            </div>

            <div className={styles.noticeCallout}>
              Do not clear browser site data or remove the original files until a manual
              draft has been submitted successfully.
            </div>

            <footer className={styles.noticeFooter}>
              <button
                type="button"
                className="app-button app-button--primary"
                onClick={acknowledgeStorageNotice}
                autoFocus
              >
                Got it
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <footer className="app-dialog__footer">
        <button
          type="button"
          className="app-button app-button--secondary"
          onClick={onClose}
        >
          Close
        </button>
      </footer>
    </dialog>
  );
}
