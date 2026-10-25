"use client";

import AssessmentRoundedIcon from "@mui/icons-material/AssessmentRounded";
import BusinessCenterRoundedIcon from "@mui/icons-material/BusinessCenterRounded";
import CampaignRoundedIcon from "@mui/icons-material/CampaignRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import MapRoundedIcon from "@mui/icons-material/MapRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import RocketLaunchRoundedIcon from "@mui/icons-material/RocketLaunchRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SourceRoundedIcon from "@mui/icons-material/SourceRounded";
import TrendingUpRoundedIcon from "@mui/icons-material/TrendingUpRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  Grid,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

type RadarCountry = "Canada" | "United States";

type CategoryOption = {
  id: string;
  label: string;
};

type RadarData = {
  asOf: string;
  filters: {
    country: RadarCountry | "";
    regions: string[];
    categories: string[];
    timeframeDays: number;
  };
  options: {
    countries: RadarCountry[];
    canadaProvinces: string[];
    usStates: string[];
    categories: CategoryOption[];
    timeframeDays: number[];
    maxResults: number;
  };
  kpis: {
    totalLeads: number;
    activePipeline: number;
    won: number;
    lost: number;
    proposalStage: number;
    overdue: number;
    stale: number;
    publicProspects: number;
    duplicateProspects: number;
    conversionRate: number;
  };
  regionBreakdown: Array<{
    country: string;
    region: string;
    totalLeads: number;
    activePipeline: number;
    won: number;
    proposalStage: number;
    overdue: number;
    stale: number;
    autoFound: number;
    importedProspects: number;
    score: number;
    topCategories: Array<{ id: string; label: string; count: number }>;
  }>;
  categoryBreakdown: Array<{
    id: string;
    label: string;
    leads: number;
    won: number;
    activePipeline: number;
    autoFound: number;
    score: number;
  }>;
  sourceBreakdown: Array<{ source: string; count: number }>;
  staleLeads: Array<{
    id: string;
    clientName: string;
    companyName: string;
    status: string;
    dueDate: string | null;
    updatedAt: string | null;
    assignedTo: string;
    location: string;
    overdue: boolean;
    stale: boolean;
  }>;
  recentProspects: ProspectRow[];
  recommendations: {
    country: RadarCountry;
    regions: string[];
    categories: string[];
    keywords: string;
    maxResults: number;
    rationale: string;
  };
  marketSources: Array<{ title: string; url: string; region: string; note: string }>;
  compliance: Array<{ region: string; title: string; url: string; bullets: string[] }>;
};

type ProspectRow = {
  id: string;
  status: string;
  country: string;
  regions: string[];
  category: { id: string; label: string };
  companyName: string;
  clientName: string;
  email: string;
  phoneRaw: string;
  website: string;
  location: string;
  confidence: number;
  sourceUrl: string;
  sourceTitle: string;
  evidence: string;
  suggestedAgent: { id: string; label: string } | null;
  createdAt: string | null;
};

type AutoFindRunItem = {
  searchResultId: string;
  duplicate: boolean;
  duplicateReasons?: string[];
  lead?: {
    companyName?: string;
    clientName?: string;
    companyLocation?: string;
    contactLocation?: string;
    industry?: string;
    evidence?: string;
    confidence?: number;
    sourceUrl?: string;
    sourceTitle?: string;
  };
  draftPreview?: {
    companyName?: string;
    clientName?: string;
    companyLocation?: string;
    industry?: string;
  };
};

type AutoFindRun = {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  items: AutoFindRunItem[];
  searched: number;
  duplicateCount: number;
  error?: string;
};

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(value: number | null | undefined) {
  return numberFormatter.format(Number(value || 0));
}

function formatPercent(value: number | null | undefined) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function scoreColor(score: number) {
  if (score >= 70) return "#16a34a";
  if (score >= 40) return "#f59e0b";
  return "#64748b";
}

function fitScore(value: number | null | undefined) {
  const raw = Number(value || 0);
  return raw > 1 ? Math.round(raw) : Math.round(raw * 100);
}

export default function RevenueRadarDashboard() {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [data, setData] = useState<RadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState<RadarCountry>("Canada");
  const [regions, setRegions] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [timeframeDays, setTimeframeDays] = useState(90);
  const [keywords, setKeywords] = useState("");
  const [maxResults, setMaxResults] = useState(30);
  const [searching, setSearching] = useState(false);
  const [run, setRun] = useState<AutoFindRun | null>(null);
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const surfaceSx = {
    borderRadius: "12px",
    border: "1px solid",
    borderColor: isDark ? alpha("#93a9c8", 0.18) : alpha("#94a3b8", 0.28),
    background: isDark
      ? `linear-gradient(180deg, ${alpha("#132238", 0.96)}, ${alpha("#0b1728", 0.98)})`
      : "rgba(255,255,255,0.96)",
    boxShadow: isDark
      ? `0 18px 46px ${alpha("#020617", 0.46)}, inset 0 1px 0 ${alpha("#fff", 0.04)}`
      : `0 16px 38px ${alpha("#0f172a", 0.10)}, inset 0 1px 0 ${alpha("#fff", 0.95)}`,
    overflow: "hidden",
  };

  const insetSx = {
    border: "1px solid",
    borderColor: isDark ? alpha("#93a9c8", 0.16) : alpha("#94a3b8", 0.25),
    bgcolor: isDark ? alpha("#07111f", 0.35) : alpha("#f8fafc", 0.82),
    boxShadow: isDark ? `inset 0 1px 0 ${alpha("#fff", 0.03)}` : `inset 0 1px 0 ${alpha("#fff", 0.9)}`,
  };

  const loadRadar = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set("country", country);
      params.set("timeframeDays", String(timeframeDays));
      if (regions.length) params.set("regions", regions.join(","));
      if (categories.length) params.set("categories", categories.join(","));
      const res = await fetch(`/api/admin/revenue-radar?${params.toString()}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load Revenue Radar");
      setData(json as RadarData);
      if (json?.recommendations?.keywords) {
        setKeywords((current) => current || json.recommendations.keywords);
      }
      if (json?.recommendations?.maxResults) setMaxResults(json.recommendations.maxResults);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Revenue Radar");
    } finally {
      setLoading(false);
    }
  }, [categories, country, regions, timeframeDays]);

  useEffect(() => {
    loadRadar();
  }, [loadRadar]);

  const pollRun = useCallback(async (runId: string) => {
    const res = await fetch(`/api/admin/crm/leads/auto-find/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || "Failed to load prospect search");
    setRun(json as AutoFindRun);
  }, []);

  useEffect(() => {
    if (!run?.runId || run.status === "completed" || run.status === "failed") return;
    const id = window.setInterval(() => {
      pollRun(run.runId).catch((e) => setError(e instanceof Error ? e.message : "Failed to poll prospect search"));
    }, 3000);
    return () => window.clearInterval(id);
  }, [pollRun, run?.runId, run?.status]);

  const regionOptions = useMemo(() => {
    if (!data) return [];
    return country === "Canada" ? data.options.canadaProvinces : data.options.usStates;
  }, [country, data]);

  const selectedCategoryLabels = useMemo(() => {
    const options = data?.options.categories || [];
    return categories.map((id) => options.find((entry) => entry.id === id)?.label || id).join(", ");
  }, [categories, data?.options.categories]);

  const runImportableIds = (run?.items || [])
    .filter((item) => item.searchResultId && !item.duplicate)
    .map((item) => item.searchResultId);

  const kpiCards: Array<{ label: string; value: string; rawValue: number; icon: ReactNode; color: string; note: string }> = [
    {
      label: "Total leads",
      value: formatNumber(data?.kpis.totalLeads),
      rawValue: data?.kpis.totalLeads || 0,
      icon: <AssessmentRoundedIcon />,
      color: "#2563eb",
      note: `${timeframeDays} day CRM view`,
    },
    {
      label: "Active pipeline",
      value: formatNumber(data?.kpis.activePipeline),
      rawValue: data?.kpis.activePipeline || 0,
      icon: <TrendingUpRoundedIcon />,
      color: "#16a34a",
      note: "Open opportunities",
    },
    {
      label: "Won / lost",
      value: `${formatNumber(data?.kpis.won)} / ${formatNumber(data?.kpis.lost)}`,
      rawValue: (data?.kpis.won || 0) + (data?.kpis.lost || 0),
      icon: <CheckCircleRoundedIcon />,
      color: "#7c3aed",
      note: "Closed outcomes",
    },
    {
      label: "Proposal stage",
      value: formatNumber(data?.kpis.proposalStage),
      rawValue: data?.kpis.proposalStage || 0,
      icon: <CampaignRoundedIcon />,
      color: "#f59e0b",
      note: "Decision-ready leads",
    },
    {
      label: "Overdue / stale",
      value: `${formatNumber(data?.kpis.overdue)} / ${formatNumber(data?.kpis.stale)}`,
      rawValue: (data?.kpis.overdue || 0) + (data?.kpis.stale || 0),
      icon: <WarningAmberRoundedIcon />,
      color: "#ef4444",
      note: "Follow-up risk",
    },
    {
      label: "Conversion",
      value: formatPercent(data?.kpis.conversionRate),
      rawValue: data?.kpis.conversionRate || 0,
      icon: <RocketLaunchRoundedIcon />,
      color: "#0ea5e9",
      note: "Won from closed",
    },
  ];

  const maxKpi = Math.max(...kpiCards.map((card) => card.rawValue), 1);

  function toggleValue(value: string, current: string[], setNext: (next: string[]) => void) {
    setNext(current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]);
  }

  function applyRecommendation() {
    if (!data) return;
    setCountry(data.recommendations.country);
    setRegions(data.recommendations.regions);
    setCategories(data.recommendations.categories);
    setKeywords(data.recommendations.keywords);
    setMaxResults(data.recommendations.maxResults);
  }

  async function startSearch() {
    try {
      setSearching(true);
      setError(null);
      setToast(null);
      setSelectedResultIds([]);
      const body = {
        country,
        regions,
        categories: categories.length ? categories : data?.recommendations.categories || [],
        keywords,
        maxResults,
      };
      const res = await fetch("/api/admin/revenue-radar/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to start prospect search");
      setRun({
        runId: json.runId,
        status: json.status || "queued",
        progress: Number(json.progress || 0),
        message: json.message || "Queued",
        items: [],
        searched: 0,
        duplicateCount: 0,
      });
      setToast("Prospect search started. Results will appear as batches complete.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start prospect search");
    } finally {
      setSearching(false);
    }
  }

  async function importResults(resultIds: string[]) {
    if (resultIds.length === 0) return;
    try {
      setImporting(true);
      setError(null);
      const res = await fetch("/api/admin/crm/leads/auto-find/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultIds }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to import prospects");
      setSelectedResultIds([]);
      setToast(`Imported ${formatNumber(json?.insertedCount || json?.imported || resultIds.length)} prospect${resultIds.length === 1 ? "" : "s"} to CRM.`);
      await loadRadar();
      if (run?.runId) await pollRun(run.runId).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import prospects");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "calc(100vh - 64px)",
        bgcolor: isDark ? "#07111f" : "#f3f6fb",
        p: { xs: 1, sm: 1.25, lg: 1.75 },
      }}
    >
      <Stack spacing={1.25} sx={{ maxWidth: 1900, mx: "auto" }}>
        <Card sx={surfaceSx}>
          <CardContent sx={{ p: { xs: 1.5, md: 2 }, "&:last-child": { pb: { xs: 1.5, md: 2 } } }}>
            <Stack
              direction={{ xs: "column", lg: "row" }}
              spacing={1.5}
              alignItems={{ xs: "stretch", lg: "center" }}
              justifyContent="space-between"
            >
              <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
                <Box
                  sx={{
                    width: 54,
                    height: 54,
                    borderRadius: "14px",
                    display: "grid",
                    placeItems: "center",
                    color: "#fff",
                    bgcolor: "#1458f5",
                    boxShadow: `0 14px 28px ${alpha("#1458f5", 0.28)}`,
                    flexShrink: 0,
                  }}
                >
                  <PublicRoundedIcon sx={{ fontSize: 30 }} />
                </Box>
                <Box minWidth={0}>
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography
                      component="h1"
                      sx={{ fontSize: { xs: 26, md: 32 }, fontWeight: 950, lineHeight: 1.05 }}
                    >
                      Revenue Radar
                    </Typography>
                    <Chip
                      size="small"
                      label="Canada / US"
                      sx={{
                        height: 26,
                        fontWeight: 850,
                        color: "#1458f5",
                        borderColor: alpha("#1458f5", 0.32),
                        bgcolor: isDark ? alpha("#1458f5", 0.14) : "#eff6ff",
                      }}
                      variant="outlined"
                    />
                    <Chip size="small" label={`Updated ${formatDateTime(data?.asOf)}`} variant="outlined" />
                  </Stack>
                  <Typography color="text.secondary" sx={{ mt: 0.55, maxWidth: 920, fontSize: { xs: 13.5, md: 15 } }}>
                    Prioritize sales regions, launch public-source prospect discovery, and import qualified auction, appraisal,
                    salvage, and equipment opportunities into CRM.
                  </Typography>
                </Box>
              </Stack>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1}
                alignItems={{ xs: "stretch", sm: "center" }}
                justifyContent="flex-end"
                sx={{ flexShrink: 0 }}
              >
                <Button
                  variant="outlined"
                  startIcon={<RefreshRoundedIcon />}
                  onClick={loadRadar}
                  disabled={loading}
                  sx={{ minHeight: 40, borderRadius: "10px", fontWeight: 850 }}
                >
                  Refresh
                </Button>
                <Button
                  variant="contained"
                  startIcon={<RocketLaunchRoundedIcon />}
                  onClick={applyRecommendation}
                  disabled={!data}
                  sx={{ minHeight: 40, borderRadius: "10px", fontWeight: 850 }}
                >
                  Apply recommendation
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        {error ? <Alert severity="error">{error}</Alert> : null}
        {toast ? (
          <Alert severity="success" onClose={() => setToast(null)}>
            {toast}
          </Alert>
        ) : null}

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "repeat(2, minmax(0, 1fr))",
              md: "repeat(3, minmax(0, 1fr))",
              xl: "repeat(6, minmax(0, 1fr))",
            },
            gap: 1.25,
          }}
        >
          {kpiCards.map((card) => {
            const progress = Math.min(100, Math.max(12, (card.rawValue / maxKpi) * 100));
            return (
              <Card key={card.label} sx={{ ...surfaceSx, minHeight: 128 }}>
                <CardContent sx={{ p: { xs: 1.2, sm: 1.45 }, "&:last-child": { pb: { xs: 1.2, sm: 1.45 } } }}>
                  <Stack spacing={1.15}>
                    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                      <Box minWidth={0}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }} noWrap>
                          {card.label}
                        </Typography>
                        <Typography
                          sx={{
                            mt: 0.35,
                            fontSize: { xs: 23, sm: 27 },
                            lineHeight: 1,
                            fontWeight: 950,
                            color: "text.primary",
                          }}
                        >
                          {loading ? "..." : card.value}
                        </Typography>
                      </Box>
                      <Box
                        sx={{
                          width: 38,
                          height: 38,
                          borderRadius: "11px",
                          display: "grid",
                          placeItems: "center",
                          bgcolor: alpha(card.color, isDark ? 0.18 : 0.12),
                          color: card.color,
                          flexShrink: 0,
                          "& svg": { fontSize: 23 },
                        }}
                      >
                        {card.icon}
                      </Box>
                    </Stack>
                    <LinearProgress
                      value={loading ? 0 : progress}
                      variant="determinate"
                      sx={{
                        height: 5,
                        borderRadius: 999,
                        bgcolor: alpha(card.color, 0.12),
                        "& .MuiLinearProgress-bar": {
                          bgcolor: card.color,
                          borderRadius: 999,
                        },
                      }}
                    />
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {card.note}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}
        </Box>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              lg: "320px minmax(0, 1fr)",
              xl: "320px minmax(0, 1fr) 360px",
            },
            gridTemplateAreas: {
              xs: `"filters" "main" "side"`,
              lg: `"filters main" "side main"`,
              xl: `"filters main side"`,
            },
            gap: 1.25,
            alignItems: "start",
          }}
        >
          <Stack spacing={1.25} sx={{ gridArea: "filters", minWidth: 0 }}>
            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                  <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
                    <TuneRoundedIcon sx={{ color: "#1458f5" }} />
                    <Typography variant="h6" sx={{ fontWeight: 950, lineHeight: 1.1 }}>
                      Targeting
                    </Typography>
                  </Stack>
                  <Chip size="small" label={`${timeframeDays}d`} color="primary" variant="outlined" />
                </Stack>

                <Stack spacing={1.25} sx={{ mt: 1.5 }}>
                  <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0.75 }}>
                    {(["Canada", "United States"] as RadarCountry[]).map((item) => (
                      <Button
                        key={item}
                        variant={country === item ? "contained" : "outlined"}
                        onClick={() => {
                          setCountry(item);
                          setRegions([]);
                        }}
                        size="small"
                        sx={{ minHeight: 36, borderRadius: "9px", fontWeight: 850 }}
                      >
                        {item}
                      </Button>
                    ))}
                  </Box>

                  <Box sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 850 }}>
                      Timeframe
                    </Typography>
                    <Stack direction="row" spacing={0.65} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
                      {(data?.options.timeframeDays || [30, 60, 90, 180, 365]).map((days) => (
                        <Chip
                          key={days}
                          clickable
                          size="small"
                          label={`${days}d`}
                          color={timeframeDays === days ? "primary" : "default"}
                          variant={timeframeDays === days ? "filled" : "outlined"}
                          onClick={() => setTimeframeDays(days)}
                          sx={{ fontWeight: 800 }}
                        />
                      ))}
                    </Stack>
                  </Box>

                  <Box sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                    <Stack direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 850 }}>
                        Regions
                      </Typography>
                      {regions.length ? (
                        <Button size="small" onClick={() => setRegions([])} sx={{ minHeight: 20, py: 0, fontSize: 12 }}>
                          Clear
                        </Button>
                      ) : null}
                    </Stack>
                    <Stack
                      direction="row"
                      spacing={0.65}
                      useFlexGap
                      flexWrap="wrap"
                      sx={{ mt: 0.75, maxHeight: { xs: 110, lg: 145 }, overflow: "auto", pr: 0.25 }}
                    >
                      {regionOptions.map((region) => (
                        <Chip
                          key={region}
                          clickable
                          size="small"
                          label={region}
                          color={regions.includes(region) ? "primary" : "default"}
                          variant={regions.includes(region) ? "filled" : "outlined"}
                          onClick={() => toggleValue(region, regions, setRegions)}
                          sx={{ maxWidth: "100%", fontWeight: 750 }}
                        />
                      ))}
                    </Stack>
                  </Box>

                  <Box sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                    <Stack direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 850 }}>
                        Revenue categories
                      </Typography>
                      {categories.length ? (
                        <Button size="small" onClick={() => setCategories([])} sx={{ minHeight: 20, py: 0, fontSize: 12 }}>
                          Clear
                        </Button>
                      ) : null}
                    </Stack>
                    <Stack direction="row" spacing={0.65} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
                      {(data?.options.categories || []).map((category) => (
                        <Chip
                          key={category.id}
                          clickable
                          size="small"
                          label={category.label}
                          color={categories.includes(category.id) ? "secondary" : "default"}
                          variant={categories.includes(category.id) ? "filled" : "outlined"}
                          onClick={() => toggleValue(category.id, categories, setCategories)}
                          sx={{ fontWeight: 750 }}
                        />
                      ))}
                    </Stack>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <SearchRoundedIcon sx={{ color: "#16a34a" }} />
                      <Typography variant="h6" sx={{ fontWeight: 950, lineHeight: 1.1 }}>
                        Prospect Scout
                      </Typography>
                    </Stack>
                    <Chip size="small" label={`${maxResults} max`} variant="outlined" />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    Start a public indexed-source lead search using the selected region and category signals.
                  </Typography>
                  <TextField
                    fullWidth
                    size="small"
                    label="Keywords"
                    multiline
                    minRows={3}
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="auction, asset recovery, fleet disposal..."
                  />
                  <Grid container spacing={1}>
                    <Grid size={{ xs: 5, lg: 12, xl: 5 }}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Max"
                        type="number"
                        value={maxResults}
                        onChange={(e) =>
                          setMaxResults(Math.min(Number(data?.options.maxResults || 100), Math.max(1, Number(e.target.value || 1))))
                        }
                        inputProps={{ min: 1, max: data?.options.maxResults || 100 }}
                      />
                    </Grid>
                    <Grid size={{ xs: 7, lg: 12, xl: 7 }}>
                      <Box sx={{ ...insetSx, borderRadius: "10px", p: 0.9, minHeight: 40 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                          Search target
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 850 }} noWrap>
                          {country} {regions.length ? `- ${regions.join(", ")}` : "- all regions"}
                        </Typography>
                      </Box>
                    </Grid>
                  </Grid>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {selectedCategoryLabels || "Recommended categories"}
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<SearchRoundedIcon />}
                    onClick={startSearch}
                    disabled={searching}
                    fullWidth
                    sx={{ minHeight: 42, borderRadius: "10px", fontWeight: 900 }}
                  >
                    {searching ? "Starting search..." : "Start search"}
                  </Button>
                  {run ? (
                    <Box sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" spacing={1}>
                        <Typography variant="body2" sx={{ fontWeight: 850 }} noWrap>
                          {statusLabel(run.status)}
                        </Typography>
                        <Chip size="small" label={`${Math.round(run.progress || 0)}%`} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                        {run.message}
                      </Typography>
                      <LinearProgress value={run.progress || 0} variant="determinate" sx={{ mt: 1, height: 6, borderRadius: 999 }} />
                      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                        <Chip size="small" label={`${formatNumber(run.items?.length || 0)} found`} />
                        <Chip size="small" label={`${formatNumber(run.duplicateCount || 0)} duplicates`} />
                      </Stack>
                      {run.error ? (
                        <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 0.75 }}>
                          {run.error}
                        </Typography>
                      ) : null}
                    </Box>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>
          </Stack>

          <Stack spacing={1.25} sx={{ gridArea: "main", minWidth: 0 }}>
            <Card sx={surfaceSx}>
              <CardContent sx={{ p: { xs: 1.4, md: 1.7 }, "&:last-child": { pb: { xs: 1.4, md: 1.7 } } }}>
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  justifyContent="space-between"
                  spacing={1}
                  alignItems={{ xs: "stretch", sm: "flex-start" }}
                >
                  <Box minWidth={0}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <MapRoundedIcon sx={{ color: "#1458f5" }} />
                      <Typography variant="h6" sx={{ fontWeight: 950 }}>
                        Opportunity map
                      </Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {data?.recommendations?.rationale ||
                        "Ranked region view from CRM pipeline, proposal activity, public prospects, and follow-up risk."}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={`${formatNumber(data?.kpis.publicProspects)} public prospects`}
                    sx={{ alignSelf: { xs: "flex-start", sm: "center" }, fontWeight: 850 }}
                  />
                </Stack>

                <Box
                  sx={{
                    mt: 1.35,
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "1fr",
                      sm: "repeat(2, minmax(0, 1fr))",
                      xxl: "repeat(3, minmax(0, 1fr))",
                    },
                    gap: 1,
                  }}
                >
                  {(data?.regionBreakdown || []).slice(0, 9).map((row) => {
                    const color = scoreColor(row.score);
                    return (
                      <Box
                        key={`${row.country}-${row.region}`}
                        sx={{
                          ...insetSx,
                          borderRadius: "11px",
                          p: 1.2,
                          minHeight: 164,
                          transition: "transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease",
                          "&:hover": {
                            transform: "translateY(-2px)",
                            borderColor: alpha(color, 0.38),
                            boxShadow: `0 12px 28px ${alpha(color, isDark ? 0.12 : 0.16)}`,
                          },
                        }}
                      >
                        <Stack direction="row" justifyContent="space-between" spacing={1}>
                          <Box minWidth={0}>
                            <Typography sx={{ fontWeight: 950, lineHeight: 1.1 }} noWrap>
                              {row.region}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {row.country || "Mixed market"}
                            </Typography>
                          </Box>
                          <Box
                            sx={{
                              width: 44,
                              height: 44,
                              borderRadius: "12px",
                              display: "grid",
                              placeItems: "center",
                              bgcolor: alpha(color, isDark ? 0.18 : 0.12),
                              color,
                              fontWeight: 950,
                              flexShrink: 0,
                            }}
                          >
                            {row.score}
                          </Box>
                        </Stack>
                        <LinearProgress
                          value={row.score}
                          variant="determinate"
                          sx={{
                            mt: 1.1,
                            height: 6,
                            borderRadius: 999,
                            bgcolor: alpha(color, 0.12),
                            "& .MuiLinearProgress-bar": { bgcolor: color, borderRadius: 999 },
                          }}
                        />
                        <Grid container spacing={0.75} sx={{ mt: 1 }}>
                          {[
                            ["Leads", row.totalLeads],
                            ["Pipeline", row.activePipeline],
                            ["Public", row.autoFound],
                            ["Overdue", row.overdue],
                          ].map(([label, value]) => (
                            <Grid key={label} size={6}>
                              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                                {label}
                              </Typography>
                              <Typography sx={{ fontWeight: 900, lineHeight: 1.15 }}>{formatNumber(Number(value))}</Typography>
                            </Grid>
                          ))}
                        </Grid>
                        <Stack direction="row" spacing={0.45} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                          {row.topCategories.slice(0, 2).map((category) => (
                            <Chip key={category.id} label={category.label} size="small" variant="outlined" sx={{ maxWidth: "100%" }} />
                          ))}
                        </Stack>
                      </Box>
                    );
                  })}
                  {!loading && (data?.regionBreakdown || []).length === 0 ? (
                    <Alert severity="info" sx={{ gridColumn: "1 / -1" }}>
                      No CRM activity matched these filters yet. Start Prospect Scout to build a public-source pipeline.
                    </Alert>
                  ) : null}
                </Box>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: { xs: 1.35, md: 1.7 }, "&:last-child": { pb: { xs: 1.35, md: 1.7 } } }}>
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "stretch", sm: "center" }}
                  spacing={1}
                >
                  <Box minWidth={0}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <BusinessCenterRoundedIcon sx={{ color: "#16a34a" }} />
                      <Typography variant="h6" sx={{ fontWeight: 950 }}>
                        Prospect search results
                      </Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.45 }}>
                      Review source evidence before importing selected prospects into CRM.
                    </Typography>
                  </Box>
                  <Button
                    variant="contained"
                    color="success"
                    disabled={selectedResultIds.length === 0 || importing}
                    onClick={() => importResults(selectedResultIds)}
                    sx={{ borderRadius: "10px", fontWeight: 900, minHeight: 38 }}
                  >
                    Import selected
                  </Button>
                </Stack>

                <TableContainer sx={{ mt: 1.25, maxHeight: { xs: 360, md: 430 }, overflowX: "auto" }}>
                  <Table size="small" stickyHeader sx={{ minWidth: 760 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell padding="checkbox">
                          <Checkbox
                            size="small"
                            checked={runImportableIds.length > 0 && selectedResultIds.length === runImportableIds.length}
                            indeterminate={selectedResultIds.length > 0 && selectedResultIds.length < runImportableIds.length}
                            onChange={(e) => setSelectedResultIds(e.target.checked ? runImportableIds : [])}
                          />
                        </TableCell>
                        <TableCell>Company</TableCell>
                        <TableCell>Location</TableCell>
                        <TableCell>Fit</TableCell>
                        <TableCell align="right">Source</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(run?.items || []).map((item) => {
                        const lead = item.lead || {};
                        const id = item.searchResultId;
                        const disabled = !id || item.duplicate;
                        return (
                          <TableRow key={id || `${lead.companyName}-${lead.sourceUrl}`} hover>
                            <TableCell padding="checkbox">
                              <Checkbox
                                size="small"
                                disabled={disabled}
                                checked={selectedResultIds.includes(id)}
                                onChange={() => toggleValue(id, selectedResultIds, setSelectedResultIds)}
                              />
                            </TableCell>
                            <TableCell sx={{ maxWidth: 300 }}>
                              <Typography variant="body2" sx={{ fontWeight: 900 }} noWrap>
                                {lead.companyName || item.draftPreview?.companyName || "Unknown company"}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                                {lead.industry || item.draftPreview?.industry || (item.duplicate ? "Duplicate" : "Public prospect")}
                              </Typography>
                            </TableCell>
                            <TableCell sx={{ maxWidth: 220 }}>
                              <Typography variant="body2" noWrap>
                                {lead.companyLocation || lead.contactLocation || item.draftPreview?.companyLocation || "--"}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                color={item.duplicate ? "warning" : "success"}
                                label={item.duplicate ? "Duplicate" : `${fitScore(lead.confidence)}%`}
                                sx={{ fontWeight: 850 }}
                              />
                            </TableCell>
                            <TableCell align="right">
                              {lead.sourceUrl ? (
                                <Button
                                  size="small"
                                  component="a"
                                  href={lead.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  endIcon={<OpenInNewRoundedIcon />}
                                  sx={{ fontWeight: 850 }}
                                >
                                  Source
                                </Button>
                              ) : (
                                "--"
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {!run?.items?.length ? (
                        <TableRow>
                          <TableCell colSpan={5}>
                            <Box sx={{ py: 3, textAlign: "center" }}>
                              <SearchRoundedIcon sx={{ color: "text.disabled", fontSize: 38 }} />
                              <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                                Start a prospect search to populate this table.
                              </Typography>
                            </Box>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: { xs: 1.35, md: 1.7 }, "&:last-child": { pb: { xs: 1.35, md: 1.7 } } }}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="space-between">
                  <Box>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <SourceRoundedIcon sx={{ color: "#7c3aed" }} />
                      <Typography variant="h6" sx={{ fontWeight: 950 }}>
                        Recent public prospects
                      </Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.45 }}>
                      Previously found public-source prospects available for review or import.
                    </Typography>
                  </Box>
                  <Chip size="small" label={`${formatNumber(data?.recentProspects?.length || 0)} visible`} variant="outlined" />
                </Stack>

                <TableContainer sx={{ mt: 1.25, maxHeight: { xs: 360, md: 410 }, overflowX: "auto" }}>
                  <Table size="small" stickyHeader sx={{ minWidth: 920 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Company</TableCell>
                        <TableCell>Region</TableCell>
                        <TableCell>Category</TableCell>
                        <TableCell>Confidence</TableCell>
                        <TableCell>Agent</TableCell>
                        <TableCell align="right">Action</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(data?.recentProspects || []).map((item) => (
                        <TableRow key={item.id} hover>
                          <TableCell sx={{ maxWidth: 320 }}>
                            <Typography variant="body2" sx={{ fontWeight: 900 }} noWrap>
                              {item.companyName || item.clientName || "Unknown company"}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                              {item.evidence || item.sourceTitle || item.website || "Public-source prospect"}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ maxWidth: 190 }}>
                            <Typography variant="body2" noWrap>
                              {item.location || item.regions.join(", ") || item.country || "--"}
                            </Typography>
                          </TableCell>
                          <TableCell>{item.category.label}</TableCell>
                          <TableCell>
                            <Chip size="small" label={`${item.confidence}%`} color={item.confidence >= 70 ? "success" : "default"} />
                          </TableCell>
                          <TableCell sx={{ maxWidth: 160 }}>
                            <Typography variant="body2" noWrap>
                              {item.suggestedAgent?.label || "--"}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                              {item.sourceUrl ? (
                                <Button size="small" component="a" href={item.sourceUrl} target="_blank" rel="noreferrer">
                                  Source
                                </Button>
                              ) : null}
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={item.status === "imported" || importing}
                                onClick={() => importResults([item.id])}
                              >
                                {item.status === "imported" ? "Imported" : "Import"}
                              </Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                      {!loading && !(data?.recentProspects || []).length ? (
                        <TableRow>
                          <TableCell colSpan={6}>
                            <Box sx={{ py: 2.5, textAlign: "center" }}>
                              <Typography color="text.secondary">No public-source prospects found for these filters yet.</Typography>
                            </Box>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>
          </Stack>

          <Stack spacing={1.25} sx={{ gridArea: "side", minWidth: 0 }}>
            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Typography variant="h6" sx={{ fontWeight: 950 }}>
                  Category signals
                </Typography>
                <Stack spacing={1.05} sx={{ mt: 1.2 }}>
                  {(data?.categoryBreakdown || []).slice(0, 6).map((category) => (
                    <Box key={category.id} sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" spacing={1}>
                        <Typography variant="body2" sx={{ fontWeight: 900 }} noWrap>
                          {category.label}
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 950 }}>
                          {category.score}
                        </Typography>
                      </Stack>
                      <LinearProgress
                        value={category.score}
                        variant="determinate"
                        sx={{ mt: 0.8, height: 5, borderRadius: 999 }}
                      />
                      <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }}>
                        <Typography variant="caption" color="text.secondary">
                          {formatNumber(category.leads)} leads
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatNumber(category.autoFound)} public
                        </Typography>
                      </Stack>
                    </Box>
                  ))}
                  {!loading && !(data?.categoryBreakdown || []).length ? (
                    <Typography color="text.secondary">No category signal yet.</Typography>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <ErrorOutlineRoundedIcon sx={{ color: "#ef4444" }} />
                  <Typography variant="h6" sx={{ fontWeight: 950 }}>
                    Follow-up risk
                  </Typography>
                </Stack>
                <Stack spacing={0.9} sx={{ mt: 1.2 }}>
                  {(data?.staleLeads || []).slice(0, 6).map((lead) => (
                    <Box key={lead.id} sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                        <Box minWidth={0}>
                          <Typography variant="body2" sx={{ fontWeight: 900 }} noWrap>
                            {lead.companyName || lead.clientName || "Lead"}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }} noWrap>
                            {statusLabel(lead.status)} - {lead.assignedTo || "Unassigned"}
                          </Typography>
                        </Box>
                        <Chip size="small" color={lead.overdue ? "error" : "warning"} label={lead.overdue ? "Overdue" : "Stale"} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        Due {formatDate(lead.dueDate)} {lead.location ? `- ${lead.location}` : ""}
                      </Typography>
                    </Box>
                  ))}
                  {!data?.staleLeads?.length ? (
                    <Typography color="text.secondary">No overdue or stale lead risk in this view.</Typography>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Typography variant="h6" sx={{ fontWeight: 950 }}>
                  Lead sources
                </Typography>
                <Stack spacing={0.85} sx={{ mt: 1.1 }}>
                  {(data?.sourceBreakdown || []).slice(0, 4).map((source) => (
                    <Stack key={source.source} direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {source.source}
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 900 }}>
                        {formatNumber(source.count)}
                      </Typography>
                    </Stack>
                  ))}
                  {!loading && !(data?.sourceBreakdown || []).length ? (
                    <Typography color="text.secondary">No CRM lead source data in this view.</Typography>
                  ) : null}
                </Stack>
                <Divider sx={{ my: 1.25 }} />
                <Typography variant="subtitle2" sx={{ fontWeight: 950 }}>
                  Official context
                </Typography>
                <Stack spacing={0.9} sx={{ mt: 0.85 }}>
                  {(data?.marketSources || []).map((source) => (
                    <Box key={source.url} sx={{ ...insetSx, borderRadius: "10px", p: 1 }}>
                      <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="flex-start">
                        <Box minWidth={0}>
                          <Typography variant="body2" sx={{ fontWeight: 900 }}>
                            {source.title}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {source.note}
                          </Typography>
                        </Box>
                        <Button
                          size="small"
                          component="a"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          endIcon={<OpenInNewRoundedIcon />}
                          sx={{ flexShrink: 0 }}
                        >
                          Open
                        </Button>
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>

            <Card sx={surfaceSx}>
              <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <WarningAmberRoundedIcon sx={{ color: "#f59e0b" }} />
                  <Typography variant="h6" sx={{ fontWeight: 950 }}>
                    Outreach guardrails
                  </Typography>
                </Stack>
                <Stack spacing={1} sx={{ mt: 1.15 }}>
                  {(data?.compliance || []).map((item) => (
                    <Box
                      key={item.region}
                      sx={{
                        ...insetSx,
                        borderRadius: "10px",
                        p: 1,
                        borderColor: alpha(theme.palette.info.main, isDark ? 0.26 : 0.22),
                      }}
                    >
                      <Stack direction="row" justifyContent="space-between" spacing={1}>
                        <Typography variant="body2" sx={{ fontWeight: 950 }}>
                          {item.region}
                        </Typography>
                        <Button size="small" component="a" href={item.url} target="_blank" rel="noreferrer">
                          Guidance
                        </Button>
                      </Stack>
                      <Stack component="ul" sx={{ pl: 2.2, my: 0.4 }}>
                        {item.bullets.slice(0, 3).map((bullet) => (
                          <Typography key={bullet} component="li" variant="caption" color="text.secondary">
                            {bullet}
                          </Typography>
                        ))}
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
