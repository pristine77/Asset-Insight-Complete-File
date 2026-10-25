"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ArrowRight,
  Boxes,
  Clock3,
  Database,
  ExternalLink,
  FileJson,
  Image as ImageIcon,
  Mail,
  RefreshCw,
  Trash2,
  UserRound,
  UserRoundCog,
  X,
} from "lucide-react";
import type {
  PreviewReportDetailResponse,
  PreviewTransferUser,
} from "./previewReportTypes";
import ReportLotNavigationControls from "@/app/components/reports/ReportLotNavigationControls";
import { lotPreviewDisplay, reportPreviewDisplay } from "@/lib/lotPreviewDisplay";

type Props = {
  open: boolean;
  reportId: string | null;
  onClose: () => void;
  onTransferred?: (message: string, hasWarnings: boolean) => void;
  onDeleted?: () => void;
  onResubmitted?: (message: string) => void;
  onNotify?: (reportId: string) => void;
  readOnly?: boolean;
};

type JsonRecord = Record<string, unknown>;

const IMAGE_KEY = /(image|photo|thumbnail|picture|cover)/i;
const IMAGE_URL = /\.(avif|bmp|gif|jpe?g|png|webp)(?:\?|#|$)/i;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isImageValue(value: unknown, key = ""): value is string {
  return isHttpUrl(value) && (IMAGE_KEY.test(key) || IMAGE_URL.test(value));
}

function humanizeKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function displayDate(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function collectImages(value: unknown, key = "", output = new Set<string>()): string[] {
  if (isImageValue(value, key)) output.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectImages(entry, key, output));
  else if (isRecord(value)) Object.entries(value).forEach(([childKey, entry]) => collectImages(entry, childKey, output));
  return Array.from(output);
}

function PrimitiveValue({ value, fieldKey = "" }: { value: unknown; fieldKey?: string }) {
  if (value === null || value === undefined || value === "") {
    return <Typography sx={{ color: "text.disabled", fontSize: 13 }}>Not provided</Typography>;
  }
  if (typeof value === "boolean") return <Chip size="small" label={value ? "Yes" : "No"} variant="outlined" />;
  if (isImageValue(value, fieldKey)) {
    return (
      <Box
        component="a"
        href={value}
        target="_blank"
        rel="noreferrer"
        sx={{ display: "block", width: "100%", maxWidth: 260 }}
      >
        <Box
          component="img"
          src={value}
          alt={humanizeKey(fieldKey) || "Report image"}
          loading="lazy"
          sx={{ display: "block", width: "100%", aspectRatio: "4 / 3", objectFit: "cover", border: "1px solid", borderColor: "divider", borderRadius: "4px" }}
        />
      </Box>
    );
  }
  if (isHttpUrl(value)) {
    return (
      <Stack component="a" href={value} target="_blank" rel="noreferrer" direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0, color: "primary.main", textDecoration: "none" }}>
        <Typography sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 }}>{value}</Typography>
        <ExternalLink size={13} />
      </Stack>
    );
  }
  return (
    <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "text.primary", fontSize: 13.5, lineHeight: 1.55 }}>
      {String(value)}
    </Typography>
  );
}

function DataValue({ value, fieldKey = "", depth = 0 }: { value: unknown; fieldKey?: string; depth?: number }) {
  if (Array.isArray(value)) {
    if (!value.length) return <PrimitiveValue value={null} />;
    if (value.every((entry) => isImageValue(entry, fieldKey))) {
      return (
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 1 }}>
          {value.map((entry, index) => <PrimitiveValue key={`${String(entry)}-${index}`} value={entry} fieldKey={fieldKey} />)}
        </Box>
      );
    }
    return (
      <Stack spacing={1}>
        {value.map((entry, index) => (
          <Box key={index} sx={{ borderLeft: "2px solid", borderColor: "divider", pl: 1.25 }}>
            <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 11.5, fontWeight: 700 }}>Item {index + 1}</Typography>
            <DataValue value={entry} fieldKey={fieldKey} depth={depth + 1} />
          </Box>
        ))}
      </Stack>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return <PrimitiveValue value={null} />;
    return (
      <Box sx={{ display: "grid", gridTemplateColumns: depth > 1 ? "1fr" : { xs: "1fr", lg: "repeat(2, minmax(0, 1fr))" }, gap: "1px", bgcolor: "divider", border: "1px solid", borderColor: "divider" }}>
        {entries.map(([key, entry]) => (
          <Box key={key} sx={{ minWidth: 0, bgcolor: "background.paper", p: 1.25 }}>
            <Typography sx={{ mb: 0.6, color: "text.secondary", fontSize: 11.5, fontWeight: 750 }}>{humanizeKey(key)}</Typography>
            <DataValue value={entry} fieldKey={key} depth={depth + 1} />
          </Box>
        ))}
      </Box>
    );
  }

  return <PrimitiveValue value={value} fieldKey={fieldKey} />;
}

export default function PreviewReportDrawer({
  open,
  reportId,
  onClose,
  onTransferred,
  onDeleted,
  onResubmitted,
  onNotify,
  readOnly = false,
}: Props) {
  const [payload, setPayload] = useState<PreviewReportDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(0);
  const [selectedLot, setSelectedLot] = useState(0);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferUsers, setTransferUsers] = useState<PreviewTransferUser[]>([]);
  const [transferUsersLoading, setTransferUsersLoading] = useState(false);
  const [transferTarget, setTransferTarget] = useState<PreviewTransferUser | null>(null);
  const [transferError, setTransferError] = useState("");
  const [transferNeedsReview, setTransferNeedsReview] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitError, setResubmitError] = useState("");
  const [resubmitNeedsReview, setResubmitNeedsReview] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const resubmitInFlight = useRef(false);
  const transferInFlight = useRef(false);
  const lotDetailsTop = useRef<HTMLDivElement>(null);
  const selectLot = (index: number) => {
    setSelectedLot(index);
    requestAnimationFrame(() => {
      lotDetailsTop.current?.focus({ preventScroll: true });
      lotDetailsTop.current?.scrollIntoView({ block: "start" });
    });
  };

  useEffect(() => {
    if (!open || !reportId) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPayload(null);
    setTab(0);
    setSelectedLot(0);
    setTransferOpen(false);
    setTransferTarget(null);
    setTransferError("");
    setTransferNeedsReview(false);
    setDeleteOpen(false);
    setDeleteError("");
    setResubmitOpen(false);
    setResubmitError("");
    setResubmitNeedsReview(false);

    fetch(`/api/admin/preview-reports/${encodeURIComponent(reportId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "Unable to load preview report details.");
        return body as PreviewReportDetailResponse;
      })
      .then(setPayload)
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Unable to load preview report details.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open, reportId, reloadToken]);

  const lots = useMemo(() => {
    const candidate = payload?.preview?.data?.lots;
    return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
  }, [payload]);
  const activeLot = lots[selectedLot] || null;
  const activeImages = useMemo(() => collectImages(activeLot), [activeLot]);
  const resubmitEligible = payload?.report.resubmitEligible === true
    && payload.report.id === reportId && Boolean(payload.report.resubmitRevision)
    && !loading && !resubmitNeedsReview && !transferNeedsReview && !readOnly;

  const submitPreview = async () => {
    if (!reportId || !resubmitEligible || !payload?.report.resubmitRevision || resubmitInFlight.current) return;
    resubmitInFlight.current = true;
    setResubmitting(true);
    setResubmitError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/api/admin/preview-reports/${encodeURIComponent(reportId)}/resubmit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: payload.report.resubmitRevision }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (response.status !== 202) {
        setResubmitNeedsReview(true);
        throw new Error(response.status === 409
          ? `${body?.message || "This preview changed or processing has already started."} Reload and review the current preview before trying again.`
          : body?.message || "Submission could not be confirmed. Reload the preview to check its current status before trying again.");
      }
      setResubmitOpen(false);
      onResubmitted?.("Saved preview accepted. Report files are being rebuilt on the same report; follow its processing status here.");
      onClose();
    } catch (reason) {
      setResubmitNeedsReview(true);
      setResubmitError(`${controller.signal.aborted ? "Submission confirmation timed out. Processing may already have started." : reason instanceof Error ? reason.message : "Submission could not be confirmed."} Reload and review before submitting again.`);
    } finally {
      window.clearTimeout(timeout);
      resubmitInFlight.current = false;
      setResubmitting(false);
    }
  };

  const openTransfer = async () => {
    if (!payload?.report.transferEligible || payload.report.id !== reportId || loading || readOnly || transferUsersLoading || transferInFlight.current) return;
    setTransferOpen(true);
    setTransferTarget(null);
    if (!transferNeedsReview) setTransferError("");
    if (transferUsers.length > 0) return;

    setTransferUsersLoading(true);
    try {
      const response = await fetch("/api/admin/preview-reports/transfer-users?limit=500", {
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || "Unable to load users.");
      }
      setTransferUsers(Array.isArray(body?.users) ? body.users : []);
    } catch (reason) {
      setTransferError(
        reason instanceof Error ? reason.message : "Unable to load users."
      );
    } finally {
      setTransferUsersLoading(false);
    }
  };

  const submitTransfer = async () => {
    if (!reportId || !transferTarget || !payload?.report.transferEligible || payload.report.id !== reportId || readOnly || loading || transferNeedsReview || transferInFlight.current) return;
    transferInFlight.current = true;
    setTransferring(true);
    setTransferError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(
        `/api/admin/preview-reports/${encodeURIComponent(reportId)}/transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUserId: transferTarget.id }),
          signal: controller.signal,
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || "Unable to reassign this preview.");
      }
      const warningCount = Array.isArray(body?.warnings) ? body.warnings.length : 0;
      setTransferOpen(false);
      setTransferTarget(null);
      onTransferred?.(
        `Preview reassigned. No files were generated; the new owner can review and resubmit it from Previews.${warningCount ? ` ${warningCount} notification could not be delivered.` : " Both users were notified."}`,
        warningCount > 0
      );
      // Ownership and the saved-preview revision changed. Close stale details and
      // load a fresh server snapshot next time, rather than patching just the name.
      onClose();
    } catch (reason) {
      setTransferNeedsReview(true);
      setTransferError(
        `${controller.signal.aborted ? "Reassignment confirmation timed out. Ownership may already have changed." : reason instanceof Error ? reason.message : "Unable to confirm reassignment."} Reload and review the current owner and processing status before trying again.`
      );
    } finally {
      window.clearTimeout(timeout);
      transferInFlight.current = false;
      setTransferring(false);
    }
  };

  const submitDelete = async () => {
    if (!reportId || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/admin/preview-reports/${encodeURIComponent(reportId)}`,
        { method: "DELETE" }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || "Unable to delete this preview report.");
      }
      setDeleteOpen(false);
      onDeleted?.();
      onClose();
    } catch (reason) {
      setDeleteError(
        reason instanceof Error ? reason.message : "Unable to delete this preview report."
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={() => { if (!resubmitInFlight.current && !transferInFlight.current) onClose(); }}
      sx={{ zIndex: (theme) => theme.zIndex.drawer + 3 }}
      PaperProps={{
        sx: {
          width: { xs: "100vw", sm: "min(96vw, 1180px)" },
          maxWidth: "100vw",
          overflow: "hidden",
          bgcolor: "background.default",
        },
      }}
    >
      <Box sx={{ display: "flex", height: "100dvh", minWidth: 0, flexDirection: "column" }}>
        <Box sx={{ flexShrink: 0, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper", px: { xs: 2, md: 3 }, py: 2 }}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Database size={20} />
                <Typography variant="h5" sx={{ fontSize: { xs: 20, md: 24 }, fontWeight: 750 }}>Preview report details</Typography>
              </Stack>
              <Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 13.5 }}>
                Complete sanitized report data, workflow state, lots, and images.
              </Typography>
            </Box>
            <IconButton aria-label="Close preview report details" disabled={resubmitting || transferring} onClick={onClose} sx={{ border: "1px solid", borderColor: "divider", borderRadius: "4px" }}>
              <X size={19} />
            </IconButton>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: payload && !readOnly ? 1.5 : 0 }}>
              {payload && !readOnly ? (
                <Tooltip title={resubmitNeedsReview ? "Reload and review the latest saved preview first." : payload.report.resubmitIneligibleReason || "Rebuild report files from the saved preview, without new analysis."}>
                  <span>
                    <Button variant="contained" startIcon={<RefreshCw size={17} />} disabled={!resubmitEligible || resubmitting || transferring || deleting} onClick={() => {
                      setResubmitError("");
                      setResubmitOpen(true);
                    }} sx={{ borderRadius: "4px" }}>
                      Resubmit preview
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              {payload && !readOnly ? (
                <Tooltip
                  title={
                    payload.report.transferEligible
                      ? "Move this preview to another user without generating files"
                      : payload.report.transferIneligibleReason ||
                        "This preview cannot be reassigned."
                  }
                >
                  <span>
                    <Button
                      variant="outlined"
                      startIcon={<UserRoundCog size={17} />}
                      disabled={!payload.report.transferEligible || resubmitting || transferring || deleting}
                      onClick={openTransfer}
                      sx={{ borderRadius: "4px", whiteSpace: "nowrap" }}
                    >
                      Reassign
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              {payload && !readOnly ? (
                <Tooltip
                  title={
                    payload.report.deleteEligible
                      ? "Permanently delete this preview report"
                      : payload.report.deleteIneligibleReason ||
                        "This preview cannot be deleted."
                  }
                >
                  <span>
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<Trash2 size={17} />}
                      disabled={!payload.report.deleteEligible || resubmitting || transferring || transferNeedsReview}
                      onClick={() => {
                        setDeleteError("");
                        setDeleteOpen(true);
                      }}
                      sx={{ borderRadius: "4px", whiteSpace: "nowrap" }}
                    >
                      Delete
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              {payload && reportId && !readOnly && onNotify ? (
                <Tooltip title="Review an email to the report owner or check a previous delivery">
                  <span><Button variant="outlined" startIcon={<Mail size={17} />} disabled={resubmitting || transferring || deleting || transferNeedsReview} onClick={() => onNotify(reportId)}>Notify</Button></span>
                </Tooltip>
              ) : null}
          </Stack>
        </Box>

        {loading ? (
          <Box sx={{ display: "grid", flex: 1, placeItems: "center" }}><CircularProgress size={30} /></Box>
        ) : error ? (
          <Box sx={{ p: 3 }}><Alert severity="error">{error}</Alert><Button onClick={() => setReloadToken((value) => value + 1)} sx={{ mt: 1 }}>Reload preview</Button></Box>
        ) : payload ? (
          <>
            {resubmitNeedsReview && !resubmitOpen ? (
              <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => setReloadToken((value) => value + 1)}>Reload and review</Button>} sx={{ flexShrink: 0, borderRadius: 0 }}>
                Reload the current saved preview and review its status before another submission.
              </Alert>
            ) : null}
            {transferNeedsReview && !transferOpen ? (
              <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => setReloadToken((value) => value + 1)}>Reload and review</Button>} sx={{ flexShrink: 0, borderRadius: 0 }}>
                Reload the current owner and processing status before another reassignment.
              </Alert>
            ) : null}
            <Box sx={{ flexShrink: 0, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper", px: { xs: 2, md: 3 }, py: 1.5 }}>
              <Stack direction={{ xs: "column", md: "row" }} alignItems={{ xs: "stretch", md: "center" }} justifyContent="space-between" spacing={1.5}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={payload.report.reportType === "Asset" ? "Asset" : "Lot Listing"} color="primary" />
                  <Typography sx={{ fontWeight: 750 }}>{payload.preview.title}</Typography>
                  <Chip size="small" variant="outlined" label={payload.report.workflow_stage.replaceAll("_", " ")} sx={{ textTransform: "capitalize" }} />
                </Stack>
                <Typography sx={{ color: "text.secondary", fontSize: 12.5 }}>Updated {displayDate(payload.report.updatedAt)}</Typography>
              </Stack>
              <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, payload.report.workflow_progress_percent || 0))} sx={{ mt: 1.25, height: 4 }} />
              <Typography sx={{ mt: 0.65, color: "text.secondary", fontSize: 12.5 }}>{payload.report.workflow_message}</Typography>
              <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ mt: 0.75, minHeight: 38, "& .MuiTab-root": { minHeight: 38, px: 1.5, fontSize: 12.5 } }}>
                <Tab icon={<Boxes size={15} />} iconPosition="start" label="Overview" />
                <Tab icon={<Database size={15} />} iconPosition="start" label="All data" />
                <Tab icon={<FileJson size={15} />} iconPosition="start" label="Raw JSON" />
              </Tabs>
            </Box>

            <Box sx={{ minHeight: 0, flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              {tab === 0 ? (
                <Box sx={{ p: { xs: 2, md: 3 } }}>
                  <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }, border: "1px solid", borderColor: "divider", bgcolor: "divider", gap: "1px" }}>
                    {[
                      ["Contract", payload.report.contractNo || "Not provided"],
                      ["Created by", payload.report.creator?.username || payload.report.creator?.companyName || payload.report.creator?.email || "Deleted user"],
                      ["Created", displayDate(payload.report.createdAt)],
                      ["Submitted", displayDate(payload.report.previewSubmittedAt)],
                    ].map(([label, value]) => (
                      <Box key={label} sx={{ bgcolor: "background.paper", p: 1.5 }}>
                        <Typography sx={{ color: "text.secondary", fontSize: 11.5, fontWeight: 750 }}>{label}</Typography>
                        <Typography sx={{ mt: 0.5, overflowWrap: "anywhere", fontSize: 13.5, fontWeight: 600 }}>{value}</Typography>
                      </Box>
                    ))}
                  </Box>

                  {payload.report.job_error ? <Alert severity="error" sx={{ mt: 2 }}>{payload.report.job_error}</Alert> : null}
                  {!readOnly && !payload.report.resubmitEligible && payload.report.resubmitIneligibleReason ? <Alert severity="info" sx={{ mt: 1 }}>{payload.report.resubmitIneligibleReason}</Alert> : null}

                  {lots.length ? (
                    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "240px minmax(0, 1fr)" }, gap: 2, mt: 2 }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: 11.5, fontWeight: 750, textTransform: "uppercase" }}>Lots ({lots.length})</Typography>
                        <Stack direction={{ xs: "row", md: "column" }} spacing={0.75} sx={{ overflowX: { xs: "auto", md: "visible" }, pb: { xs: 1, md: 0 } }}>
                          {lots.map((lot, index) => {
                            const lotNumber = String(lot.lot_number || index + 1);
                            const title = String(lot.title || lot.description || "Untitled lot");
                            return (
                              <Box
                                component="button"
                                type="button"
                                key={`${lotNumber}-${index}`}
                                onClick={() => selectLot(index)}
                                sx={{ minWidth: { xs: 190, md: 0 }, width: { md: "100%" }, border: "1px solid", borderColor: selectedLot === index ? "primary.main" : "divider", borderRadius: "4px", bgcolor: selectedLot === index ? "action.selected" : "background.paper", color: "text.primary", cursor: "pointer", p: 1.25, textAlign: "left" }}
                              >
                                <Typography sx={{ fontSize: 13, fontWeight: 750 }}>Lot {lotNumber}</Typography>
                                <Typography noWrap sx={{ mt: 0.25, color: "text.secondary", fontSize: 11.5 }}>{title}</Typography>
                              </Box>
                            );
                          })}
                        </Stack>
                      </Box>

                      <Box sx={{ minWidth: 0 }}>
                        <Box ref={lotDetailsTop} tabIndex={-1} sx={{ scrollMarginTop: 12 }}>
                          <ReportLotNavigationControls lots={lots} selectedIndex={selectedLot} onSelect={selectLot} placement="top" />
                        </Box>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <ImageIcon size={18} />
                          <Typography sx={{ fontSize: 19, fontWeight: 750 }}>Lot {String(activeLot?.lot_number || selectedLot + 1)}</Typography>
                        </Stack>
                        <Typography sx={{ mt: 0.25, color: "text.secondary", fontSize: 13.5 }}>{String(activeLot?.title || activeLot?.description || "Untitled lot")}</Typography>
                        {activeImages.length ? (
                          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 1, mt: 1.5 }}>
                            {activeImages.map((url, index) => (
                              <Box component="a" href={url} target="_blank" rel="noreferrer" key={url} sx={{ position: "relative", display: "block", minWidth: 0 }}>
                                <Box component="img" src={url} alt={`Lot image ${index + 1}`} loading="lazy" sx={{ display: "block", width: "100%", aspectRatio: "4 / 3", objectFit: "cover", border: "1px solid", borderColor: "divider", borderRadius: "4px" }} />
                              </Box>
                            ))}
                          </Box>
                        ) : <Alert severity="info" sx={{ mt: 1.5 }}>No image URLs are stored for this lot.</Alert>}
                        <Typography sx={{ mt: 2, color: "text.secondary", fontSize: 12 }}>Title is used as Description in generated files. Structured condition details are shown below.</Typography>
                        <Box sx={{ mt: 1 }}><DataValue value={lotPreviewDisplay(activeLot)} /></Box>
                        <ReportLotNavigationControls lots={lots} selectedIndex={selectedLot} onSelect={selectLot} placement="bottom" />
                      </Box>
                    </Box>
                  ) : (
                    <Alert severity="info" sx={{ mt: 2 }}>This preview does not contain a saved lot array.</Alert>
                  )}
                </Box>
              ) : null}

              {tab === 1 ? <Box sx={{ p: { xs: 2, md: 3 } }}><DataValue value={reportPreviewDisplay(payload.preview.data)} /></Box> : null}

              {tab === 2 ? (
                <Box sx={{ p: { xs: 2, md: 3 } }}>
                  <Box component="pre" sx={{ m: 0, maxWidth: "100%", overflowX: "auto", border: "1px solid", borderColor: "divider", bgcolor: "background.paper", p: 2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {JSON.stringify(payload.preview.data, null, 2)}
                  </Box>
                </Box>
              ) : null}
            </Box>

            <Divider />
            <Box sx={{ flexShrink: 0, bgcolor: "background.paper", px: { xs: 2, md: 3 }, py: 1.25 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} justifyContent="space-between">
                <Stack direction="row" alignItems="center" spacing={0.75}><UserRound size={15} /><Typography sx={{ color: "text.secondary", fontSize: 12.5 }}>{payload.report.creator?.email || "Owner unavailable"}</Typography></Stack>
                <Stack direction="row" alignItems="center" spacing={0.75}><Clock3 size={15} /><Typography sx={{ color: "text.secondary", fontSize: 12.5 }}>Last activity {displayDate(payload.report.updatedAt)}</Typography></Stack>
              </Stack>
            </Box>
          </>
        ) : null}

        <Dialog
          open={resubmitOpen}
          onClose={() => { if (!resubmitInFlight.current) setResubmitOpen(false); }}
          fullWidth
          maxWidth="sm"
          aria-labelledby="preview-resubmit-title"
          aria-describedby="preview-resubmit-description"
          PaperProps={{ sx: { borderRadius: "6px", m: { xs: 2, sm: 4 }, width: { xs: "calc(100% - 32px)", sm: "100%" } } }}
        >
          <DialogTitle id="preview-resubmit-title" sx={{ fontWeight: 750 }}>Resubmit saved preview?</DialogTitle>
          <DialogContent dividers>
            {resubmitError ? <Alert severity="error" sx={{ mb: 2 }}>{resubmitError}</Alert> : null}
            <Typography id="preview-resubmit-description" sx={{ fontSize: 14, lineHeight: 1.65 }}>
              Rebuild files for <strong>{payload?.preview.title || "this report"}</strong>
              {payload?.report.contractNo ? ` (contract ${payload.report.contractNo})` : ""} from the saved preview you have reviewed. This uses the existing saved photos and values, without running new analysis or creating a second report.
            </Typography>
            <Alert severity="info" sx={{ mt: 2 }}>
              {payload?.report.reportType === "LotListing"
                ? "The Lot Listing will be approved and released automatically only after its files are generated successfully."
                : "Asset approval and release rules remain unchanged. Resubmitting does not approve or release an Asset report."}
            </Alert>
            {resubmitting ? <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }} role="status"><CircularProgress size={18} /><Typography sx={{ fontSize: 13 }}>Submitting the saved preview. Please wait for confirmation.</Typography></Stack> : null}
          </DialogContent>
          <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, flexWrap: "wrap", gap: 1 }}>
            <Button color="inherit" disabled={resubmitting} onClick={() => setResubmitOpen(false)}>Cancel</Button>
            {resubmitNeedsReview ? (
              <Button variant="contained" startIcon={<RefreshCw size={17} />} onClick={() => setReloadToken((value) => value + 1)}>Reload and review</Button>
            ) : (
              <Button variant="contained" disabled={!resubmitEligible || resubmitting} onClick={submitPreview} startIcon={resubmitting ? <CircularProgress color="inherit" size={16} /> : <RefreshCw size={17} />}>
                {resubmitting ? "Submitting" : "Confirm resubmission"}
              </Button>
            )}
          </DialogActions>
        </Dialog>

        <Dialog
          open={transferOpen}
          onClose={() => {
            if (!transferring) setTransferOpen(false);
          }}
          fullWidth
          maxWidth="sm"
          aria-labelledby="preview-transfer-title"
          PaperProps={{ sx: { borderRadius: "6px" } }}
        >
          <DialogTitle id="preview-transfer-title" sx={{ pb: 1 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <UserRoundCog size={21} />
              <Typography component="span" sx={{ fontSize: 20, fontWeight: 750 }}>
                Reassign preview
              </Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers>
            <Typography sx={{ color: "text.secondary", fontSize: 13.5, lineHeight: 1.6 }}>
              The current owner will immediately lose access. The selected user will
              receive the complete preview, images, and editable lot data and can
              continue from their Previews screen.
            </Typography>
            {payload?.report.transferRequiresReview ? (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                This preview was submitted, but file generation failed. The error
                remains visible after reassignment. The new owner must review and
                explicitly resubmit it; reassignment does not restart processing.
              </Alert>
            ) : null}
            {transferError ? <Alert severity="error" sx={{ mt: 1.5 }}>{transferError}</Alert> : null}

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
                alignItems: "center",
                gap: 1,
                my: 2,
              }}
            >
              <Box sx={{ minWidth: 0, border: "1px solid", borderColor: "divider", p: 1.25 }}>
                <Typography sx={{ color: "text.secondary", fontSize: 11, fontWeight: 750, textTransform: "uppercase" }}>
                  Current owner
                </Typography>
                <Typography noWrap sx={{ mt: 0.35, fontSize: 13.5, fontWeight: 700 }}>
                  {payload?.report.creator?.username ||
                    payload?.report.creator?.companyName ||
                    payload?.report.creator?.email ||
                    "Unavailable"}
                </Typography>
                <Typography noWrap sx={{ color: "text.secondary", fontSize: 12 }}>
                  {payload?.report.creator?.email || "No email"}
                </Typography>
              </Box>
              <ArrowRight size={18} />
              <Box sx={{ minWidth: 0, border: "1px solid", borderColor: transferTarget ? "primary.main" : "divider", p: 1.25 }}>
                <Typography sx={{ color: "text.secondary", fontSize: 11, fontWeight: 750, textTransform: "uppercase" }}>
                  New owner
                </Typography>
                <Typography noWrap sx={{ mt: 0.35, fontSize: 13.5, fontWeight: 700 }}>
                  {transferTarget?.displayName || "Select below"}
                </Typography>
                <Typography noWrap sx={{ color: "text.secondary", fontSize: 12 }}>
                  {transferTarget?.email || "No user selected"}
                </Typography>
              </Box>
            </Box>

            <Autocomplete
              options={transferUsers}
              value={transferTarget}
              loading={transferUsersLoading}
              disabled={transferring || transferNeedsReview}
              getOptionLabel={(option) =>
                `${option.displayName}${option.email ? ` - ${option.email}` : ""}`
              }
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionDisabled={(option) =>
                option.id === payload?.report.creator?.id
              }
              onChange={(_, value) => {
                setTransferTarget(value);
                setTransferError("");
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Transfer to"
                  placeholder="Search by name, company, or email"
                  helperText="Both the previous and new owner receive an email and in-app notification."
                />
              )}
            />

            <Alert severity="warning" sx={{ mt: 2 }}>
              This action moves ownership. It does not create a copy and does not
              submit or regenerate the preview.
            </Alert>
          </DialogContent>
          <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, flexWrap: "wrap", gap: 1 }}>
            <Button
              color="inherit"
              disabled={transferring}
              onClick={() => setTransferOpen(false)}
            >
              Cancel
            </Button>
            {transferNeedsReview ? (
              <Button variant="contained" onClick={() => setReloadToken((value) => value + 1)}>
                Reload and review
              </Button>
            ) : <Button
              variant="contained"
              disabled={!transferTarget || transferring}
              onClick={submitTransfer}
              startIcon={
                transferring ? <CircularProgress color="inherit" size={16} /> : <UserRoundCog size={17} />
              }
            >
              {transferring ? "Reassigning" : "Confirm reassignment"}
            </Button>}
          </DialogActions>
        </Dialog>

        <Dialog
          open={deleteOpen}
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          fullWidth
          maxWidth="sm"
          PaperProps={{ sx: { borderRadius: "6px" } }}
        >
          <DialogTitle sx={{ fontWeight: 750 }}>Delete preview report?</DialogTitle>
          <DialogContent dividers>
            {deleteError ? <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert> : null}
            <Typography sx={{ fontSize: 14, lineHeight: 1.65 }}>
              <strong>{payload?.preview.title || "This preview"}</strong>
              {payload?.report.contractNo ? ` (contract ${payload.report.contractNo})` : ""} will be permanently removed with its generated preview files and processing history.
            </Typography>
            <Alert severity="warning" sx={{ mt: 2 }}>
              This action cannot be undone. Source photos that may be shared with another report are retained.
            </Alert>
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 1.5 }}>
            <Button color="inherit" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              disabled={deleting}
              onClick={submitDelete}
              startIcon={deleting ? <CircularProgress color="inherit" size={16} /> : <Trash2 size={17} />}
            >
              {deleting ? "Deleting" : "Delete permanently"}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Drawer>
  );
}
