"use client";

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
  Clock3,
  Eye,
  FileClock,
  HardDriveUpload,
  Image as ImageIcon,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import type {
  DraftPreviewStatus,
  DraftPreviewsResponse,
  DraftPreviewSummary,
} from "./previewReportTypes";

type Props = {
  onOpenPreview: (reportId: string) => void;
};

const STATUS_META: Record<
  DraftPreviewStatus,
  { label: string; color: "default" | "info" | "success" | "error" }
> = {
  idle: { label: "Draft saved", color: "default" },
  queued: { label: "Preview queued", color: "info" },
  processing: { label: "Preparing preview", color: "info" },
  ready: { label: "Draft preview ready", color: "success" },
  error: { label: "Preview failed", color: "error" },
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
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

function isCurrentPreview(draft: DraftPreviewSummary) {
  return (
    draft.previewStatus === "ready" &&
    Boolean(draft.previewReportId) &&
    draft.previewProcessedRevision === draft.revision
  );
}

function DraftThumbnail({ draft }: { draft: DraftPreviewSummary }) {
  return draft.thumbnailUrl ? (
    <Box
      component="img"
      src={draft.thumbnailUrl}
      alt=""
      loading="lazy"
      sx={{
        width: 64,
        height: 54,
        flexShrink: 0,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "4px",
        objectFit: "cover",
      }}
    />
  ) : (
    <Box
      sx={{
        display: "grid",
        width: 64,
        height: 54,
        flexShrink: 0,
        placeItems: "center",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "4px",
        bgcolor: "action.hover",
        color: "text.disabled",
      }}
    >
      <ImageIcon size={20} />
    </Box>
  );
}

function DraftStatus({ draft }: { draft: DraftPreviewSummary }) {
  const meta = STATUS_META[draft.previewStatus] || STATUS_META.idle;
  const active = draft.previewStatus === "queued" || draft.previewStatus === "processing";
  const changed =
    draft.previewStatus === "ready" && draft.previewProcessedRevision !== draft.revision;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Chip
        size="small"
        color={changed ? "default" : meta.color}
        variant={meta.color === "default" || changed ? "outlined" : "filled"}
        label={changed ? "Draft changed" : meta.label}
        sx={{ maxWidth: "100%", borderRadius: "4px", fontWeight: 700 }}
      />
      {active ? <LinearProgress sx={{ mt: 0.8, height: 3 }} /> : null}
      <Typography
        sx={{
          mt: 0.45,
          color: draft.previewStatus === "error" ? "error.main" : "text.secondary",
          fontSize: 11.5,
          lineHeight: 1.35,
        }}
      >
        {draft.previewError ||
          (changed
            ? `Preview revision ${draft.previewProcessedRevision ?? "-"}; draft revision ${draft.revision}.`
            : `Revision ${draft.revision}`)}
      </Typography>
    </Box>
  );
}

function DraftCard({
  draft,
  onOpenPreview,
  onDelete,
  deleting,
}: {
  draft: DraftPreviewSummary;
  onOpenPreview: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const canOpen = isCurrentPreview(draft);
  const canDelete = !["queued", "processing"].includes(draft.previewStatus);
  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "5px",
        bgcolor: "background.paper",
        p: 1.5,
      }}
    >
      <Stack direction="row" spacing={1.25}>
        <DraftThumbnail draft={draft} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography noWrap sx={{ fontSize: 14, fontWeight: 750 }}>
            {draft.title}
          </Typography>
          <Typography noWrap sx={{ mt: 0.2, color: "text.secondary", fontSize: 12 }}>
            Contract: {draft.contractNo || "Not provided"}
          </Typography>
          <Typography noWrap sx={{ mt: 0.55, color: "text.secondary", fontSize: 12 }}>
            {draft.creatorDisplay}
          </Typography>
        </Box>
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 1,
          mt: 1.5,
        }}
      >
        <Box>
          <Typography sx={{ color: "text.secondary", fontSize: 10.5, fontWeight: 750 }}>
            DRAFT MEDIA
          </Typography>
          <Typography sx={{ mt: 0.2, fontSize: 12.5 }}>
            {draft.lotCount} lots · {draft.imageCount} images
          </Typography>
        </Box>
        <Box>
          <Typography sx={{ color: "text.secondary", fontSize: 10.5, fontWeight: 750 }}>
            LAST SAVED
          </Typography>
          <Typography sx={{ mt: 0.2, fontSize: 12.5 }}>{relativeTime(draft.updatedAt)}</Typography>
        </Box>
      </Box>
      <Box sx={{ mt: 1.25 }}>
        <DraftStatus draft={draft} />
      </Box>
      {(draft.duplicateLotConflicts?.length || 0) > 0 ? (
        <Alert severity="warning" sx={{ mt: 1.25, py: 0.25 }}>
          Duplicate lot detected under this contract. The owner must resolve it before creating the preview.
        </Alert>
      ) : null}
      <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
        <Tooltip
          title={canOpen ? "Inspect the generated draft preview" : "The current draft revision is not ready yet."}
        >
          <span style={{ flex: 1 }}>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<Eye size={16} />}
              disabled={!canOpen}
              onClick={onOpenPreview}
              sx={{ borderRadius: "4px" }}
            >
              Open preview
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={canDelete ? "Permanently delete this saved draft" : "Active draft previews cannot be deleted."}>
          <span>
            <Button
              variant="outlined"
              color="error"
              disabled={!canDelete || deleting}
              onClick={onDelete}
              sx={{ minWidth: 42, px: 1, borderRadius: "4px" }}
              aria-label={`Delete ${draft.title}`}
            >
              {deleting ? <CircularProgress size={16} color="inherit" /> : <Trash2 size={16} />}
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

export default function DraftPreviewsPanel({ onOpenPreview }: Props) {
  const [data, setData] = useState<DraftPreviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [reportType, setReportType] = useState("all");
  const [previewStatus, setPreviewStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [reloadToken, setReloadToken] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DraftPreviewSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = !hasLoadedRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      reportType,
      previewStatus,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);

    fetch(`/api/admin/preview-reports/drafts?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "Unable to load draft previews.");
        return body as DraftPreviewsResponse;
      })
      .then((body) => {
        hasLoadedRef.current = true;
        setData(body);
        if (body.page !== page) setPage(body.page);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "Unable to load draft previews.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [debouncedSearch, limit, page, previewStatus, reloadToken, reportType]);

  const hasActiveJobs = useMemo(
    () => data?.items.some((draft) => draft.previewStatus === "queued" || draft.previewStatus === "processing"),
    [data]
  );
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => setReloadToken((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs]);

  function resetFilters() {
    setSearch("");
    setDebouncedSearch("");
    setReportType("all");
    setPreviewStatus("all");
    setPage(1);
  }

  async function deleteDraft() {
    if (!deleteTarget || deletingId) return;
    setDeletingId(deleteTarget.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/preview-reports/drafts/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "Unable to delete the saved draft.");
      setDeleteTarget(null);
      setFeedback("Saved draft deleted permanently.");
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete the saved draft.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Box sx={{ mt: 2.5 }}>
      <Box
        sx={{
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "5px",
          bgcolor: "background.paper",
          p: 1.5,
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
          spacing={1}
        >
          <Stack direction="row" alignItems="center" spacing={0.8}>
            <HardDriveUpload size={17} />
            <Typography sx={{ fontSize: 13, fontWeight: 750 }}>
              Server-backed saved drafts
            </Typography>
            <Chip size="small" label={data?.total ?? 0} sx={{ borderRadius: "4px" }} />
          </Stack>
          <Button
            variant="outlined"
            startIcon={refreshing ? <CircularProgress size={15} /> : <RefreshCw size={16} />}
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={refreshing}
            sx={{ borderRadius: "4px" }}
          >
            Refresh drafts
          </Button>
        </Stack>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "2fr 1fr 1fr auto" },
            gap: 1,
            mt: 1.5,
          }}
        >
          <TextField
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            size="small"
            placeholder="Search contract, draft, or creator"
            InputProps={{ startAdornment: <Search size={16} style={{ marginRight: 8 }} /> }}
          />
          <FormControl size="small">
            <Select
              value={reportType}
              onChange={(event) => {
                setReportType(event.target.value);
                setPage(1);
              }}
            >
              <MenuItem value="all">All report types</MenuItem>
              <MenuItem value="asset">Asset</MenuItem>
              <MenuItem value="lotListing">Lot Listing</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <Select
              value={previewStatus}
              onChange={(event) => {
                setPreviewStatus(event.target.value);
                setPage(1);
              }}
            >
              <MenuItem value="all">All draft states</MenuItem>
              {Object.entries(STATUS_META).map(([status, meta]) => (
                <MenuItem key={status} value={status}>
                  {meta.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button color="inherit" onClick={resetFilters} sx={{ borderRadius: "4px" }}>
            Reset
          </Button>
        </Box>
      </Box>

      {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      {feedback ? <Alert severity="success" onClose={() => setFeedback("")} sx={{ mt: 2 }}>{feedback}</Alert> : null}

      <Box sx={{ mt: 2 }}>
        {loading ? (
          <Stack spacing={1}>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} variant="rounded" height={82} />
            ))}
          </Stack>
        ) : !data?.items.length ? (
          <Box
            sx={{
              display: "grid",
              minHeight: 250,
              placeItems: "center",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: "5px",
              bgcolor: "background.paper",
              p: 3,
              textAlign: "center",
            }}
          >
            <Box>
              <FileClock size={30} />
              <Typography sx={{ mt: 1, fontSize: 18, fontWeight: 750 }}>
                No draft previews match these filters
              </Typography>
              <Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 13 }}>
                Explicit user saves will appear here while their preview is prepared.
              </Typography>
            </Box>
          </Box>
        ) : (
          <>
            <Box
              sx={{
                display: { xs: "grid", lg: "none" },
                gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                gap: 1,
              }}
            >
              {data.items.map((draft) => (
                <DraftCard
                  key={draft.id}
                  draft={draft}
                  onOpenPreview={() => draft.previewReportId && onOpenPreview(draft.previewReportId)}
                  onDelete={() => setDeleteTarget(draft)}
                  deleting={deletingId === draft.id}
                />
              ))}
            </Box>

            <TableContainer
              sx={{
                display: { xs: "none", lg: "block" },
                overflow: "hidden",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "5px",
                bgcolor: "background.paper",
              }}
            >
              <Table size="small" sx={{ tableLayout: "fixed" }}>
                <TableHead>
                  <TableRow>
                    {[
                      ["Draft", "30%"],
                      ["Creator", "20%"],
                      ["Media", "12%"],
                      ["Last saved", "15%"],
                      ["Preview", "14%"],
                      ["Actions", "9%"],
                    ].map(([label, width]) => (
                      <TableCell key={label} sx={{ width, py: 1.25, fontSize: 12, fontWeight: 750 }}>
                        {label}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.items.map((draft) => {
                    const canOpen = isCurrentPreview(draft);
                    return (
                      <TableRow key={draft.id} hover sx={{ "&:last-child td": { borderBottom: 0 } }}>
                        <TableCell sx={{ py: 1.25 }}>
                          <Stack direction="row" spacing={1.25} alignItems="center">
                            <DraftThumbnail draft={draft} />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 750 }}>
                                {draft.title}
                              </Typography>
                              <Typography noWrap sx={{ mt: 0.25, color: "text.secondary", fontSize: 11.5 }}>
                                Contract: {draft.contractNo || "Not provided"}
                              </Typography>
                              <Typography noWrap sx={{ mt: 0.15, color: "text.secondary", fontSize: 11.5 }}>
                                {draft.type === "asset" ? "Asset" : "Lot Listing"} · Revision {draft.revision}
                              </Typography>
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <UserRound size={15} />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 650 }}>
                                {draft.creatorDisplay}
                              </Typography>
                              <Typography noWrap sx={{ color: "text.secondary", fontSize: 11 }}>
                                {draft.creator?.email || "Account unavailable"}
                              </Typography>
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Typography sx={{ fontSize: 12.5 }}>{draft.lotCount} lots</Typography>
                          <Typography sx={{ mt: 0.2, color: "text.secondary", fontSize: 11.5 }}>
                            {draft.imageCount} images{draft.videoCount ? ` · ${draft.videoCount} videos` : ""}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} alignItems="flex-start">
                            <Clock3 size={15} />
                            <Box>
                              <Typography sx={{ fontSize: 12 }}>{formatDateTime(draft.updatedAt)}</Typography>
                              <Typography sx={{ color: "text.secondary", fontSize: 11 }}>
                                {relativeTime(draft.updatedAt)}
                              </Typography>
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell><DraftStatus draft={draft} /></TableCell>
                        <TableCell align="center">
                          <Stack direction="row" justifyContent="center" spacing={0.75}>
                            <Tooltip title={canOpen ? "Inspect generated draft preview" : "The current revision is not ready yet."}>
                              <span>
                                <Button
                                  variant="outlined"
                                  disabled={!canOpen}
                                  onClick={() => draft.previewReportId && onOpenPreview(draft.previewReportId)}
                                  sx={{ minWidth: 36, px: 0.75, borderRadius: "4px" }}
                                  aria-label={`Open ${draft.title}`}
                                >
                                  <Eye size={16} />
                                </Button>
                              </span>
                            </Tooltip>
                            <Tooltip title={["queued", "processing"].includes(draft.previewStatus) ? "Active draft previews cannot be deleted." : "Permanently delete saved draft"}>
                              <span>
                              <Button
                                variant="outlined"
                                color="error"
                                disabled={["queued", "processing"].includes(draft.previewStatus) || deletingId === draft.id}
                                onClick={() => setDeleteTarget(draft)}
                                sx={{ minWidth: 36, px: 0.75, borderRadius: "4px" }}
                                aria-label={`Delete ${draft.title}`}
                              >
                                {deletingId === draft.id ? <CircularProgress size={15} color="inherit" /> : <Trash2 size={16} />}
                              </Button>
                              </span>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Box>

      {data && data.pages > 1 ? (
        <Stack
          direction={{ xs: "column", sm: "row" }}
          alignItems="center"
          justifyContent="space-between"
          spacing={1.5}
          sx={{ mt: 2 }}
        >
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ color: "text.secondary", fontSize: 12.5 }}>
              {data.total} drafts
            </Typography>
            <FormControl size="small">
              <Select
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  setPage(1);
                }}
              >
                <MenuItem value={10}>10 rows</MenuItem>
                <MenuItem value={25}>25 rows</MenuItem>
                <MenuItem value={50}>50 rows</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Pagination
            count={data.pages}
            page={data.page}
            onChange={(_, value) => setPage(value)}
            color="primary"
            shape="rounded"
          />
        </Stack>
      ) : null}

      <Dialog open={Boolean(deleteTarget)} onClose={deletingId ? undefined : () => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete saved draft?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This permanently removes <strong>{deleteTarget?.title}</strong>
            {deleteTarget?.contractNo ? ` (contract ${deleteTarget.contractNo})` : ""}, its saved media references,
            and its generated draft preview. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setDeleteTarget(null)} disabled={Boolean(deletingId)}>Cancel</Button>
          <Button variant="contained" color="error" startIcon={<Trash2 size={16} />} onClick={() => void deleteDraft()} disabled={Boolean(deletingId)}>
            Delete draft
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
