"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  Boxes,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Eye,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Merge,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useAuthContext } from "@/context/AuthContext";
import { ReportsService, type PdfReport } from "@/services/reports";
import { deleteAssetReport, getAssetReports, resubmitReport, type AssetReport } from "@/services/assets";
import { deleteLotListing, getLotListings, resubmitLotListing, type LotListing } from "@/services/lotListing";
import {
  RealEstateService,
  type RealEstateReport,
} from "@/services/realEstate";
import AuctioneerService, {
  type AuctioneerDeliverySummary,
} from "@/services/auctioneer";
import { ReportThumbnail } from "@/components/reports/ReportThumbnail";
import { SERVER_BASE } from "@/lib/config";
import { SalvageService, salvagePreviewPath, salvageStatusPath, salvageIsProcessing, type SalvageReport } from "@/services/salvage";
import { salvageSystemText } from "@/lib/salvagePresentation";
import { captureAuthSession, isAuthSessionCurrent, type AuthSessionSnapshot } from "@/lib/auth-storage";

const AssetMergeDialog = dynamic(
  () => import("@/components/reports/AssetMergeDialog"),
  { ssr: false }
);
const AuctioneerDeliveryDialog = dynamic(
  () => import("@/components/reports/AuctioneerDeliveryDialog"),
  { ssr: false }
);

type ReportGroup = {
  key: string;
  address: string;
  filename?: string;
  fairMarketValue: string;
  createdAt: string;
  contract_no?: string;
  approvalStatus?: "pending" | "approved" | "rejected";
  release_status?: "pending_release" | "released";
  released_at?: string | null;
  downloadable?: boolean;
  isGeneratingFiles?: boolean;
  generationState?: "queued" | "processing" | "ready" | "error" | "cancelled";
  workflowStage?: string;
  workflowMessage?: string;
  workflowProgressPercent?: number;
  generationProgress?: {
    progressPercent?: number;
    message?: string;
    currentLot?: number;
    totalLots?: number;
  };
  jobError?: string;
  reportStatus?: string;
  salvageCanonical?: boolean;
  lotSummary?: string;
  lotCount?: number;
  thumbnail?: string;
  displayTitle?: string;
  type?: string;
  isMergedReport?: boolean;
  mergedSourceCount?: number;
  auctioneerDelivery?: AuctioneerDeliverySummary;
  variants: {
    pdf?: PdfReport;
    specPdf?: PdfReport;
    crDocx?: PdfReport;
    docx?: PdfReport;
    xlsx?: PdfReport;
    images?: PdfReport;
  };
};

const FILE_VARIANTS = [
  "pdf",
  "specPdf",
  "crDocx",
  "docx",
  "xlsx",
  "images",
] as const;

/*
   Action buttons are as wide as their label (owner, 2026-10-31: "Improve the UI
   here too ... use dead space"). They used to stretch to fill the row, so four
   actions wrapped onto two uneven lines and made every row twice as tall.
*/
const REPORT_ACTION_CLASS_NAME =
  "inline-flex min-h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-45";

function auctioneerDeliveryPresentation(
  delivery?: AuctioneerDeliverySummary
): { label: string; color: string; bg: string } | null {
  if (!delivery) return null;
  const values: Record<string, { label: string; color: string; bg: string }> = {
    not_ready: {
      label: "Auctioneer: not ready",
      color: "var(--app-text-muted)",
      bg: "var(--app-panel-alt)",
    },
    ready: {
      label: "Ready to Send",
      color: "var(--app-info)",
      bg: "var(--app-info-soft)",
    },
    queued: {
      label: "Sending",
      color: "var(--app-info)",
      bg: "var(--app-info-soft)",
    },
    sending: {
      label: "Sending",
      color: "var(--app-info)",
      bg: "var(--app-info-soft)",
    },
    failed: {
      label: "Failed — Retry",
      color: "var(--app-danger)",
      bg: "var(--app-danger-soft)",
    },
    needs_reconciliation: {
      label: "Needs Reconciliation",
      color: "var(--app-warning)",
      bg: "var(--app-warning-soft)",
    },
    sent: {
      // Say where the contract stands once a close has been confirmed: the
      // user's own part, or (when Auctioneer reported it) the whole contract.
      label: delivery.contractClosedAt
        ? delivery.contractTaskCompleted ||
          delivery.contractCompletionScope === "contract"
          ? "Sent · contract complete"
          : delivery.contractCloseUserStatus === "revoked"
            ? "Sent · assignment removed"
          : "Sent · your part closed"
        : "Sent",
      color: "var(--app-success)",
      bg: "var(--app-success-soft)",
    },
  };
  return values[delivery.state] || values.not_ready;
}

/*
   "Close my part of this contract" is offered on a delivery that has reached
   Auctioneer, for work assigned to this user, until their part is closed.

   It lives here because this is where delivered Auctioneer work stays in view:
   Incoming drops a contract's rows once they are sent, so a person whose lots
   have all gone back — or whose remaining lots someone else covered — has
   nothing left to send and no other place to say they are done.
*/
function canCloseContractPart(delivery?: AuctioneerDeliverySummary) {
  return Boolean(
    delivery &&
      // A Proposal list ends itself once every listed item is back (owner
      // 2026-10-28); the server refuses a close and reports this as false.
      delivery.canCompleteContract !== false &&
      delivery.contractCompletionScope === "user" &&
      delivery.state === "sent" &&
      delivery.contractId &&
      !delivery.contractClosedAt
  );
}
function typeLabel(type?: string) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "realestate" || normalized.includes("real")) {
    return "Real Estate";
  }
  if (normalized === "lotlisting" || normalized.includes("lot")) {
    return "Lot Listing";
  }
  if (normalized.includes("salvage")) {
    return "Salvage";
  }
  return "Asset";
}

function isFileGenerationActive(report: any) {
  if (["preparing_preview", "generating_files"].includes(report?.workflow_stage)) return true;
  if (["preview_ready", "awaiting_approval", "awaiting_release", "ready", "error", "stopped"].includes(report?.workflow_stage)) return false;
  if (report?.generation_state === "error") return false;
  if (report?.generation_state === "queued" || report?.generation_state === "processing") {
    return true;
  }
  return (
    Boolean(report?.files_generating) ||
    Boolean(report?.files_regenerating) ||
    report?.status === "processing" ||
    report?.job_status === "queued" ||
    report?.job_status === "processing"
  );
}

function summarizeLotNumbers(lots: any[], fallbackId: string) {
  const numbers = (Array.isArray(lots) ? lots : [])
    .map((lot) => String(lot?.lot_number ?? "").trim())
    .filter(Boolean);
  if (numbers.length > 0) {
    const first = numbers.slice(0, 3).map((value) => `Lot ${value}`).join(", ");
    return numbers.length > 3 ? `${first} +${numbers.length - 3}` : first;
  }
  return `#${String(fallbackId).slice(-6)}`;
}

function reportDisplayTitle(
  lots: any[],
  fallback: string,
  report?: any
): string {
  const firstLot = Array.isArray(lots) ? lots[0] : undefined;
  const firstItem = Array.isArray(firstLot?.items) ? firstLot.items[0] : undefined;
  const candidates = [
    report?.title,
    report?.report_title,
    report?.preview_data?.title,
    firstLot?.title,
    firstLot?.asset_name,
    firstItem?.title,
    firstItem?.asset_name,
    fallback,
  ];
  const value = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );
  return value ? value.trim() : "Untitled report";
}

function reportTypeColumnLabel(type?: string) {
  const label = typeLabel(type);
  return label === "Asset" ? "Asset Report" : label;
}

function statusTone(
  status?: string,
  isGeneratingFiles = false,
  releaseStatus?: string,
  generationState?: string,
  reportStatus?: string,
  workflowStage?: string
) {
  const workflowLabels: Record<string, { bg: string; color: string; label: string }> = {
    preparing_preview: { bg: "var(--app-info-soft)", color: "var(--app-info)", label: "Generating" },
    preview_ready: { bg: "var(--app-warning-soft)", color: "var(--app-warning)", label: "In review" },
    generating_files: { bg: "var(--app-info-soft)", color: "var(--app-info)", label: "Generating" },
    awaiting_approval: { bg: "var(--app-warning-soft)", color: "var(--app-warning)", label: "In review" },
    awaiting_release: { bg: "var(--app-warning-soft)", color: "var(--app-warning)", label: "In review" },
    ready: { bg: "var(--app-success-soft)", color: "var(--app-success)", label: "Ready" },
    error: { bg: "var(--app-danger-soft)", color: "var(--app-danger)", label: "Failed" },
    stopped: { bg: "var(--app-warning-soft)", color: "var(--app-warning)", label: "Stopped" },
  };
  if (workflowStage && workflowLabels[workflowStage]) return workflowLabels[workflowStage];
  if (generationState === "error" || reportStatus === "error") {
    return { bg: "var(--app-danger-soft)", color: "var(--app-danger)", label: "Failed" };
  }
  if (reportStatus === "processing") {
    return { bg: "var(--app-info-soft)", color: "var(--app-info)", label: "Generating" };
  }
  if (reportStatus === "preview" && isGeneratingFiles) {
    return { bg: "var(--app-info-soft)", color: "var(--app-info)", label: "Generating" };
  }
  if (reportStatus === "preview") {
    return { bg: "var(--app-warning-soft)", color: "var(--app-warning)", label: "In review" };
  }
  if (reportStatus === "declined") {
    return { bg: "var(--app-danger-soft)", color: "var(--app-danger)", label: "Changes required" };
  }
  if (isGeneratingFiles) {
    return {
      bg: "var(--app-info-soft)",
      color: "var(--app-info)",
      label: "Generating",
    };
  }
  if (status === "approved" && releaseStatus === "pending_release") {
    return {
      bg: "var(--app-warning-soft)",
      color: "var(--app-warning)",
      label: "In review",
    };
  }
  if (status === "approved" && releaseStatus === "released") {
    return { bg: "var(--app-success-soft)", color: "var(--app-success)", label: "Ready" };
  }
  if (status === "approved") {
    return { bg: "var(--app-success-soft)", color: "var(--app-success)", label: "Ready" };
  }
  if (status === "rejected") {
    return { bg: "var(--app-danger-soft)", color: "var(--app-danger)", label: "Rejected" };
  }
  return {
    bg: "var(--app-warning-soft)",
    color: "var(--app-warning)",
    label: "In review",
  };
}

function actionLabel(
  variant: "pdf" | "specPdf" | "crDocx" | "docx" | "xlsx" | "images",
  reportType?: string
) {
  const normalizedType = String(reportType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");

  if (variant === "pdf") {
    return normalizedType === "asset" || normalizedType === "lotlisting"
      ? "Schedule A"
      : "PDF";
  }
  if (variant === "specPdf") return "CR PDF";
  if (variant === "crDocx") return "CR DOCX";
  if (variant === "docx") {
    return normalizedType === "asset" || normalizedType === "realestate"
      ? "Appraisal report"
      : "DOCX";
  }
  if (variant === "xlsx") return "XLSX";
  return "ZIP";
}

function hasReportFileUrls(report: any) {
  const keys = [
    "schedule_a_pdf",
    "pdf",
    "spec_pdf",
    "cr_docx",
    "docx",
    "excel",
    "xlsx",
    "images",
    "zip",
  ];
  const sources = [report?.preview_files, report?.files];
  return sources.some((source) => {
    if (!source || typeof source !== "object") return false;
    return keys.some((key) => {
      const value = source[key];
      return typeof value === "string" && value.trim().length > 0;
    });
  });
}

function reportFileUrl(value: unknown): string | undefined {
  const url = String(value || "").trim();
  if (!url) return undefined;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  if (url.startsWith("/")) return `${SERVER_BASE}${url}`;
  return `${SERVER_BASE}/${url}`;
}

function isFileGenerationBlocking(report: any) {
  return isFileGenerationActive(report) && !hasReportFileUrls(report);
}

function hasGroupDownloadVariants(group: ReportGroup) {
  return Object.values(group.variants).some((variant) => {
    if (!variant) return false;
    const url = (variant as any).url;
    if (typeof url === "string" && url.trim()) {
      return !url.startsWith("/api/reports/");
    }
    return !variant.crReportId;
  });
}

/*
   Each download's icon is coloured by the kind of file, so a row's files read
   at a glance on the plain chips (owner, 2026-10-31: "make these nicer"):
   PDF red, Word blue, Excel green, ZIP amber.
*/
function fileActionIcon(
  variant: "pdf" | "specPdf" | "crDocx" | "docx" | "xlsx" | "images"
) {
  if (variant === "xlsx") {
    return <FileSpreadsheet aria-hidden className="size-3.5 shrink-0 text-[var(--app-success)]" />;
  }
  if (variant === "images") {
    return <FileArchive aria-hidden className="size-3.5 shrink-0 text-[var(--app-warning)]" />;
  }
  if (variant === "specPdf") {
    return <FileImage aria-hidden className="size-3.5 shrink-0 text-[var(--app-danger)]" />;
  }
  if (variant === "pdf") {
    return <FileText aria-hidden className="size-3.5 shrink-0 text-[var(--app-danger)]" />;
  }
  return <FileText aria-hidden className="size-3.5 shrink-0 text-[var(--app-info)]" />;
}

function imageUrlsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getFirstReportImage(lots: any[], report: any): string | undefined {
  const explicitThumbnail = [
    report?.thumbnail_url,
    report?.thumbnailUrl,
    report?.preview_data?.thumbnail_url,
    report?.preview_data?.thumbnailUrl,
  ].find((value) => typeof value === "string" && value.trim());
  if (explicitThumbnail) return explicitThumbnail.trim();

  const globalImages = [
    ...imageUrlsFrom(report?.preview_data?.image_urls),
    ...imageUrlsFrom(report?.preview_data?.imageUrls),
    ...imageUrlsFrom(report?.preview_data?.extra_image_urls),
    ...imageUrlsFrom(report?.preview_data?.extraImageUrls),
    ...imageUrlsFrom(report?.image_urls),
    ...imageUrlsFrom(report?.imageUrls),
    ...imageUrlsFrom(report?.extra_image_urls),
    ...imageUrlsFrom(report?.extraImageUrls),
  ];

  for (const lot of Array.isArray(lots) ? lots : []) {
    const lotImages = [
      ...imageUrlsFrom(lot?.image_urls),
      ...imageUrlsFrom(lot?.extra_image_urls),
    ];
    const coverIndex = Number(lot?.cover_index ?? lot?.coverIndex);
    if (
      Number.isInteger(coverIndex) &&
      coverIndex >= 0 &&
      lotImages[coverIndex]
    ) {
      return lotImages[coverIndex];
    }

    const direct = [
      lot?.image_url,
      ...lotImages,
    ].find((value) => typeof value === "string" && value.trim());
    if (direct) return direct.trim();

    const firstIndex = [
      ...(Array.isArray(lot?.image_indexes) ? lot.image_indexes : []),
      ...(Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []),
    ].find((value) => Number.isInteger(Number(value)));
    if (firstIndex !== undefined && globalImages[Number(firstIndex)]) {
      return globalImages[Number(firstIndex)];
    }
  }

  return globalImages[0];
}

function GeneratingFilesProgress({
  progress,
  fallbackMessage = "Generating updated files...",
}: {
  progress?: ReportGroup["generationProgress"];
  fallbackMessage?: string;
}) {
  const percent = Math.max(2, Math.min(100, Number(progress?.progressPercent || 0)));
  return (
    <div className="min-w-44 space-y-1.5">
      <p className="text-xs font-semibold text-[var(--app-accent)]">
        {progress?.message || fallbackMessage}
      </p>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--app-panel-alt)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span
          className="block h-full rounded-full bg-[var(--app-accent)] transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      {progress?.totalLots ? (
        <p className="text-xs text-[var(--app-text-muted)]">
          Lot {progress.currentLot || 0} of {progress.totalLots} ·{" "}
          {Math.round(percent)}%
        </p>
      ) : null}
    </div>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const { user } = useAuthContext();
  const [reports, setReports] = useState<PdfReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<
    "date-desc" | "date-asc" | "value-desc" | "value-asc"
  >("date-desc");
  const [typeFilter, setTypeFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  /*
     Delivered work leaves the working list. A report that reached Auctioneer
     needs nothing further, and leaving it here means the rows that DO need a
     Send or a Retry are scattered among rows that are simply done.
  */
  const [queueTab, setQueueTab] = useState<"outstanding" | "completed">("outstanding");
  /*
     Open report on Incoming links here with ?search=<contract number>. That
     parameter already existed and is already read below, seeding the search
     box — and the list already searches contract_no, so the narrowing needs no
     new code at all. Only the TAB has to be chosen, which is what this ref is
     for.
  */
  const deepLinkTabResolved = useRef(false);

  const [assetReports, setAssetReports] = useState<AssetReport[]>([]);
  const [realEstateReports, setRealEstateReports] = useState<RealEstateReport[]>([]);
  const [lotListingReports, setLotListingReports] = useState<LotListing[]>([]);
  const [salvageReports, setSalvageReports] = useState<SalvageReport[]>([]);
  const [auctioneerDeliveries, setAuctioneerDeliveries] = useState<
    AuctioneerDeliverySummary[]
  >([]);
  const [mergeAnchorId, setMergeAnchorId] = useState<string | null>(null);
  const [deliveryDialogItem, setDeliveryDialogItem] =
    useState<AuctioneerDeliverySummary | null>(null);
  const [closingContractId, setClosingContractId] = useState<string | null>(null);
  const closeFlightRef = useRef<symbol | null>(null);
  const deliveryRevisionRef = useRef(0);
  const deliverySessionRef = useRef<AuthSessionSnapshot | null>(null);
  const closeMountedRef = useRef(true);
  const currentOwnerRef = useRef(user?._id);
  currentOwnerRef.current = user?._id;
  useEffect(() => {
    closeMountedRef.current = true;
    return () => { closeMountedRef.current = false; };
  }, []);
  const loadingReportsRef = useRef(false);
  const retryingKeysRef = useRef(new Set<string>());
  const [retryingKeys, setRetryingKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const globalSearchQuery =
      new URLSearchParams(window.location.search).get("search")?.trim() || "";
    setQuery(globalSearchQuery);
  }, []);

  const hasActiveJobs = useMemo(
    () =>
      [...assetReports, ...realEstateReports, ...lotListingReports, ...salvageReports].some(
        isFileGenerationActive
      ) ||
      auctioneerDeliveries.some((delivery) =>
        ["queued", "sending"].includes(delivery.state)
      ),
    [assetReports, auctioneerDeliveries, realEstateReports, lotListingReports, salvageReports]
  );

  const loadReports = useCallback(async (
    options: { showLoading?: boolean; silent?: boolean; successToast?: boolean } = {}
  ) => {
    if (loadingReportsRef.current) return false;
    loadingReportsRef.current = true;
    const deliveryRevision = deliveryRevisionRef.current;
    const deliverySession = captureAuthSession();
    const deliveryOwner = currentOwnerRef.current;
    const showFullLoading = options.showLoading === true;
    try {
      if (showFullLoading) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      const [
        legacy,
        assetResponse,
        realEstateResponse,
        lotListingResponse,
        deliveryResponse,
        salvageResponse,
      ] =
        await Promise.all([
          ReportsService.getMyReports(),
          getAssetReports().catch(() => ({ data: [] })),
          RealEstateService.getReports().catch(() => ({ data: [] })),
          getLotListings().catch(() => ({ data: [] })),
          AuctioneerService.getDeliveries().catch(() => []),
          SalvageService.getReports().catch(() => ({ data: [] })),
        ]);

      setReports(legacy);
      setAssetReports(
        assetResponse.data.filter(
          (report) =>
            report.status === "approved" ||
            report.status === "pending_approval" ||
            report.status === "preview" ||
            report.status === "declined" ||
            (report as any).workflow_stage === "preview_ready" ||
            (report as any).status === "error" ||
            (report as any).generation_state === "error" ||
            isFileGenerationActive(report)
        )
      );
      setRealEstateReports(
        realEstateResponse.data.filter(
          (report) =>
            report.status === "approved" ||
            report.status === "pending_approval" ||
            (report as any).status === "error" ||
            (report as any).generation_state === "error" ||
            isFileGenerationActive(report)
        )
      );
      setLotListingReports(
        lotListingResponse.data.filter(
          (report) =>
            report.status === "approved" ||
            report.status === "pending_approval" ||
            report.status === "preview" ||
            report.status === "declined" ||
            (report as any).workflow_stage === "preview_ready" ||
            report.status === "error" ||
            (report as any).generation_state === "error" ||
            isFileGenerationActive(report)
          )
      );
      if (!closeFlightRef.current && deliveryRevision === deliveryRevisionRef.current &&
        deliveryOwner === currentOwnerRef.current && isAuthSessionCurrent(deliverySession)) {
        deliverySessionRef.current = deliverySession;
        setAuctioneerDeliveries(deliveryResponse);
      }
      setSalvageReports(salvageResponse?.data || []);
      setError(null);
      if (options.successToast) {
        toast.success("Reports refreshed.");
      }
      return true;
    } catch (loadError: any) {
      if (!options.silent) {
        setError(
          loadError?.response?.data?.message ||
            loadError?.message ||
            "Failed to load reports"
        );
      }
      return false;
    } finally {
      if (showFullLoading) setLoading(false);
      setRefreshing(false);
      loadingReportsRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadReports({ showLoading: true });

    const handler = () => void loadReports({ silent: true });
    const visibilityHandler = () => {
      if (!document.hidden) void loadReports({ silent: true });
    };
    window.addEventListener("cv:report-created", handler as any);
    window.addEventListener("focus", handler);
    window.addEventListener("pageshow", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      window.removeEventListener("cv:report-created", handler as any);
      window.removeEventListener("focus", handler);
      window.removeEventListener("pageshow", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [loadReports]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      void loadReports({ silent: true });
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveJobs, loadReports]);

  const handleManualRefresh = async () => {
    await loadReports({ successToast: true });
  };

  async function handleCloseContractPart(delivery: AuctioneerDeliverySummary) {
    const contractId = delivery.contractId;
    const ownerId = user?._id;
    if (!contractId || !ownerId || closeFlightRef.current || !canCloseContractPart(delivery)) return;
    if (!deliverySessionRef.current || !isAuthSessionCurrent(deliverySessionRef.current)) {
      toast.error("Your account session changed. Refresh Reports before closing your part of a contract.");
      return;
    }
    const session = captureAuthSession();
    const isCurrent = () => closeMountedRef.current && currentOwnerRef.current === ownerId && isAuthSessionCurrent(session);
    const label = delivery.contractNo
      ? `contract ${delivery.contractNo}`
      : "this contract";
    if (
      !confirm(
        `Close your part of ${label}? Do this when you have nothing left to send. The contract closes in Auctioneer once every person assigned to it has closed theirs.`
      )
    ) {
      return;
    }
    if (!isCurrent()) return;
    const flight = Symbol("close-contract-part");
    closeFlightRef.current = flight;
    deliveryRevisionRef.current += 1;
    try {
      setClosingContractId(contractId);
      const result = await AuctioneerService.closeContractPart(contractId, delivery.accessRevision);
      if (!isCurrent()) return;
      // The server records the close on every one of this user's assigned
      // deliveries for the contract, so every such row changes, not just this
      // one. Older whole-contract rows are not parts and keep their own state.
      setAuctioneerDeliveries((current) =>
        current.map((item) =>
          item.contractId === contractId &&
          item.accessRevision === delivery.accessRevision &&
          item.contractCompletionScope === "user"
            ? {
                ...item,
                contractClosedAt: result.closedAt,
                contractTaskCompleted: result.taskCompleted,
                contractCloseUserStatus: result.userStatus === "revoked" ? "revoked" : result.userStatus === "completed" ? "completed" : undefined,
              }
            : item
        )
      );
      if (result.userStatus === "revoked" && !result.taskCompleted) {
        toast.info(
          `Auctioneer shows you are no longer assigned to ${label}, so there was nothing of yours to close.`
        );
      } else if (result.taskCompleted) {
        toast.success(
          `Your part is closed and ${label} is now complete in Auctioneer.`
        );
      } else {
        toast.success(
          `Your part of ${label} is closed. It completes when every assigned person has closed theirs.`
        );
      }
    } catch (closeError: any) {
      if (!isCurrent()) return;
      if (closeError?.response?.data?.code === "auctioneer_contract_capture_changed") {
        toast.error("This contract's access changed after it was re-opened. Refresh Reports, then close your current part when all new deliveries are finished.");
        return;
      }
      const serverMessage = closeError?.response?.data?.message;
      toast.error(typeof serverMessage === "string" && serverMessage.trim()
        ? serverMessage.trim()
        : closeError instanceof Error && !closeError.name.includes("Axios") && !/network|status code|timeout/i.test(closeError.message)
          ? closeError.message
          : "Your contract completion could not be confirmed. Refresh Reports to check its status before trying again.");
    } finally {
      if (closeFlightRef.current === flight) {
        closeFlightRef.current = null;
        deliveryRevisionRef.current += 1;
        if (closeMountedRef.current) setClosingContractId(null);
      }
    }
  }

  async function handleDelete(group: ReportGroup) {
    if (deletingKey) return;
    const label = group.contract_no || group.address || typeLabel(group.type);
    if (!confirm(`Delete ${label}? This action cannot be undone.`)) return;

    try {
      setDeletingKey(group.key);
      const normalized = String(group.type || "").toLowerCase();

      if (normalized === "asset") {
        await deleteAssetReport(group.key);
      } else if (normalized === "realestate" || normalized.includes("real")) {
        await RealEstateService.deleteReport(group.key);
      } else if (normalized === "lotlisting" || normalized.includes("lot")) {
        await deleteLotListing(group.key);
      } else {
        await ReportsService.deleteReport(group.key);
      }

      toast.success("Report deleted");
      await loadReports();
    } catch (deleteError: any) {
      toast.error(
        deleteError?.response?.data?.message ||
          deleteError?.message ||
          "Failed to delete report"
      );
    } finally {
      setDeletingKey(null);
    }
  }

  async function handleRetry(group: ReportGroup) {
    if (group.salvageCanonical) {
      router.push(salvageStatusPath(group.key));
      return;
    }
    if (retryingKeysRef.current.has(group.key)) return;
    retryingKeysRef.current.add(group.key);
    setRetryingKeys(new Set(retryingKeysRef.current));
    try {
      const type = String(group.type || "").toLowerCase();
      if (type === "asset") await resubmitReport(group.key);
      else if (type.includes("lot")) await resubmitLotListing(group.key);
      else throw new Error("Open the report preview to retry this report type.");
      toast.success("Report processing queued again.");
      await loadReports();
    } catch (retryError: any) {
      toast.error(retryError?.response?.data?.message || retryError?.message || "Retry failed");
    } finally {
      retryingKeysRef.current.delete(group.key);
      setRetryingKeys(new Set(retryingKeysRef.current));
    }
  }

  const groups = useMemo<ReportGroup[]>(() => {
    const map = new Map<string, ReportGroup>();
    const assetReportIds = new Set(assetReports.map((report) => report._id));
    const realEstateReportIds = new Set(
      realEstateReports.map((report) => report._id)
    );
    const lotListingReportIds = new Set(
      lotListingReports.map((report) => report._id)
    );
    const salvageReportIds = new Set(salvageReports.map((report) => report._id));

    const getReportRefId = (report: any): string | undefined => {
      const raw = report?.report;
      if (!raw) return undefined;
      if (typeof raw === "string") return raw;
      if (typeof raw === "object" && raw?._id) return String(raw._id);
      return String(raw);
    };

    for (const report of reports) {
      const reportRef = getReportRefId(report);
      if (
        reportRef &&
        (assetReportIds.has(reportRef) ||
          realEstateReportIds.has(reportRef) ||
          lotListingReportIds.has(reportRef) || salvageReportIds.has(reportRef))
      ) {
        continue;
      }

      const key = String(reportRef || report._id);
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          address: report.address || "",
          filename: report.filename,
          fairMarketValue: report.fairMarketValue || "",
          createdAt: report.createdAt,
          contract_no: (report as any).contract_no,
          approvalStatus: report.approvalStatus,
          release_status: (report as any).release_status,
          released_at: (report as any).released_at,
          downloadable: (report as any).downloadable !== false,
          isGeneratingFiles: false,
          generationState: "ready",
          reportStatus: String((report as any).status || "approved"),
          lotCount: Number((report as any).lot_count || 0),
          thumbnail: getFirstReportImage([], report),
          displayTitle: reportDisplayTitle(
            [],
            report.address || report.filename || "Generated report",
            report
          ),
          type: (report as any).type,
          variants: {},
        };
        map.set(key, group);
      }

      // `/reports/myreports` also returns structured Asset aggregates. They are
      // not PdfReport rows, so their parent Asset id must never be sent to the
      // legacy `/reports/:pdfReportId/download` endpoint. Build every available
      // action from the aggregate's canonical artifact URLs instead.
      const reportRecord = report as any;
      const isStructuredAggregate =
        !reportRef &&
        (Object.prototype.hasOwnProperty.call(reportRecord, "preview_files") ||
          Object.prototype.hasOwnProperty.call(reportRecord, "files"));
      if (isStructuredAggregate) {
        const artifactFiles = {
          ...(reportRecord.files || {}),
          ...(reportRecord.preview_files || {}),
        };
        const directVariant = (
          field: string,
          fileType: NonNullable<PdfReport["fileType"]>
        ): PdfReport | undefined => {
          const url = reportFileUrl(artifactFiles[field]);
          if (!url) return undefined;
          const extension =
            fileType === "spec_pdf"
              ? "pdf"
              : fileType === "cr_docx"
                ? "docx"
                : fileType === "images"
                  ? "zip"
                  : fileType;
          const fileBase = String(
            reportRecord.contract_no || report.address || "report"
          ).replace(/[^a-zA-Z0-9._-]+/g, "-");
          return {
            ...report,
            _id: `${key}-${field}`,
            fileType,
            filename: `${fileBase}.${extension}`,
            url,
          } as PdfReport;
        };
        group.variants = {
          pdf:
            directVariant("schedule_a_pdf", "pdf") ||
            directVariant("pdf", "pdf"),
          specPdf: directVariant("spec_pdf", "spec_pdf"),
          crDocx: directVariant("cr_docx", "cr_docx"),
          docx: directVariant("docx", "docx"),
          xlsx:
            directVariant("excel", "xlsx") || directVariant("xlsx", "xlsx"),
          images:
            directVariant("images", "images") || directVariant("zip", "images"),
        };
        continue;
      }

      const fileType = (
        (report.fileType || String(report.filename || "").split(".").pop() || "") as string
      ).toLowerCase();
      if (fileType === "pdf") group.variants.pdf = report;
      else if (fileType === "spec_pdf") group.variants.specPdf = report;
      else if (fileType === "cr_docx") group.variants.crDocx = report;
      else if (fileType === "docx") group.variants.docx = report;
      else if (fileType === "xlsx") group.variants.xlsx = report;
      else if (fileType === "images" || fileType === "zip") group.variants.images = report;
    }

    for (const asset of assetReports) {
      const previewFiles = {
        ...((asset as any).files || {}),
        ...((asset as any).preview_files || {}),
      };
      const currency = String(
        (asset as any)?.preview_data?.currency || (asset as any)?.currency || "CAD"
      ).toUpperCase();
      const lots = Array.isArray((asset as any)?.preview_data?.lots)
        ? (asset as any).preview_data.lots
        : Array.isArray((asset as any)?.lots)
          ? (asset as any).lots
          : [];
      const total = lots.reduce((sum: number, lot: any) => {
        const lotValue = Number(
          String(lot?.estimated_value || "").replace(/[^0-9.-]+/g, "")
        );
        const itemValue = Array.isArray(lot?.items)
          ? lot.items.reduce((itemSum: number, item: any) => {
              const parsed = Number(
                String(item?.estimated_value || "").replace(/[^0-9.-]+/g, "")
              );
              return itemSum + (Number.isFinite(parsed) ? parsed : 0);
            }, 0)
          : 0;
        return sum + Math.max(Number.isFinite(lotValue) ? lotValue : 0, itemValue);
      }, 0);
      const fairMarketValue =
        total > 0
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency,
              maximumFractionDigits: 0,
            }).format(total)
          : `${currency} 0.00`;
      const addressBase =
        (asset as any).client_name ||
        (asset as any).preview_data?.client_name ||
        "Asset Report";

      const createPseudoReport = (url: string, fileType: string, extra?: Partial<PdfReport>) =>
        ({
          _id: `${asset._id}-${fileType}`,
          filename: `${addressBase}.${fileType}`,
          fileType,
          url: reportFileUrl(url),
          ...extra,
          address: addressBase,
          fairMarketValue,
          createdAt: asset.createdAt,
          approvalStatus: asset.status === "approved" ? "approved" : "pending",
          release_status: (asset as any).release_status,
          released_at: (asset as any).released_at,
          downloadable: (asset as any).downloadable !== false,
        }) as PdfReport;
      const isGenerating = isFileGenerationBlocking(asset);
      const isDownloadable = (asset as any).downloadable !== false;

      map.set(asset._id, {
        key: asset._id,
        address: addressBase,
        filename: `${addressBase}.docx`,
        fairMarketValue,
        createdAt: asset.createdAt,
        contract_no:
          (asset as any).contract_no || (asset as any).preview_data?.contract_no,
        approvalStatus: asset.status === "approved" ? "approved" : "pending",
        release_status: (asset as any).release_status,
        released_at: (asset as any).released_at,
        downloadable: isDownloadable,
        isGeneratingFiles: isGenerating,
        generationState: (asset as any).generation_state,
        workflowStage: (asset as any).workflow_stage,
        workflowMessage: (asset as any).workflow_message,
        workflowProgressPercent: (asset as any).workflow_progress_percent,
        reportStatus: asset.status,
        generationProgress: (asset as any).generation_progress,
        jobError: (asset as any).job_error,
        lotSummary: summarizeLotNumbers(lots, asset._id),
        lotCount: lots.length,
        thumbnail: getFirstReportImage(lots, asset),
        displayTitle: reportDisplayTitle(lots, addressBase, asset),
        type: "Asset",
        isMergedReport: (asset as any).is_merged_report === true,
        mergedSourceCount: Array.isArray((asset as any).merged_from_report_ids)
          ? (asset as any).merged_from_report_ids.length
          : 0,
        variants: {
          pdf: previewFiles.schedule_a_pdf
            ? createPseudoReport(previewFiles.schedule_a_pdf, "pdf")
            : previewFiles.pdf
              ? createPseudoReport(previewFiles.pdf, "pdf")
              : undefined,
          specPdf: previewFiles.spec_pdf
            ? createPseudoReport(previewFiles.spec_pdf, "pdf", {
                _id: `${asset._id}-cr`,
                filename: `${addressBase}-CR.pdf`,
                fileType: "spec_pdf",
              })
            : undefined,
          crDocx: previewFiles.cr_docx
            ? createPseudoReport(previewFiles.cr_docx, "docx", {
                _id: `${asset._id}-cr-docx`,
                filename: `${addressBase}-CR.docx`,
                fileType: "cr_docx",
              })
            : isDownloadable ? createPseudoReport(`/api/reports/${asset._id}/cr-docx`, "docx", {
                _id: `${asset._id}-cr-docx`,
                filename: `${addressBase}-CR.docx`,
                fileType: "cr_docx",
                crReportId: asset._id,
              }) : undefined,
          docx: previewFiles.docx
            ? createPseudoReport(previewFiles.docx, "docx")
            : undefined,
          xlsx: previewFiles.excel
            ? createPseudoReport(previewFiles.excel, "xlsx")
            : undefined,
          images: previewFiles.images
            ? createPseudoReport(previewFiles.images, "zip")
            : undefined,
        },
      });
    }

    for (const report of realEstateReports) {
      const previewFiles = {
        ...((report as any).files || {}),
        ...((report as any).preview_files || {}),
      };
      const addressBase =
        (report as any)?.property_details?.address ||
        (report as any)?.preview_data?.property_details?.address ||
        "Real Estate Report";
      const fairMarketValue = String(
        (report as any)?.preview_data?.valuation?.fair_market_value ||
          (report as any)?.valuation?.fair_market_value ||
          "CAD —"
      );
      const createPseudoReport = (url: string, fileType: string) =>
        ({
          _id: `${report._id}-${fileType}`,
          filename: `${addressBase.replace(/[^a-zA-Z0-9]/g, "_")}.${fileType}`,
          fileType,
          url: reportFileUrl(url),
          address: addressBase,
          fairMarketValue,
          createdAt: report.createdAt,
          approvalStatus: report.status === "approved" ? "approved" : "pending",
          release_status: (report as any).release_status,
          released_at: (report as any).released_at,
          downloadable: (report as any).downloadable !== false,
        }) as PdfReport;
      const isGenerating = isFileGenerationBlocking(report);
      const isDownloadable = (report as any).downloadable !== false;

      map.set(report._id, {
        key: report._id,
        address: addressBase,
        filename: `${addressBase}.docx`,
        fairMarketValue,
        createdAt: report.createdAt,
        approvalStatus: report.status === "approved" ? "approved" : "pending",
        release_status: (report as any).release_status,
        released_at: (report as any).released_at,
        downloadable: isDownloadable,
        isGeneratingFiles: isGenerating,
        generationState: (report as any).generation_state,
        workflowStage: (report as any).workflow_stage,
        workflowMessage: (report as any).workflow_message,
        workflowProgressPercent: (report as any).workflow_progress_percent,
        reportStatus: report.status,
        generationProgress: (report as any).generation_progress,
        jobError: (report as any).job_error,
        lotCount: 1,
        thumbnail: getFirstReportImage([], report),
        displayTitle: reportDisplayTitle([], addressBase, report),
        type: "RealEstate",
        variants: {
          pdf: previewFiles.pdf ? createPseudoReport(previewFiles.pdf, "pdf") : undefined,
          docx: previewFiles.docx
            ? createPseudoReport(previewFiles.docx, "docx")
            : undefined,
          xlsx: previewFiles.excel
            ? createPseudoReport(previewFiles.excel, "xlsx")
            : undefined,
          images: previewFiles.images
            ? createPseudoReport(previewFiles.images, "zip")
            : undefined,
        },
      });
    }

    for (const listing of lotListingReports) {
      const previewFiles =
        listing.status === "approved"
          ? {
              ...((listing as any).files || {}),
              ...((listing as any).preview_files || {}),
            }
          : {
              ...((listing as any).files || {}),
              ...((listing as any).preview_files || {}),
            };
      const currency = String(
        (listing as any)?.details?.currency ||
          (listing as any)?.preview_data?.currency ||
          "CAD"
      ).toUpperCase();
      const lots = Array.isArray((listing as any)?.preview_data?.lots)
        ? (listing as any).preview_data.lots
        : Array.isArray((listing as any)?.lots)
          ? (listing as any).lots
          : [];
      const total = lots.reduce((sum: number, lot: any) => {
        const parsed = Number(
          String(lot?.estimated_value || "").replace(/[^0-9.-]+/g, "")
        );
        return sum + (Number.isFinite(parsed) ? parsed : 0);
      }, 0);
      const fairMarketValue =
        total > 0
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency,
              maximumFractionDigits: 0,
            }).format(total)
          : `${currency} 0.00`;
      const addressBase =
        (listing as any).details?.contract_no ||
        (listing as any).preview_data?.contract_no ||
        "Lot Listing";
      const createPseudoReport = (url: string, fileType: string, extra?: Partial<PdfReport>) =>
        ({
          _id: `${listing._id}-${fileType}`,
          filename: `${addressBase}.${fileType}`,
          fileType,
          url: reportFileUrl(url),
          ...extra,
          address: addressBase,
          fairMarketValue,
          createdAt: listing.createdAt,
          approvalStatus: listing.status === "approved" ? "approved" : "pending",
          release_status: (listing as any).release_status,
          released_at: (listing as any).released_at,
          downloadable: (listing as any).downloadable !== false,
        }) as PdfReport;
      const isGenerating = isFileGenerationBlocking(listing);
      const isDownloadable = (listing as any).downloadable !== false;

      map.set(listing._id, {
        key: listing._id,
        address: addressBase,
        filename: `${addressBase}.xlsx`,
        fairMarketValue,
        createdAt: listing.createdAt,
        contract_no:
          (listing as any).details?.contract_no ||
          (listing as any).preview_data?.contract_no,
        approvalStatus: listing.status === "approved" ? "approved" : "pending",
        release_status: (listing as any).release_status,
        released_at: (listing as any).released_at,
        downloadable: isDownloadable,
        isGeneratingFiles: isGenerating,
        generationState: (listing as any).generation_state,
        workflowStage: (listing as any).workflow_stage,
        workflowMessage: (listing as any).workflow_message,
        workflowProgressPercent: (listing as any).workflow_progress_percent,
        reportStatus: listing.status,
        generationProgress: (listing as any).generation_progress,
        jobError: listing.job_error || listing.error_message,
        lotSummary: summarizeLotNumbers(lots, listing._id),
        lotCount: lots.length,
        thumbnail: getFirstReportImage(lots, listing),
        displayTitle: reportDisplayTitle(lots, addressBase, listing),
        type: "LotListing",
        variants: {
          pdf: previewFiles.schedule_a_pdf
            ? createPseudoReport(previewFiles.schedule_a_pdf, "pdf")
            : previewFiles.pdf
              ? createPseudoReport(previewFiles.pdf, "pdf")
              : undefined,
          specPdf: previewFiles.spec_pdf
            ? createPseudoReport(previewFiles.spec_pdf, "pdf", {
                _id: `${listing._id}-cr`,
                filename: `${addressBase}-CR.pdf`,
                fileType: "spec_pdf",
              })
            : undefined,
          crDocx: previewFiles.cr_docx
            ? createPseudoReport(previewFiles.cr_docx, "docx", {
                _id: `${listing._id}-cr-docx`,
                filename: `${addressBase}-CR.docx`,
                fileType: "cr_docx",
              })
            : isDownloadable ? createPseudoReport(`/api/reports/${listing._id}/cr-docx`, "docx", {
                _id: `${listing._id}-cr-docx`,
                filename: `${addressBase}-CR.docx`,
                fileType: "cr_docx",
                crReportId: listing._id,
              }) : undefined,
          xlsx: previewFiles.excel
            ? createPseudoReport(previewFiles.excel, "xlsx")
            : undefined,
          images: previewFiles.images
            ? createPseudoReport(previewFiles.images, "zip")
            : undefined,
        },
      });
    }

    for (const salvage of salvageReports) {
      const title = salvage.file_number || "Salvage report";
      const fairMarketValue = String(salvage.preview_data?.valuation && typeof salvage.preview_data.valuation === "object"
        ? (salvage.preview_data.valuation as Record<string, unknown>).fairMarketValue || "—"
        : salvage.valuation?.fairMarketValue || "—");
      const variants: ReportGroup["variants"] = {};
      for (const fileType of ["pdf", "docx", "xlsx", "images"] as const) {
        const fileId = salvage.files?.[fileType];
        // Salvage files are protected PdfReport ids, never public URLs or the
        // parent report id. Do not bypass server approval/release decisions.
        if (salvage.downloadable === true && fileId) variants[fileType] = {
          _id: fileId, report: salvage._id, fileType, type: "Salvage", filename: `${title}.${fileType === "images" ? "zip" : fileType}`,
          address: title, fairMarketValue, createdAt: salvage.createdAt, downloadable: true,
        };
      }
      map.set(salvage._id, {
        key: salvage._id, address: title, displayTitle: title, fairMarketValue, createdAt: salvage.createdAt,
        type: "Salvage", salvageCanonical: true, reportStatus: salvage.status,
        approvalStatus: salvage.status === "approved" ? "approved" : salvage.status === "declined" ? "rejected" : "pending",
        release_status: salvage.release_status, downloadable: salvage.downloadable === true,
        generationState: salvage.generation_state, isGeneratingFiles: isFileGenerationActive(salvage),
        workflowStage: salvage.workflow_stage, workflowMessage: salvageSystemText(salvage.workflow_message),
        workflowProgressPercent: salvage.workflow_progress_percent, jobError: salvageSystemText(salvage.job_error),
        thumbnail: salvage.imageUrls?.[0], variants,
      });
    }

    /*
       A part belongs to the person and the contract, not to one report.
       Closing it after one delivery records the close on that delivery only,
       so the user's other reports on the same contract kept offering "Close
       my part of this contract" for a part that was already closed. Every
       close on the contract is shared across its rows here; the contract
       counts as complete once any close reported it so.
    */
    const partClosesByContract = new Map<
      string,
      { closedAt: string; taskCompleted: boolean; userStatus?: "completed" | "revoked" }
    >();
    for (const delivery of auctioneerDeliveries) {
      if (
        delivery.contractCompletionScope !== "user" ||
        !delivery.contractId ||
        !delivery.contractClosedAt
      ) {
        continue;
      }
      const known = partClosesByContract.get(delivery.contractId);
      partClosesByContract.set(delivery.contractId, {
        closedAt: known?.closedAt || delivery.contractClosedAt,
        taskCompleted: Boolean(
          known?.taskCompleted || delivery.contractTaskCompleted
        ),
        userStatus: delivery.contractCloseUserStatus || known?.userStatus,
      });
    }

    for (const delivery of auctioneerDeliveries) {
      if (!delivery.reportId) continue;
      const group = map.get(String(delivery.reportId));
      if (!group) continue;
      const partClose =
        delivery.contractCompletionScope === "user" && delivery.contractId
          ? partClosesByContract.get(delivery.contractId)
          : undefined;
      group.auctioneerDelivery = partClose
        ? {
            ...delivery,
            contractClosedAt: delivery.contractClosedAt || partClose.closedAt,
            contractTaskCompleted: partClose.taskCompleted,
            contractCloseUserStatus: partClose.userStatus,
          }
        : delivery;
    }

    return Array.from(map.values());
  }, [
    salvageReports,
    assetReports,
    auctioneerDeliveries,
    lotListingReports,
    realEstateReports,
    reports,
  ]);

  const availableTypes = useMemo(() => {
    const values = new Set<string>();
    groups.forEach((group) => {
      if (group.type) values.add(String(group.type));
    });
    return Array.from(values);
  }, [groups]);

  /*
     Counted from every group rather than from the filtered output, so the tab
     counts do not move when someone types in the search box. A count that
     changes as you search cannot be used to answer "how much is left to send".
  */
  const completedCount = useMemo(
    () => groups.filter((group) => group.auctioneerDelivery?.state === "sent").length,
    [groups]
  );
  const outstandingCount = groups.length - completedCount;
  useEffect(() => {
    /*
       Choose the tab ONCE, after the data arrives. A sent report lives on
       Completed while the page opens on Outstanding, so without this the deep
       link lands on a tab that cannot hold what was asked for. Once only, so a
       later refetch cannot yank the reader back after they have changed tabs
       themselves.
    */
    if (deepLinkTabResolved.current) return;
    const wanted = new URLSearchParams(window.location.search).get("search")?.trim() || "";
    if (!wanted || groups.length === 0) return;
    deepLinkTabResolved.current = true;
    const match = groups.find(
      (group) => (group.contract_no ?? "").toLowerCase() === wanted.toLowerCase()
    );
    if (match?.auctioneerDelivery?.state === "sent") setQueueTab("completed");
  }, [groups]);

  const filteredGroups = useMemo(() => {
    /*
       The tab narrows FIRST, so the search and type filters below apply within
       the tab you are standing on rather than across both.
    */
    let output = groups.filter((group) =>
      queueTab === "completed"
        ? group.auctioneerDelivery?.state === "sent"
        : group.auctioneerDelivery?.state !== "sent"
    );
    const q = query.trim().toLowerCase();
    if (q) {
      output = output.filter((group) =>
        [
          group.address,
          group.filename,
          group.key,
          group.fairMarketValue,
          group.contract_no,
          new Date(group.createdAt).toLocaleDateString(),
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q))
      );
    }

    if (typeFilter) {
      output = output.filter((group) => String(group.type || "") === typeFilter);
    }

    const parseValue = (value: string) => {
      const parsed = Number(String(value || "").replace(/[^0-9.-]+/g, ""));
      return Number.isFinite(parsed) ? parsed : NaN;
    };

    output.sort((a, b) => {
      if (sortBy === "date-asc") {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      if (sortBy === "date-desc") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      const aValue = parseValue(a.fairMarketValue);
      const bValue = parseValue(b.fairMarketValue);
      if (sortBy === "value-asc") {
        return (Number.isNaN(aValue) ? Infinity : aValue) - (Number.isNaN(bValue) ? Infinity : bValue);
      }
      return (Number.isNaN(bValue) ? -Infinity : bValue) - (Number.isNaN(aValue) ? -Infinity : aValue);
    });

    return output;
  }, [groups, queueTab, query, sortBy, typeFilter]);

  const totalItems = filteredGroups.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = totalItems === 0 ? 0 : (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginatedGroups = filteredGroups.slice(startIndex, endIndex);

  useEffect(() => {
    setPage(1);
  }, [queueTab, query, pageSize, sortBy, typeFilter]);

  async function handleDownload(reportId: string) {
    try {
      setDownloadingId(reportId);
      let reportWithUrl: PdfReport | undefined = reports.find((item) => item._id === reportId);
      if (!reportWithUrl) {
        for (const group of groups) {
          const found = Object.values(group.variants).find(
            (variant) => variant && variant._id === reportId
          );
          if (found) {
            reportWithUrl = found;
            break;
          }
        }
      }

      if ((reportWithUrl as any)?.downloadable === false) {
        throw new Error("This report is awaiting release. Downloads will be available after release.");
      }

      if (reportWithUrl?.crReportId) {
        const isCrDocx = reportWithUrl.fileType === "cr_docx";
        const { blob, filename } = isCrDocx
          ? await ReportsService.downloadCrDocx(reportWithUrl.crReportId)
          : await ReportsService.downloadCr(reportWithUrl.crReportId);
        const objectUrl = window.URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download =
          filename ||
          reportWithUrl.filename ||
          `cr-${reportWithUrl.crReportId}.${isCrDocx ? "docx" : "pdf"}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
        toast.success(`Download started: ${anchor.download}`);
        return;
      }

      if (reportWithUrl && (reportWithUrl as any).url) {
        const fileUrl = (reportWithUrl as any).url as string;
        const anchor = document.createElement("a");
        anchor.href = fileUrl;
        anchor.download =
          reportWithUrl.filename || `report-${reportId}.${reportWithUrl.fileType}`;
        anchor.target = "_blank";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        toast.success(`Download started: ${anchor.download}`);
        return;
      }

      if (!reportWithUrl) throw new Error("Report not found");
      const { blob, filename } = await ReportsService.downloadReport(reportId);
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download =
        filename || reportWithUrl.filename || `report-${reportId}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
      toast.success(`Download started: ${anchor.download}`);
    } catch (downloadError: any) {
      toast.error(
        downloadError?.response?.data?.message ||
          downloadError?.message ||
          "Download failed"
      );
    } finally {
      setDownloadingId(null);
    }
  }

  const resetFilters = () => {
    setQuery("");
    setTypeFilter("");
    setSortBy("date-desc");
    setPageSize(20);
    setPage(1);
  };

  const renderFileControls = (group: ReportGroup) => {
    const fileGroupName =
      group.contract_no ||
      group.displayTitle ||
      group.address ||
      group.filename ||
      group.key;
    const hasDownloads = hasGroupDownloadVariants(group);
    const workflowProgress = {
      ...(group.generationProgress || {}),
      ...(group.workflowMessage ? { message: group.workflowMessage } : {}),
      ...(Number.isFinite(group.workflowProgressPercent)
        ? { progressPercent: group.workflowProgressPercent }
        : {}),
    };
    const isPreparingPreview =
      group.workflowStage === "preparing_preview" ||
      (!group.workflowStage && group.reportStatus === "processing") ||
      (group.reportStatus === "preview" && Boolean(group.isGeneratingFiles));
    const isPreviewReady =
      group.workflowStage === "preview_ready" ||
      (!group.workflowStage &&
        group.reportStatus === "preview" &&
        !group.isGeneratingFiles);
    const showGeneratingOnly =
      group.workflowStage === "generating_files" ||
      (!group.workflowStage && Boolean(group.isGeneratingFiles) && !hasDownloads);
    // Old artifact URLs can survive failed regeneration. They do not prove
    // that the edited revision completed, or suppress its actionable error.
    const showErrorOnly = group.workflowStage === "error" ||
      (!group.workflowStage && (group.generationState === "error" || group.reportStatus === "error"));
    const downloadable = group.downloadable !== false;

    if (showErrorOnly) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-xs font-semibold text-[var(--app-danger)]">
            {group.jobError || group.workflowMessage || "File generation failed. Open Preview to review your saved changes, then retry."}
          </span>
          <button
            type="button"
            disabled={retryingKeys.has(group.key)}
            aria-busy={retryingKeys.has(group.key)}
            className="rounded-md border border-[var(--app-danger-border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] disabled:cursor-wait disabled:opacity-60"
            onClick={() => void handleRetry(group)}
          >
            {retryingKeys.has(group.key) ? "Retrying…" : "Retry"}
          </button>
        </div>
      );
    }
    if (isPreparingPreview) {
      return (
        <GeneratingFilesProgress
          progress={workflowProgress}
          fallbackMessage="Analyzing images and preparing your first preview..."
        />
      );
    }
    if (isPreviewReady && !hasDownloads) {
      return (
        <span className="text-xs font-semibold leading-5 text-[var(--app-accent)]">
          Preview ready for review
        </span>
      );
    }
    if (showGeneratingOnly) {
      return <GeneratingFilesProgress progress={workflowProgress} />;
    }
    if (group.type === "LotListing" && (!downloadable ||
        group.workflowStage === "awaiting_approval" || group.workflowStage === "awaiting_release")) {
      return (
        <span className="text-xs font-semibold text-[var(--app-warning)]">
          Lot Listings release automatically after files finish generating. Open Preview to regenerate incomplete files.
        </span>
      );
    }
    if (group.workflowStage === "awaiting_approval") {
      return (
        <span className="text-xs font-semibold text-[var(--app-warning)]">
          Files ready; awaiting approval
        </span>
      );
    }
    if (group.workflowStage === "awaiting_release") {
      return (
        <span className="text-xs font-semibold text-[var(--app-warning)]">
          Approved; awaiting release
        </span>
      );
    }
    if (!downloadable) {
      return (
        <span className="text-xs font-semibold text-[var(--app-warning)]">
          Files available after release
        </span>
      );
    }

    return (
      <div
        className="flex w-full flex-wrap gap-1"
        role="group"
        aria-label={`Available files for ${fileGroupName}`}
      >
        {FILE_VARIANTS.map((variant) => {
          const file = group.variants[variant];
          if (!file) return null;
          const disabled =
            downloadingId === file._id ||
            !downloadable ||
            (!!file.approvalStatus && file.approvalStatus !== "approved");
          const label = actionLabel(variant, group.type);
          return (
            <button
              key={variant}
              type="button"
              title={`Download ${label}`}
              aria-label={`Download ${label}`}
              className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-1.5 text-xs font-semibold text-[var(--app-text)] transition-colors hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:border-[var(--app-border)] disabled:bg-[var(--app-panel-alt)] disabled:text-[var(--app-text-muted)] disabled:opacity-60"
              onClick={() => void handleDownload(file._id)}
              disabled={disabled}
            >
              {downloadingId === file._id ? (
                <RefreshCw className="size-3.5 shrink-0 animate-spin" />
              ) : (
                fileActionIcon(variant)
              )}
              <span className="leading-4">{label}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const renderReportActions = (group: ReportGroup) => {
    const normalizedType = String(group.type || "")
      .toLowerCase()
      .replace(/[\s_-]/g, "");
    const previewReportType =
      normalizedType === "asset"
        ? "asset"
        : normalizedType.includes("lot")
          ? "lotListing"
          : group.salvageCanonical ? "salvage" : null;
    const previewTitle = group.contract_no
      ? `${typeLabel(group.type)} · ${group.contract_no}`
      : group.address || group.filename || group.key;
    const salvageTracking = group.salvageCanonical && (salvageReports.some((report) => report._id === group.key && salvageIsProcessing(report)) || ["cancelled", "error"].includes(group.reportStatus || ""));
    const previewPreparing =
      group.workflowStage === "preparing_preview" ||
      (!group.workflowStage && group.reportStatus === "processing");
    const proposalValuationReady = ["approved", "pending_approval"].includes(
      String(group.reportStatus || "").toLowerCase()
    );
    const delivery = group.auctioneerDelivery;
    const lotListingDelivery = Boolean(
      delivery &&
        (delivery.reportType === "lotListing" ||
          delivery.reportModel === "LotListing")
    );
    const deliveryReadinessRequirement = lotListingDelivery
      ? "final file generation"
      : "approval, release, and final file generation";
    const deliveryDisabled = Boolean(
      delivery &&
        (["not_ready", "queued", "sending", "sent"].includes(delivery.state) ||
          (delivery.state === "failed" && delivery.canSend === false))
    );
    const deliveryLabel =
      delivery?.state === "failed"
        ? "Retry delivery"
        : delivery?.state === "needs_reconciliation"
          ? "Resolve"
          : delivery?.state === "sent"
            ? "Sent"
            : delivery?.state === "queued" || delivery?.state === "sending"
              ? "Sending"
              : "Send";
    const deliveryTitle =
      delivery?.state === "not_ready"
        ? `Available after ${deliveryReadinessRequirement}`
        : delivery?.state === "sent"
          ? "This report has been sent to Auctioneer"
          : delivery?.state === "needs_reconciliation"
            ? "Resolve the uncertain Unknown Lot before retrying"
            : delivery?.state === "failed"
              ? delivery.canSend === false
                ? `Retry is available after ${deliveryReadinessRequirement}`
                : "Retry the failed Auctioneer delivery"
              : lotListingDelivery
                ? "Send final generated listing data and photos to Auctioneer"
                : "Send approved and released data and final photos to Auctioneer";

    return (
      <div
        className="flex w-full flex-wrap items-center gap-1"
        role="group"
        aria-label={`Actions for ${previewTitle}`}
      >
        {previewReportType ? (
          <button
            type="button"
            aria-label={`Preview ${typeLabel(group.type)} report: ${previewTitle}`}
            title={
              previewPreparing
                ? "Preview is still being prepared"
                : `Preview ${typeLabel(group.type)} report`
            }
            className={`${REPORT_ACTION_CLASS_NAME} border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-on-accent)] hover:border-[var(--app-accent-hover)] hover:bg-[var(--app-accent-hover)] disabled:cursor-wait disabled:border-[var(--app-border)] disabled:bg-[var(--app-panel-alt)] disabled:text-[var(--app-text-muted)]`}
            onClick={() =>
              router.push(
                group.salvageCanonical ? salvageTracking ? salvageStatusPath(group.key) : salvagePreviewPath(group.key) : `/previews?reportId=${encodeURIComponent(group.key)}&reportType=${previewReportType}`
              )
            }
            disabled={previewPreparing && !group.salvageCanonical}
          >
            <Eye className="size-3.5 shrink-0" strokeWidth={1.9} />
            {salvageTracking ? "View progress" : "Preview"}
          </button>
        ) : null}
        {delivery ? (
          <button
            type="button"
            aria-label={`${deliveryLabel} for ${previewTitle}`}
            title={deliveryTitle}
            className={`${REPORT_ACTION_CLASS_NAME} border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text)] hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)]`}
            onClick={() => setDeliveryDialogItem(delivery)}
            disabled={deliveryDisabled}
          >
            <Send className="size-3.5 shrink-0" />
            <span className="truncate">{deliveryLabel}</span>
          </button>
        ) : null}
        {delivery && canCloseContractPart(delivery) ? (
          <button
            type="button"
            aria-label={`Close my part of this contract: ${delivery.contractNo || previewTitle}`}
            title="Tell Auctioneer you have finished this contract. It completes when every assigned person has closed theirs."
            className={`${REPORT_ACTION_CLASS_NAME} border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text)] hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)]`}
            onClick={() => void handleCloseContractPart(delivery)}
            disabled={Boolean(closingContractId)}
          >
            {closingContractId === delivery.contractId ? (
              <RefreshCw className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <CircleCheck className="size-3.5 shrink-0 text-[var(--app-success)]" />
            )}
            <span className="min-w-0 whitespace-normal">
              {closingContractId === delivery.contractId
                ? "Closing…"
                : "Close my part"}
            </span>
          </button>
        ) : null}
        {normalizedType === "asset" &&
        user?.proposalValuationEnabled === true &&
        proposalValuationReady ? (
          <button
            type="button"
            aria-label={`Open Proposal Valuation for ${previewTitle}`}
            title="Review and edit Proposal Valuation"
            className={`${REPORT_ACTION_CLASS_NAME} border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text)] hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)]`}
            onClick={() =>
              router.push(
                `/proposal-valuations/${encodeURIComponent(group.key)}`
              )
            }
          >
            <ChartNoAxesColumnIncreasing className="size-3.5 shrink-0 text-[var(--app-accent)]" />
            PV
          </button>
        ) : null}
        {normalizedType === "asset" ? (
          <button
            type="button"
            aria-label={`Merge reports for ${previewTitle}`}
            title="Merge with other Asset reports using the same contract"
            className={`${REPORT_ACTION_CLASS_NAME} border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text)] hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)]`}
            onClick={() => setMergeAnchorId(group.key)}
          >
            <Merge className="size-3.5 shrink-0 text-[var(--app-text-muted)]" />
            Merge
          </button>
        ) : null}
        {!group.salvageCanonical ? <button
          type="button"
          aria-label={`Delete report ${previewTitle}`}
          title="Permanently delete this report"
          className={`${REPORT_ACTION_CLASS_NAME} ml-auto w-7 border-transparent bg-transparent px-0 text-[var(--app-danger)] hover:border-[var(--app-danger-border)] hover:bg-[var(--app-danger-soft)]`}
          onClick={() => void handleDelete(group)}
          disabled={deletingKey === group.key}
        >
          {deletingKey === group.key ? (
            <RefreshCw className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Trash2 className="size-4 shrink-0" />
          )}
        </button> : null}
      </div>
    );
  };

  const reportPresentation = (group: ReportGroup) => {
    const hasDownloads = hasGroupDownloadVariants(group);
    const status = statusTone(
      group.approvalStatus,
      Boolean(group.isGeneratingFiles) && !hasDownloads,
      group.release_status,
      group.generationState,
      group.reportStatus,
      group.workflowStage
    );
    const deliveryStatus = auctioneerDeliveryPresentation(
      group.auctioneerDelivery
    );
    const title =
      group.displayTitle ||
      group.address ||
      group.filename ||
      typeLabel(group.type);
    const subtitle = group.contract_no
      ? `Contract ${group.contract_no}`
      : group.address && group.address !== title
        ? group.address
        : group.lotSummary || reportTypeColumnLabel(group.type);
    const thumbnailTitle = group.contract_no
      ? `${reportTypeColumnLabel(group.type)} ${group.contract_no} — ${title}`
      : `${reportTypeColumnLabel(group.type)} — ${title}`;
    return { status, deliveryStatus, title, subtitle, thumbnailTitle };
  };

  return (
    // Full width beside the menu (owner, 2026-10-31: "use dead space").
    <main className="mx-auto w-full min-w-0 space-y-4 overflow-x-hidden px-4 py-5 sm:px-5 lg:px-6 lg:py-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[1.65rem] font-bold leading-none tracking-[-0.035em] text-[var(--app-text-strong)] sm:text-[1.8rem]">
              My reports
            </h1>
            <span
              aria-label={`${groups.length} reports`}
              className="inline-grid min-w-7 place-items-center rounded-md bg-[var(--app-accent-soft)] px-2 py-0.5 text-xs font-bold text-[var(--app-accent)]"
            >
              {groups.length}
            </span>
          </div>
          <p className="mt-1.5 max-w-xl text-sm leading-5 text-[var(--app-text-muted)]">
            Track report status and download every available deliverable.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel)] px-3 text-sm font-semibold text-[var(--app-text)] shadow-[var(--app-shadow-control)] transition-colors hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void handleManualRefresh()}
          disabled={loading || refreshing}
        >
          <RefreshCw
            className={`size-[18px] ${refreshing ? "animate-spin" : ""}`}
            strokeWidth={1.8}
          />
          <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
        </button>
      </header>

      {/*
        Counts live on the tabs rather than only in the header, so the number of
        rows on screen is always explained by the tab you are standing on — the
        same treatment the Incoming queue uses.
      */}
      {/* One toolbar line on wide screens: the tabs, then the filters. */}
      <div className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-center">
      <div
        className="inline-flex shrink-0 gap-1 self-start rounded-lg bg-[var(--app-panel-alt)] p-1 2xl:self-auto"
        role="tablist"
        aria-label="Queue"
      >
        {([
          { id: "outstanding" as const, label: "Outstanding", count: outstandingCount },
          { id: "completed" as const, label: "Completed", count: completedCount },
        ]).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={queueTab === tab.id}
            tabIndex={queueTab === tab.id ? 0 : -1}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "outstanding" : event.key === "End" ? "completed" : queueTab === "outstanding" ? "completed" : "outstanding";
              setQueueTab(next);
              const index = next === "outstanding" ? 0 : 1;
              (event.currentTarget.parentElement?.querySelectorAll("button")[index] as HTMLButtonElement | undefined)?.focus();
            }}
            onClick={() => setQueueTab(tab.id)}
            className={`inline-flex min-h-8 items-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors ${
              queueTab === tab.id
                ? "bg-[var(--app-panel)] text-[var(--app-text)] shadow-[var(--app-shadow-control)]"
                : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
            }`}
          >
            {tab.label}
            <span className="rounded-full bg-[var(--app-panel-soft)] px-1.5 text-xs font-semibold tabular-nums text-[var(--app-text-muted)]">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-expanded={filtersOpen}
        aria-controls="report-filter-controls"
        className="flex min-h-10 w-full items-center justify-between rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] px-3 text-sm font-semibold text-[var(--app-text)] shadow-[var(--app-shadow-control)] transition-colors hover:border-[var(--app-control-border-hover)] xl:hidden"
        onClick={() => setFiltersOpen((open) => !open)}
      >
        <span className="flex items-center gap-3">
          <SlidersHorizontal className="size-5" strokeWidth={1.8} />
          Filters
          {query || typeFilter || sortBy !== "date-desc" || pageSize !== 20 ? (
            <span className="size-2 rounded-full bg-[var(--app-accent)]" aria-label="Filters applied" />
          ) : null}
        </span>
        <ChevronDown
          className={`size-5 transition-transform ${filtersOpen ? "rotate-180" : ""}`}
          strokeWidth={2}
        />
      </button>

      <section
        id="report-filter-controls"
        aria-label="Report filters"
        className={`${filtersOpen ? "grid" : "hidden"} min-w-0 gap-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2.5 shadow-[var(--app-shadow-card)] sm:grid-cols-2 xl:grid xl:grid-cols-[minmax(0,1.5fr)_minmax(0,.72fr)_minmax(0,.82fr)_minmax(0,.65fr)_auto] xl:gap-2 xl:border-0 xl:bg-transparent xl:p-0 xl:shadow-none 2xl:flex-1`}
      >
        <label className="relative block min-w-0">
          <span className="sr-only">Search reports</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-[var(--app-text-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reports by title, lot, address..."
            className="min-h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel-soft)] pl-10 pr-3 text-sm font-medium text-[var(--app-text)] outline-none transition-shadow placeholder:font-normal placeholder:text-[var(--app-text-muted)] focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]"
          />
        </label>
        <label>
          <span className="sr-only">Report type</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="min-h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel-soft)] px-3 text-sm font-medium text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]"
          >
            <option value="">All types</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>
                {reportTypeColumnLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Sort reports</span>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
            className="min-h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel-soft)] px-3 text-sm font-medium text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]"
          >
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="value-desc">Value high to low</option>
            <option value="value-asc">Value low to high</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Rows per page</span>
          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className="min-h-9 w-full rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel-soft)] px-3 text-sm font-medium text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]"
          >
            {[10, 20, 50].map((size) => (
              <option key={size} value={size}>
                {size} rows
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold text-[var(--app-accent)] transition-colors hover:bg-[var(--app-accent-soft)]"
          onClick={resetFilters}
        >
          <RotateCcw className="size-4" />
          Reset
        </button>
      </section>
      </div>

      {loading ? (
        <section
          className="grid min-h-80 place-items-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-card)]"
          role="status"
          aria-label="Loading reports"
        >
          <div className="flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
            <RefreshCw className="size-4 animate-spin text-[var(--app-accent)]" />
            Loading reports...
          </div>
        </section>
      ) : error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-3 text-sm text-[var(--app-danger)]"
        >
          {error}
        </div>
      ) : filteredGroups.length === 0 ? (
        <section className="rounded-xl border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel)] px-5 py-14 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]">
            <FileText className="size-5" />
          </span>
          <h2 className="mt-3 font-semibold text-[var(--app-text)]">
            {queueTab === "completed" ? "Nothing completed yet" : "No reports found"}
          </h2>
          {/*
            An empty tab says why it is empty. "No reports match the current
            search and filters" on a tab with no filters applied reads as a
            fault rather than as an empty state.
          */}
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--app-text-muted)]">
            {groups.length === 0
              ? "Create a report from the dashboard to populate this page."
              : queueTab === "completed"
                ? "Reports appear here once they have been sent to Auctioneer."
                : outstandingCount === 0
                  ? "Every report has been sent. See the Completed tab."
                  : "No reports match the current search and filters."}
          </p>
        </section>
      ) : (
        <>
          <ul className="divide-y divide-[var(--app-border)] overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-card)] min-[1440px]:hidden">
            {paginatedGroups.map((group) => {
              const { status, deliveryStatus, title, subtitle, thumbnailTitle } =
                reportPresentation(group);
              return (
                <li
                  key={group.key}
                  className="app-render-row p-3.5 sm:p-4"
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: "260px",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <ReportThumbnail
                        src={group.thumbnail}
                        title={thumbnailTitle}
                        size="card"
                      />
                      <div className="min-w-0 pt-0.5">
                        <h2 className="break-words text-[15px] font-semibold leading-5 text-[var(--app-accent)] sm:text-base">
                          {title}
                        </h2>
                        <p className="mt-1 break-words text-sm leading-5 text-[var(--app-text-muted)]">
                          {subtitle}
                        </p>
                          <p className="mt-1 text-xs text-[var(--app-text-muted)] sm:hidden">
                          {reportTypeColumnLabel(group.type)} ·{" "}
                          {new Date(group.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <span
                      className="shrink-0 rounded-md border border-current/20 px-2.5 py-1.5 text-xs font-semibold"
                      style={{ backgroundColor: status.bg, color: status.color }}
                    >
                      {status.label}
                    </span>
                  </div>
                  {deliveryStatus ? (
                    <p className="mt-2 break-words text-xs font-medium" style={{ color: deliveryStatus.color }}>
                      {deliveryStatus.label}
                    </p>
                  ) : null}

                  <div className="mt-3.5 flex flex-col gap-3 border-t border-[var(--app-border)] pt-3 sm:flex-row sm:items-end sm:justify-between">
                    {/* Never squeezed: the files and actions beside it wrap instead. */}
                    <div className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3">
                      <div className="flex min-w-0 gap-2.5">
                        <Boxes className="mt-0.5 size-[18px] shrink-0 text-[var(--app-text-muted)]" strokeWidth={1.8} />
                        <dl>
                          <dt className="text-xs font-medium text-[var(--app-text-muted)]">Lots</dt>
                          <dd className="mt-1 text-sm font-semibold text-[var(--app-text)]">
                            {group.lotCount || "—"} {group.lotCount === 1 ? "lot" : group.lotCount ? "lots" : ""}
                          </dd>
                        </dl>
                      </div>
                      <div className="flex min-w-0 gap-2.5">
                        <ChartNoAxesColumnIncreasing className="mt-0.5 size-[18px] shrink-0 text-[var(--app-text-muted)]" strokeWidth={1.8} />
                        <dl>
                          <dt className="text-xs font-medium text-[var(--app-text-muted)]">Market value</dt>
                          <dd className="mt-1 break-words text-sm font-semibold text-[var(--app-text)]">
                            {group.fairMarketValue || "—"}
                          </dd>
                        </dl>
                      </div>
                    </div>
                    <div className="grid w-full gap-2 sm:max-w-xl sm:grid-cols-2">
                      <div>{renderFileControls(group)}</div>
                      <div>{renderReportActions(group)}</div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <section className="hidden overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-card)] min-[1440px]:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] table-fixed border-collapse text-left">
                <caption className="sr-only">Generated reports</caption>
                <colgroup>
                  {/*
                    Files and Actions get the room, so a row's chips and buttons
                    sit on as few lines as possible. The report type is shown
                    under the report's name instead of in a column of its own.
                  */}
                  <col className="w-[19%]" />
                  <col className="w-[4%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[28%]" />
                  <col className="w-[25%]" />
                </colgroup>
                <thead className="bg-[var(--app-panel-soft)] text-xs font-semibold text-[var(--app-text-muted)]">
                  <tr>
                    {[
                      "Report",
                      "Lots",
                      "Market value",
                      "Created",
                      "Status",
                      "Files",
                      "Actions",
                    ].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="border-b border-r border-[var(--app-border)] px-3 py-2.5 last:border-r-0"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--app-border)]">
                  {paginatedGroups.map((group) => {
                    const {
                      status,
                      deliveryStatus,
                      title,
                      subtitle,
                      thumbnailTitle,
                    } = reportPresentation(group);
                    return (
                      <tr
                        key={group.key}
                        className="app-render-row align-middle transition-colors hover:bg-[var(--app-panel-soft)]"
                        style={{
                          contentVisibility: "auto",
                          containIntrinsicSize: "74px",
                        }}
                      >
                        <td className="border-r border-[var(--app-border)] px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <ReportThumbnail
                              src={group.thumbnail}
                              title={thumbnailTitle}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-[var(--app-accent)]">
                                {title}
                              </p>
                              <p className="mt-0.5 truncate text-xs text-[var(--app-text-muted)]">
                                {subtitle === reportTypeColumnLabel(group.type)
                                  ? subtitle
                                  : `${reportTypeColumnLabel(group.type)} · ${subtitle}`}
                              </p>
                              {group.isMergedReport ? (
                                <p className="mt-0.5 text-[11px] font-semibold text-[var(--app-accent)]">
                                  Merged · {group.mergedSourceCount || 2} sources
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="border-r border-[var(--app-border)] px-3 py-2.5 text-sm font-medium text-[var(--app-text)]">
                          {group.lotCount || "—"}
                        </td>
                        <td className="border-r border-[var(--app-border)] px-3 py-2.5 text-sm font-medium text-[var(--app-text)]">
                          {group.fairMarketValue || "—"}
                        </td>
                        <td className="border-r border-[var(--app-border)] px-3 py-2.5">
                          <p className="text-sm text-[var(--app-text)]">
                            {new Date(group.createdAt).toLocaleDateString()}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">
                            {new Date(group.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </td>
                        <td className="border-r border-[var(--app-border)] px-3 py-2.5">
                          <span
                            className="inline-flex rounded-md border border-current/20 px-2 py-1 text-xs font-semibold"
                            style={{
                              backgroundColor: status.bg,
                              color: status.color,
                            }}
                          >
                            {status.label}
                          </span>
                          {deliveryStatus ? (
                            <span
                              className="mt-1 block w-fit text-[11px] font-medium"
                              style={{ color: deliveryStatus.color }}
                            >
                              {deliveryStatus.label}
                            </span>
                          ) : null}
                        </td>
                        <td className="border-r border-[var(--app-border)] px-2.5 py-2.5">
                          {renderFileControls(group)}
                        </td>
                        <td className="px-2.5 py-2.5">
                          {renderReportActions(group)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <nav
            aria-label="Reports pagination"
            className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-[var(--app-text-muted)]">
              Showing {startIndex + 1}–{endIndex} of {totalItems} reports
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous reports page"
                className="grid size-9 place-items-center rounded-lg border border-[var(--app-border)] text-[var(--app-text)] transition-colors hover:bg-[var(--app-panel-alt)] disabled:opacity-40"
                disabled={currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="grid size-9 place-items-center rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent-soft)] font-semibold text-[var(--app-accent)]">
                {currentPage}
              </span>
              <span className="px-1 text-xs text-[var(--app-text-muted)]">
                of {totalPages}
              </span>
              <button
                type="button"
                aria-label="Next reports page"
                className="grid size-9 place-items-center rounded-lg border border-[var(--app-border)] text-[var(--app-text)] transition-colors hover:bg-[var(--app-panel-alt)] disabled:opacity-40"
                disabled={currentPage >= totalPages}
                onClick={() =>
                  setPage((value) => Math.min(totalPages, value + 1))
                }
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </nav>
        </>
      )}

      {mergeAnchorId ? (
        <AssetMergeDialog
          open
          anchorReportId={mergeAnchorId}
          onClose={() => setMergeAnchorId(null)}
          onCreated={() => {
            setMergeAnchorId(null);
            window.dispatchEvent(new Event("cv:report-created"));
            router.push("/previews");
          }}
        />
      ) : null}
      {deliveryDialogItem ? (
        <AuctioneerDeliveryDialog
          open
          delivery={deliveryDialogItem}
          onClose={() => setDeliveryDialogItem(null)}
          onUpdated={(updated) => {
            setAuctioneerDeliveries((current) => {
              const existingIndex = current.findIndex(
                (item) => item.workItemId === updated.workItemId
              );
              if (existingIndex < 0) return [...current, updated];
              return current.map((item, index) =>
                index === existingIndex ? updated : item
              );
            });
          }}
        />
      ) : null}
    </main>
  );
}
