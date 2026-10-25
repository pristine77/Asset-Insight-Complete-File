"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, CircularProgress,
  Dialog, DialogContent, DialogTitle, FormControl, IconButton, InputAdornment,
  MenuItem, Pagination, Select, Skeleton, Snackbar, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import ArchiveRoundedIcon from "@mui/icons-material/ArchiveRounded";
import AssessmentRoundedIcon from "@mui/icons-material/AssessmentRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DataObjectRoundedIcon from "@mui/icons-material/DataObjectRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import InsertDriveFileRoundedIcon from "@mui/icons-material/InsertDriveFileRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import NoteAltRoundedIcon from "@mui/icons-material/NoteAltRounded";
import PictureAsPdfRoundedIcon from "@mui/icons-material/PictureAsPdfRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import RestoreRoundedIcon from "@mui/icons-material/RestoreRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TableChartRoundedIcon from "@mui/icons-material/TableChartRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import ConfirmModal from "@/app/components/common/ConfirmModal";

const ExcelConditionReportEditorDialog = dynamic(
  () => import("@/app/components/reports/ExcelConditionReportEditorDialog"),
  { ssr: false }
);
const ReleasedAppraisalInsights = dynamic(() => import("./ReleasedAppraisalInsights"), {
  ssr: false,
});

type ArtifactKind = "cr-pdf" | "cr-docx" | "appraisal-docx" | "excel" | "images";
type Artifact = {
  kind: ArtifactKind;
  available: boolean;
  downloadUrl: string | null;
  filename: string;
  reasonCode: string | null;
  reason: string | null;
  recoverable: boolean;
};
type Finding = {
  code: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  lotNumber?: string;
  actionTarget?: "data" | "cr-notes" | "proposal-valuation" | "regenerate";
};
type ReleasedRow = {
  id: string;
  title: string;
  contractNo: string;
  currency: string;
  lotCount: number;
  lotNumberSummary: string;
  lotThumbnails: Array<{ lotId: string; lotNumber: string; title: string; imageUrl: string | null }>;
  fmv: number;
  creator: { id: string; name: string; email: string; avatarUrl: string | null };
  createdAt: string;
  releasedAt: string;
  releaseTurnaroundMs: number | null;
  archived: boolean;
  artifacts: Record<ArtifactKind, Artifact>;
  qualitySummary: {
    issueCount: number;
    counts: { critical: number; warning: number; info: number };
    highestSeverity: "critical" | "warning" | "info" | null;
    imageCoveragePercent: number;
  };
  qualityFindings: Finding[];
};
type ReleasedResponse = {
  items: ReleasedRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type Creator = { _id: string; email?: string; username?: string; label?: string };
type SameContractRow = {
  _id?: string;
  id?: string;
  title?: string;
  contract_no?: string;
  contractNo?: string;
  createdAt?: string;
  user?: { email?: string; username?: string } | string;
  username?: string;
  email?: string;
  lots?: unknown[];
  preview_data?: { lots?: unknown[] };
  preview_files?: { spec_pdf?: string; pdf?: string; cr_docx?: string; docx?: string; excel?: string; images?: string };
};
type ConfirmAction = { kind: "archive" | "restore" | "delete"; row: ReleasedRow } | null;

const artifactDisplay: Array<{ kind: ArtifactKind; label: string; icon: typeof DescriptionRoundedIcon }> = [
  { kind: "cr-pdf", label: "CR", icon: PictureAsPdfRoundedIcon },
  { kind: "cr-docx", label: "CR DOCX", icon: DescriptionRoundedIcon },
  { kind: "appraisal-docx", label: "DOCX", icon: InsertDriveFileRoundedIcon },
  { kind: "excel", label: "Excel", icon: TableChartRoundedIcon },
  { kind: "images", label: "Images", icon: ImageRoundedIcon },
];
const issueOptions = [
  ["all", "All QA states"], ["critical", "Critical issues"], ["warning", "Warnings"],
  ["missing-artifacts", "Missing artifacts"], ["valuation", "Valuation issues"],
  ["images", "Image coverage"], ["duplicates", "Duplicate identifiers"],
  ["turnaround", "Slow turnaround"],
] as const;
const sortOptions = [
  ["released_desc", "Newest release"], ["released_asc", "Oldest release"],
  ["fmv_desc", "Highest FMV"], ["fmv_asc", "Lowest FMV"],
  ["lots_desc", "Most lots"], ["issues_desc", "Most QA issues"],
] as const;
const compactButtonSx = {
  minWidth: 0, width: "100%", minHeight: 38, height: "100%", px: 0.65, py: 0.55,
  borderRadius: 1, borderColor: "divider", color: "text.primary", fontSize: 9.75,
  fontWeight: 750, lineHeight: 1.05, textAlign: "center", textTransform: "none",
  whiteSpace: "normal", overflowWrap: "anywhere",
  "& .MuiButton-startIcon": { mx: 0, mr: 0.45, flex: "0 0 auto" },
  "&:hover": { borderColor: "text.secondary", bgcolor: "action.hover" },
};

const actionGridSx = (cardLayout: boolean, kind: "files" | "actions") => ({
  display: "grid",
  gridTemplateColumns: cardLayout
    ? { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(3, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }
    : kind === "files" ? "repeat(3, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))",
  gap: 0.5,
  width: "100%",
  minWidth: 0,
  alignItems: "stretch",
  "& > *": { minWidth: 0, width: "100%" },
});

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency", currency: currency || "CAD", maximumFractionDigits: 0,
  }).format(Number(value || 0));
}
function formatDateTime(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function formatDuration(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "Not available";
  const hours = value / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
  return `${(hours / 86_400_000).toFixed(1)} days`;
}
function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback;
}

function getSameContractId(row: SameContractRow) {
  return String(row._id || row.id || "");
}

function getSameContractTitle(row: SameContractRow) {
  return row.title || `Asset - ${row.contract_no || row.contractNo || "Untitled"}`;
}

function getSameContractOwner(row: SameContractRow) {
  if (typeof row.user === "object" && row.user) {
    return row.user.username || row.user.email || "Unknown user";
  }
  return row.username || row.email || "Unknown user";
}

function getSameContractLotCount(row: SameContractRow) {
  if (Array.isArray(row.lots)) return row.lots.length;
  if (Array.isArray(row.preview_data?.lots)) return row.preview_data.lots.length;
  return 0;
}

function getSameContractFiles(row: SameContractRow) {
  const files = row.preview_files || {};
  return [
    ["CR", files.spec_pdf || files.pdf],
    ["CR DOCX", files.cr_docx],
    ["DOCX", files.docx],
    ["Excel", files.excel],
    ["Images", files.images],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function QualityChip({ row }: { row: ReleasedRow }) {
  const { counts, issueCount } = row.qualitySummary;
  if (!issueCount) return <Chip size="small" color="success" variant="outlined" label="QA clear" />;
  const critical = counts.critical > 0;
  return (
    <Tooltip title={`${counts.critical} critical, ${counts.warning} warning, ${counts.info} informational`}>
      <Chip size="small" color={critical ? "error" : "warning"}
        icon={critical ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
        label={`${issueCount} ${issueCount === 1 ? "issue" : "issues"}`} />
    </Tooltip>
  );
}

function ReportThumbnail({ row, tick, paused, onPause }: {
  row: ReleasedRow; tick: number; paused: boolean; onPause: (value: boolean) => void;
}) {
  const thumbnails = row.lotThumbnails.filter((item) => Boolean(item.imageUrl));
  const current = thumbnails[thumbnails.length ? (paused ? 0 : tick % thumbnails.length) : 0];
  return (
    <Box tabIndex={thumbnails.length > 1 ? 0 : -1} onMouseEnter={() => onPause(true)}
      onMouseLeave={() => onPause(false)} onFocus={() => onPause(true)} onBlur={() => onPause(false)}
      sx={{ position: "relative", width: 66, height: 58, flex: "0 0 66px", overflow: "hidden",
        border: "1px solid", borderColor: "divider", bgcolor: "action.hover" }}>
      {current?.imageUrl ? <Box component="img" src={current.imageUrl} alt={current.title || row.title}
        loading="lazy" sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        : <Box sx={{ display: "grid", placeItems: "center", height: "100%" }}><ImageRoundedIcon color="disabled" /></Box>}
      {current?.lotNumber ? <Box sx={{ position: "absolute", left: 3, bottom: 3, maxWidth: "calc(100% - 6px)",
        bgcolor: "rgba(0,0,0,.76)", color: "white", px: 0.5, py: 0.2, fontSize: 9,
        fontWeight: 800, lineHeight: 1 }}>Lot {current.lotNumber}</Box> : null}
    </Box>
  );
}

function ArtifactButton({ artifact }: { artifact: Artifact }) {
  const config = artifactDisplay.find((item) => item.kind === artifact.kind);
  if (!config) return null;
  const Icon = config.icon;
  const reason = artifact.available ? `Download ${config.label}: ${artifact.filename}`
    : artifact.reason || `${config.label} is not available.`;
  return (
    <Tooltip title={reason} arrow><span style={{ display: "block", width: "100%" }}>
      <Button component={artifact.available ? "a" : "button"} href={artifact.available ? artifact.downloadUrl || undefined : undefined}
        download={artifact.available ? artifact.filename : undefined} variant="outlined" disabled={!artifact.available}
        startIcon={<Icon sx={{ fontSize: "16px !important" }} />} sx={compactButtonSx}>{config.label}</Button>
    </span></Tooltip>
  );
}

export default function ReleasedAppraisalsWorkspace() {
  const router = useRouter();
  const theme = useTheme();
  const compactView = useMediaQuery(theme.breakpoints.down("xl"));
  const [data, setData] = useState<ReleasedResponse | null>(null);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [creator, setCreator] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [issue, setIssue] = useState("all");
  const [sort, setSort] = useState("released_desc");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [thumbnailTick, setThumbnailTick] = useState(0);
  const [pausedThumbnail, setPausedThumbnail] = useState<string | null>(null);
  const [sameContract, setSameContract] = useState<{ open: boolean; row: ReleasedRow | null;
    loading: boolean; error: string | null; items: SameContractRow[] }>(
    { open: false, row: null, loading: false, error: null, items: [] }
  );
  const [crNotesRow, setCrNotesRow] = useState<ReleasedRow | null>(null);
  const [insightsRow, setInsightsRow] = useState<ReleasedRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState<{ severity: "success" | "error"; message: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const dataRef = useRef<ReleasedResponse | null>(null);

  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!data?.items.some((row) => row.lotThumbnails.filter((item) => item.imageUrl).length > 1)) return;
    const timer = window.setInterval(() => setThumbnailTick((value) => value + 1), 4500);
    return () => window.clearInterval(timer);
  }, [data?.items]);

  const load = useCallback(async (manual = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!dataRef.current) setLoading(true);
    if (manual || dataRef.current) setRefreshing(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(limit), issue, sort,
      archived: String(archived) });
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (creator) params.set("creator", creator);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const response = await fetch(`/api/admin/released-appraisals?${params}`, {
        cache: "no-store", signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to load released appraisals");
      setData(body as ReleasedResponse);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") setError(errorMessage(loadError, "Unable to load released appraisals"));
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    }
  }, [archived, creator, debouncedSearch, from, issue, limit, page, sort, to]);

  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/report-creators", { cache: "no-store", signal: controller.signal })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => { if (ok) setCreators(Array.isArray(body?.items) ? body.items : []); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const resetFilters = () => {
    setSearch(""); setDebouncedSearch(""); setCreator(""); setFrom(""); setTo("");
    setIssue("all"); setSort("released_desc"); setPage(1);
  };

  const openSameContract = useCallback(async (row: ReleasedRow) => {
    setSameContract({ open: true, row, loading: true, error: null, items: [] });
    try {
      const params = new URLSearchParams({ contractNo: row.contractNo, archived: String(archived) });
      const response = await fetch(`/api/admin/reports/same-contract?${params}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to load reports for this contract");
      setSameContract((previous) => ({ ...previous, loading: false,
        items: Array.isArray(body?.items) ? body.items : [] }));
    } catch (sameContractError) {
      setSameContract((previous) => ({ ...previous, loading: false,
        error: errorMessage(sameContractError, "Unable to load reports for this contract") }));
    }
  }, [archived]);

  const regenerate = useCallback(async (row: ReleasedRow) => {
    setActionLoading(true);
    try {
      const response = await fetch(`/api/admin/reports/${encodeURIComponent(row.id)}/rerun-excel-cr`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to regenerate report files");
      setToast({ severity: "success", message: "File regeneration started." });
      await load(true);
    } catch (regenerateError) {
      setToast({ severity: "error", message: errorMessage(regenerateError, "Unable to regenerate report files") });
    } finally { setActionLoading(false); }
  }, [load]);

  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    const { kind, row } = confirmAction;
    try {
      const endpoint = kind === "delete" ? `/api/admin/reports/${encodeURIComponent(row.id)}`
        : `/api/admin/reports/${encodeURIComponent(row.id)}/${kind}`;
      const response = await fetch(endpoint, { method: kind === "delete" ? "DELETE" : "PATCH" });
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || `Unable to ${kind} report`);
      setConfirmAction(null);
      setToast({ severity: "success", message: kind === "delete" ? "Report deleted."
        : kind === "archive" ? "Report archived." : "Report restored." });
      await load(true);
    } catch (actionError) {
      setToast({ severity: "error", message: errorMessage(actionError, "Unable to update report") });
    } finally { setActionLoading(false); }
  };

  const insightAction = useCallback((target: NonNullable<Finding["actionTarget"]>) => {
    if (!insightsRow) return;
    if (target === "data") router.push(`/reports/${insightsRow.id}/data?from=approvals`);
    if (target === "proposal-valuation") router.push(`/reports/${insightsRow.id}/pv?from=approvals`);
    if (target === "cr-notes") setCrNotesRow(insightsRow);
    if (target === "regenerate") void regenerate(insightsRow);
  }, [insightsRow, regenerate, router]);

  const items = data?.items || [];

  // One clock drives every visible carousel, avoiding one timer per report row.
  const reportIdentity = (row: ReleasedRow) => (
    <Stack direction="row" spacing={1.2} alignItems="center" sx={{ minWidth: 0 }}>
      <ReportThumbnail row={row} tick={thumbnailTick} paused={pausedThumbnail === row.id}
        onPause={(value) => setPausedThumbnail(value ? row.id : null)} />
      <Box sx={{ minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 800 }}>{row.title}</Typography>
        <Typography noWrap color="text.secondary" sx={{ fontSize: 11.5 }}>Contract: {row.contractNo}</Typography>
        <Typography noWrap color="text.secondary" sx={{ fontSize: 11.5 }}>
          {row.lotNumberSummary ? `Lots ${row.lotNumberSummary}` : "No lot numbers"}
        </Typography>
      </Box>
    </Stack>
  );

  const fileActions = (row: ReleasedRow, cardLayout = false) => (
    <Box sx={actionGridSx(cardLayout, "files")}>
      <Tooltip title="Open complete saved report data"><Button variant="outlined"
        startIcon={<DataObjectRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => router.push(`/reports/${row.id}/data?from=approvals`)} sx={compactButtonSx}>Data</Button></Tooltip>
      {artifactDisplay.map(({ kind }) => <ArtifactButton key={kind} artifact={row.artifacts[kind]} />)}
    </Box>
  );

  const rowActions = (row: ReleasedRow, cardLayout = false) => {
    const recoverable = Object.values(row.artifacts).some((artifact) => !artifact.available && artifact.recoverable);
    return <Box sx={actionGridSx(cardLayout, "actions")}>
      <Tooltip title="Open Proposal Valuation"><Button variant="outlined" startIcon={<AssessmentRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => router.push(`/reports/${row.id}/pv?from=approvals`)} sx={compactButtonSx}>Valuation</Button></Tooltip>
      <Tooltip title="View reports with this exact contract number"><Button variant="outlined" startIcon={<LinkRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => void openSameContract(row)} sx={compactButtonSx}>Same contract</Button></Tooltip>
      <Tooltip title="Edit per-lot CR notes"><Button variant="outlined" startIcon={<NoteAltRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => setCrNotesRow(row)} sx={compactButtonSx}>CR Notes</Button></Tooltip>
      <Tooltip title="Quality review and advisory analysis"><Button variant="outlined" startIcon={<AutoAwesomeRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => setInsightsRow(row)} sx={{ ...compactButtonSx, color: "#b91c1c" }}>Insights</Button></Tooltip>
      {recoverable ? <Tooltip title="Recover missing generated files"><Button variant="outlined" disabled={actionLoading}
        startIcon={<RestartAltRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => void regenerate(row)} sx={compactButtonSx}>Recover</Button></Tooltip> : null}
      <Tooltip title={archived ? "Restore appraisal" : "Archive appraisal"}><Button variant="outlined"
        startIcon={archived ? <RestoreRoundedIcon sx={{ fontSize: "16px !important" }} /> : <ArchiveRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => setConfirmAction({ kind: archived ? "restore" : "archive", row })}
        sx={compactButtonSx}>{archived ? "Restore" : "Archive"}</Button></Tooltip>
      <Tooltip title="Delete report permanently"><Button color="error" variant="outlined"
        startIcon={<DeleteOutlineRoundedIcon sx={{ fontSize: "16px !important" }} />}
        onClick={() => setConfirmAction({ kind: "delete", row })}
        sx={{ ...compactButtonSx, borderColor: "error.light", color: "error.main" }}>Delete</Button></Tooltip>
    </Box>;
  };

  const confirmTitle = confirmAction?.kind === "delete" ? "Delete released appraisal?"
    : confirmAction?.kind === "restore" ? "Restore released appraisal?" : "Archive released appraisal?";

  return (
    <div className="admin-page-shell desktop-admin-page">
      <Stack spacing={2.25} sx={{ minWidth: 0, maxWidth: "100%", overflowX: "clip" }}>
        <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ xs: "stretch", sm: "center" }}
          justifyContent="space-between" spacing={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography component="h1" className="desktop-page-title">Released Appraisals</Typography>
              <Chip size="small" label={data?.total ?? 0} sx={{ height: 24, fontWeight: 800 }} />
            </Stack>
            <Typography className="desktop-page-subtitle">
              Review released Asset reports, recover files, and inspect appraisal quality.
            </Typography>
          </Box>
          <Button variant="outlined" startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshRoundedIcon />}
            onClick={() => void load(true)} disabled={refreshing} sx={{ borderRadius: 1, alignSelf: { xs: "flex-start", sm: "center" } }}>
            Refresh
          </Button>
        </Stack>

        <Card variant="outlined" sx={{ borderRadius: 1, boxShadow: "none" }}>
          <CardContent sx={{ p: { xs: 1.5, md: 2 }, "&:last-child": { pb: { xs: 1.5, md: 2 } } }}>
            <Box sx={{ display: "grid", gap: 1,
              gridTemplateColumns: { xs: "1fr", sm: "minmax(220px,2fr) 1fr", lg: "minmax(250px,2fr) 150px 150px 150px minmax(170px,1fr) 170px" } }}>
              <TextField size="small" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, contract, lot, or creator"
                InputProps={{ startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> }} />
              <TextField select size="small" label="Creator" value={creator}
                onChange={(event) => { setCreator(event.target.value); setPage(1); }}>
                <MenuItem value="">All creators</MenuItem>
                {creators.map((item) => <MenuItem key={item._id} value={item._id}>
                  {item.label || item.username || item.email || item._id}
                </MenuItem>)}
              </TextField>
              <TextField size="small" label="Released from" type="date" value={from}
                InputLabelProps={{ shrink: true }} onChange={(event) => { setFrom(event.target.value); setPage(1); }} />
              <TextField size="small" label="Released to" type="date" value={to}
                InputLabelProps={{ shrink: true }} onChange={(event) => { setTo(event.target.value); setPage(1); }} />
              <TextField select size="small" label="Quality" value={issue}
                onChange={(event) => { setIssue(event.target.value); setPage(1); }}>
                {issueOptions.map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Sort" value={sort}
                onChange={(event) => { setSort(event.target.value); setPage(1); }}>
                {sortOptions.map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
              </TextField>
            </Box>
            <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }}
              spacing={1} sx={{ mt: 1.25 }}>
              <ToggleButtonGroup exclusive size="small" value={archived ? "archived" : "active"}
                onChange={(_, value: "active" | "archived" | null) => {
                  if (!value) return;
                  setArchived(value === "archived"); setPage(1);
                }} sx={{ alignSelf: { xs: "stretch", sm: "auto" }, "& .MuiToggleButton-root": { px: 2, py: 0.65, textTransform: "none", fontWeight: 750 } }}>
                <ToggleButton value="active">Active</ToggleButton>
                <ToggleButton value="archived">Archived</ToggleButton>
              </ToggleButtonGroup>
              <Button color="inherit" variant="text" startIcon={<RestartAltRoundedIcon />} onClick={resetFilters}
                sx={{ alignSelf: { xs: "flex-start", sm: "center" }, textTransform: "none" }}>Reset filters</Button>
            </Stack>
          </CardContent>
        </Card>

        {error ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void load(true)}>Retry</Button>}>
          {error}
        </Alert> : null}

        {loading && !data ? <Stack spacing={1}>{Array.from({ length: 5 }, (_, index) =>
          <Skeleton key={index} variant="rectangular" height={96} sx={{ borderRadius: 1 }} />)}</Stack> : null}

        {!loading && !items.length ? <Card variant="outlined" sx={{ borderRadius: 1, boxShadow: "none" }}>
          <CardContent sx={{ py: 7, textAlign: "center" }}>
            <AssessmentRoundedIcon color="disabled" sx={{ fontSize: 44 }} />
            <Typography sx={{ mt: 1, fontWeight: 800 }}>No released appraisals match these filters</Typography>
            <Typography variant="body2" color="text.secondary">Reset filters or switch between active and archived records.</Typography>
          </CardContent>
        </Card> : null}

        {!loading && items.length && compactView ? <Stack spacing={1.25}>
          {items.map((row) => <Card key={row.id} variant="outlined" sx={{ borderRadius: 1, boxShadow: "none" }}>
            <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1.25}>
                {reportIdentity(row)}
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" color="success" variant="outlined" label="Released" />
                  <QualityChip row={row} />
                </Stack>
              </Stack>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2,minmax(0,1fr))", md: "repeat(4,minmax(0,1fr))" },
                gap: 0, mt: 1.4, border: "1px solid", borderColor: "divider" }}>
                {[
                  ["Lots / FMV", `${row.lotCount} lots · ${money(row.fmv, row.currency)}`],
                  ["Creator", row.creator.name || row.creator.email],
                  ["Released", formatDateTime(row.releasedAt)],
                  ["Turnaround", formatDuration(row.releaseTurnaroundMs)],
                ].map(([label, value], index) => <Box key={label} sx={{ p: 1.1, minWidth: 0,
                  borderRight: { xs: index % 2 === 0 ? "1px solid" : 0, md: index < 3 ? "1px solid" : 0 },
                  borderBottom: { xs: index < 2 ? "1px solid" : 0, md: 0 }, borderColor: "divider" }}>
                  <Typography sx={{ fontSize: 10, fontWeight: 800, color: "text.secondary", textTransform: "uppercase" }}>{label}</Typography>
                  <Typography noWrap title={value} sx={{ mt: 0.25, fontSize: 12.5, fontWeight: 700 }}>{value}</Typography>
                </Box>)}
              </Box>
              <Box sx={{ mt: 1.25 }}><Typography sx={{ mb: 0.6, fontSize: 10, fontWeight: 800, color: "text.secondary", textTransform: "uppercase" }}>Files</Typography>{fileActions(row, true)}</Box>
              <Box sx={{ mt: 1.25 }}><Typography sx={{ mb: 0.6, fontSize: 10, fontWeight: 800, color: "text.secondary", textTransform: "uppercase" }}>Actions</Typography>{rowActions(row, true)}</Box>
            </CardContent>
          </Card>)}
        </Stack> : null}

        {!loading && items.length && !compactView ? <TableContainer component={Card} variant="outlined"
          sx={{ borderRadius: 1, boxShadow: "none", overflow: "hidden", width: "100%", maxWidth: "100%" }}>
          <Table size="small" className="desktop-reports-table" sx={{ width: "100%", tableLayout: "fixed" }}>
            <TableHead><TableRow sx={{ bgcolor: "action.hover" }}>
              <TableCell sx={{ width: "19%", px: 1, fontWeight: 850 }}>Report</TableCell>
              <TableCell sx={{ width: "8%", px: 1, fontWeight: 850 }}>Lots / FMV</TableCell>
              <TableCell sx={{ width: "11%", px: 1, fontWeight: 850 }}>Creator</TableCell>
              <TableCell sx={{ width: "10%", px: 1, fontWeight: 850 }}>Released</TableCell>
              <TableCell sx={{ width: "10%", px: 1, fontWeight: 850 }}>Quality</TableCell>
              <TableCell sx={{ width: "19%", px: 1, fontWeight: 850 }}>Files</TableCell>
              <TableCell sx={{ width: "23%", px: 1, fontWeight: 850 }}>Actions</TableCell>
            </TableRow></TableHead>
            <TableBody>{items.map((row) => <TableRow key={row.id} hover>
              <TableCell sx={{ px: 1, minWidth: 0, overflow: "hidden" }}>{reportIdentity(row)}</TableCell>
              <TableCell sx={{ px: 1, minWidth: 0, overflow: "hidden" }}><Typography sx={{ fontSize: 12.5, fontWeight: 800 }}>{row.lotCount} lots</Typography>
                <Typography color="text.secondary" sx={{ fontSize: 11.5 }}>{money(row.fmv, row.currency)}</Typography></TableCell>
              <TableCell sx={{ px: 1, minWidth: 0, overflow: "hidden" }}><Stack direction="row" spacing={0.75} alignItems="center"><Avatar src={row.creator.avatarUrl || undefined}
                sx={{ width: 28, height: 28, fontSize: 11 }}>{(row.creator.name || row.creator.email || "?").slice(0, 1).toUpperCase()}</Avatar>
                <Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 12.25, fontWeight: 750 }}>{row.creator.name || "Unnamed user"}</Typography>
                  <Typography noWrap color="text.secondary" sx={{ fontSize: 10.5 }}>{row.creator.email}</Typography></Box></Stack></TableCell>
              <TableCell sx={{ px: 1, minWidth: 0, overflow: "hidden" }}><Typography sx={{ fontSize: 12.25, fontWeight: 700 }}>{formatDateTime(row.releasedAt)}</Typography>
                <Typography color="text.secondary" sx={{ fontSize: 10.5 }}>{formatDuration(row.releaseTurnaroundMs)}</Typography></TableCell>
              <TableCell sx={{ px: 1, minWidth: 0, overflow: "hidden" }}><Stack spacing={0.5} alignItems="flex-start"><QualityChip row={row} />
                <Typography color="text.secondary" sx={{ fontSize: 10.5 }}>{row.qualitySummary.imageCoveragePercent}% image coverage</Typography></Stack></TableCell>
              <TableCell sx={{ px: 1, py: 1, minWidth: 0, verticalAlign: "top" }}>{fileActions(row)}</TableCell>
              <TableCell sx={{ px: 1, py: 1, minWidth: 0, verticalAlign: "top" }}>{rowActions(row)}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </TableContainer> : null}

        {data && data.total > 0 ? <Card variant="outlined" sx={{ borderRadius: 1, boxShadow: "none" }}>
          <CardContent sx={{ py: 1.1, px: 1.5, "&:last-child": { pb: 1.1 } }}>
            <Stack direction={{ xs: "column", md: "row" }} alignItems="center" justifyContent="space-between" spacing={1.25}>
              <Typography variant="body2" color="text.secondary">
                Showing {(data.page - 1) * data.limit + 1}-{Math.min(data.page * data.limit, data.total)} of {data.total}
              </Typography>
              <Pagination count={Math.max(1, data.totalPages)} page={data.page} onChange={(_, value) => setPage(value)}
                color="primary" size="small" showFirstButton showLastButton />
              <FormControl size="small"><Select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}>
                {[25, 50, 100].map((value) => <MenuItem key={value} value={value}>{value} rows</MenuItem>)}
              </Select></FormControl>
            </Stack>
          </CardContent>
        </Card> : null}
      </Stack>

      <Dialog open={sameContract.open} onClose={() => setSameContract((value) => ({ ...value, open: false }))}
        fullWidth maxWidth="lg" PaperProps={{ sx: { width: "min(1120px,94vw)", maxWidth: "94vw", maxHeight: "88vh", borderRadius: 1 } }}>
        <DialogTitle sx={{ pr: 6 }}>
          <Typography component="div" sx={{ fontSize: 20, fontWeight: 850 }}>Same contract appraisals</Typography>
          <Typography variant="body2" color="text.secondary">Exact match for contract {sameContract.row?.contractNo || "-"}. Each report and file remains independent.</Typography>
          <IconButton aria-label="Close same contract reports" onClick={() => setSameContract((value) => ({ ...value, open: false }))}
            sx={{ position: "absolute", right: 12, top: 12 }}><CloseRoundedIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: { xs: 1, md: 2 } }}>
          {sameContract.loading ? <Stack alignItems="center" sx={{ py: 7 }}><CircularProgress size={30} /></Stack> : null}
          {sameContract.error ? <Alert severity="error">{sameContract.error}</Alert> : null}
          {!sameContract.loading && !sameContract.error && !sameContract.items.length ? <Alert severity="info">No other reports use this exact contract number.</Alert> : null}
          {!sameContract.loading && sameContract.items.length ? <TableContainer sx={{ border: "1px solid", borderColor: "divider", maxHeight: "66vh" }}>
            <Table stickyHeader size="small" sx={{ minWidth: 820 }}><TableHead><TableRow>
              <TableCell sx={{ fontWeight: 850 }}>Report</TableCell><TableCell sx={{ fontWeight: 850 }}>Created</TableCell>
              <TableCell sx={{ fontWeight: 850 }}>Owner</TableCell><TableCell sx={{ fontWeight: 850 }}>Lots</TableCell>
              <TableCell sx={{ fontWeight: 850 }}>Files</TableCell>
            </TableRow></TableHead><TableBody>
              {sameContract.items.map((row, index) => <TableRow key={getSameContractId(row) || index} hover>
                <TableCell><Typography sx={{ fontSize: 12.5, fontWeight: 800 }}>{getSameContractTitle(row)}</Typography>
                  <Button size="small" onClick={() => router.push(`/reports/${getSameContractId(row)}/data?from=approvals`)}
                    sx={{ px: 0, minWidth: 0, textTransform: "none" }}>Open data</Button></TableCell>
                <TableCell sx={{ fontSize: 12 }}>{formatDateTime(row.createdAt)}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{getSameContractOwner(row)}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{getSameContractLotCount(row)}</TableCell>
                <TableCell><Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
                  {getSameContractFiles(row).map(([label, url]) => <Button key={`${label}-${url}`} component="a" href={url}
                    target="_blank" rel="noreferrer" size="small" variant="outlined" sx={{ borderRadius: 1, textTransform: "none" }}>{label}</Button>)}
                  {!getSameContractFiles(row).length ? <Typography color="text.secondary" sx={{ fontSize: 11 }}>No legacy links available</Typography> : null}
                </Stack></TableCell>
              </TableRow>)}
            </TableBody></Table>
          </TableContainer> : null}
        </DialogContent>
      </Dialog>

      {crNotesRow ? <ExcelConditionReportEditorDialog open reportId={crNotesRow.id} reportTitle={crNotesRow.title}
        onClose={() => setCrNotesRow(null)} onSaved={() => void load(true)} /> : null}
      {insightsRow ? <ReleasedAppraisalInsights open reportId={insightsRow.id} reportTitle={insightsRow.title}
        onClose={() => setInsightsRow(null)} onAction={insightAction} /> : null}

      <ConfirmModal open={Boolean(confirmAction)} title={confirmTitle}
        description={confirmAction?.kind === "delete"
          ? "This permanently removes the report and cannot be undone. Generated storage objects are not silently reused by another report."
          : confirmAction?.kind === "restore" ? "This report will return to the active Released Appraisals list."
            : "This report will move to Archived and remain recoverable."}
        confirmText={confirmAction?.kind === "delete" ? "Delete report" : confirmAction?.kind === "restore" ? "Restore" : "Archive"}
        onCancel={() => setConfirmAction(null)} onConfirm={() => void runConfirmedAction()} loading={actionLoading} />

      {toast ? <Snackbar open autoHideDuration={4200} onClose={() => setToast(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity={toast.severity} variant="filled" onClose={() => setToast(null)} sx={{ minWidth: 280 }}>{toast.message}</Alert>
      </Snackbar> : null}
    </div>
  );
}
