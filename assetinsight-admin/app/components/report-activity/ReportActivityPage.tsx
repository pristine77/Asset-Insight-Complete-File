"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, IconButton, LinearProgress, MenuItem, Pagination, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { ArrowRight, Camera, ChevronRight, Clock3, History, RefreshCw, Trash2, X } from "lucide-react";
import { ACTIVITY_LABELS, activityEventLabel, activityOutcomeLabel, activityQuery, activityReceiptNote, activityTime, backupReasonLabel, isBackupActivity, isUploadTransferActivity, uploadReasonLabel, logoLabel, parseActivityDetail, parseActivityPage, type ActivityCounts, type ActivityDetail, type ActivityEvent, type ActivityField, type ActivityPage, type ActivityRow } from "@/lib/reportActivity";
import { parseCaptureUsers, type CaptureUser } from "@/lib/captureInventory";
import ActivityLotCounts from "./ActivityLotCounts";

const Captures = dynamic(() => import("@/app/components/offline-captures/OfflineCapturesPage"), { loading: () => <LinearProgress aria-label="Loading captures" /> });
const emptyFilters = { userId: "", search: "", reportType: "", source: "", action: "", outcome: "", from: "", to: "" };
const touch = { minHeight: 44 };
const person = (user: { name: string; email: string } | null) => user?.name || user?.email || "System";
const valueText = (value: unknown) => value == null ? "Not set" : typeof value === "string" ? value || "Blank" : JSON.stringify(value, null, 2);
const label = (action?: string) => action ? ACTIVITY_LABELS[action] || "Activity recorded" : "History recording started";
async function getJson(url: string, signal?: AbortSignal, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "Activity could not be loaded. Refresh to try again.");
  return payload;
}
function Count({ value }: { value: ActivityCounts | null | undefined }) {
  return <Typography component="span" sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{value ? `${value.lots.toLocaleString()} lots · ${value.photos.toLocaleString()} photos` : "Counts not recorded"}</Typography>;
}
function Outcome({ outcome }: { outcome?: string }) {
  return <Chip size="small" variant="outlined" label={outcome || "Recorded"} color={outcome === "failed" ? "error" : outcome === "completed" ? "success" : "default"} sx={{ textTransform: "capitalize", height: 24, fontSize: 11, color: theme => outcome === "completed" && theme.palette.mode === "light" ? theme.palette.success.dark : undefined }} />;
}
function ReportedApp({ row, detailed = false }: { row: ActivityRow; detailed?: boolean }) {
  const app = row.lastReportedApp;
  return <Typography sx={{ fontSize: 11, color: "text.secondary", overflowWrap: "anywhere" }} title={app ? `Reported by ${app.source}; received ${activityTime(app.receivedAt)}` : undefined}>
    Last reported app: {app?.appVersion || "Not recorded"}{detailed && app ? ` · ${app.source} · received ${activityTime(app.receivedAt)}. Offline activity may arrive later than it occurred.` : ""}
  </Typography>;
}
function FieldChange({ field }: { field: ActivityField }) {
  if (typeof field === "string" || !("before" in field)) return <Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{typeof field === "string" ? field : field.field} · value not included</Typography>;
  return <Box sx={{ border: "1px solid", borderColor: "divider", p: 1, borderRadius: 1 }}><Typography sx={{ fontSize: 12, fontWeight: 700, mb: 0.5, overflowWrap: "anywhere" }}>{field.field}</Typography><Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1 }}>
    {[{ name: "Before", value: field.before }, { name: "After", value: field.after }].map(item => <Box key={item.name} sx={{ minWidth: 0 }}><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{item.name}</Typography><Typography component="pre" sx={{ m: 0, fontFamily: "inherit", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflow: "auto" }}>{valueText(item.value)}</Typography></Box>)}
  </Box></Box>;
}
function EventItem({ event }: { event: ActivityEvent }) {
  const data = event.data || {};
  const backup = isBackupActivity(event.action);
  const transfer = isUploadTransferActivity(event.action);
  const receiptNote = activityReceiptNote(event);
  const verifiedBackup = data.backupCountAuthority === "server_verified" ? data.backupCounts : null;
  const verifiedUpload = data.uploadCountAuthority === "server_verified" ? data.uploadCounts : null;
  return <Box component="article" sx={{ borderLeft: "2px solid", borderColor: event.outcome === "failed" ? "error.main" : "divider", pl: 2, pb: 2, position: "relative" }}>
    <Box sx={{ position: "absolute", left: -5, top: 5, width: 8, height: 8, borderRadius: "50%", bgcolor: event.outcome === "failed" ? "error.main" : "primary.main" }} />
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><Typography sx={{ fontWeight: 700, fontSize: 14 }}>{activityEventLabel(event)}</Typography><Outcome outcome={activityOutcomeLabel(event.action, event.outcome)} />{(data.parts || 1) > 1 ? <Typography sx={{ fontSize: 11, color: "text.secondary" }}>Part {data.part} of {data.parts}</Typography> : null}</Stack>
    <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5, overflowWrap: "anywhere" }}>{person(event.actor)} · Source: {event.source === "unknown" ? "Not recorded" : event.source} · {event.authority === "server" ? "Server confirmed" : "Device reported"}{event.appVersion ? ` · App ${event.appVersion}` : ""}</Typography>
    <Typography sx={{ fontSize: 11, color: "text.secondary" }}>Received {activityTime(event.receivedAt)}{["android", "ios"].includes(event.source) && !event.appVersion ? " · App version: Not recorded" : ""}</Typography>
    {data.baseline ? <Alert severity="info" sx={{ my: 1 }}>Current-state baseline only. Earlier actions were not recorded.</Alert> : null}
    {data.error ? <Alert severity="error" sx={{ my: 1 }}>{data.error}</Alert> : null}
    {data.verifiedLogoReceipts ? <Typography sx={{ fontSize: 12 }}>Verified existing-logo receipts: {data.verifiedLogoReceipts}. Receipt verification does not identify the camera.</Typography> : null}
    {data.deliveryStatus ? <Typography sx={{ fontSize: 12 }}>Auction delivery: {data.deliveryStatus.replaceAll("_", " ")}</Typography> : null}
    {event.authority === "device" ? <Typography sx={{ fontSize: 11, color: "text.secondary" }}>Device time {activityTime(event.observedAt)}{event.sequence ? ` · sequence ${event.sequence}` : ""}</Typography> : null}
    {receiptNote ? <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>{receiptNote}</Typography> : null}
    {transfer ? <Box sx={{ my: 1, bgcolor: "action.hover", p: 1 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>Background report upload</Typography>
      {verifiedUpload ? <Typography sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>Server-verified files: {verifiedUpload.verifiedFiles.toLocaleString()} of {verifiedUpload.totalFiles.toLocaleString()}</Typography> : <Typography sx={{ fontSize: 13 }}>Upload verification counts not recorded</Typography>}
      <Typography sx={{ fontSize: 12, mt: 0.5 }}>Reason: {uploadReasonLabel(data.uploadReason)}</Typography>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>This is a device transfer observation, not proof of report acceptance or deletion. Closing the form does not cancel a queued upload. A force-stopped app cannot report its state until Android allows it to run or the user reopens it.</Typography>
    </Box> : null}
    {backup ? <Box sx={{ my: 1, bgcolor: "action.hover", p: 1 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>Cloud backup snapshot{data.backupRevision != null ? ` · revision ${data.backupRevision}` : ""}</Typography>
      {verifiedBackup ? <>
        <Typography sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>Server-verified files: {verifiedBackup.verifiedFiles.toLocaleString()} of {verifiedBackup.totalFiles.toLocaleString()}</Typography>
        <Typography sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>Server-verified photos: {verifiedBackup.verifiedPhotos.toLocaleString()} of {verifiedBackup.totalPhotos.toLocaleString()}</Typography>
      </> : <Typography sx={{ fontSize: 13 }}>Cloud verification counts not recorded</Typography>}
      {["backup_paused", "backup_interrupted"].includes(event.action) || data.backupReason ? <Typography sx={{ fontSize: 12, mt: 0.5 }}>Reason: {backupReasonLabel(data.backupReason)}</Typography> : null}
      <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>These counts cover this saved backup snapshot, separately from captured photo totals. Backup does not submit the report.</Typography>
    </Box> : null}
    {(!backup && !transfer) || data.beforeCounts || data.afterCounts ? <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ my: 1, bgcolor: "action.hover", p: 1 }}><Count value={data.beforeCounts} /><ArrowRight size={14} aria-label="changed to" /><Count value={data.afterCounts} /></Stack> : null}
    {!backup && !transfer ? <Stack direction="row" gap={1.5} flexWrap="wrap"><Typography sx={{ fontSize: 12 }}>Upload logo: <b>{logoLabel(data.uploadLogo)}</b></Typography><Typography sx={{ fontSize: 12 }}>Camera stamp: <b>{data.cameraStamp === "camera_reported" ? "Reported by camera" : data.cameraStamp === "receipt_verified" ? "Receipt verified" : "Not recorded"}</b></Typography>{data.destination ? <Typography sx={{ fontSize: 12 }}>Destination: <b>{data.destination}</b></Typography> : null}{data.captureMode ? <Typography sx={{ fontSize: 12 }}>Capture: {data.captureMode}</Typography> : null}</Stack> : null}
    {(data.fields?.length || data.lots?.length) ? <Box component="details" sx={{ mt: 1, "& summary": { cursor: "pointer", minHeight: 40, display: "list-item", fontSize: 13, fontWeight: 600, pt: 1 } }}><summary>View changes{data.fields?.length ? ` · ${data.fields.length} fields` : ""}{data.lots?.length ? ` · ${data.lots.length} lot updates` : ""}</summary>
      <Stack gap={1} sx={{ pt: 1 }}>{data.fields?.map((field, index) => <FieldChange key={index} field={field} />)}
        {data.lots?.map((lot, index) => <Box key={`${lot.id}-${index}`} sx={{ border: "1px solid", borderColor: "divider", p: 1 }}><Typography sx={{ fontSize: 13, fontWeight: 700 }}>Lot {lot.lotNumber || lot.id}</Typography><Typography sx={{ fontSize: 12 }}>{lot.before ? `${lot.before.mainPhotos} main + ${lot.before.extraPhotos} report-only` : "Not present"} → {lot.after ? `${lot.after.mainPhotos} main + ${lot.after.extraPhotos} report-only` : "Removed"}</Typography>
          {lot.beforePosition !== lot.afterPosition ? <Typography sx={{ fontSize: 12 }}>Lot position: {lot.beforePosition == null ? "—" : lot.beforePosition + 1} → {lot.afterPosition == null ? "—" : lot.afterPosition + 1}</Typography> : null}
          {(lot.before?.cover ?? lot.beforeCover) !== (lot.after?.cover ?? lot.afterCover) ? <Typography sx={{ fontSize: 12 }}>Cover position: {(lot.before?.cover ?? lot.beforeCover) == null ? "Not recorded" : (lot.before?.cover ?? lot.beforeCover ?? 0) + 1} → {(lot.after?.cover ?? lot.afterCover) == null ? "Not recorded" : (lot.after?.cover ?? lot.afterCover ?? 0) + 1}</Typography> : null}
          {lot.photos?.length ? <Box component="details" sx={{ mt: 0.5 }}><summary>{lot.photos.length} photo position changes</summary>{lot.photos.map(photo => <Typography key={photo.id} sx={{ fontSize: 11, overflowWrap: "anywhere", py: 0.25 }}>{photo.id.slice(0, 16)} · {photo.before == null ? "Added" : photo.before + 1} → {photo.after == null ? "Removed" : photo.after + 1}{photo.slot ? ` · ${photo.slot}` : ""}</Typography>)}</Box> : null}
        </Box>)}
      </Stack>
    </Box> : null}
  </Box>;
}
function ActivityDrawer({ id, close, removed }: { id: string; close: () => void; removed: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null), [events, setEvents] = useState<ActivityPage<ActivityEvent> | null>(null);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(true), [issue, setIssue] = useState("");
  const [confirm, setConfirm] = useState(false), [removing, setRemoving] = useState(false), [removalIssue, setRemovalIssue] = useState("");
  const removalLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setIssue("");
    Promise.all([getJson(`/api/admin/report-activity/${id}`, controller.signal), getJson(`/api/admin/report-activity/${id}/events?page=${page}&limit=25`, controller.signal)]).then(([row, list]) => {
      if (controller.signal.aborted) return;
      setDetail(parseActivityDetail(row)); setEvents(parseActivityPage<ActivityEvent>(list));
    }).catch(error => { if (!controller.signal.aborted) setIssue(error.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [id, page, refresh]);
  async function remove() {
    if (!detail || removalLock.current || removalIssue) return;
    removalLock.current = true; setRemoving(true);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await getJson(`/api/admin/report-activity/${id}`, controller.signal, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: detail.revision }) });
      if (result?.data?.removed !== true) throw new Error("Removal could not be confirmed. Reload to check its outcome.");
      removed();
    } catch (error) { setRemovalIssue(error instanceof Error ? error.message : "Removal could not be confirmed."); }
    finally { clearTimeout(timeout); removalLock.current = false; setRemoving(false); }
  }
  return <><Drawer open sx={{ zIndex: theme => theme.zIndex.modal }} anchor="right" onClose={removing ? undefined : close} slotProps={{ paper: { sx: { width: { xs: "100%", md: 760 }, maxWidth: "100vw", "& .MuiButton-outlinedPrimary:not(.Mui-disabled), & .MuiButton-textPrimary:not(.Mui-disabled)": { color: theme => theme.palette.mode === "dark" ? theme.palette.primary.light : undefined } }, role: "dialog", "aria-label": "Report activity details" } }}>
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}><Box><Typography sx={{ fontWeight: 700, fontSize: 19 }}>Contract {detail?.contract || "Not assigned"}</Typography><Typography sx={{ fontSize: 12, color: "text.secondary" }}>{detail ? person(detail.owner) : "Loading history…"}</Typography></Box><IconButton onClick={close} disabled={removing} aria-label="Close activity details" sx={touch}><X /></IconButton></Stack>
    {busy ? <LinearProgress aria-label="Loading activity details" /> : null}
    <Box sx={{ p: { xs: 1.5, sm: 2.5 }, overflowY: "auto" }}>
      {issue ? <Alert severity="error" action={<Button onClick={() => setRefresh(value => value + 1)}>Retry</Button>}>{issue}</Alert> : null}
      {detail ? <><Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ mb: 1 }}><Chip size="small" label={detail.reportType === "asset" ? "Asset" : "Lot Listing"} />{detail.deleted ? <Chip size="small" color="warning" label="Report deleted · history retained" /> : null}<Count value={detail.latestCounts} /></Stack><Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1.5 }}>Last received {activityTime(detail.lastReceivedAt)}. Device observations reflect the last synchronization.</Typography>
        <ReportedApp row={detail} detailed />
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 2, mt: 1 }}><Button variant="outlined" startIcon={<RefreshCw size={15} />} onClick={() => setRefresh(value => value + 1)} disabled={busy} sx={touch}>Refresh history</Button><Button variant="outlined" disabled={!detail.canOpenPreview || detail.deleted} href={detail.canOpenPreview ? `${detail.previewPath || "/preview-reports"}?reportId=${detail.reportId}` : undefined} sx={touch}>Open preview</Button>{detail.canRemove ? <Button color="error" startIcon={<Trash2 size={15} />} onClick={() => { setRemovalIssue(""); setConfirm(true); }} disabled={busy || !!issue} sx={touch}>Remove history</Button> : null}</Stack>
        {!detail.canViewValues ? <Alert severity="info" sx={{ mb: 2 }}>Operational history is available. Saved field values require access to this report.</Alert> : null}
      </> : null}
      {detail ? <ActivityLotCounts key={id} id={id} refresh={refresh} /> : null}
      {events?.items.map(event => <EventItem key={event.id} event={event} />)}
      {events && events.items.length === 0 ? <Typography sx={{ py: 3 }}>No activity events have been received.</Typography> : null}
      {events && events.total > 25 ? <Pagination size="small" count={Math.ceil(events.total / 25)} page={page} disabled={busy} onChange={(_, value) => setPage(value)} /> : null}
    </Box>
  </Drawer><Dialog open={confirm} onClose={removing ? undefined : () => setConfirm(false)} maxWidth="xs" fullWidth><DialogTitle>Remove this activity history?</DialogTitle><DialogContent><Typography>This removes the recorded activity and field changes. Reports, drafts and photos remain unchanged. Delayed synchronization cannot restore this history.</Typography>{removalIssue ? <Alert severity="error" sx={{ mt: 2 }}>{removalIssue}</Alert> : null}</DialogContent><DialogActions sx={{ p: 2, flexWrap: "wrap" }}><Button onClick={() => setConfirm(false)} disabled={removing} sx={touch}>Cancel</Button>{removalIssue ? <Button onClick={() => { setConfirm(false); setRefresh(value => value + 1); }} sx={touch}>Reload and review</Button> : <Button color="error" variant="contained" onClick={() => void remove()} disabled={removing} sx={touch}>{removing ? "Removing…" : "Remove history"}</Button>}</DialogActions></Dialog></>;
}

export default function ReportActivityPage({ initialTab = "activity" }: { initialTab?: "activity" | "captures" }) {
  const [tab, setTab] = useState(initialTab), [draft, setDraft] = useState(emptyFilters), [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(true), [issue, setIssue] = useState("");
  const [data, setData] = useState<ActivityPage<ActivityRow> | null>(null), [selected, setSelected] = useState<string | null>(null), [updated, setUpdated] = useState<string | null>(null);
  const [users, setUsers] = useState<CaptureUser[]>([]), [user, setUser] = useState<CaptureUser | null>(null), [userSearch, setUserSearch] = useState(""), [userIssue, setUserIssue] = useState("");
  const query = new URLSearchParams({ ...filters, page: String(page), limit: "25" }).toString();
  useEffect(() => {
    if (tab !== "activity") return;
    const controller = new AbortController(); setBusy(true); setIssue("");
    getJson(`/api/admin/report-activity?${query}`, controller.signal).then(payload => { if (!controller.signal.aborted) { setData(parseActivityPage<ActivityRow>(payload)); setUpdated(new Date().toISOString()); } }).catch(error => { if (!controller.signal.aborted) setIssue(error.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [query, refresh, tab]);
  useEffect(() => {
    if (tab !== "activity") return;
    const controller = new AbortController(); const timer = setTimeout(() => { setUserIssue(""); getJson(`/api/admin/report-activity/users?search=${encodeURIComponent(userSearch)}&limit=25`, controller.signal).then(payload => { if (!controller.signal.aborted) setUsers(parseCaptureUsers(payload).items); }).catch(error => { if (!controller.signal.aborted) setUserIssue(error.message); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [userSearch, tab]);
  const field = (name: keyof typeof draft, value: string) => setDraft(current => ({ ...current, [name]: value }));
  return <Box sx={{ p: { xs: 1.5, md: 3 }, minWidth: 0 }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}><Box><Typography component="h1" sx={{ fontSize: { xs: 22, md: 26 }, fontWeight: 750 }}>Report Activity</Typography><Typography sx={{ color: "text.secondary", fontSize: 13 }}>Follow Asset and Lot Listing work from capture to delivery. Device activity may arrive after the phone reconnects or the app reopens.</Typography></Box><History size={25} aria-hidden /></Stack>
    <Tabs value={tab} onChange={(_, value) => setTab(value)} aria-label="Report activity views" sx={{ borderBottom: "1px solid", borderColor: "divider", mb: 2 }}><Tab value="activity" label="Activity" icon={<Clock3 size={16} />} iconPosition="start" /><Tab value="captures" label="Captures" icon={<Camera size={16} />} iconPosition="start" /></Tabs>
    {tab === "captures" ? <Captures /> : <>
      <Box component="form" onSubmit={event => { event.preventDefault(); try { activityQuery(new URLSearchParams(draft)); setFilters({ ...draft }); setPage(1); setIssue(""); } catch (error) { setIssue((error as Error).message); } }} sx={{ p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1, mb: 2 }}>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, minmax(0,1fr))" }, gap: 1.5 }}>
          <Autocomplete size="small" options={users} value={user} filterOptions={options => options} getOptionLabel={option => `${option.username || option.email}${option.username ? ` · ${option.email}` : ""}`} isOptionEqualToValue={(a, b) => a.id === b.id} onInputChange={(_, value) => setUserSearch(value)} onChange={(_, value) => { setUser(value); field("userId", value?.id || ""); }} renderInput={params => <TextField {...params} label="Search user or email" error={!!userIssue} helperText={userIssue || undefined} />} />
          <TextField size="small" label="Contract" value={draft.search} onChange={event => field("search", event.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} />
          {([{ key: "reportType", name: "Report type", items: [["asset", "Asset"], ["lotListing", "Lot Listing"]] }, { key: "source", name: "Source", items: [["web", "Web"], ["android", "Android"], ["ios", "iOS"], ["admin", "Admin"], ["unknown", "Not recorded"]] }, { key: "action", name: "Action", items: Object.entries(ACTIVITY_LABELS) }, { key: "outcome", name: "Outcome", items: [["requested", "Requested"], ["accepted", "Accepted"], ["completed", "Completed"], ["failed", "Failed"]] }] as const).map(filter => <TextField key={filter.key} select size="small" label={filter.name} value={draft[filter.key]} onChange={event => field(filter.key, event.target.value)}><MenuItem value="">All</MenuItem>{filter.items.map(([value, name]) => <MenuItem key={value} value={value}>{name}</MenuItem>)}</TextField>)}
          <TextField size="small" type="date" label="Received from (UTC)" value={draft.from} onChange={event => field("from", event.target.value)} slotProps={{ inputLabel: { shrink: true } }} /><TextField size="small" type="date" label="Received to (UTC)" value={draft.to} onChange={event => field("to", event.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        </Box><Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}><Button type="submit" variant="contained" sx={touch}>Apply filters</Button><Button onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setUser(null); setPage(1); }} sx={touch}>Reset</Button><Button startIcon={<RefreshCw size={15} />} onClick={() => setRefresh(value => value + 1)} disabled={busy} sx={{ ...touch, ml: "auto" }}>Refresh</Button></Stack>
      </Box>
      {issue ? <Alert severity="error" sx={{ mb: 1 }}>{issue}{data ? " Showing the last successful results." : ""}</Alert> : null}
      <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="space-between" sx={{ mb: 1 }}><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{data ? `${data.total.toLocaleString()} report histories` : "Loading activity…"}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>Last refreshed {activityTime(updated)}</Typography></Stack>
      {busy ? <LinearProgress aria-label="Loading activity" /> : null}
      <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
        <Box sx={{ display: { xs: "none", lg: "grid" }, gridTemplateColumns: "1.1fr 1.5fr 1fr 1.4fr 1.2fr 44px", gap: 1.5, p: 1.5, bgcolor: "action.hover" }}>{["Contract / type", "Report owner", "Last known counts", "Latest action", "Last received", ""].map((title, index) => <Typography key={index} sx={{ fontSize: 11, fontWeight: 700 }}>{title}</Typography>)}</Box>
        {data?.items.map(row => <Box key={row.id} component="button" onClick={() => setSelected(row.id)} aria-label={`View history for contract ${row.contract || "not assigned"}`} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr auto", lg: "1.1fr 1.5fr 1fr 1.4fr 1.2fr 44px" }, width: "100%", gap: 1.5, alignItems: "center", p: 1.5, border: 0, borderTop: "1px solid", borderColor: "divider", bgcolor: "background.paper", color: "text.primary", textAlign: "left", cursor: "pointer", "&:hover": { bgcolor: "action.hover" }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 } }}>
          <Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 700, fontSize: 14, overflowWrap: "anywhere" }}>{row.contract || "No contract yet"}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{row.reportType === "asset" ? "Asset" : "Lot Listing"}{row.deleted ? " · Deleted" : ""}</Typography></Box>
          <Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: 13, overflowWrap: "anywhere" }}>{person(row.owner)}</Typography><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{row.source === "unknown" ? "Source not recorded" : row.source}</Typography><ReportedApp row={row} /></Box>
          <Count value={row.latestCounts} /><Box><Typography sx={{ fontSize: 12, mb: 0.5 }}>{label(row.latestAction)}</Typography><Outcome outcome={activityOutcomeLabel(row.latestAction, row.latestOutcome)} /></Box><Typography sx={{ fontSize: 11, color: "text.secondary" }}>{activityTime(row.lastReceivedAt)}</Typography><ChevronRight size={18} aria-hidden />
        </Box>)}
        {data?.items.length === 0 ? <Box sx={{ p: 3 }}><Typography sx={{ fontWeight: 600 }}>No activity received yet</Typography><Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}>Try different filters. Offline activity appears after the device reconnects and synchronizes.</Typography></Box> : null}
      </Box>
      {data && data.total > 25 ? <Stack direction="row" justifyContent="center" sx={{ mt: 2 }}><Pagination size="small" count={Math.ceil(data.total / 25)} page={page} onChange={(_, value) => setPage(value)} disabled={busy} /></Stack> : null}
    </>}
    {selected ? <ActivityDrawer key={selected} id={selected} close={() => setSelected(null)} removed={() => { setSelected(null); setRefresh(value => value + 1); }} /> : null}
  </Box>;
}
