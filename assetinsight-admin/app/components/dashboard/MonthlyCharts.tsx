"use client";

import AssessmentRoundedIcon from "@mui/icons-material/AssessmentRounded";
import TrendingUpRoundedIcon from "@mui/icons-material/TrendingUpRounded";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Bar, Chart } from "react-chartjs-2";
import { alpha, Box, Card, CardContent, Chip, Stack, Typography, useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler
);

type ReportTypeKey = "Asset" | "LotListing" | "RealEstate" | "Salvage";

type MonthlyResponse = {
  months: string[];
  reports: { totals: number[]; byType: Record<ReportTypeKey, number[]> };
  users: { totals: number[] };
  deltas: {
    reports: { total: number; delta: number; percent: number };
    users: { total: number; delta: number; percent: number };
  };
};

type UserReportRow = {
  userId: string;
  label: string;
  email?: string;
  total: number;
  Asset: number;
  LotListing: number;
  RealEstate: number;
  Salvage: number;
};

type LotListingUserRow = {
  userId: string;
  label: string;
  email?: string;
  count: number;
};

type LotStatsUserRow = {
  userId: string;
  label: string;
  email?: string;
  lotCount: number;
  lotValue: number;
};

type AnalyticsResponse = {
  reportsByUser: UserReportRow[];
  lotListingsByUser: LotListingUserRow[];
  lotStatsByUser: LotStatsUserRow[];
};

const reportTypeMeta: Record<ReportTypeKey, { label: string; color: string }> = {
  Asset: { label: "Asset", color: "#2f80ed" },
  LotListing: { label: "Lot Listing", color: "#7c3aed" },
  RealEstate: { label: "Real Estate", color: "#16a34a" },
  Salvage: { label: "Salvage", color: "#f59e0b" },
};

const surfaceSx = {
  height: "100%",
  borderRadius: "12px",
  border: "1px solid",
  borderColor: (theme: any) =>
    theme.palette.mode === "dark" ? alpha("#93a9c8", 0.18) : alpha("#94a3b8", 0.28),
  background: (theme: any) =>
    theme.palette.mode === "dark"
      ? `linear-gradient(180deg, ${alpha("#132238", 0.96)}, ${alpha("#0b1728", 0.98)})`
      : "rgba(255,255,255,0.94)",
  boxShadow: (theme: any) =>
    theme.palette.mode === "dark"
      ? `0 18px 46px ${alpha("#020617", 0.46)}, inset 0 1px 0 ${alpha("#fff", 0.04)}`
      : `0 16px 38px ${alpha("#0f172a", 0.10)}, inset 0 1px 0 ${alpha("#fff", 0.95)}`,
  transition: "transform 170ms ease, box-shadow 170ms ease",
  "&:hover": {
    transform: "translateY(-2px)",
    boxShadow: (theme: any) =>
      theme.palette.mode === "dark"
        ? `0 22px 52px ${alpha("#020617", 0.58)}, inset 0 1px 0 ${alpha("#fff", 0.05)}`
        : `0 20px 46px ${alpha("#0f172a", 0.13)}, inset 0 1px 0 ${alpha("#fff", 1)}`,
  },
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

function topWithOthers<T>(
  rows: T[],
  valueOf: (row: T) => number,
  buildOthers: (rows: T[]) => T,
  limit = 10
) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  if (sorted.length <= limit) return sorted;
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit).filter((row) => valueOf(row) > 0);
  return rest.length ? [...top, buildOthers(rest)] : top;
}

function chartErrorBox(theme: any, message: string) {
  return (
    <Box sx={{ color: "error.main", bgcolor: alpha(theme.palette.error.main, 0.08), borderRadius: "8px", p: 1.5 }}>
      {message}
    </Box>
  );
}

export default function MonthlyCharts() {
  const theme = useTheme();
  const [monthly, setMonthly] = useState<MonthlyResponse | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [monthlyRes, analyticsRes] = await Promise.all([
          fetch("/api/admin/stats/monthly", { cache: "no-store" }),
          fetch("/api/admin/stats/dashboard-analytics", { cache: "no-store" }),
        ]);
        const monthlyJson = await monthlyRes.json().catch(() => ({}));
        const analyticsJson = await analyticsRes.json().catch(() => ({}));
        if (!monthlyRes.ok) throw new Error(monthlyJson?.message || "Failed to load monthly stats");
        if (!analyticsRes.ok) throw new Error(analyticsJson?.message || "Failed to load dashboard analytics");
        setMonthly(monthlyJson);
        setAnalytics(analyticsJson);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to load dashboard analytics";
        setError(message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const months = useMemo(() => monthly?.months || [], [monthly]);
  const byType = useMemo(() => monthly?.reports?.byType, [monthly]);
  const reportKpi = monthly?.deltas?.reports || { total: 0, delta: 0, percent: 0 };
  const reportTrendUp = reportKpi.delta >= 0;

  const chartText = theme.palette.mode === "dark" ? "#dbeafe" : "#1f2a44";
  const mutedText = theme.palette.mode === "dark" ? "#93a9c8" : "#52637a";
  const gridColor = theme.palette.mode === "dark" ? "rgba(147,169,200,0.15)" : "rgba(31,42,68,0.10)";

  const baseLegend = useMemo(
    () => ({
      position: "top" as const,
      align: "end" as const,
      labels: {
        color: chartText,
        boxWidth: 10,
        boxHeight: 10,
        padding: 14,
        font: { size: 12, weight: 600 },
      },
    }),
    [chartText]
  );

  const reportsByTypeData = useMemo(
    () => ({
      labels: months,
      datasets: (Object.keys(reportTypeMeta) as ReportTypeKey[]).map((type) => ({
        label: reportTypeMeta[type].label,
        data: byType?.[type] || [],
        backgroundColor: reportTypeMeta[type].color,
        borderColor: reportTypeMeta[type].color,
        borderWidth: 1,
        borderRadius: 2,
      })),
    }),
    [byType, months]
  );

  const reportsByTypeOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: baseLegend,
        tooltip: { mode: "index" as const, intersect: false },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: mutedText, maxRotation: 0 },
          grid: { display: false },
          border: { color: gridColor },
        },
        y: {
          stacked: true,
          ticks: { color: mutedText, precision: 0 },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
      },
    }),
    [baseLegend, gridColor, mutedText]
  );

  const lotStatsRows = useMemo(
    () =>
      topWithOthers<LotStatsUserRow>(
        analytics?.lotStatsByUser || [],
        (row) => row.lotCount,
        (rows) => ({
          userId: "others",
          label: "Others",
          lotCount: rows.reduce((sum, row) => sum + row.lotCount, 0),
          lotValue: rows.reduce((sum, row) => sum + row.lotValue, 0),
        })
      ),
    [analytics]
  );

  const lotCountValueData = useMemo(
    () => ({
      labels: lotStatsRows.map((row) => row.label),
      datasets: [
        {
          type: "bar" as const,
          label: "Lot Count",
          data: lotStatsRows.map((row) => row.lotCount),
          backgroundColor: "rgba(37,99,235,0.72)",
          borderColor: "#2563eb",
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: "y",
        },
        {
          type: "line" as const,
          label: "Lot Value",
          data: lotStatsRows.map((row) => row.lotValue),
          borderColor: "#16a34a",
          backgroundColor: "rgba(22,163,74,0.12)",
          pointBackgroundColor: "#16a34a",
          pointBorderColor: "#16a34a",
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.3,
          yAxisID: "y1",
        },
      ],
    }),
    [lotStatsRows]
  );

  const lotCountValueOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index" as const, intersect: false },
      plugins: {
        legend: baseLegend,
        tooltip: {
          callbacks: {
            label: (ctx: any) =>
              ctx.dataset.label === "Lot Value"
                ? `Lot Value: ${currencyFormatter.format(Number(ctx.raw || 0))}`
                : `Lot Count: ${ctx.raw}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: mutedText, maxRotation: 35, minRotation: 0 },
          grid: { display: false },
          border: { color: gridColor },
        },
        y: {
          type: "linear" as const,
          position: "left" as const,
          ticks: { color: mutedText, precision: 0 },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
        y1: {
          type: "linear" as const,
          position: "right" as const,
          ticks: {
            color: mutedText,
            callback: (value: string | number) => currencyFormatter.format(Number(value)),
          },
          grid: { drawOnChartArea: false },
          border: { color: gridColor },
        },
      },
    }),
    [baseLegend, gridColor, mutedText]
  );

  const reportsByUserRows = useMemo(
    () =>
      topWithOthers<UserReportRow>(
        analytics?.reportsByUser || [],
        (row) => row.total,
        (rows) => ({
          userId: "others",
          label: "Others",
          total: rows.reduce((sum, row) => sum + row.total, 0),
          Asset: rows.reduce((sum, row) => sum + row.Asset, 0),
          LotListing: rows.reduce((sum, row) => sum + row.LotListing, 0),
          RealEstate: rows.reduce((sum, row) => sum + row.RealEstate, 0),
          Salvage: rows.reduce((sum, row) => sum + row.Salvage, 0),
        })
      ),
    [analytics]
  );

  const reportsByUserData = useMemo(
    () => ({
      labels: reportsByUserRows.map((row) => row.label),
      datasets: (Object.keys(reportTypeMeta) as ReportTypeKey[]).map((type) => ({
        label: reportTypeMeta[type].label,
        data: reportsByUserRows.map((row) => row[type]),
        backgroundColor: reportTypeMeta[type].color,
        borderColor: reportTypeMeta[type].color,
        borderWidth: 1,
        borderRadius: 2,
      })),
    }),
    [reportsByUserRows]
  );

  const stackedUserOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: baseLegend,
        tooltip: { mode: "index" as const, intersect: false },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: mutedText, maxRotation: 35 },
          grid: { display: false },
          border: { color: gridColor },
        },
        y: {
          stacked: true,
          ticks: { color: mutedText, precision: 0 },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
      },
    }),
    [baseLegend, gridColor, mutedText]
  );

  const lotListingRows = useMemo(
    () =>
      topWithOthers<LotListingUserRow>(
        analytics?.lotListingsByUser || [],
        (row) => row.count,
        (rows) => ({
          userId: "others",
          label: "Others",
          count: rows.reduce((sum, row) => sum + row.count, 0),
        })
      ),
    [analytics]
  );

  const lotListingData = useMemo(
    () => ({
      labels: lotListingRows.map((row) => row.label),
      datasets: [
        {
          label: "Lot Listings",
          data: lotListingRows.map((row) => row.count),
          backgroundColor: "rgba(124,58,237,0.78)",
          borderColor: "#7c3aed",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    }),
    [lotListingRows]
  );

  const lotListingOptions = useMemo(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index" as const, intersect: false },
      },
      scales: {
        x: {
          ticks: { color: mutedText, precision: 0 },
          grid: { color: gridColor },
          border: { color: gridColor },
        },
        y: {
          ticks: { color: mutedText },
          grid: { display: false },
          border: { color: gridColor },
        },
      },
    }),
    [gridColor, mutedText]
  );

  return (
    <Box
      component="section"
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "1fr",
          lg: "minmax(220px, 0.62fr) minmax(0, 1.38fr) minmax(0, 1.2fr)",
        },
        gap: 1.5,
      }}
    >
      <Card sx={surfaceSx}>
        <CardContent sx={{ p: { xs: 2, md: 2.75 }, height: "100%", "&:last-child": { pb: { xs: 2, md: 2.75 } } }}>
          <Stack spacing={2.4} sx={{ height: "100%" }}>
            <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1.5}>
              <Box minWidth={0}>
                <Typography component="h3" sx={{ fontSize: 20, fontWeight: 950, lineHeight: 1.1 }}>
                  Reports <Typography component="span" color="text.secondary" sx={{ fontSize: 17, fontWeight: 650 }}>(this month)</Typography>
                </Typography>
                <Typography variant="h3" sx={{ mt: 2.25, fontWeight: 950, lineHeight: 1 }} suppressHydrationWarning>
                  {loading ? "..." : reportKpi.total}
                </Typography>
              </Box>
              {!loading ? (
                <Chip
                  size="small"
                  icon={<TrendingUpRoundedIcon />}
                  label={`${Math.abs(reportKpi.percent).toFixed(1)}%`}
                  sx={{
                    height: 40,
                    borderRadius: "10px",
                    px: 0.8,
                    bgcolor: reportTrendUp ? alpha("#16a34a", 0.13) : alpha("#dc2626", 0.13),
                    color: reportTrendUp ? "#16a34a" : "#dc2626",
                    fontWeight: 850,
                    "& .MuiChip-icon": {
                      color: "inherit",
                      transform: reportTrendUp ? "none" : "rotate(180deg)",
                    },
                  }}
                />
              ) : null}
            </Stack>

            <Box sx={{ flex: 1, display: "flex", alignItems: "center" }}>
              <Box
                sx={{
                  width: 76,
                  height: 76,
                  borderRadius: "999px",
                  display: "grid",
                  placeItems: "center",
                  bgcolor: (muiTheme) => (muiTheme.palette.mode === "dark" ? alpha("#2563eb", 0.18) : "#eff6ff"),
                  color: "#2563eb",
                  "& svg": { fontSize: 40 },
                }}
              >
                <AssessmentRoundedIcon />
              </Box>
            </Box>

            <Typography variant="body1" color="text.secondary" sx={{ fontWeight: 520, lineHeight: 1.55 }}>
              {reportTrendUp ? "Monthly report generation is trending upward." : "Monthly report generation remains steady."}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card sx={surfaceSx}>
        <CardContent sx={{ p: { xs: 2, md: 2.6 }, "&:last-child": { pb: { xs: 2, md: 2.6 } } }}>
          <Typography component="h3" sx={{ fontSize: 20, fontWeight: 950, mb: 1 }}>
            All Reports by User
          </Typography>
          <Box sx={{ height: { xs: 300, md: 340, xl: 360 }, overflowX: "auto" }}>
            <Box sx={{ minWidth: { xs: 720, md: "auto" }, height: "100%" }}>
              {error ? chartErrorBox(theme, error) : <Bar data={reportsByUserData} options={stackedUserOptions as any} />}
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Card sx={surfaceSx}>
        <CardContent sx={{ p: { xs: 2, md: 2.6 }, "&:last-child": { pb: { xs: 2, md: 2.6 } } }}>
          <Typography component="h3" sx={{ fontSize: 20, fontWeight: 950, mb: 1 }}>
            Reports by Type
          </Typography>
          <Box sx={{ height: { xs: 300, md: 340, xl: 360 } }}>
            {error ? chartErrorBox(theme, error) : <Bar data={reportsByTypeData} options={reportsByTypeOptions as any} />}
          </Box>
        </CardContent>
      </Card>

      <Card sx={{ ...surfaceSx, gridColumn: { xs: "auto", lg: "span 2" } }}>
        <CardContent sx={{ p: { xs: 2, md: 2.6 }, "&:last-child": { pb: { xs: 2, md: 2.6 } } }}>
          <Typography component="h3" sx={{ fontSize: 20, fontWeight: 950, mb: 1 }}>
            Lot Count vs Lot Value by User
          </Typography>
          <Box sx={{ height: { xs: 320, md: 390, xl: 420 }, overflowX: "auto" }}>
            <Box sx={{ minWidth: { xs: 720, md: "auto" }, height: "100%" }}>
              {error ? chartErrorBox(theme, error) : <Chart type="bar" data={lotCountValueData as any} options={lotCountValueOptions as any} />}
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Card sx={surfaceSx}>
        <CardContent sx={{ p: { xs: 2, md: 2.6 }, "&:last-child": { pb: { xs: 2, md: 2.6 } } }}>
          <Typography component="h3" sx={{ fontSize: 20, fontWeight: 950, mb: 1 }}>
            Lot Listings by User
          </Typography>
          <Box sx={{ height: { xs: 320, md: 360 } }}>
            {error ? chartErrorBox(theme, error) : <Bar data={lotListingData} options={lotListingOptions as any} />}
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
