"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import TrendingUpRoundedIcon from "@mui/icons-material/TrendingUpRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";

type Finding = {
  code: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  lotNumber?: string;
  actionTarget?: "data" | "cr-notes" | "proposal-valuation" | "regenerate";
};

type HighestValueLot = {
  lotId: string;
  lotNumber: string;
  title: string;
  fmv: number | null;
  imageCount: number;
};

type AdvisoryResult = {
  observations?: Array<string | { title?: string; detail?: string }>;
  comparableRanges?: Array<{
    item?: string;
    rangeLow?: number;
    rangeHigh?: number;
    currency?: string;
    rationale?: string;
  }>;
  confidence?: string | number;
  cautions?: string[];
  sources?: Array<{ title?: string; url?: string; note?: string }>;
  [key: string]: unknown;
};

type InsightsPayload = {
  fingerprint: string;
  staticInsights: {
    currency: string;
    totals: { flv: number; olv: number; fmv: number };
    medianFmv: number;
    highestValueLots: HighestValueLot[];
    lotCount: number;
    imageCount: number;
    imageCoveragePercent: number;
    releaseTurnaroundMs: number | null;
  };
  qualitySummary: {
    issueCount: number;
    counts: { critical: number; warning: number; info: number };
    imageCoveragePercent: number;
  };
  findings: Finding[];
  analysis: null | {
    id: string;
    status: "queued" | "processing" | "completed" | "failed";
    result: AdvisoryResult | null;
    error: string | null;
    model: string | null;
    updatedAt: string;
    stale: boolean;
  };
};

type Props = {
  open: boolean;
  reportId: string;
  reportTitle: string;
  onClose: () => void;
  onAction: (target: NonNullable<Finding["actionTarget"]>) => void;
};

const money = (value: number, currency: string) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: currency || "CAD",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const duration = (value: number | null) => {
  if (value == null) return "Not available";
  const hours = value / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
};

const observationText = (value: string | { title?: string; detail?: string }) =>
  typeof value === "string"
    ? value
    : [value.title, value.detail].filter(Boolean).join(": ");

const normalizeInsightsPayload = (value: unknown): InsightsPayload => {
  const input = (value && typeof value === "object" ? value : {}) as Partial<InsightsPayload>;
  const staticInsights = input.staticInsights;
  const qualitySummary = input.qualitySummary;

  // Keep the drawer usable when a legacy cache row is missing newer summary fields.
  return {
    fingerprint: String(input.fingerprint || ""),
    staticInsights: {
      currency: String(staticInsights?.currency || "CAD"),
      totals: {
        flv: Number(staticInsights?.totals?.flv || 0),
        olv: Number(staticInsights?.totals?.olv || 0),
        fmv: Number(staticInsights?.totals?.fmv || 0),
      },
      medianFmv: Number(staticInsights?.medianFmv || 0),
      highestValueLots: Array.isArray(staticInsights?.highestValueLots)
        ? staticInsights.highestValueLots
        : [],
      lotCount: Number(staticInsights?.lotCount || 0),
      imageCount: Number(staticInsights?.imageCount || 0),
      imageCoveragePercent: Number(staticInsights?.imageCoveragePercent || 0),
      releaseTurnaroundMs:
        typeof staticInsights?.releaseTurnaroundMs === "number"
          ? staticInsights.releaseTurnaroundMs
          : null,
    },
    qualitySummary: {
      issueCount: Number(qualitySummary?.issueCount || 0),
      counts: {
        critical: Number(qualitySummary?.counts?.critical || 0),
        warning: Number(qualitySummary?.counts?.warning || 0),
        info: Number(qualitySummary?.counts?.info || 0),
      },
      imageCoveragePercent: Number(qualitySummary?.imageCoveragePercent || 0),
    },
    findings: Array.isArray(input.findings) ? input.findings : [],
    analysis: input.analysis || null,
  };
};

export default function ReleasedAppraisalInsights({
  open,
  reportId,
  reportTitle,
  onClose,
  onAction,
}: Props) {
  const [payload, setPayload] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (quiet = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/released-appraisals/${encodeURIComponent(reportId)}/analysis`,
        { cache: "no-store", signal: controller.signal }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to load appraisal insights");
      setPayload(normalizeInsightsPayload(body));
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError(loadError instanceof Error ? loadError.message : "Unable to load appraisal insights");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    if (!open) return;
    void load();
    return () => abortRef.current?.abort();
  }, [load, open]);

  const analysisActive = ["queued", "processing"].includes(payload?.analysis?.status || "");
  useEffect(() => {
    if (!open || !analysisActive) return;
    const timer = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(timer);
  }, [analysisActive, load, open]);

  async function runAnalysis(refresh: boolean) {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/released-appraisals/${encodeURIComponent(reportId)}/analysis`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh }),
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to start market analysis");
      await load(true);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Unable to start market analysis");
    } finally {
      setStarting(false);
    }
  }

  const result = payload?.analysis?.result;
  const observations = useMemo(
    () => (Array.isArray(result?.observations) ? result.observations : []),
    [result]
  );
  const comparables = Array.isArray(result?.comparableRanges) ? result.comparableRanges : [];
  const cautions = Array.isArray(result?.cautions) ? result.cautions : [];
  const sources = Array.isArray(result?.sources) ? result.sources : [];

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: "100vw", sm: "min(760px, 92vw)" },
          bgcolor: "background.default",
          backgroundImage: "none",
        },
      }}
    >
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 2.25, borderBottom: "1px solid", borderColor: "divider" }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <AutoAwesomeRoundedIcon sx={{ color: "#dc2626" }} />
                <Typography component="h2" sx={{ fontSize: 21, fontWeight: 750 }}>Appraisal insights</Typography>
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 0.5, fontSize: 13 }}>{reportTitle}</Typography>
            </Box>
            <IconButton aria-label="Close insights" onClick={onClose} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: { xs: 2, sm: 3 }, py: 2.5 }}>
          {loading && !payload ? <Box sx={{ display: "grid", minHeight: 260, placeItems: "center" }}><CircularProgress size={28} /></Box> : null}
          {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
          {payload ? (
            <Stack spacing={2.5}>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" }, gap: 1 }}>
                {[
                  ["FMV", money(payload.staticInsights.totals.fmv, payload.staticInsights.currency)],
                  ["Median lot", money(payload.staticInsights.medianFmv, payload.staticInsights.currency)],
                  ["Lots / images", `${payload.staticInsights.lotCount} / ${payload.staticInsights.imageCount}`],
                  ["Release time", duration(payload.staticInsights.releaseTurnaroundMs)],
                ].map(([label, value]) => (
                  <Box key={label} sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 1.5 }}>
                    <Typography color="text.secondary" sx={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{label}</Typography>
                    <Typography sx={{ mt: 0.5, fontSize: 17, fontWeight: 750 }}>{value}</Typography>
                  </Box>
                ))}
              </Box>

              <Box sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 2 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Box>
                    <Typography sx={{ fontWeight: 750 }}>Quality review</Typography>
                    <Typography color="text.secondary" sx={{ mt: 0.25, fontSize: 12 }}>
                      Deterministic checks across every lot and generated file.
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    <Chip size="small" color="error" label={`${payload.qualitySummary.counts.critical} critical`} />
                    <Chip size="small" color="warning" label={`${payload.qualitySummary.counts.warning} warning`} />
                  </Stack>
                </Stack>
                <Stack spacing={1} sx={{ mt: 1.5 }}>
                  {payload.findings.length ? payload.findings.map((finding, index) => (
                    <Box key={`${finding.code || "finding"}-${finding.lotNumber || "report"}-${index}`} sx={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) auto", gap: 1, alignItems: "start", borderTop: index ? "1px solid" : 0, borderColor: "divider", pt: index ? 1.25 : 0 }}>
                      {finding.severity === "critical" ? <ErrorOutlineRoundedIcon color="error" fontSize="small" /> : <WarningAmberRoundedIcon color={finding.severity === "warning" ? "warning" : "disabled"} fontSize="small" />}
                      <Box>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{finding.title}</Typography>
                        <Typography color="text.secondary" sx={{ mt: 0.2, fontSize: 12 }}>{finding.message}</Typography>
                      </Box>
                      {finding.actionTarget ? <Button size="small"
                        onClick={() => onAction(finding.actionTarget!)} sx={{ whiteSpace: "nowrap" }}>Open</Button> : null}
                    </Box>
                  )) : <Alert severity="success">No appraisal QA issues were detected.</Alert>}
                </Stack>
              </Box>

              <Box sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 2 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5}>
                  <Box>
                    <Typography sx={{ fontWeight: 750 }}>Highest-value lots</Typography>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>Fast review of valuation concentration and image coverage.</Typography>
                  </Box>
                  <Chip size="small" icon={<ImageRoundedIcon />} label={`${payload.staticInsights.imageCoveragePercent}% image coverage`} />
                </Stack>
                <Stack sx={{ mt: 1.5 }} divider={<Divider flexItem />}>
                  {payload.staticInsights.highestValueLots.map((lot, index) => (
                    <Stack key={`${lot.lotId || lot.lotNumber || "lot"}-${index}`} direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ py: 1 }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: 13, fontWeight: 700 }}>Lot {lot.lotNumber}: {lot.title}</Typography>
                        <Typography color="text.secondary" sx={{ fontSize: 11 }}>{lot.imageCount} images</Typography>
                      </Box>
                      <Typography sx={{ fontSize: 13, fontWeight: 750, whiteSpace: "nowrap" }}>{money(lot.fmv || 0, payload.staticInsights.currency)}</Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>

              <Box sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 2 }}>
                <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} gap={1.5}>
                  <Box>
                    <Stack direction="row" alignItems="center" spacing={0.75}>
                      <TrendingUpRoundedIcon sx={{ color: "#dc2626" }} />
                      <Typography sx={{ fontWeight: 750 }}>Advisory market analysis</Typography>
                    </Stack>
                    <Typography color="text.secondary" sx={{ mt: 0.25, fontSize: 12 }}>On-demand web comparables. Results never alter saved valuations.</Typography>
                  </Box>
                  <Button
                    variant="contained"
                    color="error"
                    startIcon={payload.analysis?.status === "completed" ? <RefreshRoundedIcon /> : <AutoAwesomeRoundedIcon />}
                    disabled={starting || analysisActive}
                    onClick={() => void runAnalysis(payload.analysis?.status === "completed")}
                    sx={{ whiteSpace: "nowrap" }}
                  >
                    {payload.analysis?.status === "completed" ? "Refresh analysis" : "Run analysis"}
                  </Button>
                </Stack>
                {analysisActive ? <Box sx={{ mt: 2 }}><LinearProgress color="error" /><Typography color="text.secondary" sx={{ mt: 0.75, fontSize: 12 }}>Researching comparable equipment and market signals. You can close this drawer safely.</Typography></Box> : null}
                {payload.analysis?.status === "failed" ? <Alert severity="error" sx={{ mt: 2 }}>{payload.analysis.error || "Analysis failed."}</Alert> : null}
                {payload.analysis?.stale ? <Alert severity="warning" sx={{ mt: 2 }}>This analysis predates the latest report edits. Refresh it before relying on the findings.</Alert> : null}
                {payload.analysis?.status === "completed" && result ? (
                  <Stack spacing={2} sx={{ mt: 2 }}>
                    {observations.length ? <Box><Typography sx={{ mb: 0.75, fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>Observations</Typography><Stack component="ul" spacing={0.75} sx={{ m: 0, pl: 2.25 }}>{observations.map((item, index) => <Typography component="li" key={index} sx={{ fontSize: 13 }}>{observationText(item)}</Typography>)}</Stack></Box> : null}
                    {comparables.length ? <Box><Typography sx={{ mb: 0.75, fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>Comparable ranges</Typography><Stack spacing={0.75}>{comparables.map((item, index) => <Box key={index} sx={{ borderLeft: "3px solid #dc2626", bgcolor: "action.hover", px: 1.25, py: 1 }}><Typography sx={{ fontSize: 13, fontWeight: 700 }}>{item.item || `Comparable ${index + 1}`}: {money(item.rangeLow || 0, item.currency || payload.staticInsights.currency)} - {money(item.rangeHigh || 0, item.currency || payload.staticInsights.currency)}</Typography>{item.rationale ? <Typography color="text.secondary" sx={{ mt: 0.25, fontSize: 12 }}>{item.rationale}</Typography> : null}</Box>)}</Stack></Box> : null}
                    {cautions.length ? <Alert severity="warning"><Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2 }}>{cautions.map((item, index) => <li key={index}>{item}</li>)}</Stack></Alert> : null}
                    {sources.length ? <Box><Typography sx={{ mb: 0.75, fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>Sources</Typography><Stack spacing={0.5}>{sources.map((source, index) => source.url ? <Link key={index} href={source.url} target="_blank" rel="noopener noreferrer" underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: 12 }}>{source.title || source.url}<OpenInNewRoundedIcon sx={{ fontSize: 14 }} /></Link> : null)}</Stack></Box> : null}
                  </Stack>
                ) : null}
              </Box>
            </Stack>
          ) : null}
        </Box>

        <Stack direction="row" justifyContent="flex-end" sx={{ borderTop: "1px solid", borderColor: "divider", px: { xs: 2, sm: 3 }, py: 1.5 }}>
          <Button variant="outlined" onClick={onClose}>Close</Button>
        </Stack>
      </Stack>
    </Drawer>
  );
}
