"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, FormControlLabel, Link, Paper, Stack, Typography } from "@mui/material";
import { ExternalLink, Link2, RefreshCw, Unlink, Video } from "lucide-react";
import { parseYouTubeAuthorization, parseYouTubeStatus, type YouTubeStatus } from "@/lib/youtube";
import YouTubeVideos from "@/app/components/youtube/YouTubeVideos";

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "The connection could not be confirmed.";
    throw new Error(response.status === 401 ? "Your admin session expired. Sign in again, then restart the connection." : message);
  }
  return body;
}

export default function YouTubeSettings() {
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseConfirmed, setEraseConfirmed] = useState(false);
  const [acknowledgeOpen, setAcknowledgeOpen] = useState(false);
  const [acknowledgeConfirmed, setAcknowledgeConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true); setFresh(false); setError("");
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await responseBody(await fetch("/api/admin/youtube/status", { cache: "no-store", signal: controller.signal }));
      if (read.current !== controller || !mounted.current) return;
      setStatus(parseYouTubeStatus(result)); setFresh(true); setCheckedAt(new Date());
    } catch (cause) {
      if (read.current === controller && mounted.current) setError(controller.signal.aborted ? "The connection check timed out. Refresh to try again." : cause instanceof Error ? cause.message : "The connection could not be loaded.");
    } finally {
      window.clearTimeout(timer);
      if (read.current === controller && mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; read.current?.abort(); read.current = null; };
  }, [refresh]);

  async function connect() {
    if (mutation.current || !fresh || !status?.configured || !status.canConnect || !consent) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const body = await responseBody(await fetch("/api/admin/youtube/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policyConsent: true }), signal: AbortSignal.timeout(30_000) }));
      const target = parseYouTubeAuthorization(body, window.location.origin);
      if (mounted.current) window.location.assign(target.authorizationUrl);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "The connection request could not be confirmed. Refresh the status before trying again."); setFresh(false); setConsent(false); }
    } finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }

  async function disconnect() {
    if (mutation.current || !fresh || !status?.connected) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const body = await responseBody(await fetch("/api/admin/youtube/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: status.revision }), signal: AbortSignal.timeout(30_000) }));
      const next = parseYouTubeStatus(body);
      if (mounted.current) { setStatus(next); setCheckedAt(new Date()); setConsent(false); setNotice("Channel disconnected. Existing YouTube videos and report originals have not been deleted."); }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Disconnection could not be confirmed. Refresh the status before trying again."); setFresh(false); }
    } finally { mutation.current = false; if (mounted.current) { setBusy(false); setDisconnectOpen(false); } }
  }

  async function eraseData() {
    if (mutation.current || !fresh || !status || !eraseConfirmed) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const body = await responseBody(await fetch("/api/admin/youtube/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: status.revision, confirm: true }), signal: AbortSignal.timeout(30_000) }));
      const next = parseYouTubeStatus(body);
      if (mounted.current) { setStatus(next); setCheckedAt(new Date()); setConsent(false); setNotice("Removal requested. Refresh to confirm data removal and Google revocation separately. Existing YouTube videos and original report media are unchanged."); }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Removal could not be confirmed. Refresh before trying again."); setFresh(false); }
    } finally { mutation.current = false; if (mounted.current) { setBusy(false); setEraseOpen(false); setEraseConfirmed(false); } }
  }

  async function acknowledgeRevocation() {
    if (mutation.current || !fresh || !status || !status.canAcknowledgeRevocation || status.revocation.status !== "needs_attention" || !acknowledgeConfirmed) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const body = await responseBody(await fetch("/api/admin/youtube/acknowledge-revocation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: status.revision, confirm: true }), signal: AbortSignal.timeout(30_000) }));
      const next = parseYouTubeStatus(body);
      if (mounted.current) { setStatus(next); setCheckedAt(new Date()); setConsent(false); setNotice("Your confirmation of removal in Google Account settings was recorded. This is administrator confirmation, not a Google-verified revocation response."); }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Your confirmation could not be recorded. Refresh before trying again."); setFresh(false); }
    } finally { mutation.current = false; if (mounted.current) { setBusy(false); setAcknowledgeOpen(false); setAcknowledgeConfirmed(false); } }
  }

  return <Box component="main" sx={{ p: { xs: 2, md: 3 }, maxWidth: 1120, mx: "auto", width: "100%" }}>
    <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" gap={1.5} mb={2}>
      <Box><Typography component="h1" variant="h5" fontWeight={700} display="flex" alignItems="center" gap={1}><Video size={24} aria-hidden />YouTube Videos</Typography><Typography color="text.secondary" variant="body2" mt={0.5}>Connect one channel for Asset and Lot Listing videos.</Typography></Box>
      <Button variant="outlined" startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshCw size={16} />} disabled={loading || busy} onClick={() => void refresh()}>Refresh status</Button>
    </Stack>
    <Stack gap={2}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }} aria-busy={loading || busy}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap" mb={1.5}>
          <Typography component="h2" variant="h6" fontSize={18}>Channel connection</Typography>
          <Chip size="small" variant="outlined" sx={{ color: "text.primary" }} color={fresh && status?.connected ? "success" : "default"} label={loading ? "Checking" : !fresh ? "Status unavailable" : status?.connected ? "Connected" : status?.configured ? "Not connected" : "Setup required"} />
        </Stack>
        {loading && !status ? <Typography color="text.secondary" role="status">Checking the channel configuration…</Typography> : null}
        {status?.channel ? <Box sx={{ overflowWrap: "anywhere" }}><Typography fontWeight={650}>{status.channel.title}</Typography><Link color="inherit" href={status.channel.url} target="_blank" rel="noopener noreferrer" sx={{ display: "inline-flex", gap: 0.5, alignItems: "center", my: 0.5 }}>View YouTube channel <ExternalLink size={14} /></Link><Typography color="text.secondary" variant="caption" display="block">Channel ID: {status.channel.id}</Typography></Box> : <Typography color="text.secondary" variant="body2">An authorized channel owner must approve access through Google. No Google password or token is stored in this browser.</Typography>}
        {status && !status.configured ? <Alert severity="info" sx={{ mt: 2 }}><Typography variant="body2" fontWeight={600}>Google setup is required on the backend</Typography><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{status.configurationIssue || "Ask your server administrator to configure the YouTube OAuth client, callback URL and encrypted credential storage."}</Typography><Typography variant="body2" mt={0.5}>Callback path: /youtube/callback</Typography></Alert> : null}
        {status?.needsReconnect ? <Alert severity="warning" sx={{ mt: 2 }}>Google access needs to be renewed. Review the removal and revocation status below before connecting again. Existing videos will not be deleted.</Alert> : null}
        {status && (status.dataCleanup.status !== "not_requested" || status.revocation.status !== "not_requested") ? <Alert severity={status.dataCleanup.status === "completed" && status.revocation.status === "completed" ? "success" : "info"} sx={{ mt: 2 }}>
          <Typography variant="body2">Stored YouTube data: {status.dataCleanup.status === "completed" ? "Removed" : status.dataCleanup.status === "pending" ? "Removal pending" : "No removal requested"}.</Typography>
          <Typography variant="body2">Google access: {({ not_requested: "Revocation not requested", pending: "Revocation pending", completed: "Revoked", unavailable: "Cannot confirm revocation; remove access in your Google account", needs_attention: "Revocation needs attention; remove access in your Google account", manually_confirmed: "Removal manually confirmed by an administrator; not verified by Google" })[status.revocation.status]}.</Typography>
          {status.dataCleanup.completedAt ? <Typography variant="caption" display="block">Data removal confirmed {new Date(status.dataCleanup.completedAt).toLocaleString()}</Typography> : null}
          {status.revocation.manuallyConfirmedAt ? <Typography variant="caption" display="block">Administrator confirmation recorded {new Date(status.revocation.manuallyConfirmedAt).toLocaleString()}</Typography> : null}
          {!status.canConnect ? <Typography variant="caption">Connection is unavailable until pending privacy actions are resolved.</Typography> : null}
        </Alert> : null}
        {status?.configured && !status.connected ? <Box mt={2}>
          <FormControlLabel sx={{ alignItems: "flex-start", ml: -1, mr: 0 }} control={<Checkbox checked={consent} disabled={!fresh || busy || !status.canConnect} onChange={event => setConsent(event.target.checked)} />} label={<Typography variant="body2" pt={1}>I am authorized to connect this shared channel for Asset Insight administrators (admin and superadmin) and authorize automatic public publication of eligible Asset and Lot Listing videos after report release, without a separate per-video review. Viewers can watch, search for and share these videos and their published title and description. I agree to the <Link href="https://assetinsightvaluator.com/terms/youtube" target="_blank" rel="noopener noreferrer">YouTube integration terms</Link>, <Link href="https://assetinsightvaluator.com/privacy#youtube-privacy" target="_blank" rel="noopener noreferrer">privacy policy</Link> and <Link href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</Link>.</Typography>} />
          <Button sx={{ mt: 1, bgcolor: "primary.dark" }} variant="contained" startIcon={<Link2 size={16} />} disabled={!fresh || !consent || !status.canConnect || busy} onClick={() => void connect()}>{busy ? "Opening Google…" : "Connect with Google"}</Button>
          {!status.canConnect && status.dataCleanup.status === "not_requested" && status.revocation.status === "not_requested" ? <Typography variant="caption" color="text.secondary" display="block" mt={1}>The server has not enabled a new connection. Refresh after backend support is ready.</Typography> : null}
        </Box> : null}
        {status ? <Stack mt={2} direction={{ xs: "column", sm: "row" }} gap={1} alignItems={{ sm: "center" }}><Button color="inherit" variant="outlined" disabled={!fresh || busy || status.dataCleanup.status === "pending" || ["pending", "needs_attention"].includes(status.revocation.status)} onClick={() => { setEraseConfirmed(false); setEraseOpen(true); }}>Revoke access &amp; remove stored YouTube data</Button>{status.connected ? <Button size="small" color="inherit" startIcon={<Unlink size={15} />} disabled={!fresh || busy} onClick={() => setDisconnectOpen(true)}>Disconnect locally only</Button> : null}</Stack> : null}
        {status?.canAcknowledgeRevocation && status.revocation.status === "needs_attention" ? <Button color="inherit" variant="outlined" sx={{ mt: 1 }} disabled={!fresh || busy || status.dataCleanup.status !== "completed"} onClick={() => { setAcknowledgeConfirmed(false); setAcknowledgeOpen(true); }}>Confirm removal in Google Account settings</Button> : null}
        <Stack mt={2} direction={{ xs: "column", sm: "row" }} gap={1.5}><Link color="inherit" href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer" fontSize={14}>Google account access controls</Link><Link color="inherit" href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer" fontSize={14}>Manage videos in YouTube Studio</Link></Stack>
        <Typography color="text.secondary" variant="caption" display="block" mt={2}>Last checked: {checkedAt ? checkedAt.toLocaleString() : "Not yet checked"}{!fresh && checkedAt ? " · Previous snapshot; refresh before making changes." : ""}</Typography>
      </Paper>
      <YouTubeVideos connectionRevision={status?.revision ?? 0} connectionReady={fresh && Boolean(status?.connected) && !status?.needsReconnect && !busy} />
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Typography component="h2" variant="h6" fontSize={18} mb={1.5}>Publication and report files</Typography>
        <Stack gap={1.5} divider={<Divider />}>
          <Box><Typography variant="body2" fontWeight={650}>Automatic public publication</Typography><Typography variant="body2" color="text.secondary">Eligible Asset and Lot Listing videos publish to the connected channel automatically after the report’s existing approval and release rules are satisfied. No separate video review is required. Videos are not labelled Public until YouTube confirms their visibility.</Typography></Box>
          <Box><Typography variant="body2" fontWeight={650}>Report files do not wait for YouTube</Typography><Typography variant="body2" color="text.secondary">Original videos remain in R2 storage and the media ZIP. Confirmed public and unlisted links are available in Video publication above. Excel keeps its original column layout without a YouTube column. Video publication never regenerates report files automatically.</Typography></Box>
          <Box><Typography variant="body2" fontWeight={650}>Existing queue and original media</Typography><Typography variant="body2" color="text.secondary">Eligible submitted videos already in the queue may resume automatically. Connecting does not create uploads for historical reports. Disconnecting stops new publishing work; it does not remove videos already on YouTube or delete any report media.</Typography></Box>
        </Stack>
      </Paper>
      <Alert severity="info"><Typography variant="body2" fontWeight={650}>YouTube confirms publication</Typography><Typography variant="body2">Publication depends on channel authorization, video processing and a confirmed visibility response from YouTube. Automatic Public is the requested visibility; it does not confirm that the video is public.</Typography><Link href="https://developers.google.com/youtube/v3/docs/videos/insert" target="_blank" rel="noopener noreferrer" sx={{ fontSize: 14 }}>Read Google’s upload requirements</Link></Alert>
    </Stack>
    <Dialog open={disconnectOpen} onClose={() => { if (!busy) setDisconnectOpen(false); }} fullWidth maxWidth="xs" aria-labelledby="youtube-disconnect-title">
      <DialogTitle id="youtube-disconnect-title">Disconnect this channel?</DialogTitle>
      <DialogContent><DialogContentText>New uploading and publishing work will stop and local connection tokens will be cleared. This does not revoke the Google account grant or remove stored YouTube history. Use “Revoke access &amp; remove stored YouTube data” for that. Existing YouTube videos, R2 originals and report ZIP files will not be deleted.</DialogContentText></DialogContent>
      <DialogActions><Button color="inherit" disabled={busy} onClick={() => setDisconnectOpen(false)}>Cancel</Button><Button variant="contained" sx={{ bgcolor: "primary.dark" }} disabled={busy || !fresh} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Confirm disconnect"}</Button></DialogActions>
    </Dialog>
    <Dialog open={eraseOpen} onClose={() => { if (!busy) setEraseOpen(false); }} fullWidth maxWidth="sm" aria-labelledby="youtube-erase-title">
      <DialogTitle id="youtube-erase-title">Revoke Google access and remove stored YouTube data?</DialogTitle>
      <DialogContent><Stack gap={2}><DialogContentText>This stops new uploading and publishing work, requests revocation of this application’s Google access, and removes its stored YouTube channel, tokens and video metadata. Minimal removal records prevent delayed work from restoring deleted data.</DialogContentText><Alert severity="warning">Videos already uploaded to YouTube are not deleted or made private. Report records, original media in R2, ZIPs and previously generated report files are not changed. Manage remote videos in YouTube Studio.</Alert><FormControlLabel sx={{ alignItems: "flex-start", ml: -1, mr: 0 }} control={<Checkbox checked={eraseConfirmed} disabled={busy} onChange={event => setEraseConfirmed(event.target.checked)} />} label={<Typography variant="body2" pt={1}>I understand this removes stored YouTube integration data and revokes access, but does not remove videos from YouTube or change existing reports.</Typography>} /></Stack></DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}><Button color="inherit" disabled={busy} onClick={() => setEraseOpen(false)}>Cancel</Button><Button variant="contained" sx={{ bgcolor: "primary.dark" }} disabled={busy || !fresh || !eraseConfirmed} onClick={() => void eraseData()}>{busy ? "Requesting removal…" : "Revoke & remove stored data"}</Button></DialogActions>
    </Dialog>
    <Dialog open={acknowledgeOpen} onClose={() => { if (!busy) setAcknowledgeOpen(false); }} fullWidth maxWidth="sm" aria-labelledby="youtube-acknowledge-title">
      <DialogTitle id="youtube-acknowledge-title">Confirm access was removed in Google?</DialogTitle>
      <DialogContent><Stack gap={2}><DialogContentText>First open Google Account settings for the connected channel owner and remove Asset Insight’s access. This application cannot verify that action automatically. Confirm only after it is complete.</DialogContentText><Link href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Open Google Account access controls</Link><Alert severity="warning">This records your confirmation in an administrator audit record. It does not call Google to revoke access, delete videos or change report files.</Alert><FormControlLabel sx={{ alignItems: "flex-start", ml: -1, mr: 0 }} control={<Checkbox checked={acknowledgeConfirmed} disabled={busy} onChange={event => setAcknowledgeConfirmed(event.target.checked)} />} label={<Typography variant="body2" pt={1}>I removed Asset Insight access in Google Account settings for the connected channel owner.</Typography>} /></Stack></DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}><Button color="inherit" disabled={busy} onClick={() => setAcknowledgeOpen(false)}>Cancel</Button><Button variant="contained" sx={{ bgcolor: "primary.dark" }} disabled={busy || !fresh || !acknowledgeConfirmed} onClick={() => void acknowledgeRevocation()}>{busy ? "Recording confirmation…" : "Record my confirmation"}</Button></DialogActions>
    </Dialog>
  </Box>;
}
