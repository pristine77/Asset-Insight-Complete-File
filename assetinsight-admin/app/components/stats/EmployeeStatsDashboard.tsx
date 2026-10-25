"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  Files,
  Image as ImageIcon,
  RefreshCcw,
  RotateCcw,
  Users,
  X,
} from "lucide-react";
import DashboardTabs from "@/app/components/dashboard/DashboardTabs";
import type { EmployeeDetailPayload, PerformancePayload, WorkflowStage } from "./types";
import { STAGE_LABELS } from "./types";

const PerformanceCharts = dynamic(() => import("./PerformanceCharts"), {
  ssr: false,
  loading: () => <Skeleton variant="rectangular" height={580} />,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const toDateInput = (value: Date) => value.toISOString().slice(0, 10);
const number = (value: unknown) => Number(value || 0).toLocaleString();
const minutes = (value: number | null | undefined) => value == null ? "--" : value < 60 ? `${Math.round(value)}m` : `${(value / 60).toFixed(1)}h`;
const percent = (value: number | null | undefined) => `${Number(value || 0).toFixed(1)}%`;
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString() : "--";

type SortKey = "reports" | "lots" | "images" | "activeDays" | "medianPreviewMinutes" | "medianFileMinutes" | "readyRate" | "retryRate" | "failureRate" | "lastActivityAt";

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Coverage({ label, metric }: { label: string; metric: { covered: number; total: number } }) {
  const value = metric.total ? Math.round((metric.covered / metric.total) * 100) : 0;
  return <Chip size="small" variant="outlined" label={`${label}: ${metric.covered}/${metric.total} (${value}%)`} />;
}

function StageChip({ stage }: { stage: WorkflowStage }) {
  const color = stage === "error" ? "#c81e2a" : stage === "ready" ? "#087f5b" : stage === "awaiting_release" || stage === "awaiting_approval" ? "#a45b00" : "#354a66";
  return <Chip size="small" label={STAGE_LABELS[stage]} sx={{ height: 23, color, bgcolor: `${color}12`, border: `1px solid ${color}28`, fontSize: 11 }} />;
}

function EmployeeDrawer({ userId, query, onClose }: { userId: string | null; query: string; onClose: () => void }) {
  const [data, setData] = useState<EmployeeDetailPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setData(null);
    setError("");
    fetch(`/api/admin/stats/performance/users/${userId}?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || "Failed to load employee details");
        setData(payload);
      })
      .catch((currentError) => {
        if (currentError?.name !== "AbortError") setError(currentError instanceof Error ? currentError.message : "Failed to load employee details");
      });
    return () => controller.abort();
  }, [query, userId]);

  return (
    <Drawer anchor="right" open={Boolean(userId)} onClose={onClose} PaperProps={{ sx: { width: { xs: "100%", md: 820 }, maxWidth: "100vw" } }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ px: 2.5, py: 2, borderBottom: "1px solid", borderColor: "divider" }}>
        <Box><Typography sx={{ fontSize: 20, fontWeight: 750 }}>Employee activity</Typography><Typography sx={{ color: "text.secondary", fontSize: 12 }}>Report activity and lifecycle timing in America/Regina.</Typography></Box>
        <IconButton aria-label="Close employee details" onClick={onClose}><X size={19} /></IconButton>
      </Stack>
      <Box sx={{ flex: 1, overflowY: "auto", p: 2.5 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {!data && !error ? <Stack spacing={1.5}><Skeleton height={70} /><Skeleton height={180} /><Skeleton height={280} /></Stack> : null}
        {data ? (
          <Stack spacing={2.5}>
            <Box>
              <Typography sx={{ fontSize: 22, fontWeight: 750 }}>{data.employee.name}</Typography>
              <Typography sx={{ color: "text.secondary" }}>{data.employee.email || "Historical account"}</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.25 }}>
                <Chip size="small" label={`${number(data.employee.reports)} reports`} />
                <Chip size="small" label={`${number(data.employee.lots)} lots`} />
                <Chip size="small" label={`${number(data.employee.images)} images`} />
                <Chip size="small" label={`${number(data.employee.activeDays)} active days`} />
              </Stack>
            </Box>
            <Alert severity="info" icon={false}>Activity span is the interval between the first and last recorded report event on a day. It is not attendance, payroll, or logged working time.</Alert>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Coverage label="Preview timing" metric={data.coverage.previewTiming} />
              <Coverage label="File timing" metric={data.coverage.fileTiming} />
              <Coverage label="End-to-end" metric={data.coverage.endToEndTiming} />
            </Stack>
            <Box>
              <Typography sx={{ mb: 1, fontSize: 16, fontWeight: 700 }}>Daily activity</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "1.2fr repeat(6, minmax(64px, .7fr))", border: "1px solid", borderColor: "divider", "& > div": { px: 1, py: 1, borderBottom: "1px solid", borderColor: "divider", fontSize: 12 } }}>
                {['Date','First','Last','Span','Reports','Lots','Images'].map((label) => <Box key={label} sx={{ fontWeight: 700, bgcolor: "action.hover" }}>{label}</Box>)}
                {data.daily.map((row) => <Box key={row.date} sx={{ display: "contents" }}><Box>{row.date}</Box><Box>{row.firstActivity}</Box><Box>{row.lastActivity}</Box><Box>{minutes(row.activitySpanMinutes)}</Box><Box>{row.reports}</Box><Box>{row.lots}</Box><Box>{row.images}</Box></Box>)}
              </Box>
            </Box>
            <Box>
              <Typography sx={{ mb: 1, fontSize: 16, fontWeight: 700 }}>Report type breakdown</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>{data.byType.map((row) => <Chip key={row.type} label={`${row.type === "LotListing" ? "Lot Listing" : row.type}: ${row.count}`} />)}</Stack>
            </Box>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: 1.5 }}>
              <Box sx={{ border: "1px solid", borderColor: "divider", p: 1.5 }}>
                <Typography sx={{ mb: 1, fontSize: 15, fontWeight: 700 }}>Failures</Typography>
                <Stack spacing={0.75}>
                  {data.failures.length ? data.failures.slice(0, 8).map((report) => (
                    <Box key={`failure-${report.id}`} sx={{ borderLeft: "3px solid", borderColor: "error.main", pl: 1 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{report.title || report.contractNo || report.reportType}</Typography>
                      <Typography sx={{ color: "text.secondary", fontSize: 10 }}>{dateTime(report.createdAt)} - {report.error || "Generation failed"}</Typography>
                    </Box>
                  )) : <Typography sx={{ color: "text.secondary", fontSize: 12 }}>No failures in this period.</Typography>}
                </Stack>
              </Box>
              <Box sx={{ border: "1px solid", borderColor: "divider", p: 1.5 }}>
                <Typography sx={{ mb: 1, fontSize: 15, fontWeight: 700 }}>Long-running outliers</Typography>
                <Stack spacing={0.75}>
                  {data.outliers.length ? data.outliers.slice(0, 8).map((report) => (
                    <Box key={`outlier-${report.id}`} sx={{ borderLeft: "3px solid", borderColor: "warning.main", pl: 1 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{report.title || report.contractNo || report.reportType}</Typography>
                      <Typography sx={{ color: "text.secondary", fontSize: 10 }}>End-to-end {minutes(report.endToEndMinutes)} - {report.lotCount} lots - {report.imageCount} images</Typography>
                    </Box>
                  )) : <Typography sx={{ color: "text.secondary", fontSize: 12 }}>No timing outliers with complete lifecycle data.</Typography>}
                </Stack>
              </Box>
            </Box>
            <Box>
              <Typography sx={{ mb: 1, fontSize: 16, fontWeight: 700 }}>Report timelines</Typography>
              <Stack spacing={1}>
                {data.reports.map((report) => (
                  <Box key={report.id} sx={{ border: "1px solid", borderColor: report.error ? "error.light" : "divider", p: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1}>
                      <Box><Typography sx={{ fontWeight: 700 }}>{report.title || report.contractNo || report.reportType}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11 }}>{report.reportType} - {dateTime(report.createdAt)} - {report.lotCount} lots - {report.imageCount} images</Typography></Box>
                      <StageChip stage={report.workflowStage} />
                    </Stack>
                    <Typography sx={{ mt: 1, color: "text.secondary", fontSize: 11 }}>Preview {minutes(report.previewMinutes)} - Files {minutes(report.fileMinutes)} - End-to-end {minutes(report.endToEndMinutes)} - Retries {report.retries}</Typography>
                    {report.error ? <Alert severity="error" sx={{ mt: 1 }}>{report.error}</Alert> : null}
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>{report.timeline.map((entry) => <Chip key={`${report.id}-${entry.key}`} size="small" variant="outlined" label={`${entry.label}: ${dateTime(entry.at)}`} />)}</Stack>
                  </Box>
                ))}
              </Stack>
            </Box>
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}

export default function EmployeeStatsDashboard() {
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(() => toDateInput(new Date(Date.now() - 29 * DAY_MS)));
  const [to, setTo] = useState(() => toDateInput(new Date()));
  const [userId, setUserId] = useState(() => searchParams.get("userId") || "");
  const [reportType, setReportType] = useState(() => searchParams.get("reportType") || "");
  const [workflowStage, setWorkflowStage] = useState(() => searchParams.get("workflowStage") || "");
  const [outcome, setOutcome] = useState(() => searchParams.get("outcome") || "all");
  const [data, setData] = useState<PerformancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("reports");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [creatorOptions, setCreatorOptions] = useState<PerformancePayload["filterOptions"]["creators"]>([]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (userId) params.set("userId", userId);
    if (reportType) params.set("reportType", reportType);
    if (workflowStage) params.set("workflowStage", workflowStage);
    if (outcome !== "all") params.set("outcome", outcome);
    return params.toString();
  }, [from, outcome, reportType, to, userId, workflowStage]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/admin/stats/performance?${query}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Failed to load employee statistics");
      setData(payload);
      setCreatorOptions((current) => payload.filterOptions.creators.length >= current.length ? payload.filterOptions.creators : current);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Failed to load employee statistics");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const employees = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...(data?.employees || [])].sort((left, right) => {
      const leftValue = sortKey === "lastActivityAt" ? new Date(left.lastActivityAt || 0).getTime() : Number(left[sortKey] ?? -1);
      const rightValue = sortKey === "lastActivityAt" ? new Date(right.lastActivityAt || 0).getTime() : Number(right[sortKey] ?? -1);
      return (leftValue - rightValue) * direction;
    });
  }, [data?.employees, sortDirection, sortKey]);

  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((value) => value === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDirection("desc"); }
  };

  const exportEmployees = () => downloadCsv(`employee-performance-${from}-to-${to}.csv`, ["Employee","Email","State","Active Days","Reports","Lots","Images","Avg Lots/Report","Median Preview Min","P90 Preview Min","Median Files Min","P90 Files Min","Ready %","Retry %","Failure %","Last Activity"], employees.map((row) => [row.name,row.email,row.accountState,row.activeDays,row.reports,row.lots,row.images,row.averageLotsPerReport,row.medianPreviewMinutes,row.p90PreviewMinutes,row.medianFileMinutes,row.p90FileMinutes,row.readyRate,row.retryRate,row.failureRate,row.lastActivityAt]));
  const exportDaily = () => downloadCsv(`daily-report-activity-${from}-to-${to}.csv`, ["Date","Reports","Lots","Images","Active Creators","Median Preview Min","Median Files Min"], (data?.daily || []).map((row) => [row.date,row.reports,row.lots,row.images,row.activeCreators,row.medianPreviewMinutes,row.medianFileMinutes]));

  const summaryCards = data ? [
    { label: "Total reports", value: number(data.summary.totalReports), icon: Files },
    { label: "Total lots", value: number(data.summary.totalLots), icon: BarChart3 },
    { label: "Total images", value: number(data.summary.totalImages), icon: ImageIcon },
    { label: "Active creators", value: number(data.summary.activeCreators), icon: Users },
    { label: "Reports ready", value: number(data.summary.readyReports), icon: FileCheck2 },
    { label: "Reports failed", value: number(data.summary.failedReports), icon: AlertTriangle },
    { label: "Median preview", value: minutes(data.summary.medianPreviewMinutes), icon: Clock3 },
    { label: "Median file generation", value: minutes(data.summary.medianFileMinutes), icon: Clock3 },
    { label: "P90 end-to-end", value: minutes(data.summary.p90EndToEndMinutes), icon: Clock3 },
  ] : [];

  return (
    <Box className="desktop-admin-page" sx={{ p: { xs: 2, lg: 3 } }}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2} sx={{ mb: 2 }}>
        <Box>
          <Button component={Link} href="/dashboard" startIcon={<ArrowLeft size={16} />} sx={{ mb: 0.75, ml: -1, color: "text.secondary" }}>
            Back to Dashboard
          </Button>
          <h1 className="desktop-page-title">Stats</h1>
          <p className="desktop-page-subtitle">Employee throughput, report lifecycle timing, failures, and current workflow backlog.</p>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Button variant="outlined" startIcon={<Download size={16} />} disabled={!data} onClick={exportEmployees}>Employees CSV</Button><Button variant="outlined" startIcon={<Download size={16} />} disabled={!data} onClick={exportDaily}>Daily CSV</Button><Button variant="contained" startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <RefreshCcw size={16} />} onClick={() => void load()}>Refresh</Button></Stack>
      </Stack>

      <Box sx={{ mb: 2, borderBottom: "1px solid", borderColor: "divider" }}>
        <DashboardTabs active="stats" />
      </Box>

      <Box className="desktop-flat-panel" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0,1fr))", lg: "repeat(6, minmax(0,1fr))" }, gap: 1.25, p: 1.5, mb: 1.5 }}>
        <TextField size="small" type="date" label="From" value={from} onChange={(event) => setFrom(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" type="date" label="To" value={to} onChange={(event) => setTo(event.target.value)} InputLabelProps={{ shrink: true }} />
        <FormControl size="small"><InputLabel>Employee</InputLabel><Select label="Employee" value={userId} onChange={(event) => setUserId(event.target.value)}><MenuItem value="">All employees</MenuItem>{creatorOptions.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}{option.email ? ` - ${option.email}` : ""}</MenuItem>)}</Select></FormControl>
        <FormControl size="small"><InputLabel>Report type</InputLabel><Select label="Report type" value={reportType} onChange={(event) => setReportType(event.target.value)}><MenuItem value="">All types</MenuItem>{["Asset","LotListing","RealEstate","Salvage"].map((value) => <MenuItem key={value} value={value}>{value === "LotListing" ? "Lot Listing" : value === "RealEstate" ? "Real Estate" : value}</MenuItem>)}</Select></FormControl>
        <FormControl size="small"><InputLabel>Workflow stage</InputLabel><Select label="Workflow stage" value={workflowStage} onChange={(event) => setWorkflowStage(event.target.value)}><MenuItem value="">All stages</MenuItem>{Object.entries(STAGE_LABELS).map(([value,label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</Select></FormControl>
        <Stack direction="row" spacing={1}><FormControl fullWidth size="small"><InputLabel>Result</InputLabel><Select label="Result" value={outcome} onChange={(event) => setOutcome(event.target.value)}><MenuItem value="all">All results</MenuItem><MenuItem value="ready">Ready</MenuItem><MenuItem value="error">Error</MenuItem></Select></FormControl><IconButton aria-label="Reset filters" onClick={() => { setFrom(toDateInput(new Date(Date.now() - 29 * DAY_MS))); setTo(toDateInput(new Date())); setUserId(""); setReportType(""); setWorkflowStage(""); setOutcome("all"); }} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}><RotateCcw size={17} /></IconButton></Stack>
      </Box>

      {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      {loading && !data ? <Stack spacing={1.5}><Skeleton variant="rectangular" height={210} /><Skeleton variant="rectangular" height={580} /><Skeleton variant="rectangular" height={350} /></Stack> : null}
      {data ? <>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0,1fr))", md: "repeat(3, minmax(0,1fr))", xl: "repeat(9, minmax(0,1fr))" }, gap: 1.25, mb: 1.5 }}>
          {summaryCards.map(({ label, value, icon: Icon }) => <Box key={label} className="desktop-flat-panel" sx={{ minWidth: 0, p: 1.75 }}><Icon size={18} /><Typography sx={{ mt: 1, color: "text.secondary", fontSize: 11 }}>{label}</Typography><Typography sx={{ mt: 0.25, fontSize: 21, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{value}</Typography></Box>)}
        </Box>
        <Alert severity="info" icon={false} sx={{ mb: 1.5 }}><Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center"><Typography sx={{ fontSize: 12, fontWeight: 700 }}>Timing coverage:</Typography><Coverage label="Preview" metric={data.coverage.previewTiming} /><Coverage label="Files" metric={data.coverage.fileTiming} /><Coverage label="End-to-end" metric={data.coverage.endToEndTiming} /><Typography sx={{ fontSize: 11 }}>Incomplete legacy timestamps are omitted, never counted as zero.</Typography></Stack></Alert>
        <PerformanceCharts data={data} />

        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "minmax(0,2fr) minmax(300px,.8fr)" }, gap: 1.5, mt: 1.5 }}>
          <Box className="desktop-flat-panel" sx={{ minWidth: 0, overflow: "hidden" }}>
            <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}><Typography sx={{ fontSize: 17, fontWeight: 700 }}>Employee performance</Typography><Typography sx={{ color: "text.secondary", fontSize: 11 }}>Sortable operational measures; no artificial employee score.</Typography></Box>
            <Box sx={{ display: { xs: "none", lg: "grid" }, gridTemplateColumns: "minmax(160px,1.7fr) repeat(9,minmax(60px,.72fr)) 42px", "& > div": { minWidth: 0, px: 1, py: 1.15, borderBottom: "1px solid", borderColor: "divider", fontSize: 11 } }}>
              <Box sx={{ fontWeight: 700, bgcolor: "action.hover" }}>Employee</Box>{[["Reports","reports"],["Lots","lots"],["Images","images"],["Days","activeDays"],["Median preview","medianPreviewMinutes"],["Median files","medianFileMinutes"],["Ready","readyRate"],["Retry","retryRate"],["Failure","failureRate"]].map(([label,key]) => <Box key={key} component="button" onClick={() => setSort(key as SortKey)} sx={{ border: 0, fontWeight: 700, bgcolor: sortKey === key ? "action.selected" : "action.hover", textAlign: "left", cursor: "pointer" }}>{label}</Box>)}<Box sx={{ bgcolor: "action.hover" }} />
              {employees.map((employee) => <Box key={employee.userId} sx={{ display: "contents" }}><Box><Typography noWrap sx={{ fontSize: 12, fontWeight: 700 }}>{employee.name}</Typography><Typography noWrap sx={{ color: "text.secondary", fontSize: 10 }}>{employee.email || employee.accountState}</Typography></Box><Box>{employee.reports}</Box><Box>{employee.lots}</Box><Box>{employee.images}</Box><Box>{employee.activeDays}</Box><Box>{minutes(employee.medianPreviewMinutes)}</Box><Box>{minutes(employee.medianFileMinutes)}</Box><Box>{percent(employee.readyRate)}</Box><Box>{percent(employee.retryRate)}</Box><Box>{percent(employee.failureRate)}</Box><Box><IconButton size="small" aria-label={`View ${employee.name}`} onClick={() => setSelectedUser(employee.userId)}><Eye size={15} /></IconButton></Box></Box>)}
            </Box>
            <Stack sx={{ display: { xs: "flex", lg: "none" }, p: 1.25 }} spacing={1}>
              {employees.map((employee) => <Box key={employee.userId} sx={{ border: "1px solid", borderColor: "divider", p: 1.5 }}><Stack direction="row" justifyContent="space-between" gap={1}><Box><Typography sx={{ fontWeight: 700 }}>{employee.name}</Typography><Typography sx={{ color: "text.secondary", fontSize: 11 }}>{employee.email || employee.accountState}</Typography></Box><IconButton aria-label={`View ${employee.name}`} onClick={() => setSelectedUser(employee.userId)}><Eye size={17} /></IconButton></Stack><Box sx={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 1, mt: 1.25 }}><Typography fontSize={11}>{employee.reports} reports</Typography><Typography fontSize={11}>{employee.lots} lots</Typography><Typography fontSize={11}>{employee.images} images</Typography><Typography fontSize={11}>{minutes(employee.medianPreviewMinutes)} preview</Typography><Typography fontSize={11}>{minutes(employee.medianFileMinutes)} files</Typography><Typography fontSize={11}>{percent(employee.failureRate)} failed</Typography></Box></Box>)}
            </Stack>
          </Box>

          <Box className="desktop-flat-panel" sx={{ overflow: "hidden" }}>
            <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}><Typography sx={{ fontSize: 17, fontWeight: 700 }}>Current backlog</Typography><Typography sx={{ color: "text.secondary", fontSize: 11 }}>Oldest active work first.</Typography></Box>
            <Stack divider={<Divider />}>
              {data.backlog.length ? data.backlog.slice(0, 12).map((report) => <Box key={report.id} sx={{ p: 1.5 }}><Stack direction="row" justifyContent="space-between" gap={1}><Box sx={{ minWidth: 0 }}><Typography noWrap sx={{ fontSize: 12, fontWeight: 700 }}>{report.title || report.contractNo}</Typography><Typography noWrap sx={{ color: "text.secondary", fontSize: 10 }}>{report.creator} - {report.lotCount} lots - {minutes(report.elapsedMinutes)}</Typography></Box><StageChip stage={report.workflowStage} /></Stack></Box>) : <Typography sx={{ p: 2, color: "text.secondary", fontSize: 12 }}>No active backlog in this period.</Typography>}
            </Stack>
          </Box>
        </Box>
      </> : null}
      <EmployeeDrawer userId={selectedUser} query={query} onClose={() => setSelectedUser(null)} />
    </Box>
  );
}
