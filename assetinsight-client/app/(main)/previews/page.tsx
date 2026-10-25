"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Download,
  FileSearch,
  Merge,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  deleteAssetReport,
  getAssetReports,
  resubmitReport,
  type AssetReport,
} from "@/services/assets";
import {
  deleteLotListing,
  getLotListings,
  resubmitLotListing,
  type LotListing,
} from "@/services/lotListing";
import {
  RealEstateService,
  type RealEstateReport,
} from "@/services/realEstate";
import { ReportThumbnail } from "@/components/reports/ReportThumbnail";
import {
  ReportDraftService,
  draftKindForRecord,
  type ReportDraftRecord,
} from "@/services/reportDrafts";
import { navigateToReportForm } from "@/services/reportFormNavigation";
import styles from "./page.module.css";
import { hasSavedReportPreview } from "@/lib/reportPreviewAvailability";
import { SalvageService, salvagePreviewPath, salvageStatusPath, salvageIsProcessing, type SalvageReport } from "@/services/salvage";
import { salvageSystemText } from "@/lib/salvagePresentation";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import { previewLoadError } from "@/lib/previewLoadError";

const AssetMergeDialog = dynamic(
  () => import("@/components/reports/AssetMergeDialog"),
  { ssr: false }
);
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

type CombinedReport =
  | (AssetReport & { reportType: "asset" })
  | (RealEstateReport & { reportType: "realEstate" })
  | (LotListing & { reportType: "lotListing" })
  | (SalvageReport & { reportType: "salvage" });

type TabType = "new" | "submitted" | "drafts";

const WORKFLOW_LABELS: Record<string, string> = {
  preparing_preview: "Preparing preview",
  preview_ready: "Preview ready",
  generating_files: "Generating files",
  awaiting_approval: "Awaiting approval",
  awaiting_release: "Awaiting release",
  ready: "Ready to download",
  error: "Generation failed",
  stopped: "Processing stopped",
};

const PREVIEW_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function isWorkflowActive(report: any): boolean {
  if (["preparing_preview", "generating_files"].includes(report?.workflow_stage)) return true;
  if (
    ["preview_ready", "awaiting_approval", "awaiting_release", "ready", "error", "stopped"].includes(
      report?.workflow_stage
    )
  ) {
    return false;
  }
  return (
    report?.generation_state === "queued" ||
    report?.generation_state === "processing" ||
    report?.job_status === "queued" ||
    report?.job_status === "processing"
  );
}

function isSubmittedPreview(report: CombinedReport): boolean {
  return Boolean(
    (report.reportType === "salvage" && ((report as any).generation_kind === "files" || report.workflow_stage === "generating_files")) ||
    (report as any).preview_submitted_at ||
      (report as any).approval_requested_at ||
      ["pending_approval", "approved"].includes(String(report.status)) ||
      ["pending_approval", "approved"].includes(
        String((report as any).generation_target_status || "")
      )
  );
}

function hasOpenablePreview(report: CombinedReport): boolean {
  const status = String(report.status || "");
  const stage = String((report as any).workflow_stage || "");

  if (stage === "preparing_preview") return false;
  if (stage === "error" || status === "error") return hasSavedReportPreview(report);
  if (["preview", "declined", "pending_approval", "approved"].includes(status)) {
    return true;
  }
  if (stage === "preview_ready") return true;
  if (
    ["generating_files", "awaiting_approval", "awaiting_release", "ready"].includes(
      stage
    )
  ) {
    return isSubmittedPreview(report);
  }
  return false;
}

function workflowBadgeStatus(report: any) {
  const stage = report?.workflow_stage;
  if (stage === "error") return "error";
  if (stage === "preview_ready") return "preview";
  if (stage === "awaiting_approval" || stage === "awaiting_release") return "pending_approval";
  if (stage === "ready") return "approved";
  if (stage === "preparing_preview" || stage === "generating_files") return "processing";
  return report?.status || "draft";
}

function requestReportsRefetch() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("cv:report-created"));
}

function summaryForReport(report: CombinedReport) {
  if (report.reportType === "salvage") {
    return {
      title: report.file_number || "Salvage report", typeLabel: "Salvage", accent: "var(--app-accent)",
      fields: [["Claim", String(report.preview_data?.claim_number || "—")], ["Currency", report.currency || "CAD"], ["Images", String((report as any).image_count ?? report.imageUrls?.length ?? 0)]],
    };
  }
  if (report.reportType === "realEstate") {
    return {
      title:
        (report as any).property_details?.address ||
        (report as any).preview_data?.property_details?.address ||
        "Real Estate Report",
      typeLabel: "Real Estate",
      accent: "#059669",
      fields: [
        ["Property Type", (report as any).property_type || "—"],
        [
          "Market Value",
          (report as any).preview_data?.valuation?.fair_market_value ||
            (report as any).valuation?.fair_market_value ||
            "—",
        ],
        ["Images", String((report as any).image_count ?? report.imageUrls?.length ?? 0)],
      ],
    };
  }
  if (report.reportType === "lotListing") {
    return {
      title:
        (report as any).details?.contract_no ||
        (report as any).preview_data?.contract_no ||
        (report as any).contract_no ||
        "Lot Listing",
      typeLabel: "Lot Listing",
      accent: "#7c3aed",
      fields: [
        ["Lots", String((report as any).lot_count ?? (report as any).lots?.length ?? 0)],
        [
          "Currency",
          (report as any).preview_data?.currency ||
            (report as any).details?.currency ||
            (report as any).currency ||
            "CAD",
        ],
        ["Images", String((report as any).image_count ?? report.imageUrls?.length ?? 0)],
      ],
    };
  }
  return {
    title: (report as any).preview_data?.client_name || (report as any).client_name || (report as any).contract_no || "Asset Report",
    typeLabel: "Asset",
    accent: "#2563eb",
    fields: [
      ["Total Assets", String((report as any).lot_count ?? (report as any).lots?.length ?? 0)],
      ["Grouping", (report as any).grouping_mode?.replace(/_/g, " ") || "—"],
      ["Industry", report.preview_data?.industry || "Not specified"],
    ],
  };
}

function previewThumbnailForReport(report: CombinedReport): string | null {
  if (typeof (report as any).thumbnail_url === "string") return (report as any).thumbnail_url;
  const directImages = Array.isArray((report as any).imageUrls)
    ? (report as any).imageUrls
    : [];
  const previewImages = Array.isArray((report as any).preview_data?.imageUrls)
    ? (report as any).preview_data.imageUrls
    : [];
  const lots = Array.isArray((report as any).lots)
    ? (report as any).lots
    : Array.isArray((report as any).preview_data?.lots)
      ? (report as any).preview_data.lots
      : [];
  const lotImage = lots
    .flatMap((lot: any) => [
      ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
      ...(Array.isArray(lot?.imageUrls) ? lot.imageUrls : []),
      ...(Array.isArray(lot?.images) ? lot.images : []),
    ])
    .find((value: unknown) => typeof value === "string" && value.length > 0);

  return (
    [...directImages, ...previewImages].find(
      (value: unknown) => typeof value === "string" && value.length > 0
    ) ||
    lotImage ||
    null
  );
}

export default function PreviewsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>("new");
  const [newReports, setNewReports] = useState<CombinedReport[]>([]);
  const [submittedReports, setSubmittedReports] = useState<CombinedReport[]>([]);
  const [draftReports, setDraftReports] = useState<ReportDraftRecord[]>([]);

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (
      requestedTab === "new" ||
      requestedTab === "submitted" ||
      requestedTab === "drafts"
    ) {
      setActiveTab(requestedTab);
    }
  }, []);
  const hasActiveJobs = useMemo(
    () =>
      [...newReports, ...submittedReports].some(isWorkflowActive) ||
      draftReports.some((draft) =>
        ["queued", "processing"].includes(String(draft.previewStatus || ""))
      ),
    [draftReports, newReports, submittedReports]
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const [promotingDraft, setPromotingDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [realEstateModalOpen, setRealEstateModalOpen] = useState(false);
  const [lotListingModalOpen, setLotListingModalOpen] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedDraftPreviewId, setSelectedDraftPreviewId] = useState<string | null>(null);
  const [isResubmitMode, setIsResubmitMode] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CombinedReport | null>(null);
  const [mergeAnchorId, setMergeAnchorId] = useState<string | null>(null);
  const loadingReportsRef = useRef(false);
  const mountedRef = useRef(true);
  const queueRevisionRef = useRef(0);
  const queuedReloadRef = useRef(false);
  const [loadIssues, setLoadIssues] = useState<string[]>([]);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const deepLinkHandledRef = useRef(false);
  const isPreviewEditorOpen =
    previewModalOpen || realEstateModalOpen || lotListingModalOpen;

  const loadReports = useCallback(async (
    options: { showLoading?: boolean; silent?: boolean; successToast?: boolean; afterMutation?: boolean } = {}
  ): Promise<boolean> => {
    if (options.afterMutation) queueRevisionRef.current += 1;
    if (loadingReportsRef.current) {
      if (options.afterMutation) queuedReloadRef.current = true;
      return false;
    }
    loadingReportsRef.current = true;
    const revision = queueRevisionRef.current;
    const session = captureAuthSession();
    if (options.showLoading) setLoading(true); else setRefreshing(true);
    const valid = () => mountedRef.current && isAuthSessionCurrent(session) && revision === queueRevisionRef.current;
    try {
      const reportRead = async (request: Promise<{ data: any[] }>) => {
        const response = await request;
        if (!Array.isArray(response?.data) || response.data.some(report => !report || typeof report._id !== 'string' || typeof report.status !== 'string')) throw new Error('Incomplete preview response');
        return response.data;
      };
      const results = await Promise.allSettled([
        reportRead(getAssetReports('previews')),
        reportRead(RealEstateService.getReports('previews')),
        reportRead(getLotListings('previews')),
        reportRead(SalvageService.getReports('previews')),
        ReportDraftService.list(undefined, 30000).then(rows => { if (!Array.isArray(rows) || rows.some(row => !row || !(row.id || row._id))) throw new Error('Incomplete draft response'); return rows; }),
      ]);
      if (!valid()) return false;
      const kinds = ['asset', 'realEstate', 'lotListing', 'salvage'] as const;
      const labels = ['Asset', 'Real Estate', 'Lot Listing', 'Salvage', 'Drafts'];
      const succeeded = new Set<string>();
      const next: CombinedReport[] = [];
      results.slice(0, 4).forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const reportType = kinds[index];
        succeeded.add(reportType);
        for (const report of result.value) {
          if (!report?._id || !['processing', 'error', 'preview', 'declined', 'pending_approval', 'approved', 'cancelled'].includes(report.status)) continue;
          next.push({ ...report, reportType, ...(reportType === 'salvage' ? {
            workflow_message: salvageSystemText(report.workflow_message), job_error: salvageSystemText(report.job_error),
          } : {}) } as CombinedReport);
        }
      });
      const merge = (current: CombinedReport[], submitted: boolean) => [
        ...current.filter(report => !succeeded.has(report.reportType)),
        ...next.filter(report => isSubmittedPreview(report) === submitted),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setNewReports(current => merge(current, false));
      setSubmittedReports(current => merge(current, true));
      const drafts = results[4];
      if (drafts.status === 'fulfilled') setDraftReports([...drafts.value].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
      const issues = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index] + ': ' + previewLoadError(result.reason)] : []);
      setLoadIssues(issues);
      if (!issues.length) setLastLoadedAt(new Date());
      if (options.successToast && !issues.length) toast.success('Previews refreshed.');
      return !issues.length;
    } catch (error) {
      if (valid()) setLoadIssues([previewLoadError(error)]);
      return false;
    } finally {
      loadingReportsRef.current = false;
      if (mountedRef.current && isAuthSessionCurrent(session)) { setLoading(false); setRefreshing(false); }
      if (mountedRef.current && queuedReloadRef.current && isAuthSessionCurrent(session)) {
        queuedReloadRef.current = false;
        void loadReports({ silent: true });
      }
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    void loadReports({ showLoading: true });
    return () => { mountedRef.current = false; queueRevisionRef.current += 1; queuedReloadRef.current = true; };
  }, [loadReports]);

  useEffect(() => {
    const refreshOwnership = () => {
      if (
        document.visibilityState === "visible" &&
        !isPreviewEditorOpen
      ) {
        void loadReports({ silent: true });
      }
    };
    window.addEventListener("focus", refreshOwnership);
    document.addEventListener("visibilitychange", refreshOwnership);
    return () => {
      window.removeEventListener("focus", refreshOwnership);
      document.removeEventListener("visibilitychange", refreshOwnership);
    };
  }, [isPreviewEditorOpen, loadReports]);

  useEffect(() => {
    // Editing must remain stable. Queue polling resumes as soon as the drawer
    // closes, so status updates never steal focus or move the active lot.
    if (!hasActiveJobs || isPreviewEditorOpen) return;
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      void loadReports({ silent: true });
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveJobs, isPreviewEditorOpen, loadReports]);

  useEffect(() => {
    if (hasActiveJobs || isPreviewEditorOpen) return;
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      void loadReports({ silent: true });
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveJobs, isPreviewEditorOpen, loadReports]);

  const handleManualRefresh = async () => {
    await loadReports({ successToast: true });
  };

  const handleOpenPreview = (report: CombinedReport, resubmitMode = false) => {
    if (report.reportType === "salvage") {
      router.push(salvageIsProcessing(report) || ["cancelled", "error"].includes(report.status) ? salvageStatusPath(report._id) : salvagePreviewPath(report._id));
      return;
    }
    setSelectedDraftPreviewId(null);
    setSelectedReportId(report._id);
    setIsResubmitMode(resubmitMode);
    if (report.reportType === "realEstate") {
      setRealEstateModalOpen(true);
    } else if (report.reportType === "lotListing") {
      setLotListingModalOpen(true);
    } else {
      setPreviewModalOpen(true);
    }
  };

  useEffect(() => {
    if (loading || loadIssues.length || deepLinkHandledRef.current) return;

    const params = new URLSearchParams(window.location.search);
    const reportId = params.get("reportId")?.trim();
    const requestedType = params.get("reportType")?.trim();
    if (!reportId) {
      deepLinkHandledRef.current = true;
      return;
    }

    const matchesTarget = (report: CombinedReport) =>
      String(report._id) === reportId &&
      (!requestedType || report.reportType === requestedType);
    const submittedReport = submittedReports.find(matchesTarget);
    const report = submittedReport || newReports.find(matchesTarget);
    if (!report) {
      deepLinkHandledRef.current = true;
      return;
    }
    if (!hasOpenablePreview(report)) return;

    deepLinkHandledRef.current = true;
    setActiveTab(submittedReport ? "submitted" : "new");
    handleOpenPreview(
      report,
      Boolean(submittedReport) || isSubmittedPreview(report)
    );
  }, [loading, loadIssues.length, newReports, submittedReports]);

  const handleModalClose = () => {
    setPreviewModalOpen(false);
    setRealEstateModalOpen(false);
    setLotListingModalOpen(false);
    setSelectedReportId(null);
    setSelectedDraftPreviewId(null);
    setIsResubmitMode(false);
  };

  const handleOpenDraftPreview = (draft: ReportDraftRecord) => {
    if (!draft.previewReportId || draft.previewStatus !== "ready") return;
    setSelectedDraftPreviewId(String(draft.id || draft._id));
    setSelectedReportId(String(draft.previewReportId));
    setIsResubmitMode(false);
    if (draft.type === "lotListing") setLotListingModalOpen(true);
    else setPreviewModalOpen(true);
  };

  const handleContinueDraft = (draft: ReportDraftRecord) => {
    navigateToReportForm(router, {
      kind: draftKindForRecord(draft),
      resumeDraft: draft,
      returnTo: "/previews",
    });
  };

  const handleRetryDraftPreview = async (draft: ReportDraftRecord) => {
    try {
      await ReportDraftService.processPreview(draft.id || draft._id);
      toast.success("Draft preview processing restarted.");
      await loadReports({ silent: true, afterMutation: true });
    } catch (error: any) {
      toast.error(
        error?.response?.data?.message ||
          error?.message ||
          "Draft preview processing could not be started."
      );
    }
  };

  const handlePromoteDraftPreview = async (draft: ReportDraftRecord) => {
    const draftId = String(draft.id || draft._id || "");
    if (!draftId) return;
    try {
      setPromotingDraft(draftId);
      const promoted = await ReportDraftService.promotePreview(draftId, {
        submit: false,
      });
      const submitted = ["pending_approval", "approved"].includes(
        String(promoted.status || "")
      );
      setActiveTab(submitted ? "submitted" : "new");
      requestReportsRefetch();
      toast.success(
        submitted
          ? "Draft moved to submitted previews."
          : "Draft moved to main previews."
      );
      await loadReports({ silent: true, afterMutation: true });
    } catch (error: any) {
      toast.error(
        error?.response?.data?.message ||
          error?.message ||
          "Draft preview could not be moved."
      );
    } finally {
      setPromotingDraft(null);
    }
  };

  const handleSuccess = (submittedReport?: any) => {
    const reportId = String(
      submittedReport?._id || submittedReport?.reportId || selectedReportId || ""
    );
    if (reportId) {
      const source = [...newReports, ...submittedReports].find(
        (report) => String(report._id) === reportId
      );
      if (source) {
        const nextReport = {
          ...source,
          ...(submittedReport || {}),
          _id: reportId,
          reportType: source.reportType,
          preview_submitted_at:
            submittedReport?.preview_submitted_at || new Date().toISOString(),
        } as CombinedReport;
        setNewReports((current) =>
          current.filter((report) => String(report._id) !== reportId)
        );
        setSubmittedReports((current) => [
          nextReport,
          ...current.filter((report) => String(report._id) !== reportId),
        ]);
      }
    }
    setActiveTab("submitted");
    requestReportsRefetch();
    void loadReports({ afterMutation: true });
    toast.success("Report submitted successfully.");
  };

  const handleQuickResubmit = async (report: CombinedReport) => {
    try {
      setResubmitting(report._id);
      if (report.reportType === "lotListing") {
        await resubmitLotListing(report._id);
      } else {
        await resubmitReport(report._id);
      }
      requestReportsRefetch();
      toast.success("Report resubmitted. Files are being regenerated.");
      await loadReports({ afterMutation: true });
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Failed to resubmit report");
    } finally {
      setResubmitting(null);
    }
  };

  const handleDeleteReport = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(deleteTarget._id);
      if (deleteTarget.reportType === "asset") {
        await deleteAssetReport(deleteTarget._id);
      } else if (deleteTarget.reportType === "lotListing") {
        await deleteLotListing(deleteTarget._id);
      } else {
        await RealEstateService.deleteReport(deleteTarget._id);
      }
      toast.success("Report deleted successfully");
      setDeleteTarget(null);
      await loadReports({ afterMutation: true });
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Failed to delete report");
    } finally {
      setDeleting(null);
    }
  };

  const reports =
    activeTab === "new"
      ? newReports
      : activeTab === "submitted"
        ? submittedReports
        : [];

  const summary = useMemo(() => {
    const all = [...newReports, ...submittedReports];
    return {
      newCount: newReports.length,
      draftCount: draftReports.length,
      pendingCount: all.filter((report) => report.status === "pending_approval")
        .length,
      approvedCount: all.filter((report) => report.status === "approved").length,
      declinedCount: all.filter((report) => report.status === "declined").length,
    };
  }, [draftReports.length, newReports, submittedReports]);

  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (deleteTarget && !dialog.open) dialog.showModal();
    if (!deleteTarget && dialog.open) dialog.close();
  }, [deleteTarget]);

  if (loading) {
    return (
      <div
        className="grid min-h-[60vh] place-items-center"
        role="status"
        aria-label="Loading previews"
      >
        <div className="flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
          <RefreshCw className="size-4 animate-spin text-[var(--app-accent)]" />
          Loading previews...
        </div>
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>Report previews</h1>
          <p className={styles.subtitle}>
            Review new outputs, submit reports for approval, and manage already
            submitted preview packages.
          </p>
        </div>
        <button
          type="button"
          className={styles.control}
          onClick={() => void handleManualRefresh()}
          disabled={refreshing}
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {loadIssues.length > 0 ? <section role="alert" className={styles.loadIssue}>
        <strong>Some preview lists could not be refreshed</strong>
        <p>Available previews remain below. Counts marked * are last loaded and may be out of date; this does not mean your reports were deleted.</p>
        <ul>{loadIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        <button type="button" className={styles.control} disabled={refreshing} onClick={() => void handleManualRefresh()}>Retry loading previews</button>
      </section> : null}
      {lastLoadedAt ? <p className={styles.subtitle}>Last complete refresh: {lastLoadedAt.toLocaleTimeString()}</p> : null}

      <section
        aria-label="Preview summary"
        className={styles.summary}
      >
        {[
          { label: "New", value: summary.newCount },
          { label: "Submitted", value: submittedReports.length },
          { label: "Draft previews", value: summary.draftCount },
          {
            label: "Pending approval",
            value: summary.pendingCount,
          },
          { label: "Approved", value: summary.approvedCount },
          { label: "Declined", value: summary.declinedCount },
        ].map((item) => (
          <div key={item.label} className={styles.summaryItem}>
            <p className={styles.summaryLabel}>{item.label}</p>
            <p className={styles.summaryValue}>{loadIssues.length ? (item.value ? `${item.value}*` : "—") : item.value}</p>
          </div>
        ))}
      </section>

      <section className={styles.queue}>
        <div className={styles.queueHeader}>
          <div className={styles.queueIntro}>
            <h2 className={styles.queueTitle}>Preview queue</h2>
            <p className={styles.queueDescription}>
              Switch between new previews and submitted items awaiting the next
              step.
            </p>
          </div>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Preview queue"
          >
            {[
              { id: "new" as const, label: "New", count: newReports.length },
              {
                id: "submitted" as const,
                label: "Submitted",
                count: submittedReports.length,
              },
              {
                id: "drafts" as const,
                label: "Draft Previews",
                count: draftReports.length,
              },
            ].map((tab) => (
              <button
                key={tab.id}
                id={`preview-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="preview-tabpanel"
                className={`${styles.tab} ${
                  activeTab === tab.id ? styles.tabActive : ""
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label} ({loadIssues.length ? (tab.count ? `${tab.count}*` : "—") : tab.count})
              </button>
            ))}
          </div>
        </div>

        <div
          id="preview-tabpanel"
          role="tabpanel"
          aria-labelledby={`preview-tab-${activeTab}`}
        >
          {activeTab === "drafts" && draftReports.length > 0 ? (
            <ul className={styles.reportList}>
              {draftReports.map((draft) => {
                const status = draft.previewStatus || "idle";
                const isActive = status === "queued" || status === "processing";
                const isReady = status === "ready" && Boolean(draft.previewReportId);
                const imageCount = (draft.media || []).filter(
                  (item) => item.slot !== "video"
                ).length;
                const lotCount = Array.isArray(draft.lots) ? draft.lots.length : 0;
                const processedRevision = Number(draft.previewProcessedRevision || 0);
                const stale = isReady && processedRevision < Number(draft.revision || 0);
                return (
                  <li key={draft._id} className={styles.reportRow}>
                    <div className={styles.rowMain}>
                      <div className={styles.reportIdentity}>
                        <span className={styles.thumbnail}>
                          <ReportThumbnail
                            src={(draft.media || []).find((item) => item.url)?.url || null}
                            title={draft.title || draft.contractNo || "Draft report"}
                            size="table"
                          />
                        </span>
                        <div className={styles.identityCopy}>
                          <div className={styles.metaLine}>
                            <span className={styles.typeLabel}>
                              {draft.type === "lotListing" ? "Lot Listing" : "Asset"}
                            </span>
                            <span
                              className={`${styles.badge} ${
                                status === "ready"
                                  ? styles.badgeSuccess
                                  : status === "error"
                                    ? styles.badgeDanger
                                    : isActive
                                      ? styles.badgeInfo
                                      : styles.badgeNeutral
                              }`}
                            >
                              {stale
                                ? "Changes need processing"
                                : status === "idle"
                                  ? "Saved draft"
                                  : status === "queued"
                                    ? "Queued"
                                    : status === "processing"
                                      ? "Preparing preview"
                                      : status === "ready"
                                        ? "Draft preview ready"
                                        : "Preview failed"}
                            </span>
                          </div>
                          <h3 className={styles.reportTitle}>
                            {draft.title || draft.contractNo || "Untitled draft"}
                          </h3>
                          <p className={styles.createdAt}>
                            Contract: {draft.contractNo || "Not set"} · {lotCount} lot{lotCount === 1 ? "" : "s"} · {imageCount} image{imageCount === 1 ? "" : "s"} · Updated {PREVIEW_DATE_FORMATTER.format(new Date(draft.updatedAt))}
                          </p>
                          {draft.previewError ? (
                            <div className={`${styles.notice} ${styles.noticeDanger}`}>
                              {draft.previewError}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className={styles.actions}>
                        {isReady && !stale ? (
                          <>
                            <button
                              type="button"
                              className={`${styles.action} ${styles.actionPrimary}`}
                              onClick={() => handleOpenDraftPreview(draft)}
                            >
                              <FileSearch className="size-4" /> Open preview
                            </button>
                            <button
                              type="button"
                              className={`${styles.action} ${styles.actionSecondary}`}
                              onClick={() => void handlePromoteDraftPreview(draft)}
                              disabled={promotingDraft === String(draft.id || draft._id)}
                            >
                              {promotingDraft === String(draft.id || draft._id) ? (
                                <RefreshCw className="size-4 animate-spin" />
                              ) : (
                                <ArrowRight className="size-4" />
                              )}
                              {promotingDraft === String(draft.id || draft._id)
                                ? "Moving..."
                                : "Move to previews"}
                            </button>
                          </>
                        ) : null}
                        {(status === "error" || stale || status === "idle") ? (
                          <button
                            type="button"
                            className={`${styles.action} ${styles.actionSecondary}`}
                            onClick={() => void handleRetryDraftPreview(draft)}
                          >
                            <RefreshCw className="size-4" /> Prepare preview
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`${styles.action} ${styles.actionSecondary}`}
                          onClick={() => handleContinueDraft(draft)}
                        >
                          <Pencil className="size-4" /> Continue editing
                        </button>
                      </div>
                    </div>
                    {isActive ? (
                      <div className={`${styles.progressPanel} ${styles.rowContinuation}`}>
                        <div className={styles.progressHeader}>
                          <span>Preparing a draft preview from the saved details and media</span>
                          <span>{status === "queued" ? "Queued" : "Processing"}</span>
                        </div>
                        <div className={styles.progressTrack}>
                          <span
                            className={styles.progressValue}
                            style={{ width: status === "queued" ? "18%" : "62%" }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : reports.length === 0 ? (
            <div className={styles.emptyState}>
              <div>
                <span className={styles.emptyIcon} aria-hidden="true">
                  <FileSearch className="size-4" />
                </span>
                <h3 className={styles.emptyTitle}>
                  {loadIssues.length ? "Preview list unavailable" : activeTab === "new"
                    ? "No new previews"
                    : activeTab === "submitted"
                      ? "No submitted previews"
                      : "No draft previews"}
                </h3>
                <p className={styles.emptyDescription}>
                  {loadIssues.length ? "Retry loading above. Saved reports and photos are unchanged." : activeTab === "new"
                    ? submittedReports.length ? "Reports you already submitted are in the Submitted tab. New uploads appear here while processing." : "Generate a new report to begin the review and submission flow."
                    : activeTab === "submitted"
                      ? "Submitted previews and approvals will appear here."
                      : "Save an Asset or Lot Listing draft, then choose Prepare preview here when you are ready to review it."}
                </p>
                {activeTab === "new" && submittedReports.length > 0 ? <button type="button" className={`${styles.action} ${styles.actionPrimary} ${styles.emptyAction}`} onClick={() => setActiveTab("submitted")}>View submitted previews ({submittedReports.length})</button> : null}
                {activeTab === "new" && !loadIssues.length && submittedReports.length === 0 ? (
                  <Link
                    href="/dashboard"
                    className={`${styles.action} ${styles.actionPrimary} ${styles.emptyAction}`}
                  >
                    Create new report
                  </Link>
                ) : null}
              </div>
            </div>
          ) : (
            <ul className={styles.reportList}>
              {reports.map((report) => {
                const info = summaryForReport(report);
                const jobActive = isWorkflowActive(report);
                const jobFailed =
                  (report as any).workflow_stage === "error" ||
                  report.status === "error" ||
                  (report as any).job_status === "error";
                const canRetryFailedJob =
                  jobFailed &&
                  (report.reportType === "asset" ||
                    report.reportType === "lotListing") &&
                  hasSavedReportPreview(report);
                const badgeStatus = workflowBadgeStatus(report);
                const badgeLabel =
                  WORKFLOW_LABELS[(report as any).workflow_stage] ||
                  String(badgeStatus).replace(/_/g, " ");
                const progress = Math.max(
                  2,
                  Number(
                    (report as any).workflow_progress_percent ??
                      (report as any).generation_progress?.progressPercent ??
                      0
                  )
                );
                const hasPersistentPreviewAction =
                  (report.reportType === "asset" ||
                    report.reportType === "lotListing") &&
                  hasOpenablePreview(report);
                const previewIsSubmitted =
                  activeTab === "submitted" || isSubmittedPreview(report);
                const previewAccessibleName = `Preview ${info.typeLabel} report: ${info.title}`;

                return (
                  <li
                    key={report._id}
                    className={styles.reportRow}
                  >
                    <div className={styles.rowMain}>
                      <div className={styles.reportIdentity}>
                        <span className={styles.thumbnail}>
                          <ReportThumbnail
                            src={previewThumbnailForReport(report)}
                            title={info.title}
                            size="table"
                          />
                        </span>
                        <div className={styles.identityCopy}>
                          <div className={styles.metaLine}>
                            <span className={styles.typeLabel}>
                              {info.typeLabel}
                            </span>
                            <span
                              className={`${styles.badge} ${
                                badgeStatus === "error" ||
                                badgeStatus === "declined"
                                  ? styles.badgeDanger
                                  : badgeStatus === "approved"
                                    ? styles.badgeSuccess
                                    : badgeStatus === "pending_approval"
                                      ? styles.badgeWarning
                                      : styles.badgeInfo
                              }`}
                            >
                              {badgeLabel}
                            </span>
                            {report.reportType === "asset" &&
                            (report as any).is_merged_report ? (
                              <span
                                className={`${styles.badge} ${styles.badgeNeutral}`}
                              >
                                Merged ·{" "}
                                {(report as any).merged_source_count ?? (Array.isArray(
                                  (report as any).merged_from_report_ids
                                )
                                  ? (report as any).merged_from_report_ids.length
                                  : 2)}{" "}
                                sources
                              </span>
                            ) : null}
                            {(report as any).preview_transferred_at ? (
                              <span
                                className={`${styles.badge} ${styles.badgeWarning}`}
                              >
                                Assigned by admin
                              </span>
                            ) : null}
                          </div>
                          <h3 className={styles.reportTitle}>{info.title}</h3>
                          <p className={styles.createdAt}>
                            Created{" "}
                            <time dateTime={report.createdAt}>
                              {PREVIEW_DATE_FORMATTER.format(
                                new Date(report.createdAt)
                              )}
                            </time>
                          </p>
                        </div>
                      </div>

                      <div className={styles.actions}>
                        {hasPersistentPreviewAction ? (
                          <button
                            type="button"
                            aria-label={previewAccessibleName}
                            className={`${styles.action} ${styles.actionPrimary}`}
                            onClick={() =>
                              handleOpenPreview(report, previewIsSubmitted)
                            }
                          >
                            <FileSearch className="size-3.5" />
                            Preview
                          </button>
                        ) : null}

                        {report.reportType === "realEstate" &&
                        report.status === "preview" &&
                        !jobActive ? (
                          <button
                            type="button"
                            className={`${styles.action} ${styles.actionPrimary}`}
                            onClick={() => handleOpenPreview(report)}
                          >
                            <FileSearch className="size-3.5" />
                            Review & submit
                          </button>
                        ) : null}

                        {report.reportType === "realEstate" &&
                        report.status === "declined" ? (
                          <button
                            type="button"
                            className={`${styles.action} ${styles.actionPrimary}`}
                            onClick={() => handleOpenPreview(report)}
                          >
                            <Pencil className="size-3.5" />
                            Edit & resubmit
                          </button>
                        ) : null}

                        {report.reportType !== "salvage" && (report.status === "pending_approval" ||
                          report.status === "approved" ||
                          jobActive) &&
                        !jobActive ? (
                          <>
                            {report.reportType === "realEstate" ? (
                              <button
                                type="button"
                                className={`${styles.action} ${styles.actionSecondary}`}
                                onClick={() => handleOpenPreview(report, true)}
                              >
                                <Pencil className="size-3.5" />
                                Edit
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`${styles.action} ${styles.actionSecondary}`}
                              onClick={() => void handleQuickResubmit(report)}
                              disabled={resubmitting === report._id}
                            >
                              <RefreshCw
                                className={`size-3.5 ${
                                  resubmitting === report._id
                                    ? "animate-spin"
                                    : ""
                                }`}
                              />
                              {resubmitting === report._id
                                ? "Resubmitting..."
                                : "Quick resubmit"}
                            </button>
                          </>
                        ) : null}

                        {jobActive ? (
                          <span
                            className={`${styles.action} ${styles.actionStatus}`}
                            role="status"
                          >
                            <RefreshCw className="size-3.5 animate-spin" />
                            {WORKFLOW_LABELS[
                              (report as any).workflow_stage
                            ] ||
                              (activeTab === "new"
                                ? "Preparing preview"
                                : "Generating files")}
                          </span>
                        ) : null}

                        {canRetryFailedJob ? (
                          <button
                            type="button"
                            className={`${styles.action} ${styles.actionSecondary}`}
                            onClick={() => void handleQuickResubmit(report)}
                            disabled={resubmitting === report._id}
                          >
                            <RefreshCw className="size-3.5" />
                            {resubmitting === report._id
                              ? "Retrying..."
                              : "Retry generation"}
                          </button>
                        ) : null}

                        {report.reportType === "asset" && !jobActive ? (
                          <button
                            type="button"
                            className={`${styles.action} ${styles.actionSecondary}`}
                            onClick={() => setMergeAnchorId(report._id)}
                          >
                            <Merge className="size-3.5" />
                            Merge assets
                          </button>
                        ) : null}

                        {report.reportType === "salvage" ? <button
                          type="button"
                          className={`${styles.action} ${styles.actionPrimary}`}
                          onClick={() => handleOpenPreview(report)}
                        ><FileSearch className="size-3.5" /> {jobActive || report.status === "cancelled" ? "View progress" : jobFailed ? "Review & retry" : "Review report"}</button> : <button
                          type="button"
                          className={`${styles.action} ${styles.actionDanger}`}
                          onClick={() => setDeleteTarget(report)}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </button>}
                      </div>
                    </div>

                    <dl className={styles.details}>
                      {info.fields.map(([label, value]) => (
                        <div key={label} className={styles.detail}>
                          <dt className={styles.detailLabel}>{label}</dt>
                          <dd className={styles.detailValue}>{value}</dd>
                        </div>
                      ))}
                    </dl>

                    {report.status === "declined" &&
                    report.decline_reason ? (
                      <div
                        role="alert"
                        className={`${styles.rowContinuation} ${styles.notice} ${styles.noticeDanger}`}
                      >
                        {report.decline_reason}
                      </div>
                    ) : null}
                    {(report as any).workflow_stage ===
                    "awaiting_approval" ? (
                      <div
                        className={`${styles.rowContinuation} ${styles.notice} ${styles.noticeWarning}`}
                      >
                        Files are ready and awaiting the assigned report
                        approver.
                      </div>
                    ) : null}
                    {(report as any).workflow_stage === "awaiting_release" ? (
                      <div
                        className={`${styles.rowContinuation} ${styles.notice} ${styles.noticeWarning}`}
                      >
                        Approved and awaiting the assigned release manager.
                      </div>
                    ) : null}

                    {jobActive ? (
                      <div
                        className={`${styles.rowContinuation} ${styles.progressPanel}`}
                      >
                        <div className={styles.progressHeader}>
                          <span>
                            {(report as any).workflow_message ||
                              (report as any).generation_progress?.message ||
                              (activeTab === "new"
                                ? "Preparing preview"
                                : "Generating files")}
                          </span>
                          <span>{Math.round(progress)}%</span>
                        </div>
                        <div
                          className={styles.progressTrack}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(progress)}
                        >
                          <span
                            className={styles.progressValue}
                            style={{ width: `${Math.min(100, progress)}%` }}
                          />
                        </div>
                        {(report as any).generation_progress?.totalLots ? (
                          <p className={styles.progressMeta}>
                            Lot{" "}
                            {(report as any).generation_progress.currentLot ||
                              0}{" "}
                            of{" "}
                            {(report as any).generation_progress.totalLots}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {jobFailed ? (
                      <div
                        role="alert"
                        className={`${styles.rowContinuation} ${styles.notice} ${styles.noticeDanger}`}
                      >
                        {(report as any).job_error ||
                          (report as any).error_message ||
                          "This report failed to process. Please try again or contact an admin."}
                        {hasPersistentPreviewAction ? (
                          <p className="mt-2">Your saved preview is available. Open Preview, review all lots and photos, then save and resubmit to generate files.</p>
                        ) : (
                          <p className="mt-2">No saved preview is available. <a href="/drafts" className="underline">Open saved drafts</a> to recover the source upload.</p>
                        )}
                      </div>
                    ) : null}

                    {!jobActive &&
                    ((report as any).preview_files?.spec_pdf ||
                      (report as any).preview_files?.cr_docx ||
                      (report as any).preview_files?.docx) ? (
                      <div
                        className={`${styles.rowContinuation} ${styles.downloads}`}
                      >
                        {[
                          [
                            "CR",
                            (report as any).preview_files?.spec_pdf,
                          ],
                          [
                            "CR DOCX",
                            (report as any).preview_files?.cr_docx,
                          ],
                          [
                            "Download DOCX",
                            (report as any).preview_files?.docx,
                          ],
                        ].map(([label, href]) =>
                          href ? (
                            <a
                              key={label}
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`${styles.action} ${styles.actionSecondary} ${styles.downloadAction}`}
                            >
                              <Download className="size-3.5" />
                              {label}
                            </a>
                          ) : null
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <dialog
        ref={deleteDialogRef}
        aria-labelledby="delete-preview-title"
        className={styles.dialog}
        onCancel={(event) => {
          if (deleting) event.preventDefault();
          else setDeleteTarget(null);
        }}
        onClose={() => {
          if (deleteTarget && !deleting) setDeleteTarget(null);
        }}
      >
        <div className={styles.dialogBody}>
          <h2 id="delete-preview-title" className={styles.dialogTitle}>
            Delete preview?
          </h2>
          <p className={styles.dialogDescription}>
            This permanently removes the selected preview and its associated
            data.
          </p>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={`${styles.action} ${styles.actionSecondary}`}
              onClick={() => setDeleteTarget(null)}
              disabled={Boolean(deleting)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.action} ${styles.deleteConfirm}`}
              onClick={() => void handleDeleteReport()}
              disabled={deleting === deleteTarget?._id}
            >
              {deleting === deleteTarget?._id ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </dialog>

      {selectedReportId && previewModalOpen ? (
        <PreviewModal
          reportId={selectedReportId}
          isOpen={previewModalOpen}
          onClose={handleModalClose}
          onSuccess={handleSuccess}
          isResubmitMode={isResubmitMode}
          draftPreviewId={selectedDraftPreviewId || undefined}
        />
      ) : null}
      {selectedReportId && realEstateModalOpen ? (
        <RealEstatePreviewModal
          reportId={selectedReportId}
          isOpen={realEstateModalOpen}
          onClose={handleModalClose}
          onSuccess={handleSuccess}
          isResubmitMode={isResubmitMode}
        />
      ) : null}
      {selectedReportId && lotListingModalOpen ? (
        <LotListingPreviewModal
          reportId={selectedReportId}
          isOpen={lotListingModalOpen}
          onClose={handleModalClose}
          onSuccess={handleSuccess}
          isResubmitMode={isResubmitMode}
          draftPreviewId={selectedDraftPreviewId || undefined}
        />
      ) : null}
      {mergeAnchorId ? (
        <AssetMergeDialog
          open
          anchorReportId={mergeAnchorId}
          onClose={() => setMergeAnchorId(null)}
          onCreated={() => {
            setMergeAnchorId(null);
            setActiveTab("new");
            requestReportsRefetch();
            void loadReports();
          }}
        />
      ) : null}
    </main>
  );
}
