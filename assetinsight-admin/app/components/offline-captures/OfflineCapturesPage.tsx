"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Autocomplete, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, LinearProgress, MenuItem, Pagination, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography, useMediaQuery, useTheme, type SxProps, type Theme } from "@mui/material";
import { Camera, Eye, RefreshCw, Trash2, X } from "lucide-react";
import {
  CAPTURE_STAGE_LABELS, CAPTURE_STATUS_LABELS, EMPTY_CAPTURE_FILTERS,
  captureQuery, captureTime, parseCaptureDetail, parseCaptureList, parseCaptureUsers,
  type CaptureDetail, type CaptureFilters, type CaptureList, type CaptureRow, type CaptureUser,
} from "@/lib/captureInventory";

const touch = {
  minHeight: 44,
  "&.MuiButton-textPrimary:not(.Mui-disabled), &.MuiButton-outlinedPrimary:not(.Mui-disabled)": {
    color: (theme: Theme) => theme.palette.mode === "dark" ? theme.palette.primary.light : undefined,
  },
  "&.MuiButton-containedPrimary:not(.Mui-disabled)": {
    bgcolor: (theme: Theme) => theme.palette.mode === "dark" ? theme.palette.primary.dark : undefined,
  },
} satisfies SxProps<Theme>;
class CaptureRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function requestJson(url: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message;
    throw new CaptureRequestError(typeof message === "string" ? message : response.status === 403 ? "You do not have permission to view capture history." : "Capture information is unavailable. Try again.", response.status);
  }
  return payload;
}
function errorText(error: unknown): string {
  return error instanceof Error && error.name !== "AbortError" ? error.message : "The request timed out. Refresh to try again.";
}
function label(row: CaptureRow): string { return row.contractNo || "No contract number"; }
function creatorName(user: CaptureUser): string { return user.username || user.email || "Unavailable user"; }
function deviceName(row: CaptureRow): string { return `${row.device.platform || "Device"}${row.device.appVersion ? ` · v${row.device.appVersion}` : ""}`; }

function Stage({ row }: { row: CaptureRow }) {
  const stage = row.server.stage;
  return <Chip size="small" variant="outlined" color={stage === "error" ? "error" : stage === "completed" || stage === "preview_ready" ? "success" : stage === "not_uploaded" ? "default" : "info"} label={CAPTURE_STAGE_LABELS[stage]} sx={{ maxWidth: "100%", height: "auto", minHeight: 24, color: theme => (stage === "completed" || stage === "preview_ready") && theme.palette.mode === "light" ? theme.palette.success.dark : undefined, "& .MuiChip-label": { whiteSpace: "normal", py: 0.3 } }} />;
}
function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return <Box sx={{ minWidth: 0 }}><Typography component="dt" sx={{ fontSize: 11, fontWeight: 600, color: "text.secondary", mb: 0.4 }}>{name}</Typography><Typography component="dd" sx={{ m: 0, fontSize: 13, overflowWrap: "anywhere" }}>{children}</Typography></Box>;
}
function UserFilter({ value, onChange }: { value: CaptureUser | null; onChange: (value: CaptureUser | null) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [options, setOptions] = useState<CaptureUser[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const debounce = setTimeout(async () => {
      setBusy(true); setError("");
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const result = parseCaptureUsers(await requestJson(`/api/admin/capture-inventory/users?${new URLSearchParams({ search: query.trim(), limit: "50" })}`, controller.signal));
        if (active) { setOptions(result.items); setHasMore(result.hasMore); }
      } catch (cause) { if (active) { setOptions([]); setError(errorText(cause)); } }
      finally { clearTimeout(timeout); if (active) setBusy(false); }
    }, 250);
    return () => { active = false; clearTimeout(debounce); controller.abort(); };
  }, [open, query]);
  return <Autocomplete
    value={value} options={options} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} loading={busy}
    onChange={(_event, next) => onChange(next)} onInputChange={(_event, next, reason) => { if (reason === "input" || reason === "clear") setQuery(next); }}
    getOptionLabel={creatorName} getOptionKey={option => option.id} isOptionEqualToValue={(option, selected) => option.id === selected.id} filterOptions={items => items}
    noOptionsText={error || "No matching users"} size="small" sx={{ minWidth: 0 }}
    renderOption={({ key, ...props }, option) => <Box component="li" {...props} key={key} sx={{ display: "block !important", overflowWrap: "anywhere" }}><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{creatorName(option)}{option.isBlocked ? " · blocked" : ""}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{option.email}</Typography></Box>}
    renderInput={params => <TextField {...params} label="User" placeholder="Search users" helperText={error || (hasMore ? "Refine search for more users" : undefined)} error={!!error} slotProps={{ htmlInput: { ...params.inputProps, maxLength: 100 } }} />}
  />;
}

function CaptureDrawer({ id, onClose, onRemoved }: { id: string; onClose: () => void; onRemoved: () => void }) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [data, setData] = useState<CaptureDetail | null>(null), [busy, setBusy] = useState(true), [issue, setIssue] = useState("");
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [confirm, setConfirm] = useState(false), [removing, setRemoving] = useState(false), [removeIssue, setRemoveIssue] = useState("");
  const removeLock = useRef(false), removal = useRef<AbortController | null>(null);
  useEffect(() => () => { removal.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setIssue("");
    void requestJson(`/api/admin/capture-inventory/${id}?lotsPage=${page}&lotsLimit=25`, controller.signal)
      .then(parseCaptureDetail).then(result => { if (active) setData(result); })
      .catch(cause => { if (active) setIssue(errorText(cause)); })
      .finally(() => { clearTimeout(timeout); if (active) setBusy(false); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [id, page, refresh]);
  const reload = () => { setConfirm(false); setRemoveIssue(""); setRefresh(value => value + 1); };
  async function remove() {
    if (!data || data.localStatus !== "discarded" || busy || issue || removeLock.current || removeIssue) return;
    removeLock.current = true; setRemoving(true);
    const controller = new AbortController(); removal.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await requestJson(`/api/admin/capture-inventory/${data.id}`, controller.signal, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: data.revision }) });
      if (result?.data?.removed !== true || result.data.id !== data.id) throw new Error("Removal could not be confirmed.");
      onRemoved();
    } catch (cause) {
      if (!controller.signal.aborted || removal.current === controller) setRemoveIssue(cause instanceof CaptureRequestError && cause.status === 409 ? "This capture changed. Reload and review its current status before removing history." : "Removal could not be confirmed. Reload capture history before trying again.");
    } finally { clearTimeout(timeout); removeLock.current = false; setRemoving(false); }
  }
  return <>
    <Dialog open onClose={removing ? undefined : onClose} fullScreen={fullScreen} fullWidth maxWidth="lg" aria-labelledby="capture-detail-title" slotProps={{ paper: { sx: { maxHeight: fullScreen ? "100%" : "calc(100% - 32px)" } } }}>
      <DialogTitle id="capture-dialog-heading" sx={{ p: 2, pr: 7, overflowWrap: "anywhere" }}><Typography id="capture-detail-title" component="span" sx={{ fontSize: 20, fontWeight: 700 }}>Capture details{data ? ` · ${label(data)}` : ""}</Typography><IconButton aria-label="Close capture details" onClick={onClose} disabled={removing} sx={{ position: "absolute", top: 8, right: 8, width: 44, height: 44 }}><X size={20} /></IconButton></DialogTitle>
      {busy ? <LinearProgress aria-label="Loading capture details" /> : null}
      <DialogContent dividers sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Stack spacing={2}>
          {issue ? <Alert severity="error" action={<Button onClick={reload} color="inherit" sx={touch}>Retry</Button>}>{issue}{data ? " Previously loaded details are shown below." : ""}</Alert> : null}
          {!data && busy ? <Typography color="text.secondary">Loading capture information…</Typography> : null}
          {data ? <>
            <Stack direction="row" gap={1} flexWrap="wrap"><Chip size="small" label={data.reportType === "asset" ? "Asset" : "Lot Listing"} /><Chip size="small" variant="outlined" label={CAPTURE_STATUS_LABELS[data.localStatus]} /><Stage row={data} /></Stack>
            <Alert severity="info" sx={{ py: 0 }}>Last synchronized {captureTime(data.lastReceivedAt)}. Device information may be outdated while offline. These counts are metadata, not a cloud backup of the photos.</Alert>
            <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, minmax(0, 1fr))" }, gap: 1.5 }}>
              <Fact name="Created by">{creatorName(data.creator)}<br />{data.creator.email}</Fact>
              <Fact name="Device">{deviceName(data)}<br />{data.device.verified ? "Verified device" : "Unverified device"}</Fact>
              <Fact name="Report on server">{data.server.reportId || "Not linked to a server report"}</Fact>
            </Box>
            <Box>
              <Typography component="h3" sx={{ fontSize: 15, fontWeight: 700, mb: 1 }}>Last reported on device</Typography>
              <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1.5, p: 1.5, bgcolor: "action.hover", border: "1px solid", borderColor: "divider" }}>
                <Fact name="Lots">{data.counts.lotCount.toLocaleString()}</Fact><Fact name="Photos">{data.counts.photoCount.toLocaleString()} total · {data.counts.mainPhotoCount.toLocaleString()} main · {data.counts.extraPhotoCount.toLocaleString()} report-only</Fact>
                <Fact name="Available on device">{data.counts.availablePhotoCount.toLocaleString()}</Fact><Fact name="Missing on device">{data.counts.missingPhotoCount.toLocaleString()}</Fact>
                <Fact name="Capture created (device clock)">{captureTime(data.deviceCreatedAt)}</Fact><Fact name="Last saved (device clock)">{captureTime(data.deviceSavedAt)}</Fact>
                <Fact name="First photo (device clock)">{captureTime(data.firstCapturedAt)}</Fact><Fact name="Last photo (device clock)">{captureTime(data.lastCapturedAt)}</Fact>
              </Box>
            </Box>
            <Box>
              <Typography component="h3" sx={{ fontSize: 15, fontWeight: 700, mb: 1 }}>Confirmed by server</Typography>
              {data.server.issue ? <Alert severity="error" sx={{ mb: 1, overflowWrap: "anywhere" }}>{data.server.issue}</Alert> : null}
              <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, minmax(0, 1fr))" }, gap: 1.5 }}>
                <Fact name="Uploaded photos">{data.server.uploadedPhotoCount === null ? "Not confirmed" : `${data.server.uploadedPhotoCount.toLocaleString()}${data.server.expectedPhotoCount !== null ? ` of ${data.server.expectedPhotoCount.toLocaleString()}` : ""}`}</Fact>
                <Fact name="Upload started">{captureTime(data.server.uploadStartedAt)}</Fact><Fact name="Upload completed">{captureTime(data.server.uploadCompletedAt)}</Fact>
                <Fact name="Accepted for processing">{captureTime(data.server.acceptedAt)}</Fact><Fact name="Preview submitted">{captureTime(data.server.previewSubmittedAt)}</Fact><Fact name="Processing completed">{captureTime(data.server.processingCompletedAt)}</Fact>
                <Fact name="Preview available">{data.server.previewAvailable ? "Yes" : "Not available"}</Fact><Fact name="Files generated">{data.server.filesReady ? "Yes — approval/release is separate" : "Not confirmed"}</Fact><Fact name="First synchronized">{captureTime(data.firstReceivedAt)}</Fact>
              </Box>
            </Box>
            <Divider />
            <Box>
              <Typography component="h3" sx={{ fontSize: 15, fontWeight: 700 }}>Lots · {data.lotsTotal.toLocaleString()}</Typography>
              <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1 }}>Photo counts reflect the last device synchronization. No photos or private notes are shown.</Typography>
              {data.lots.length ? <TableContainer sx={{ border: "1px solid", borderColor: "divider" }} tabIndex={0} aria-label="Per-lot photo counts; scroll horizontally on small screens"><Table size="small" sx={{ minWidth: 530 }}><TableHead><TableRow>{["Lot", "Title", "Main", "Report-only", "Available", "Missing"].map(name => <TableCell key={name} sx={{ fontWeight: 700 }}>{name}</TableCell>)}</TableRow></TableHead><TableBody>{data.lots.map(lot => <TableRow key={lot.id}><TableCell>{lot.lotNumber || "Not assigned"}</TableCell><TableCell sx={{ maxWidth: 280, overflowWrap: "anywhere" }}>{lot.title || "Untitled lot"}</TableCell><TableCell>{lot.mainPhotoCount}</TableCell><TableCell>{lot.extraPhotoCount}</TableCell><TableCell>{lot.availablePhotoCount}</TableCell><TableCell sx={{ color: lot.missingPhotoCount ? "error.main" : "text.secondary" }}>{lot.missingPhotoCount}</TableCell></TableRow>)}</TableBody></Table></TableContainer> : <Typography color="text.secondary" sx={{ py: 1 }}>No lot metadata was reported.</Typography>}
              {data.lotsPages > 1 ? <Pagination aria-label="Lot pages" count={data.lotsPages} page={data.lotsPage} onChange={(_event, value) => setPage(value)} disabled={busy} size="small" siblingCount={0} sx={{ mt: 1, "& button": touch }} /> : null}
            </Box>
          </> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1, flexWrap: "wrap", gap: 1 }}>
        {data?.localStatus === "discarded" ? <Button color="error" startIcon={<Trash2 size={16} />} onClick={() => setConfirm(true)} disabled={busy || !!issue || removing} sx={{ ...touch, mr: "auto" }}>Remove discarded history</Button> : null}
        <Button startIcon={<RefreshCw size={16} />} onClick={reload} disabled={busy || removing} sx={touch}>Reload details</Button><Button onClick={onClose} disabled={removing} sx={touch}>Close</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={confirm} onClose={removing ? undefined : () => setConfirm(false)} maxWidth="xs" fullWidth aria-labelledby="remove-capture-title">
      <DialogTitle id="remove-capture-title">Remove discarded history?</DialogTitle><DialogContent><Typography>This hides the discarded capture’s metadata from this list. It does not delete device photos, uploaded files, drafts or reports.</Typography>{removeIssue ? <Alert severity="error" sx={{ mt: 2 }}>{removeIssue}</Alert> : null}</DialogContent><DialogActions sx={{ p: 2, gap: 1, flexWrap: "wrap" }}><Button onClick={() => setConfirm(false)} disabled={removing} sx={touch}>Cancel</Button>{removeIssue ? <Button variant="contained" onClick={reload} sx={touch}>Reload and review</Button> : <Button color="error" variant="contained" disabled={removing} onClick={() => void remove()} sx={touch}>{removing ? "Removing…" : "Remove history"}</Button>}</DialogActions>
    </Dialog>
  </>;
}

export default function OfflineCapturesPage() {
  const [draft, setDraft] = useState<CaptureFilters>({ ...EMPTY_CAPTURE_FILTERS }), [filters, setFilters] = useState<CaptureFilters>({ ...EMPTY_CAPTURE_FILTERS });
  const [selectedUser, setSelectedUser] = useState<CaptureUser | null>(null);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [data, setData] = useState<CaptureList | null>(null), [busy, setBusy] = useState(true), [issue, setIssue] = useState(""), [filterIssue, setFilterIssue] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null), [notice, setNotice] = useState("");
  const query = new URLSearchParams({ ...filters, page: String(page), limit: "25" }).toString();
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setIssue("");
    void requestJson(`/api/admin/capture-inventory?${query}`, controller.signal).then(parseCaptureList)
      .then(result => { if (active) setData(result); })
      .catch(cause => { if (active) setIssue(errorText(cause)); })
      .finally(() => { clearTimeout(timeout); if (active) setBusy(false); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [query, refresh]);
  function apply() {
    try { captureQuery(new URLSearchParams(draft), "list"); }
    catch (cause) { setFilterIssue(errorText(cause)); return; }
    setFilterIssue(""); setFilters({ ...draft }); setPage(1); setRefresh(value => value + 1); setNotice("");
  }
  function reset() { setDraft({ ...EMPTY_CAPTURE_FILTERS }); setFilters({ ...EMPTY_CAPTURE_FILTERS }); setSelectedUser(null); setPage(1); setFilterIssue(""); setRefresh(value => value + 1); }
  const edit = (key: keyof CaptureFilters, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return <Box sx={{ p: { xs: 1.5, sm: 2, lg: 3 }, minWidth: 0, overflowWrap: "anywhere" }}>
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box sx={{ minWidth: 0 }}><Typography component="h1" sx={{ fontSize: { xs: 23, sm: 28 }, fontWeight: 700, display: "flex", gap: 1, alignItems: "center" }}><Camera size={25} aria-hidden />Offline Captures</Typography><Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}>Device capture history and server-confirmed progress.</Typography></Box>
        <Button variant="outlined" startIcon={<RefreshCw size={16} />} onClick={() => setRefresh(value => value + 1)} disabled={busy} sx={{ ...touch, flexShrink: 0 }}>Refresh</Button>
      </Stack>
      <Alert severity="info" sx={{ py: 0 }}>Only synchronized metadata appears here. A device that is offline may have newer changes. Photo counts do not confirm cloud backup or upload.</Alert>
      <Box component="form" onSubmit={event => { event.preventDefault(); apply(); }} sx={{ p: 1.5, border: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }, gap: 1.5 }}>
          <UserFilter value={selectedUser} onChange={value => { setSelectedUser(value); edit("userId", value?.id || ""); }} />
          <TextField label="Contract" placeholder="Search contract number" value={draft.search} onChange={event => edit("search", event.target.value)} size="small" slotProps={{ htmlInput: { maxLength: 100 } }} />
          <TextField select label="Report type" value={draft.reportType} onChange={event => edit("reportType", event.target.value)} size="small"><MenuItem value="">All types</MenuItem><MenuItem value="asset">Asset</MenuItem><MenuItem value="lotListing">Lot Listing</MenuItem></TextField>
          <TextField select label="Device status" value={draft.localStatus} onChange={event => edit("localStatus", event.target.value)} size="small"><MenuItem value="">All device statuses</MenuItem>{Object.entries(CAPTURE_STATUS_LABELS).map(([value, title]) => <MenuItem value={value} key={value}>{title}</MenuItem>)}</TextField>
          <TextField type="date" label="Last synchronized from (UTC)" value={draft.receivedFrom} onChange={event => edit("receivedFrom", event.target.value)} size="small" slotProps={{ inputLabel: { shrink: true } }} />
          <TextField type="date" label="Last synchronized to (UTC)" value={draft.receivedTo} onChange={event => edit("receivedTo", event.target.value)} size="small" slotProps={{ inputLabel: { shrink: true } }} />
          <Stack direction="row" gap={1} sx={{ gridColumn: { lg: "span 2" }, alignItems: "flex-start" }}><Button type="submit" variant="contained" sx={touch}>Apply filters</Button><Button onClick={reset} sx={touch}>Reset</Button></Stack>
        </Box>
        {filterIssue ? <Alert severity="error" sx={{ mt: 1 }}>{filterIssue}</Alert> : null}
      </Box>
      {notice ? <Alert severity="success" onClose={() => setNotice("")}>{notice}</Alert> : null}
      {issue ? <Alert severity="error" action={<Button color="inherit" onClick={() => setRefresh(value => value + 1)} sx={touch}>Retry</Button>}>{issue}{data ? " Showing the last successful snapshot; it may not match the current filters." : ""}</Alert> : null}
      <Box aria-busy={busy} sx={{ border: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
        {busy ? <LinearProgress aria-label="Loading capture history" /> : null}
        <Typography sx={{ p: 1.5, fontSize: 13, fontWeight: 600 }} aria-live="polite">{data ? `${data.total.toLocaleString()} capture${data.total === 1 ? "" : "s"}` : busy ? "Loading captures…" : "Capture history unavailable"}</Typography>
        {!data && busy ? <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress size={24} aria-label="Loading" /></Box> : null}
        {data?.items.length === 0 ? <Box sx={{ p: 3, textAlign: "center" }}><Typography sx={{ fontWeight: 600 }}>No synchronized captures found</Typography><Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}>Try different filters. Offline devices appear only after their metadata synchronizes.</Typography></Box> : null}
        {data?.items.length ? <>
          <TableContainer sx={{ display: { xs: "none", lg: "block" } }}><Table size="small"><TableHead><TableRow>{["Contract / type", "User / device", "Device inventory", "Progress", "Last synchronized", ""].map((name, index) => <TableCell key={index} sx={{ fontWeight: 700 }}>{name || <span className="sr-only">Actions</span>}</TableCell>)}</TableRow></TableHead><TableBody>{data.items.map(row => <TableRow key={row.id} hover>
            <TableCell sx={{ maxWidth: 190, overflowWrap: "anywhere" }}><Typography sx={{ fontSize: 13, fontWeight: 700 }}>{label(row)}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{row.reportType === "asset" ? "Asset" : "Lot Listing"}</Typography></TableCell>
            <TableCell sx={{ maxWidth: 220, overflowWrap: "anywhere" }}><Typography sx={{ fontSize: 13 }}>{creatorName(row.creator)}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{deviceName(row)}</Typography></TableCell>
            <TableCell><Typography sx={{ fontSize: 13 }}>{row.counts.lotCount.toLocaleString()} lots · {row.counts.photoCount.toLocaleString()} photos</Typography><Typography sx={{ fontSize: 11, color: row.counts.missingPhotoCount ? "error.main" : "text.secondary" }}>{row.counts.missingPhotoCount ? `${row.counts.missingPhotoCount} missing on device` : "Last reported counts"}</Typography></TableCell>
            <TableCell><Stage row={row} /><Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>{CAPTURE_STATUS_LABELS[row.localStatus]}</Typography></TableCell>
            <TableCell sx={{ maxWidth: 175, fontSize: 12 }}>{captureTime(row.lastReceivedAt)}</TableCell><TableCell><Button startIcon={<Eye size={16} />} onClick={() => setSelectedId(row.id)} sx={touch} aria-label={`View capture ${label(row)}`}>Details</Button></TableCell>
          </TableRow>)}</TableBody></Table></TableContainer>
          <Stack sx={{ display: { xs: "flex", lg: "none" } }} divider={<Divider />}>{data.items.map(row => <Box key={row.id} sx={{ px: 1.5, py: 1.5, minWidth: 0 }}>
            <Stack direction="row" gap={1} justifyContent="space-between" alignItems="flex-start"><Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{label(row)}</Typography><Typography sx={{ fontSize: 12, color: "text.secondary" }}>{row.reportType === "asset" ? "Asset" : "Lot Listing"} · {creatorName(row.creator)}</Typography></Box><Button onClick={() => setSelectedId(row.id)} aria-label={`View capture ${label(row)}`} sx={touch}>Details</Button></Stack>
            <Stack direction="row" flexWrap="wrap" gap={1} sx={{ my: 1 }}><Stage row={row} /><Typography sx={{ fontSize: 12, alignSelf: "center" }}>{CAPTURE_STATUS_LABELS[row.localStatus]}</Typography></Stack>
            <Typography sx={{ fontSize: 13 }}>{row.counts.lotCount.toLocaleString()} lots · {row.counts.photoCount.toLocaleString()} photos · {row.counts.missingPhotoCount} missing</Typography><Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>{deviceName(row)}<br />Last synchronized {captureTime(row.lastReceivedAt)}</Typography>
          </Box>)}</Stack>
        </> : null}
        {data && data.pages > 1 ? <Stack direction={{ xs: "column", sm: "row" }} alignItems="center" justifyContent="space-between" gap={1} sx={{ p: 1.5, borderTop: "1px solid", borderColor: "divider" }}><Typography sx={{ fontSize: 12, color: "text.secondary" }}>Page {data.page} of {data.pages} · Up to {data.limit} per page</Typography><Pagination aria-label="Capture pages" count={data.pages} page={data.page} onChange={(_event, value) => setPage(value)} disabled={busy} siblingCount={0} size="small" sx={{ "& button": touch }} /></Stack> : null}
      </Box>
    </Stack>
    {selectedId ? <CaptureDrawer key={selectedId} id={selectedId} onClose={() => setSelectedId(null)} onRemoved={() => { setSelectedId(null); setPage(1); setNotice("Discarded capture history removed. Files, drafts and reports are unchanged."); setRefresh(value => value + 1); }} /> : null}
  </Box>;
}
