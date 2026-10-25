"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  LinearProgress,
  MenuItem,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Mail,
  CalendarClock,
  Eye,
  FileClock,
  Files,
  Image as ImageIcon,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from "lucide-react";
import type {
  PreviewReportsResponse,
  PreviewReportSummary,
  PreviewWorkflowStage,
} from "./previewReportTypes";

const PreviewReportDrawer = dynamic(() => import("./PreviewReportDrawer"), {
  ssr: false,
  loading: () => null,
});
const PreviewNotificationComposer = dynamic(() => import("./PreviewNotificationComposer"), { ssr: false });

const DraftPreviewsPanel = dynamic(() => import("./DraftPreviewsPanel"), {
  ssr: false,
  loading: () => (
    <Stack spacing={1} sx={{ mt: 2.5 }}>
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} variant="rounded" height={82} />
      ))}
    </Stack>
  ),
});

const EMPTY_STAGE_COUNTS: Record<PreviewWorkflowStage, number> = {
  preparing_preview: 0,
  preview_ready: 0,
  generating_files: 0,
  awaiting_approval: 0,
  awaiting_release: 0,
  error: 0,
};

const STAGE_META: Record<PreviewWorkflowStage, { label: string; color: "default" | "info" | "warning" | "success" | "error" }> = {
  preparing_preview: { label: "Preparing preview", color: "info" },
  preview_ready: { label: "Preview ready", color: "success" },
  generating_files: { label: "Generating files", color: "info" },
  awaiting_approval: { label: "Awaiting approval", color: "warning" },
  awaiting_release: { label: "Awaiting release", color: "warning" },
  error: { label: "Needs attention", color: "error" },
};

function formatDateTime(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function relativeTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

function stageMeta(stage: PreviewWorkflowStage) {
  return STAGE_META[stage] || { label: stage.replaceAll("_", " "), color: "default" as const };
}

function ReportThumbnail({ report }: { report: PreviewReportSummary }) {
  return report.thumbnailUrl ? (
    <Box
      component="img"
      src={report.thumbnailUrl}
      alt=""
      loading="lazy"
      sx={{ width: 64, height: 54, flexShrink: 0, border: "1px solid", borderColor: "divider", borderRadius: "4px", objectFit: "cover" }}
    />
  ) : (
    <Box sx={{ display: "grid", width: 64, height: 54, flexShrink: 0, placeItems: "center", border: "1px solid", borderColor: "divider", borderRadius: "4px", bgcolor: "action.hover", color: "text.disabled" }}>
      <ImageIcon size={20} />
    </Box>
  );
}

function WorkflowBadge({ report }: { report: PreviewReportSummary }) {
  const meta = stageMeta(report.workflowStage);
  const active = report.workflowStage === "preparing_preview" || report.workflowStage === "generating_files";
  return (
    <Box sx={{ minWidth: 0 }}>
      <Chip size="small" color={meta.color} variant={meta.color === "default" ? "outlined" : "filled"} label={meta.label} sx={{ maxWidth: "100%", borderRadius: "4px", fontWeight: 700 }} />
      {active ? <LinearProgress variant="determinate" value={Math.max(2, report.workflowProgressPercent || 0)} sx={{ mt: 0.9, height: 3 }} /> : null}
      <Typography sx={{ mt: 0.55, color: report.workflowStage === "error" ? "error.main" : "text.secondary", fontSize: 11.5, lineHeight: 1.35 }}>
        {report.jobError || report.workflowMessage}
      </Typography>
    </Box>
  );
}

function ReportCard({
  report,
  onOpen,
  onReminder,
  onDelete,
}: {
  report: PreviewReportSummary;
  onOpen: () => void;
  onReminder: () => void;
  onDelete: () => void;
}) {
  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "5px", bgcolor: "background.paper", p: 1.5 }}>
      <Stack direction="row" spacing={1.25}>
        <ReportThumbnail report={report} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
            <Box sx={{ minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: 14, fontWeight: 750 }}>{report.title}</Typography>
              <Typography noWrap sx={{ mt: 0.2, color: "text.secondary", fontSize: 12 }}>Contract: {report.contractNo || "Not provided"}</Typography>
            </Box>
            <Chip size="small" variant="outlined" label={report.reportType === "Asset" ? "Asset" : "Lot Listing"} sx={{ flexShrink: 0, borderRadius: "3px" }} />
          </Stack>
          <Typography noWrap sx={{ mt: 0.65, color: "text.secondary", fontSize: 12 }}>{report.creatorDisplay}</Typography>
        </Box>
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1, mt: 1.5 }}>
        <Box><Typography sx={{ color: "text.secondary", fontSize: 10.5, fontWeight: 750 }}>WORKLOAD</Typography><Typography sx={{ mt: 0.2, fontSize: 12.5 }}>{report.lotCount} lots · {report.imageCount} images</Typography></Box>
        <Box><Typography sx={{ color: "text.secondary", fontSize: 10.5, fontWeight: 750 }}>LAST ACTIVITY</Typography><Typography sx={{ mt: 0.2, fontSize: 12.5 }}>{relativeTime(report.updatedAt)}</Typography></Box>
      </Box>
      <Box sx={{ mt: 1.25 }}><WorkflowBadge report={report} /></Box>
      <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
        <Button fullWidth variant="outlined" startIcon={<Eye size={16} />} onClick={onOpen} sx={{ borderRadius: "4px" }}>Open full report</Button>
        <Tooltip title="Review an email to the report owner or check a previous delivery">
          <span>
            <Button
              aria-label={`Notify owner about ${report.title}`}
              onClick={onReminder}
              variant="outlined" startIcon={<Mail size={16} />} sx={{ height: "100%" }}
            >
              Notify
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={report.deleteEligible ? "Delete preview report" : report.deleteIneligibleReason || "This preview cannot be deleted."}>
          <span>
            <IconButton
              aria-label={`Delete ${report.title}`}
              color="error"
              disabled={!report.deleteEligible}
              onClick={onDelete}
              sx={{ border: "1px solid", borderColor: "error.light", borderRadius: "4px" }}
            >
              <Trash2 size={17} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

export default function PreviewReportsPage({ initialReportId = null }: { initialReportId?: string | null }) {
  const [viewMode, setViewMode] = useState<"reports" | "drafts">("reports");
  const [data, setData] = useState<PreviewReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [reportType, setReportType] = useState("all");
  const [workflowStage, setWorkflowStage] = useState("all");
  const [creatorId, setCreatorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("updated_desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(initialReportId);
  const [selectedReportReadOnly, setSelectedReportReadOnly] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PreviewReportSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [notificationReportId, setNotificationReportId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ message: string; severity: "success" | "warning" } | null>(null);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (viewMode !== "reports") return;
    const controller = new AbortController();
    const initial = !hasLoadedRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      reportType,
      workflowStage,
      sort,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (creatorId) params.set("creatorId", creatorId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    fetch(`/api/admin/preview-reports?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "Unable to load preview reports.");
        return body as PreviewReportsResponse;
      })
      .then((body) => {
        hasLoadedRef.current = true;
        setData(body);
        if (body.page !== page) setPage(body.page);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Unable to load preview reports.");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [creatorId, debouncedSearch, from, limit, page, reloadToken, reportType, sort, to, viewMode, workflowStage]);

  const hasActiveJobs = data?.items.some((item) => item.workflowStage === "preparing_preview" || item.workflowStage === "generating_files");
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => setReloadToken((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs]);

  const counts = data?.stageCounts || EMPTY_STAGE_COUNTS;
  const visibleStageCards = useMemo(
    () => (["preparing_preview", "preview_ready", "generating_files", "awaiting_approval", "awaiting_release", "error"] as PreviewWorkflowStage[]),
    []
  );

  function resetFilters() {
    setSearch("");
    setDebouncedSearch("");
    setReportType("all");
    setWorkflowStage("all");
    setCreatorId("");
    setFrom("");
    setTo("");
    setSort("updated_desc");
    setPage(1);
  }

  function openReport(reportId: string) {
    setSelectedReportReadOnly(false);
    setSelectedReportId(reportId);
  }

  function openDraftPreview(reportId: string) {
    setSelectedReportReadOnly(true);
    setSelectedReportId(reportId);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/admin/preview-reports/${encodeURIComponent(deleteTarget.id)}`,
        { method: "DELETE" }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to delete this preview report.");

      setSelectedReportId((current) => current === deleteTarget.id ? null : current);
      setData((current) => current ? {
        ...current,
        items: current.items.filter((item) => item.id !== deleteTarget.id),
        total: Math.max(0, current.total - 1),
        stageCounts: {
          ...current.stageCounts,
          [deleteTarget.workflowStage]: Math.max(0, (current.stageCounts[deleteTarget.workflowStage] || 0) - 1),
        },
      } : current);
      setDeleteTarget(null);
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "Unable to delete this preview report.");
    } finally {
      setDeleting(false);
    }
  }

  function openReminder(report: PreviewReportSummary) {
    setNotificationReportId(report.id);
  }

  return (
    <Box className="desktop-admin-page" sx={{ minHeight: "100vh", overflowX: "hidden", p: { xs: 2, md: 3, xl: 4 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ xs: "stretch", sm: "center" }} justifyContent="space-between" spacing={2}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <FileClock size={25} />
            <Typography component="h1" className="desktop-page-title" sx={{ fontSize: { xs: 26, md: 32 }, fontWeight: 760 }}>Preview Reports</Typography>
            {viewMode === "reports" ? (
              <Chip size="small" label={data?.total ?? 0} sx={{ borderRadius: "4px", fontWeight: 750 }} />
            ) : null}
          </Stack>
          <Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 14 }}>Monitor every user preview, file-generation job, approval handoff, and release wait.</Typography>
        </Box>
        <Button variant="outlined" startIcon={refreshing ? <CircularProgress size={15} /> : <RefreshCw size={16} />} onClick={() => setReloadToken((value) => value + 1)} disabled={refreshing} sx={{ alignSelf: { xs: "stretch", sm: "center" }, borderRadius: "4px" }}>
          Refresh
        </Button>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mt: 2.5 }}>
        <Button
          variant={viewMode === "reports" ? "contained" : "outlined"}
          onClick={() => setViewMode("reports")}
          sx={{ borderRadius: "4px" }}
        >
          Report previews
        </Button>
        <Button
          variant={viewMode === "drafts" ? "contained" : "outlined"}
          onClick={() => setViewMode("drafts")}
          sx={{ borderRadius: "4px" }}
        >
          Draft previews
        </Button>
      </Stack>

      {viewMode === "drafts" ? (
        <DraftPreviewsPanel onOpenPreview={openDraftPreview} />
      ) : (
        <>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))", xl: "repeat(6, minmax(0, 1fr))" }, gap: 1, mt: 2.5 }}>
        {visibleStageCards.map((stage) => {
          const meta = stageMeta(stage);
          const selected = workflowStage === stage;
          return (
            <Box component="button" type="button" key={stage} onClick={() => { setWorkflowStage(selected ? "all" : stage); setPage(1); }} sx={{ minWidth: 0, border: "1px solid", borderColor: selected ? "primary.main" : "divider", borderRadius: "5px", bgcolor: selected ? "action.selected" : "background.paper", color: "text.primary", cursor: "pointer", p: 1.5, textAlign: "left" }}>
              <Typography sx={{ color: "text.secondary", fontSize: 11, fontWeight: 750, textTransform: "uppercase" }}>{meta.label}</Typography>
              <Typography sx={{ mt: 0.4, fontSize: 25, fontWeight: 760, lineHeight: 1 }}>{counts[stage] || 0}</Typography>
            </Box>
          );
        })}
      </Box>

      <Box className="desktop-flat-panel" sx={{ mt: 2, border: "1px solid", borderColor: "divider", borderRadius: "5px", bgcolor: "background.paper", p: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1.25 }}><SlidersHorizontal size={16} /><Typography sx={{ fontSize: 12.5, fontWeight: 750 }}>Filters</Typography></Stack>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "minmax(240px, 2fr) repeat(5, minmax(130px, 1fr))" }, gap: 1 }}>
          <TextField value={search} onChange={(event) => setSearch(event.target.value)} size="small" placeholder="Search contract, creator, client, or lot" InputProps={{ startAdornment: <Search size={16} style={{ marginRight: 8 }} /> }} />
          <FormControl size="small"><Select value={reportType} onChange={(event) => { setReportType(event.target.value); setPage(1); }}><MenuItem value="all">All report types</MenuItem><MenuItem value="Asset">Asset</MenuItem><MenuItem value="LotListing">Lot Listing</MenuItem></Select></FormControl>
          <FormControl size="small"><Select value={workflowStage} onChange={(event) => { setWorkflowStage(event.target.value); setPage(1); }}><MenuItem value="all">All workflow stages</MenuItem>{visibleStageCards.map((stage) => <MenuItem key={stage} value={stage}>{stageMeta(stage).label}</MenuItem>)}</Select></FormControl>
          <FormControl size="small"><Select value={creatorId} displayEmpty onChange={(event) => { setCreatorId(event.target.value); setPage(1); }}><MenuItem value="">All creators</MenuItem>{data?.creators.map((creator) => <MenuItem key={creator.id} value={creator.id}>{creator.displayName}</MenuItem>)}</Select></FormControl>
          <TextField type="date" size="small" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} inputProps={{ "aria-label": "Created from" }} />
          <TextField type="date" size="small" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} inputProps={{ "aria-label": "Created to" }} />
        </Box>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} sx={{ mt: 1 }}>
          <FormControl size="small" sx={{ minWidth: 180 }}><Select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><MenuItem value="updated_desc">Latest activity</MenuItem><MenuItem value="updated_asc">Oldest activity</MenuItem><MenuItem value="created_desc">Newest created</MenuItem><MenuItem value="created_asc">Oldest created</MenuItem></Select></FormControl>
          <Button color="inherit" onClick={resetFilters} sx={{ alignSelf: { xs: "stretch", sm: "center" }, borderRadius: "4px" }}>Reset filters</Button>
        </Stack>
      </Box>

      {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      {actionFeedback ? <Alert severity={actionFeedback.severity} onClose={() => setActionFeedback(null)} sx={{ mt: 2 }}>{actionFeedback.message}</Alert> : null}
      {data?.truncated ? <Alert severity="warning" sx={{ mt: 2 }}>The active queue is unusually large. Narrow the date or report-type filters for a complete result set.</Alert> : null}

      <Box sx={{ mt: 2 }}>
        {loading ? (
          <Stack spacing={1}>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} variant="rounded" height={82} />)}</Stack>
        ) : !data?.items.length ? (
          <Box sx={{ display: "grid", minHeight: 260, placeItems: "center", border: "1px solid", borderColor: "divider", borderRadius: "5px", bgcolor: "background.paper", p: 3, textAlign: "center" }}>
            <Box><Files size={30} /><Typography sx={{ mt: 1, fontSize: 18, fontWeight: 750 }}>No preview reports match these filters</Typography><Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 13 }}>Reset filters or widen the date range.</Typography></Box>
          </Box>
        ) : (
          <>
            <Box sx={{ display: { xs: "grid", lg: "none" }, gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
              {data.items.map((report) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  onOpen={() => openReport(report.id)}
                  onReminder={() => openReminder(report)}
                  onDelete={() => { setDeleteError(""); setDeleteTarget(report); }}
                />
              ))}
            </Box>

            <TableContainer sx={{ display: { xs: "none", lg: "block" }, overflow: "hidden", border: "1px solid", borderColor: "divider", borderRadius: "5px", bgcolor: "background.paper" }}>
              <Table size="small" sx={{ tableLayout: "fixed" }}>
                <TableHead><TableRow>{[["Report", "27%"], ["Creator", "16%"], ["Workload", "11%"], ["Activity", "14%"], ["Workflow", "20%"], ["Actions", "12%"]].map(([label, width]) => <TableCell key={label} sx={{ width, py: 1.25, fontSize: 12, fontWeight: 750 }}>{label}</TableCell>)}</TableRow></TableHead>
                <TableBody>
                  {data.items.map((report) => (
                    <TableRow key={report.id} hover sx={{ "&:last-child td": { borderBottom: 0 } }}>
                      <TableCell sx={{ py: 1.25 }}>
                        <Stack direction="row" spacing={1.25} alignItems="center"><ReportThumbnail report={report} /><Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 13.5, fontWeight: 750 }}>{report.title}</Typography><Typography noWrap sx={{ mt: 0.25, color: "text.secondary", fontSize: 11.5 }}>Contract: {report.contractNo || "Not provided"}</Typography><Typography noWrap sx={{ mt: 0.15, color: "text.secondary", fontSize: 11.5 }}>{report.lotNumberSummary}</Typography></Box></Stack>
                      </TableCell>
                      <TableCell><Stack direction="row" spacing={0.75} alignItems="center"><UserRound size={15} /><Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 12.5, fontWeight: 650 }}>{report.creatorDisplay}</Typography><Typography noWrap sx={{ color: "text.secondary", fontSize: 11 }}>{report.creator?.email || "Account unavailable"}</Typography></Box></Stack></TableCell>
                      <TableCell><Typography sx={{ fontSize: 12.5 }}>{report.lotCount} lots</Typography><Typography sx={{ mt: 0.25, color: "text.secondary", fontSize: 11.5 }}>{report.imageCount} images</Typography></TableCell>
                      <TableCell><Stack direction="row" spacing={0.75} alignItems="flex-start"><CalendarClock size={15} /><Box><Typography sx={{ fontSize: 12 }}>{formatDateTime(report.updatedAt)}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11 }}>{relativeTime(report.updatedAt)}</Typography></Box></Stack></TableCell>
                      <TableCell><WorkflowBadge report={report} /></TableCell>
                      <TableCell align="center">
                        <Stack direction="row" justifyContent="center" spacing={0.75}>
                          <Tooltip title="Open complete preview"><IconButton aria-label={`Open ${report.title}`} onClick={() => openReport(report.id)} sx={{ border: "1px solid", borderColor: "divider", borderRadius: "4px" }}><Eye size={17} /></IconButton></Tooltip>
                          <Tooltip title="Review an email to the report owner or check a previous delivery">
                            <span><Button size="small" variant="outlined" aria-label={`Notify owner about ${report.title}`} onClick={() => openReminder(report)} startIcon={<Mail size={16} />}>Notify</Button></span>
                          </Tooltip>
                          <Tooltip title={report.deleteEligible ? "Delete preview report" : report.deleteIneligibleReason || "This preview cannot be deleted."}>
                            <span><IconButton aria-label={`Delete ${report.title}`} color="error" disabled={!report.deleteEligible} onClick={() => { setDeleteError(""); setDeleteTarget(report); }} sx={{ border: "1px solid", borderColor: report.deleteEligible ? "error.light" : "divider", borderRadius: "4px" }}><Trash2 size={17} /></IconButton></span>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Box>

      {data && data.pages > 1 ? (
        <Stack direction={{ xs: "column", sm: "row" }} alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ mt: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1}><Typography sx={{ color: "text.secondary", fontSize: 12.5 }}>{data.total} reports</Typography><FormControl size="small"><Select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}><MenuItem value={10}>10 rows</MenuItem><MenuItem value={25}>25 rows</MenuItem><MenuItem value={50}>50 rows</MenuItem></Select></FormControl></Stack>
          <Pagination count={data.pages} page={data.page} onChange={(_, value) => setPage(value)} color="primary" shape="rounded" />
        </Stack>
      ) : null}
        </>
      )}

      <PreviewReportDrawer
        open={Boolean(selectedReportId)}
        reportId={selectedReportId}
        readOnly={selectedReportReadOnly}
        onClose={() => {
          setSelectedReportId(null);
          setSelectedReportReadOnly(false);
        }}
        onTransferred={(message, hasWarnings) => {
          setActionFeedback({ message, severity: hasWarnings ? "warning" : "success" });
          setReloadToken((value) => value + 1);
        }}
        onResubmitted={(message) => {
          setActionFeedback({ message, severity: "success" });
          setReloadToken((value) => value + 1);
        }}
        onNotify={(id) => setNotificationReportId(id)}
        onDeleted={() => {
          setSelectedReportId(null);
          setReloadToken((value) => value + 1);
        }}
      />

      <PreviewNotificationComposer
        reportId={notificationReportId}
        onClose={() => setNotificationReportId(null)}
        onSent={(message, warning) => {
          setActionFeedback({ message, severity: warning ? "warning" : "success" });
        }}
        onDeliveryAttempt={() => {
          setSelectedReportId(null);
          setReloadToken((value) => value + 1);
        }}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        fullWidth
        maxWidth="sm"
        PaperProps={{ sx: { borderRadius: "6px" } }}
      >
        <DialogTitle sx={{ fontWeight: 750 }}>Delete preview report?</DialogTitle>
        <DialogContent dividers>
          {deleteError ? <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert> : null}
          <Typography sx={{ fontSize: 14, lineHeight: 1.65 }}>
            <strong>{deleteTarget?.title}</strong>{deleteTarget?.contractNo ? ` (contract ${deleteTarget.contractNo})` : ""} will be permanently removed from Preview Reports. Generated preview files and processing history will also be removed.
          </Typography>
          <Alert severity="warning" sx={{ mt: 2 }}>This action cannot be undone. Source photos that may be shared with another report are retained.</Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button color="inherit" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="contained" color="error" disabled={deleting} onClick={confirmDelete} startIcon={deleting ? <CircularProgress color="inherit" size={16} /> : <Trash2 size={17} />}>
            {deleting ? "Deleting" : "Delete permanently"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
