"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import ConfirmModal from "@/app/components/common/ConfirmModal";
import { releasesWithApproval } from "@/lib/reportApprovalUiPolicy";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  Grid,
  InputAdornment,
  IconButton,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ArchiveRoundedIcon from "@mui/icons-material/ArchiveRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CollectionsRoundedIcon from "@mui/icons-material/CollectionsRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import NoteAddRoundedIcon from "@mui/icons-material/NoteAddRounded";
import PictureAsPdfRoundedIcon from "@mui/icons-material/PictureAsPdfRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import RestoreRoundedIcon from "@mui/icons-material/RestoreRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TableChartRoundedIcon from "@mui/icons-material/TableChartRounded";
import TableRowsRoundedIcon from "@mui/icons-material/TableRowsRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";

const ExcelConditionReportEditorDialog = dynamic(
  () => import("@/app/components/reports/ExcelConditionReportEditorDialog"),
  {
    ssr: false,
    loading: () => null,
  }
);

type ReportItem = {
  _id: string;
  filename: string;
  address: string;
  fairMarketValue: string;
  user?: { email?: string; username?: string } | null;
  reportType: "RealEstate" | "Salvage" | "Asset" | "LotListing" | string;
  createdAt: string;
  reportModel?: string;
  fileType?: "pdf" | "spec_pdf" | "cr_docx" | "docx" | "xlsx" | "images";
  approvalStatus?: "pending" | "approved" | "rejected";
  approval_assigned_to?: { _id?: string; email?: string; username?: string; companyName?: string; role?: string } | string | null;
  release_status?: "pending_release" | "released";
  release_assigned_to?: { _id?: string; email?: string; username?: string; companyName?: string; role?: string } | string | null;
  released_at?: string | null;
  downloadable?: boolean;
  download_access?: ReportDownloadAccess;
  generation_state?: "queued" | "processing" | "ready" | "error";
  workflow_stage?: "preparing_preview" | "preview_ready" | "generating_files" | "awaiting_approval" | "awaiting_release" | "ready" | "error";
  workflow_message?: string;
  files_ready?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  job_status?: string;
  job_error?: string;
  report?: string;
  contract_no?: string;
  lot_number_summary?: string;
  thumbnail_url?: string | null;
  preview_files?: { pdf?: string; spec_pdf?: string; cr_docx?: string; docx?: string; excel?: string; images?: string };
  crDisclaimerCount?: number;
  isRealEstateReport?: boolean;
  isLotListingReport?: boolean;
  property_type?: string;
  language?: string;
  adminArchivedAt?: string | null;
};

type ApiResponse = {
  items: ReportItem[];
  total: number;
  page: number;
  limit: number;
};

type ReportGroup = {
  key: string;
  title: string;
  contract_no?: string;
  lotNumberSummary?: string;
  thumbnailUrl?: string | null;
  reportType: string;
  createdAt: string;
  fairMarketValue: string;
  userEmail?: string;
  userDisplayName?: string;
  variants: { pdf?: ReportItem; specPdf?: ReportItem; crDocx?: ReportItem; docx?: ReportItem; xlsx?: ReportItem; images?: ReportItem };
  isAssetReport?: boolean;
  isRealEstateReport?: boolean;
  isLotListingReport?: boolean;
  preview_files?: { pdf?: string; spec_pdf?: string; cr_docx?: string; docx?: string; excel?: string; images?: string };
  crDisclaimerCount?: number;
  approvalStatus?: ReportItem["approvalStatus"];
  approval_assigned_to?: ReportItem["approval_assigned_to"];
  release_status?: "pending_release" | "released";
  release_assigned_to?: ReportItem["release_assigned_to"];
  released_at?: string | null;
  downloadable?: boolean;
  download_access?: ReportDownloadAccess;
  generation_state?: ReportItem["generation_state"];
  workflow_stage?: ReportItem["workflow_stage"];
  workflow_message?: string;
  files_ready?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  job_status?: string;
  job_error?: string;
  adminArchivedAt?: string | null;
};

type ReportDownloadAccess = {
  allowed: boolean;
  code:
    | "READY"
    | "AWAITING_APPROVAL"
    | "AWAITING_RELEASE"
    | "DECLINED"
    | "FILES_GENERATING"
    | "FILES_UNAVAILABLE";
  message: string;
  approval_status: "pending" | "approved" | "rejected";
  release_status: "pending_release" | "released";
};

type ReportFileLink = {
  label: string;
  href?: string;
  download?: boolean;
};

const LARGE_PAGE_SIZE = 500;
const DOWNLOAD_ACCESS_PRIORITY: Record<ReportDownloadAccess["code"], number> = {
  READY: 0,
  FILES_UNAVAILABLE: 1,
  FILES_GENERATING: 2,
  AWAITING_RELEASE: 3,
  AWAITING_APPROVAL: 4,
  DECLINED: 5,
};

function formatFMV(value: string) {
  return value || "N/A";
}

function getReportTypeLabel(reportType: string) {
  return reportType === "LotListing" ? "Lot Listing" : reportType;
}

function normalizedReportType(group: ReportGroup) {
  return String(group.reportType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function getPreviewTargetId(group: ReportGroup) {
  return (
    group.variants.pdf?._id ||
    group.variants.specPdf?._id ||
    group.variants.crDocx?._id ||
    group.variants.docx?._id ||
    group.variants.xlsx?._id ||
    group.variants.images?._id ||
    group.key
  );
}

function reportIsActivelyGenerating(group: ReportGroup) {
  return Boolean(
    group.generation_state === "queued" ||
      group.generation_state === "processing" ||
      group.workflow_stage === "preparing_preview" ||
      group.workflow_stage === "generating_files" ||
      group.files_generating ||
      group.files_regenerating
  );
}

function reportApprovalIsApproved(group: ReportGroup) {
  if (group.download_access) {
    return group.download_access.approval_status === "approved";
  }
  return !group.approvalStatus || group.approvalStatus === "approved";
}

function getFileBlockReason(group: ReportGroup, file: ReportFileLink): string | null {
  if (
    group.approvalStatus === "rejected" ||
    group.download_access?.code === "DECLINED"
  ) {
    return "This report was not approved. Please resolve the approver feedback before downloading.";
  }
  if (
    group.approvalStatus === "pending" ||
    group.workflow_stage === "awaiting_approval" ||
    group.download_access?.code === "AWAITING_APPROVAL"
  ) {
    return group.approval_assigned_to
      ? "This report is waiting for approval from the assigned approver. Downloads will be available after approval."
      : "This report is waiting for approval. Downloads will be available after approval.";
  }
  if (
    group.release_status === "pending_release" ||
    group.workflow_stage === "awaiting_release" ||
    group.download_access?.code === "AWAITING_RELEASE"
  ) {
    return releasesWithApproval(group)
      ? "New approvals release automatically. This older report still has a pending release; refresh or contact an administrator to resolve its existing state."
      : "This report is approved but is waiting to be released. Downloads will be available after release.";
  }
  if (
    group.download_access?.code === "FILES_GENERATING" ||
    reportIsActivelyGenerating(group)
  ) {
    return `${file.label} is still being generated. Please refresh shortly.`;
  }
  if (
    group.download_access &&
    !group.download_access.allowed &&
    group.download_access.code !== "FILES_UNAVAILABLE"
  ) {
    return group.download_access.message;
  }
  if (
    group.downloadable === false &&
    group.download_access?.code !== "FILES_UNAVAILABLE"
  ) {
    return releasesWithApproval(group) ? "Downloads will be available after approval and completion of all report files." : "Downloads will be available after this report has been approved and released.";
  }
  if (file.href) return null;
  if (
    group.download_access?.code === "FILES_UNAVAILABLE" ||
    group.generation_state === "error" ||
    group.workflow_stage === "error" ||
    group.job_status === "error"
  ) {
    return (
      group.download_access?.message ||
      `${file.label} is unavailable. Regenerate the report files or contact support.`
    );
  }
  return `${file.label} is not available for this report. Regenerate the report files or contact support.`;
}

function getReportStatusPresentation(group: ReportGroup) {
  if (
    group.approvalStatus === "rejected" ||
    group.download_access?.code === "DECLINED"
  ) {
    return { label: "Not Approved", background: "#fff1f2", color: "#be123c", border: "#fecdd3" };
  }
  if (
    group.approvalStatus === "pending" ||
    group.workflow_stage === "awaiting_approval" ||
    group.download_access?.code === "AWAITING_APPROVAL"
  ) {
    return { label: "Awaiting Approval", background: "#fff4df", color: "#a45a00", border: "#f2d6a5" };
  }
  if (
    group.release_status === "pending_release" ||
    group.workflow_stage === "awaiting_release" ||
    group.download_access?.code === "AWAITING_RELEASE"
  ) {
    return { label: releasesWithApproval(group) ? "Legacy Release Pending" : "Awaiting Release", background: "#fff4df", color: "#a45a00", border: "#f2d6a5" };
  }
  if (
    group.download_access?.code === "FILES_GENERATING" ||
    reportIsActivelyGenerating(group)
  ) {
    return { label: "Generating Files", background: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
  }
  if (
    group.download_access?.code === "FILES_UNAVAILABLE" ||
    (group.files_ready === false &&
      (group.generation_state === "error" ||
      group.workflow_stage === "error" ||
      group.job_status === "error"))
  ) {
    return { label: "Files Unavailable", background: "#fff1f2", color: "#be123c", border: "#fecdd3" };
  }
  return { label: "Released", background: "#e9f7f2", color: "#087f5b", border: "#c5e9dd" };
}

function groupReportItems(items: ReportItem[]): ReportGroup[] {
  const map = new Map<string, ReportGroup>();
  for (const r of items) {
    const key = String(r.report || r._id);
    let group = map.get(key);
    if (!group) {
      const base =
        r.reportType === "RealEstate"
          ? "Real Estate"
          : r.reportType === "Salvage"
            ? "Salvage"
            : r.reportType === "LotListing"
              ? "Lot Listing"
              : "Asset";
      group = {
        key,
        title: r.contract_no
          ? `${base} - ${r.contract_no}`
          : r.address || base,
        contract_no: r.contract_no,
        lotNumberSummary: r.lot_number_summary,
        thumbnailUrl: r.thumbnail_url || null,
        reportType: r.reportType,
        createdAt: r.createdAt,
        fairMarketValue: r.fairMarketValue,
        userEmail: r.user?.email || undefined,
        userDisplayName: r.user?.username || r.user?.email || undefined,
        variants: {},
        isAssetReport: r.reportType === "Asset",
        isRealEstateReport: r.reportType === "RealEstate" || r.isRealEstateReport,
        isLotListingReport: r.reportType === "LotListing" || r.isLotListingReport || (r as any).isLotListing,
        preview_files: r.preview_files,
        crDisclaimerCount: Number(r.crDisclaimerCount || 0),
        approvalStatus: r.approvalStatus,
        approval_assigned_to: r.approval_assigned_to || null,
        release_status: r.release_status || "released",
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: r.downloadable !== false,
        download_access: r.download_access,
        generation_state: r.generation_state,
        workflow_stage: r.workflow_stage,
        workflow_message: r.workflow_message,
        files_ready: r.files_ready,
        files_generating: r.files_generating,
        files_regenerating: r.files_regenerating,
        job_status: r.job_status,
        job_error: r.job_error,
        adminArchivedAt: r.adminArchivedAt || null,
      };
      map.set(key, group);
    } else {
      if (group.release_status !== "pending_release" && r.release_status === "pending_release") {
        group.release_status = "pending_release";
        group.release_assigned_to = r.release_assigned_to || null;
        group.released_at = r.released_at || null;
      }
      if (r.downloadable === false) group.downloadable = false;
      if (
        r.download_access &&
        (!group.download_access ||
          DOWNLOAD_ACCESS_PRIORITY[r.download_access.code] >
            DOWNLOAD_ACCESS_PRIORITY[group.download_access.code])
      ) {
        group.download_access = r.download_access;
      }
      if (
        r.approvalStatus === "rejected" ||
        (r.approvalStatus === "pending" && group.approvalStatus !== "rejected")
      ) {
        group.approvalStatus = r.approvalStatus;
        group.approval_assigned_to = r.approval_assigned_to || null;
      }
      if (
        r.generation_state === "error" ||
        (r.generation_state === "processing" && group.generation_state !== "error") ||
        (r.generation_state === "queued" && !group.generation_state)
      ) {
        group.generation_state = r.generation_state;
        group.workflow_stage = r.workflow_stage;
        group.workflow_message = r.workflow_message;
        group.files_ready = r.files_ready;
        group.files_generating = r.files_generating;
        group.files_regenerating = r.files_regenerating;
        group.job_status = r.job_status;
        group.job_error = r.job_error;
      }
    }

    if (new Date(r.createdAt).getTime() > new Date(group.createdAt).getTime()) group.createdAt = r.createdAt;
    const fileType = String(r.fileType || r.filename.split(".").pop() || "").toLowerCase();
    if (fileType === "pdf") group.variants.pdf = r;
    else if (fileType === "spec_pdf") group.variants.specPdf = r;
    else if (fileType === "cr_docx") group.variants.crDocx = r;
    else if (fileType === "docx") group.variants.docx = r;
    else if (fileType === "xlsx") group.variants.xlsx = r;
    else if (fileType === "images" || fileType === "zip") group.variants.images = r;
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function buildFileLinks(group: ReportGroup): ReportFileLink[] {
  const reportType = normalizedReportType(group);
  const isAssetType = reportType === "asset";
  const isRealEstateType = reportType === "realestate";

  if (group.isLotListingReport) {
    return [
      { label: "CR", href: `/api/admin/reports/${group.key}/spec-pdf/download`, download: true },
      { label: "CR DOCX", href: group.preview_files?.cr_docx || `/api/admin/reports/${group.key}/cr-docx`, download: true },
      { label: "Excel", href: group.preview_files?.excel },
      { label: "Images", href: group.preview_files?.images },
    ];
  }

  if ((group.isAssetReport || group.isRealEstateReport) && group.preview_files) {
    return [
      {
        label: group.isAssetReport ? "CR" : "PDF",
        href: group.isAssetReport
          ? `/api/admin/reports/${group.key}/spec-pdf/download`
          : group.preview_files.spec_pdf || group.preview_files.pdf,
        download: group.isAssetReport,
      },
      ...(group.isAssetReport
        ? [
            {
              label: "CR DOCX",
              href: group.preview_files.cr_docx || `/api/admin/reports/${group.key}/cr-docx`,
              download: true,
            },
          ]
        : []),
      { label: "Appraisal report", href: group.preview_files.docx },
      { label: "Excel", href: group.preview_files.excel },
      { label: "Images", href: group.preview_files.images },
    ];
  }

  if (group.isAssetReport) {
    return [
      { label: "CR", href: `/api/admin/reports/${group.key}/spec-pdf/download`, download: true },
      { label: "CR DOCX", href: `/api/admin/reports/${group.key}/cr-docx`, download: true },
      {
        label: "Appraisal report",
        href: group.variants.docx ? `/api/admin/reports/${group.variants.docx._id}/download` : undefined,
      },
      {
        label: "Excel",
        href: group.variants.xlsx ? `/api/admin/reports/${group.variants.xlsx._id}/download` : undefined,
      },
      {
        label: "Images",
        href: group.variants.images ? `/api/admin/reports/${group.variants.images._id}/download` : undefined,
      },
    ];
  }

  return [
    {
      label: group.variants.specPdf
        ? "CR"
        : isAssetType
          ? "Schedule A"
          : "PDF",
      href: group.variants.specPdf
        ? `/api/admin/reports/${group.variants.specPdf._id}/download`
        : group.variants.pdf
          ? `/api/admin/reports/${group.variants.pdf._id}/download`
          : undefined,
    },
    {
      label:
        isAssetType || isRealEstateType ? "Appraisal report" : "DOCX",
      href: group.variants.docx ? `/api/admin/reports/${group.variants.docx._id}/download` : undefined,
    },
    {
      label: "Excel",
      href:
        group.variants.xlsx && group.variants.xlsx.approvalStatus === "approved"
          ? `/api/admin/reports/${group.variants.xlsx._id}/download`
          : undefined,
    },
    {
      label: "Images",
      href:
        group.variants.images && group.variants.images.approvalStatus === "approved"
          ? `/api/admin/reports/${group.variants.images._id}/download`
          : undefined,
    },
  ];
}

function getFileActionIcon(label: string) {
  const key = label.toLowerCase();
  if (
    key === "cr" ||
    key === "schedule a" ||
    key.includes("pdf") ||
    key.includes("conditional report")
  ) {
    return <PictureAsPdfRoundedIcon />;
  }
  if (key === "appraisal report" || key.includes("docx")) return <NoteAddRoundedIcon />;
  if (key.includes("excel")) return <TableChartRoundedIcon />;
  if (key.includes("image")) return <CollectionsRoundedIcon />;
  return undefined;
}

const actionButtonSx = {
  minWidth: "auto",
  height: 26,
  px: 0.62,
  py: 0,
  borderRadius: 1.25,
  textTransform: "none",
  fontSize: "0.62rem",
  fontWeight: 800,
  lineHeight: 1,
  boxShadow: "none",
  whiteSpace: "nowrap",
  transition: "background-color 120ms ease, border-color 120ms ease",
  "&:hover": { boxShadow: "none" },
  "& .MuiButton-startIcon": { mr: 0.32, ml: -0.22 },
  "& .MuiSvgIcon-root": { fontSize: "0.8rem" },
};

export default function AdminReports() {
  const router = useRouter();
  // Filters
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [reportType, setReportType] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [debouncedUserEmail, setDebouncedUserEmail] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [pageSizeMode, setPageSizeMode] = useState<"5" | "20" | "50" | "100" | "all" | "custom">("50");
  const [customPageSizeInput] = useState("150");
  const [archiveMode, setArchiveMode] = useState<"active" | "archived">("active");
  const [sameContractOpen, setSameContractOpen] = useState(false);
  const [sameContractLoading, setSameContractLoading] = useState(false);
  const [sameContractError, setSameContractError] = useState<string | null>(null);
  const [sameContractNumber, setSameContractNumber] = useState("");
  const [sameContractCurrentKey, setSameContractCurrentKey] = useState("");
  const [sameContractGroups, setSameContractGroups] = useState<ReportGroup[]>([]);

  // Data
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [crSubmitSuccess, setCrSubmitSuccess] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [excelCrTarget, setExcelCrTarget] = useState<ReportGroup | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedQ(q.trim());
    }, 350);
    return () => window.clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedUserEmail(userEmail.trim());
    }, 350);
    return () => window.clearTimeout(id);
  }, [userEmail]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set("q", debouncedQ);
    if (reportType) p.set("reportType", reportType);
    p.set("approvalStatus", "approved");
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (debouncedUserEmail) p.set("userEmail", debouncedUserEmail);
    if (archiveMode === "archived") p.set("archived", "true");
    p.set("page", String(pagination.pageIndex + 1));
    p.set("limit", String(pagination.pageSize));
    return p.toString();
  }, [debouncedQ, reportType, from, to, debouncedUserEmail, archiveMode, pagination.pageIndex, pagination.pageSize]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports?${queryString}&_t=${Date.now()}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load reports");
      setData(json as ApiResponse);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to load reports";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  function openDelete(id: string) {
    setPendingDeleteId(id);
    setConfirmOpen(true);
  }

  function openProposalValuation(id: string) {
    router.push(`/reports/${encodeURIComponent(id)}/pv?from=reports`);
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    try {
      setDeleting(true);
      const res = await fetch(`/api/admin/reports/${pendingDeleteId}`, {
        method: "DELETE",
      });
      if (!(res.ok || res.status === 204)) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.message || "Failed to delete");
      }
      setConfirmOpen(false);
      setPendingDeleteId(null);
      await load();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to delete report";
      setError(message);
    } finally {
      setDeleting(false);
    }
  }

  async function setReportArchived(id: string, archived: boolean) {
    try {
      setActionBusyId(id);
      setError(null);
      const res = await fetch(`/api/admin/reports/${id}/${archived ? "archive" : "restore"}`, {
        method: "PATCH",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.message || (archived ? "Failed to complete report" : "Failed to restore report"));
      }
      await load();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : archived ? "Failed to complete report" : "Failed to restore report";
      setError(message);
    } finally {
      setActionBusyId(null);
    }
  }

  async function releaseReport(group: ReportGroup) {
    const id = releasesWithApproval(group) ? getPreviewTargetId(group) : group.key;
    try {
      setActionBusyId(group.key);
      const res = await fetch(`/api/admin/reports/${id}/release`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to release report");
      await load();
    } catch (e: unknown) {
      setDownloadNotice(e instanceof Error ? e.message : "Failed to release report");
    } finally {
      setActionBusyId(null);
    }
  }

  function canUseExcelCrEditor(group: ReportGroup) {
    return Boolean(group.isAssetReport || group.isLotListingReport);
  }

  function openExcelCrEditor(group: ReportGroup) {
    if (!canUseExcelCrEditor(group)) return;
    setCrSubmitSuccess(null);
    setExcelCrTarget(group);
  }

  async function handleExcelCrSaved(result: { regenerated: boolean; message: string }) {
    setCrSubmitSuccess(result.message);
    // Refresh the table after both save modes so reopening Data/CR Notes cannot
    // show a stale report snapshot after a successful editor save.
    await load();
  }

  function onReset() {
    setQ("");
    setDebouncedQ("");
    setReportType("");
    setFrom("");
    setTo("");
    setUserEmail("");
    setDebouncedUserEmail("");
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  const totalPages = useMemo(() => {
    return data
      ? Math.max(1, Math.ceil((data.total || 0) / pagination.pageSize))
      : 1;
  }, [data, pagination.pageSize]);

  function applyPageSize(nextSize: number, nextMode: "5" | "20" | "50" | "100" | "all" | "custom") {
    const safeSize = Math.max(1, Math.floor(nextSize));
    setPageSizeMode(nextMode);
    setPagination((prev) => ({
      ...prev,
      pageIndex: 0,
      pageSize: safeSize,
    }));
  }

  function commitCustomPageSize() {
    const parsed = Number(customPageSizeInput);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    applyPageSize(parsed, "custom");
  }

  function applyTextFiltersNow() {
    setDebouncedQ(q.trim());
    setDebouncedUserEmail(userEmail.trim());
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  const groups = useMemo<ReportGroup[]>(() => groupReportItems((data?.items || []) as ReportItem[]), [data]);

  async function openSameContractReports(group: ReportGroup) {
    if (!group.contract_no) return;
    setSameContractNumber(group.contract_no);
    setSameContractCurrentKey(group.key);
    setSameContractGroups([]);
    setSameContractError(null);
    setSameContractOpen(true);
    setSameContractLoading(true);
    try {
      const params = new URLSearchParams({
        contractNo: group.contract_no,
        approvalStatus: "approved",
        page: "1",
        limit: "200",
      });
      const response = await fetch(`/api/admin/reports?${params.toString()}&_t=${Date.now()}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Failed to load reports for this contract");
      setSameContractGroups(groupReportItems(Array.isArray(body?.items) ? body.items : []));
    } catch (sameContractError) {
      setSameContractError(sameContractError instanceof Error ? sameContractError.message : "Failed to load same-contract reports");
    } finally {
      setSameContractLoading(false);
    }
  }

  function renderReportActions(group: ReportGroup, options: { wrap?: boolean } = {}) {
    const previewId = getPreviewTargetId(group);
    const archiveLabel = archiveMode === "archived" ? "Restore" : "Done";
    const archiveTooltip =
      archiveMode === "archived" ? "Restore report to active list" : "Move report to archived list";
    const statusPresentation = getReportStatusPresentation(group);
    const canRelease =
      group.release_status === "pending_release" &&
      reportApprovalIsApproved(group) &&
      !reportIsActivelyGenerating(group) &&
      group.files_ready !== false &&
      group.workflow_stage !== "error";

    return (
      <Stack
        direction="row"
        flexWrap={options.wrap ? "wrap" : "nowrap"}
        useFlexGap
        spacing={0.38}
        sx={{
          alignItems: "center",
          minWidth: 0,
          width: "100%",
          maxWidth: "100%",
          overflow: "visible",
          rowGap: options.wrap ? 0.75 : 0,
          "& > span": { flexShrink: 0 },
        }}
      >
        <Tooltip title="Open proposal valuation">
          <span>
            <Button
              size="small"
              variant="contained"
              aria-label="Proposal valuation"
              startIcon={<VisibilityRoundedIcon />}
              sx={{
                ...actionButtonSx,
                bgcolor: "#0284c7",
                color: "#fff",
                "&:hover": { bgcolor: "#0369a1", boxShadow: "0 8px 18px rgba(2, 132, 199, 0.22)" },
              }}
              onClick={() => {
                if (previewId) openProposalValuation(previewId);
              }}
            >
              <Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>
                PV
              </Box>
              <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
                Proposal valuation
              </Box>
            </Button>
          </span>
        </Tooltip>

        {(group.isAssetReport || group.isLotListingReport) && group.contract_no ? (
          <Tooltip title="View every report using this contract number">
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<TableRowsRoundedIcon />}
                sx={{
                  ...actionButtonSx,
                  borderColor: "#94a3b8",
                  color: "#334155",
                  bgcolor: "#fff",
                  "&:hover": { borderColor: "#64748b", bgcolor: "#f8fafc" },
                }}
                onClick={() => void openSameContractReports(group)}
              >
                Same
              </Button>
            </span>
          </Tooltip>
        ) : null}

        {buildFileLinks(group).map((link) => {
          const linkKey = link.label.toLowerCase();
          const tooltipLabel = linkKey === "cr" ? "CR" : link.label;
          const isPdf =
            linkKey === "cr" ||
            linkKey === "schedule a" ||
            linkKey.includes("pdf");
          const isExcel = link.label.toLowerCase().includes("excel");
          const color = isPdf ? "#4f46e5" : isExcel ? "#2563eb" : "#7c3aed";
          const hover = isPdf ? "#4338ca" : isExcel ? "#1d4ed8" : "#6d28d9";
          const blockReason = getFileBlockReason(group, link);
          return (
            <Tooltip key={`${group.key}-${link.label}`} title={blockReason || tooltipLabel}>
              <span>
                <Button
                  size="small"
                  variant="contained"
                  aria-disabled={Boolean(blockReason)}
                  startIcon={getFileActionIcon(link.label)}
                  onClick={blockReason ? () => setDownloadNotice(blockReason) : undefined}
                  sx={{
                    ...actionButtonSx,
                    bgcolor: blockReason ? "#e5e7eb" : color,
                    color: blockReason ? "#64748b" : "#fff",
                    cursor: blockReason ? "pointer" : undefined,
                    "&:hover": blockReason
                      ? { bgcolor: "#dbe0e6", boxShadow: "none" }
                      : { bgcolor: hover, boxShadow: `0 8px 18px ${color}33` },
                  }}
                  {...(!blockReason && link.href
                    ? {
                        href: link.href,
                        ...(link.download
                          ? { download: true }
                          : { target: "_blank", rel: "noopener noreferrer" }),
                      }
                    : {})}
                >
                  {link.label}
                </Button>
              </span>
            </Tooltip>
          );
        })}

        {canUseExcelCrEditor(group) ? (
          <Tooltip title="Edit CR notes">
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={actionBusyId === group.key}
                startIcon={<TableChartRoundedIcon />}
                sx={{
                  ...actionButtonSx,
                  borderColor: "#a78bfa",
                  color: "#6d28d9",
                  bgcolor: "#faf5ff",
                  "&:hover": {
                    borderColor: "#8b5cf6",
                    bgcolor: "#f3e8ff",
                  },
                }}
                onClick={() => openExcelCrEditor(group)}
              >
                CR Notes
              </Button>
            </span>
          </Tooltip>
        ) : null}

        <Tooltip
          title={
            canRelease
              ? releasesWithApproval(group) ? "Complete this older report's pending release. New approvals release automatically." : "Release this approved report so the user can download files"
              : releasesWithApproval(group) && group.release_status === "pending_release"
                ? "New approvals release automatically. This older report's pending state must be resolved by an administrator."
              : group.release_status === "pending_release"
                ? group.workflow_message || "Approval and all required files must be complete before release"
              : group.workflow_message
                ? group.workflow_message
              : group.released_at
                ? `Released ${new Date(group.released_at).toLocaleString()}`
                : "Released"
          }
        >
          <span>
            {canRelease ? (
              <Button
                size="small"
                variant="contained"
                disabled={actionBusyId === group.key}
                sx={{
                  ...actionButtonSx,
                  bgcolor: "#7c3aed",
                  color: "#fff",
                  "&:hover": { bgcolor: "#6d28d9", boxShadow: "0 8px 18px rgba(124, 58, 237, 0.22)" },
                }}
                onClick={() => void releaseReport(group)}
              >
                {releasesWithApproval(group) ? "Legacy release" : "Release"}
              </Button>
            ) : (
              <Chip
                size="small"
                label={statusPresentation.label}
                sx={{
                  height: 26,
                  fontSize: "0.62rem",
                  fontWeight: 900,
                  bgcolor: statusPresentation.background,
                  color: statusPresentation.color,
                  border: `1px solid ${statusPresentation.border}`,
                  borderRadius: 1.25,
                }}
              />
            )}
          </span>
        </Tooltip>

        <Tooltip title={archiveTooltip}>
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={actionBusyId === group.key}
              startIcon={archiveMode === "archived" ? <RestoreRoundedIcon /> : <ArchiveRoundedIcon />}
              sx={{
                ...actionButtonSx,
                borderColor: archiveMode === "archived" ? "#16a34a" : "#f59e0b",
                color: archiveMode === "archived" ? "#15803d" : "#b45309",
                bgcolor: archiveMode === "archived" ? "#f0fdf4" : "#fffbeb",
                "&:hover": {
                  borderColor: archiveMode === "archived" ? "#15803d" : "#d97706",
                  bgcolor: archiveMode === "archived" ? "#dcfce7" : "#fef3c7",
                },
              }}
              onClick={() => void setReportArchived(group.key, archiveMode !== "archived")}
            >
              {archiveLabel}
            </Button>
          </span>
        </Tooltip>

        <Tooltip title="Delete report">
          <span>
            <IconButton
              size="small"
              color="error"
              sx={{
                width: 26,
                height: 26,
                borderRadius: 1.25,
                border: "1px solid #fca5a5",
                borderColor: "#f87171",
                color: "#dc2626",
                bgcolor: "#fff7f7",
                "&:hover": {
                  borderColor: "#ef4444",
                  bgcolor: "#fee2e2",
                },
              }}
              onClick={() => openDelete(group.key)}
            >
              <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    );
  }

  const desktopTileSx = {
    minWidth: 0,
    width: 47,
    height: 44,
    px: 0.25,
    py: 0.3,
    borderRadius: 0,
    borderColor: "divider",
    bgcolor: "background.paper",
    color: "text.primary",
    fontSize: "0.48rem",
    fontWeight: 550,
    lineHeight: 1.05,
    flexDirection: "column",
    gap: 0.35,
    whiteSpace: "normal",
    "&:hover": { borderColor: "#9b9da0", bgcolor: "action.hover" },
    "& .MuiButton-startIcon": { m: 0 },
    "& .MuiSvgIcon-root": { fontSize: "1rem" },
  } as const;

  function renderDesktopFiles(group: ReportGroup) {
    const previewId = getPreviewTargetId(group);
    return (
      <Stack direction="row" spacing={0.4} useFlexGap flexWrap="wrap" alignItems="center" sx={{ maxWidth: "100%", rowGap: 0.5 }}>
        <Button
          variant="outlined"
          aria-label="Proposal valuation"
          startIcon={<VisibilityRoundedIcon />}
          sx={{ ...desktopTileSx, width: 64 }}
          onClick={() => previewId && openProposalValuation(previewId)}
        >
          Proposal valuation
        </Button>
        {buildFileLinks(group).map((file) => {
          const blockReason = getFileBlockReason(group, file);
          return (
            <Tooltip key={`${group.key}-${file.label}`} title={blockReason || file.label}>
              <span>
                <Button
                  variant="outlined"
                  aria-disabled={Boolean(blockReason)}
                  startIcon={getFileActionIcon(file.label)}
                  onClick={blockReason ? () => setDownloadNotice(blockReason) : undefined}
                  sx={{
                    ...desktopTileSx,
                    ...(blockReason
                      ? {
                          borderColor: "#d8dde3",
                          bgcolor: "#f4f6f8",
                          color: "#7b8794",
                          cursor: "pointer",
                          "&:hover": { borderColor: "#b8c1cb", bgcolor: "#e9edf1" },
                        }
                      : {}),
                  }}
                  {...(!blockReason && file.href
                    ? {
                        href: file.href,
                        ...(file.download ? { download: true } : { target: "_blank", rel: "noopener noreferrer" }),
                      }
                    : {})}
                >
                  {file.label}
                </Button>
              </span>
            </Tooltip>
          );
        })}
      </Stack>
    );
  }

  function renderDesktopRowActions(group: ReportGroup) {
    const canRelease =
      group.release_status === "pending_release" &&
      reportApprovalIsApproved(group) &&
      !reportIsActivelyGenerating(group) &&
      group.files_ready !== false &&
      group.workflow_stage !== "error";
    const desktopActionSx = {
      width: 48,
      minWidth: 48,
      height: 44,
      borderRadius: 0,
      borderColor: "divider",
      bgcolor: "background.paper",
      color: "text.primary",
      px: 0.35,
      py: 0.3,
      fontSize: "0.5rem",
      fontWeight: 550,
      lineHeight: 1.05,
      whiteSpace: "normal",
      textAlign: "center",
      flexDirection: "column",
      gap: 0.25,
      "&:hover": { borderColor: "#9b9da0", bgcolor: "action.hover" },
      "& .MuiButton-startIcon": { m: 0 },
      "& .MuiSvgIcon-root": { fontSize: "0.95rem" },
    } as const;
    return (
      <Stack direction="row" spacing={0.4} useFlexGap flexWrap="wrap" alignItems="center" sx={{ maxWidth: "100%", rowGap: 0.5 }}>
        {group.contract_no ? (
          <Button variant="outlined" startIcon={<TableRowsRoundedIcon />} sx={{ ...desktopActionSx, width: 58, minWidth: 58 }} onClick={() => void openSameContractReports(group)}>
            Same Contract
          </Button>
        ) : null}
        {canUseExcelCrEditor(group) ? (
          <Button variant="outlined" startIcon={<TableChartRoundedIcon />} sx={desktopActionSx} disabled={actionBusyId === group.key} onClick={() => openExcelCrEditor(group)}>
            CR Notes
          </Button>
        ) : null}
        {canRelease ? (
          <Button variant="outlined" sx={{ ...desktopActionSx, color: "#087f5b" }} disabled={actionBusyId === group.key} onClick={() => void releaseReport(group)}>
            {releasesWithApproval(group) ? "Legacy release" : "Release"}
          </Button>
        ) : null}
        <Button
          variant="outlined"
          startIcon={archiveMode === "archived" ? <RestoreRoundedIcon /> : <ArchiveRoundedIcon />}
          sx={desktopActionSx}
          disabled={actionBusyId === group.key}
          onClick={() => void setReportArchived(group.key, archiveMode !== "archived")}
        >
          {archiveMode === "archived" ? "Restore" : "Archive"}
        </Button>
        <Button
          variant="outlined"
          startIcon={<DeleteOutlineRoundedIcon />}
          onClick={() => openDelete(group.key)}
          sx={{ ...desktopActionSx, width: 44, minWidth: 44, borderColor: "#efb6ba", color: "#df111b" }}
        >
          Delete
        </Button>
      </Stack>
    );
  }

  const columns: ColumnDef<ReportGroup>[] = [
    {
      id: "title",
      accessorKey: "title",
      header: "Report",
      cell: ({ row }) => (
        <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
          {row.original.thumbnailUrl ? (
            <Box component="img" src={row.original.thumbnailUrl} alt="" sx={{ width: 70, height: 58, flexShrink: 0, objectFit: "cover", border: "1px solid", borderColor: "divider" }} />
          ) : (
            <Box sx={{ position: "relative", display: "grid", width: 70, height: 58, flexShrink: 0, placeItems: "center", overflow: "hidden", border: "1px solid", borderColor: "divider", bgcolor: "#ececed", color: "#111", fontSize: 22, fontWeight: 750 }}>
              {String(row.original.contract_no || row.original.key).slice(-3)}
              <Box sx={{ position: "absolute", inset: "auto 0 0", bgcolor: "#181918", color: "#fff", py: 0.2, textAlign: "center", fontSize: 8, fontWeight: 650 }}>
                {row.original.lotNumberSummary?.split(",")[0] || "Report"}
              </Box>
            </Box>
          )}
          <Stack spacing={0.25} minWidth={0}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 650,
                lineHeight: 1.25,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.original.title}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              Contract: {row.original.contract_no || "-"}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>{row.original.lotNumberSummary || "No lot summary"}</Typography>
          </Stack>
        </Stack>
      ),
    },
    {
      id: "lotsFmv",
      header: "Lots / FMV",
      enableSorting: false,
      cell: ({ row }) => (
        <Stack spacing={0.4}>
          <Typography variant="body2" sx={{ fontSize: "0.72rem" }}>
            Lot: {String(row.original.fairMarketValue || "").toLowerCase().includes("lot") ? String(row.original.fairMarketValue).match(/\d+/)?.[0] || "-" : row.original.lotNumberSummary ? row.original.lotNumberSummary.split(",").length : "-"}
          </Typography>
          <Typography variant="body2" sx={{ fontSize: "0.72rem" }}>
            FMV: {String(row.original.fairMarketValue || "").toLowerCase().includes("lot") ? "-" : formatFMV(row.original.fairMarketValue)}
          </Typography>
        </Stack>
      ),
    },
    {
      id: "reportType",
      accessorFn: (row) => getReportTypeLabel(row.reportType),
      header: "Type",
      cell: ({ row }) => <Typography variant="body2" sx={{ fontSize: "0.72rem" }}>{getReportTypeLabel(row.original.reportType)}</Typography>,
    },
    {
      id: "createdAt",
      accessorFn: (row) => new Date(row.createdAt).getTime(),
      header: "Created",
      cell: ({ row }) => (
        <Stack spacing={0.2} minWidth={0}>
          <Typography variant="body2" sx={{ fontSize: "0.72rem", lineHeight: 1.25 }}>{new Date(row.original.createdAt).toLocaleDateString()}</Typography>
          <Typography variant="body2" sx={{ fontSize: "0.72rem", lineHeight: 1.25 }}>{new Date(row.original.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>by {row.original.userEmail || "-"}</Typography>
        </Stack>
      ),
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => {
        const status = getReportStatusPresentation(row.original);
        return (
          <Stack spacing={0.5} alignItems="center">
            <Chip
              size="small"
              label={status.label}
              sx={{
                height: 23,
                bgcolor: status.background,
                color: status.color,
                border: "1px solid",
                borderColor: status.border,
                fontSize: "0.62rem",
              }}
            />
            {row.original.released_at ? <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.56rem" }}>{new Date(row.original.released_at).toLocaleString()}</Typography> : null}
          </Stack>
        );
      },
    },
    {
      id: "files",
      header: "Files",
      enableSorting: false,
      cell: ({ row }) => renderDesktopFiles(row.original),
    },
    {
      id: "actions",
      enableSorting: false,
      header: "Actions",
      cell: ({ row }) => renderDesktopRowActions(row.original),
    },
  ];

  const table = useReactTable({
    data: groups,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
    pageCount: totalPages,
    rowCount: data?.total ?? groups.length,
  });

  const rows = table.getRowModel().rows;
  const currentPage = pagination.pageIndex + 1;
  const pageValues = Array.from(new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages].filter((value) => value >= 1 && value <= totalPages))).sort((a, b) => a - b);

  return (
    <div className="admin-page-shell desktop-admin-page">
      <main className="w-full min-w-0 max-w-none mx-auto space-y-3 overflow-x-hidden">
        <header className="mb-5">
          <div className="flex items-center gap-2">
            <h1 className="desktop-page-title">{archiveMode === "archived" ? "Archived Reports" : "Approved Reports"}</h1>
            <span className="inline-flex min-w-8 items-center justify-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
              {data?.total ?? 0}
            </span>
          </div>
          <p className="desktop-page-subtitle">{archiveMode === "archived" ? "Reports moved out of the active workspace." : "Reports that have been approved and released."}</p>
        </header>

        <section className="desktop-flat-panel p-3">
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "minmax(220px, 2fr) 130px minmax(150px, 1fr) minmax(150px, 1fr)", xl: "minmax(220px,1fr) 130px 150px 12px 150px minmax(140px,0.75fr) 128px auto auto" }, gap: 1, alignItems: "center" }}>
            <TextField
              fullWidth
              size="small"
              value={q}
              onChange={(event) => { setQ(event.target.value); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }}
              placeholder="Search reports..."
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 18, color: "text.secondary" }} /></InputAdornment> }}
            />
            <FormControl fullWidth size="small">
              <Select value={reportType} displayEmpty onChange={(event) => { setReportType(event.target.value); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }}>
                <MenuItem value="">All Types</MenuItem>
                <MenuItem value="RealEstate">Real Estate</MenuItem>
                <MenuItem value="Salvage">Salvage</MenuItem>
                <MenuItem value="Asset">Asset</MenuItem>
                <MenuItem value="LotListing">Lot Listing</MenuItem>
              </Select>
            </FormControl>
            <TextField fullWidth size="small" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }} inputProps={{ "aria-label": "From date" }} />
            <Typography sx={{ display: { xs: "none", xl: "block" }, color: "text.secondary", textAlign: "center", fontSize: 12 }}>-</Typography>
            <TextField fullWidth size="small" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }} inputProps={{ "aria-label": "To date" }} />
            <TextField fullWidth size="small" value={userEmail} onChange={(event) => { setUserEmail(event.target.value); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }} placeholder="All Creators" inputProps={{ "aria-label": "Created by" }} />
            <Stack direction="row" sx={{ height: 40, border: "1px solid", borderColor: "divider", p: 0.25 }}>
              <Button size="small" variant={archiveMode === "active" ? "contained" : "text"} onClick={() => { setArchiveMode("active"); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }} sx={{ minWidth: 58, minHeight: 32 }}>Active</Button>
              <Button size="small" variant={archiveMode === "archived" ? "contained" : "text"} onClick={() => { setArchiveMode("archived"); setPagination((previous) => ({ ...previous, pageIndex: 0 })); }} sx={{ minWidth: 62, minHeight: 32 }}>Archived</Button>
            </Stack>
            <Button variant="contained" onClick={applyTextFiltersNow}>Apply</Button>
            <Stack direction="row" spacing={0.5}>
              <IconButton aria-label="Refresh reports" onClick={() => void load()} disabled={loading} sx={{ width: 40, height: 40, border: "1px solid", borderColor: "divider", borderRadius: "4px" }}><RefreshRoundedIcon sx={{ fontSize: 18 }} /></IconButton>
              <IconButton aria-label="Reset filters" onClick={onReset} sx={{ width: 40, height: 40, border: "1px solid", borderColor: "divider", borderRadius: "4px" }}><RestartAltRoundedIcon sx={{ fontSize: 18 }} /></IconButton>
            </Stack>
          </Box>
        </section>

        {/* List */}
        <section className="desktop-flat-panel overflow-hidden">
          {loading ? (
            <Typography color="text.secondary" sx={{ p: 3 }}>Loading...</Typography>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : (
            <>
              {crSubmitSuccess ? (
                <Alert severity="success" sx={{ mb: 2 }} onClose={() => setCrSubmitSuccess(null)}>
                  {crSubmitSuccess}
                </Alert>
              ) : null}
              {/* Table on md+ */}
              <TableContainer sx={{ display: { xs: "none", xl: "block" }, maxWidth: "100%", overflowX: "hidden" }}>
                <Table
                  className="desktop-reports-table"
                  size="small"
                  sx={{
                    tableLayout: "fixed",
                    width: "100%",
                    minWidth: 0,
                    "& .MuiTableCell-root": {
                      px: 1.5,
                      py: 1,
                      fontSize: "0.72rem",
                      verticalAlign: "middle",
                    },
                    "& .MuiTableHead-root .MuiTableCell-root": {
                      height: 48,
                      fontSize: "0.7rem",
                      fontWeight: 650,
                      bgcolor: "background.paper",
                    },
                  }}
                >
                  <TableHead>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <TableCell
                            key={header.id}
                            align="left"
                            sx={{
                              fontWeight: 700,
                              whiteSpace: "nowrap",
                              width:
                                header.column.id === "title"
                                  ? "20%"
                                  : header.column.id === "lotsFmv"
                                  ? "7%"
                                  : header.column.id === "reportType"
                                  ? "7%"
                                  : header.column.id === "createdAt"
                                  ? "11%"
                                  : header.column.id === "status"
                                  ? "9%"
                                  : header.column.id === "files"
                                  ? "25%"
                                  : header.column.id === "actions"
                                  ? "21%"
                                  : "auto",
                            }}
                          >
                            {header.isPlaceholder ? null : header.column.getCanSort() ? (
                              <TableSortLabel
                                active={!!header.column.getIsSorted()}
                                direction={header.column.getIsSorted() === "desc" ? "desc" : "asc"}
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                              </TableSortLabel>
                            ) : (
                              flexRender(header.column.columnDef.header, header.getContext())
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableHead>
                  <TableBody>
                    {rows.length ? (
                      rows.map((row) => (
                        <TableRow
                          key={row.id}
                          hover
                          sx={{
                            contentVisibility: "auto",
                            containIntrinsicSize: "84px",
                            minHeight: 84,
                          }}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              align="left"
                              sx={{
                                overflow: "hidden",
                              }}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={columns.length}>
                          <Typography color="text.secondary">No {archiveMode === "archived" ? "archived" : "approved"} reports match the current filters.</Typography>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>

              {/* Cards on mobile */}
              <Stack spacing={1.5} sx={{ display: { xs: "flex", xl: "none" }, p: { xs: 1.25, sm: 2 } }}>
                {rows.length ? (
                  rows.map((row) => {
                    const g = row.original;
                    return (
                      <Card
                        key={g.key}
                        variant="outlined"
                        sx={{
                          contentVisibility: "auto",
                          containIntrinsicSize: "260px",
                          borderRadius: 2,
                        }}
                      >
                        <CardContent>
                          <Stack spacing={1.5}>
                            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.5}>
                              <Stack direction="row" spacing={0.75} minWidth={0}>
                              <Stack spacing={0.5} minWidth={0}>
                                <Typography variant="subtitle2" sx={{ wordBreak: "break-word" }}>{g.title}</Typography>
                                <Typography variant="body2" color="text.secondary">Contract: {g.contract_no || "-"}</Typography>
                              </Stack>
                              </Stack>
                              <Chip size="small" variant="outlined" color="secondary" label={getReportTypeLabel(g.reportType)} />
                            </Stack>
                            <Grid container spacing={1.5}>
                              <Grid size={{ xs: 12, sm: 6 }}>
                                <Typography variant="caption" color="text.secondary">FMV</Typography>
                                <Stack sx={{ mt: 0.5 }}>
                                  <Chip size="small" color="success" label={formatFMV(g.fairMarketValue)} sx={{ alignSelf: "flex-start" }} />
                                </Stack>
                              </Grid>
                              <Grid size={{ xs: 12, sm: 6 }}>
                                <Typography variant="caption" color="text.secondary">Created</Typography>
                                <Typography variant="body2">{new Date(g.createdAt).toLocaleString()}</Typography>
                              </Grid>
                              <Grid size={{ xs: 12 }}>
                                <Typography variant="caption" color="text.secondary">Created By</Typography>
                                <Typography variant="body2">{g.userEmail || "-"}</Typography>
                              </Grid>
                            </Grid>
                            {renderReportActions(g, { wrap: true })}
                          </Stack>
                        </CardContent>
                      </Card>
                    );
                  })
                ) : (
                  <Card variant="outlined">
                    <CardContent>
                      <Typography color="text.secondary">No {archiveMode === "archived" ? "archived" : "approved"} reports match the current filters.</Typography>
                    </CardContent>
                  </Card>
                )}
              </Stack>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} sx={{ minHeight: 60, borderTop: "1px solid", borderColor: "divider", px: 2, py: 1.25 }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.72rem" }}>
                  Showing {data?.total ? pagination.pageIndex * pagination.pageSize + 1 : 0} to {Math.min((pagination.pageIndex + 1) * pagination.pageSize, data?.total || 0)} of {data?.total || 0} reports
                </Typography>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <IconButton aria-label="Previous page" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} sx={{ width: 36, height: 36, border: "1px solid", borderColor: "divider", borderRadius: 0 }}><ChevronLeftRoundedIcon /></IconButton>
                  {pageValues.map((value, index) => (
                    <span key={value} className="contents">
                      {index > 0 && value - pageValues[index - 1] > 1 ? <Typography sx={{ px: 0.5, fontSize: 12 }}>...</Typography> : null}
                      <Button variant={value === currentPage ? "contained" : "outlined"} onClick={() => setPagination((previous) => ({ ...previous, pageIndex: value - 1 }))} sx={{ minWidth: 36, width: 36, minHeight: 36, borderRadius: 0, px: 0 }}>{value}</Button>
                    </span>
                  ))}
                  <IconButton aria-label="Next page" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} sx={{ width: 36, height: 36, border: "1px solid", borderColor: "divider", borderRadius: 0 }}><ChevronRightRoundedIcon /></IconButton>
                </Stack>
                <FormControl size="small" sx={{ width: 122 }}>
                  <Select
                    value={pageSizeMode}
                    onChange={(event) => {
                      const value = event.target.value as "5" | "20" | "50" | "100" | "all" | "custom";
                      if (value === "5" || value === "20" || value === "50" || value === "100") return applyPageSize(Number(value), value);
                      if (value === "all") return applyPageSize(LARGE_PAGE_SIZE, "all");
                      setPageSizeMode("custom");
                      commitCustomPageSize();
                    }}
                  >
                    <MenuItem value="5">5 per page</MenuItem>
                    <MenuItem value="20">20 per page</MenuItem>
                    <MenuItem value="50">50 per page</MenuItem>
                    <MenuItem value="100">100 per page</MenuItem>
                    <MenuItem value="all">500 per page</MenuItem>
                    <MenuItem value="custom">Custom</MenuItem>
                  </Select>
                </FormControl>
              </Stack>
            </>
          )}
        </section>
      </main>
      <Dialog
        open={sameContractOpen}
        onClose={() => {
          setSameContractOpen(false);
          setSameContractCurrentKey("");
        }}
        fullWidth
        maxWidth={false}
        slotProps={{ backdrop: { sx: { bgcolor: "rgba(0,0,0,0.10)", backdropFilter: "blur(2px)" } } }}
        PaperProps={{
          sx: {
            width: { xs: "calc(100vw - 16px)", sm: "min(1280px, calc(100vw - 32px))" },
            height: { xs: "90vh", sm: "82vh" },
            maxHeight: { xs: "90vh", sm: "82vh" },
            m: { xs: 1, sm: 2 },
            borderRadius: "4px",
            overflow: "hidden",
            bgcolor: "#fff",
            backgroundImage: "none",
          },
        }}
      >
        <DialogTitle sx={{ position: "relative", flex: "0 0 auto", borderBottom: "1px solid #dedfe1", px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 2.5 }, pb: { xs: 2, sm: 2.25 } }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
            <Box>
              <Typography component="h2" sx={{ color: "#17191d", fontSize: 16, fontWeight: 500, lineHeight: 1 }}>Same Contract Reports</Typography>
              <Typography sx={{ mt: 1, color: "#737773", fontSize: 14, lineHeight: "20px" }}>Exact contract {sameContractNumber || "-"}. Every report and file remains independent.</Typography>
            </Box>
            <IconButton
              aria-label="Close same contract reports"
              onClick={() => {
                setSameContractOpen(false);
                setSameContractCurrentKey("");
              }}
              sx={{ position: "absolute", top: 8, right: 8, width: 28, height: 28, border: "1px solid #dedfe1", borderRadius: "3px", color: "#555955" }}
            >
              <CloseRoundedIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent sx={{ minHeight: 0, flex: 1, overflow: "auto", bgcolor: "#fff", p: { xs: 1.5, sm: 2.5 }, "&&": { pt: { xs: 1.5, sm: 2.5 } } }}>
          {sameContractError ? <Alert severity="error" sx={{ mb: 2, borderRadius: "3px" }}>{sameContractError}</Alert> : null}
          {sameContractLoading ? <Box sx={{ display: "grid", height: "100%", minHeight: 220, placeItems: "center" }}><CircularProgress size={26} sx={{ color: "#df111b" }} /></Box> : null}
          {!sameContractLoading && !sameContractError && !sameContractGroups.length ? (
            <Box sx={{ display: "grid", height: 208, placeItems: "center", border: "1px solid #dedfe1", color: "#737773", textAlign: "center" }}>
              <Box><TableRowsRoundedIcon sx={{ mb: 1, fontSize: 24 }} /><Typography sx={{ fontSize: 13 }}>No other reports use this exact contract.</Typography></Box>
            </Box>
          ) : null}
          {!sameContractLoading && sameContractGroups.length ? (
            <Stack spacing={1}>
              {sameContractGroups.map((report) => {
                const files = buildFileLinks(report);
                return (
                  <Box
                    component="article"
                    key={report.key}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr", md: "minmax(280px, 1.2fr) 140px 180px minmax(280px, 1fr)" },
                      alignItems: { md: "center" },
                      gap: 2,
                      border: "1px solid #dedfe1",
                      p: 2,
                    }}
                  >
                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minWidth: 0 }}>
                      {report.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={report.thumbnailUrl} alt="" loading="lazy" style={{ width: 56, height: 56, flex: "0 0 auto", border: "1px solid #dedfe1", objectFit: "cover" }} />
                      ) : (
                        <Box sx={{ display: "grid", width: 56, height: 56, flex: "0 0 auto", placeItems: "center", border: "1px solid #dedfe1", bgcolor: "#f4f5f5" }}><TableRowsRoundedIcon sx={{ fontSize: 21, color: "#737773" }} /></Box>
                      )}
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
                          <Typography noWrap sx={{ minWidth: 0, color: "#17191d", fontSize: 14, fontWeight: 650 }}>{report.title}</Typography>
                          {report.key === sameContractCurrentKey ? <Chip label="Current" size="small" sx={{ height: 21, borderRadius: "10px", bgcolor: "#eef0f1", color: "#4b4f4b", fontSize: 10, fontWeight: 650 }} /> : null}
                        </Stack>
                        <Typography noWrap sx={{ mt: 0.5, color: "#737773", fontSize: 11 }}>{report.lotNumberSummary || "No lot summary"}</Typography>
                      </Box>
                    </Stack>
                    <Box><Typography sx={{ color: "#737773", fontSize: 11 }}>Created</Typography><Typography sx={{ mt: 0.5, color: "#17191d", fontSize: 13 }}>{new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(report.createdAt))}</Typography></Box>
                    <Box sx={{ minWidth: 0 }}><Typography sx={{ color: "#737773", fontSize: 11 }}>Owner</Typography><Typography noWrap sx={{ mt: 0.5, color: "#17191d", fontSize: 13 }}>{report.userDisplayName || report.userEmail || "Unknown"}</Typography></Box>
                    <Stack direction="row" justifyContent={{ md: "flex-end" }} spacing={0.75} useFlexGap flexWrap="wrap">
                      {files.map((file) => {
                        const blockReason = getFileBlockReason(report, file);
                        return (
                          <Tooltip key={`${report.key}-${file.label}`} title={blockReason || file.label}>
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                aria-disabled={Boolean(blockReason)}
                                onClick={blockReason ? () => setDownloadNotice(blockReason) : undefined}
                                {...(!blockReason && file.href
                                  ? {
                                      href: file.href,
                                      ...(file.download
                                        ? { download: true }
                                        : { target: "_blank", rel: "noopener noreferrer" }),
                                    }
                                  : {})}
                                sx={{
                                  minWidth: "auto",
                                  minHeight: 28,
                                  borderRadius: "3px",
                                  borderColor: blockReason ? "#d8dde3" : "#dedfe1",
                                  bgcolor: blockReason ? "#f4f6f8" : undefined,
                                  px: 1.25,
                                  color: blockReason ? "#7b8794" : "#17191d",
                                  cursor: blockReason ? "pointer" : undefined,
                                  fontSize: 11,
                                  fontWeight: 600,
                                  textTransform: "none",
                                  boxShadow: "none",
                                  "&:hover": {
                                    borderColor: blockReason ? "#b8c1cb" : "#b9bcbe",
                                    bgcolor: blockReason ? "#e9edf1" : "#f7f8f8",
                                    boxShadow: "none",
                                  },
                                  "&.Mui-focusVisible": {
                                    borderColor: "#df111b",
                                    boxShadow: "0 0 0 2px rgba(223,17,27,0.28)",
                                  },
                                }}
                              >
                                {file.label}
                              </Button>
                            </span>
                          </Tooltip>
                        );
                      })}
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmModal
        open={confirmOpen}
        title="Delete this report?"
        description={
          <>
            This action cannot be undone. The report file (if present) and its
            record will be permanently removed.
          </>
        }
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={confirmDelete}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingDeleteId(null);
        }}
        loading={deleting}
      />
      {excelCrTarget ? (
        <ExcelConditionReportEditorDialog
          open
          reportId={excelCrTarget.key}
          reportTitle={excelCrTarget.title}
          onClose={() => setExcelCrTarget(null)}
          onSaved={handleExcelCrSaved}
        />
      ) : null}
      <Snackbar
        open={Boolean(downloadNotice)}
        autoHideDuration={7000}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        onClose={() => setDownloadNotice(null)}
      >
        <Alert
          severity="warning"
          variant="filled"
          onClose={() => setDownloadNotice(null)}
          sx={{ width: "100%", maxWidth: 620 }}
        >
          {downloadNotice}
        </Alert>
      </Snackbar>
    </div>
  );
}
