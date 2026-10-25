"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { parseYouTubeCallback, finishYouTubeConnection, type YouTubeCallback as CallbackData } from "@/lib/youtube";

export default function YouTubeCallback() {
  const credentials = useRef<CallbackData | null>(null);
  const initialized = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [channel, setChannel] = useState("");
  useEffect(() => {
    mounted.current = true;
    if (!initialized.current) {
      initialized.current = true;
      const search = window.location.search;
      // Remove authorization data before any interaction, logging or navigation.
      window.history.replaceState(window.history.state, "", "/youtube/callback");
      try { credentials.current = parseYouTubeCallback(search); setReady(true); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Start again from YouTube settings."); }
    }
    return () => { mounted.current = false; requestController.current?.abort(); };
  }, []);
  async function complete() {
    if (inFlight.current || !credentials.current) return;
    inFlight.current = true; setBusy(true); setReady(false);
    const input = credentials.current;
    credentials.current = null;
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const status = await finishYouTubeConnection(input, fetch, controller.signal);
      if (mounted.current) setChannel(status.channel!.title);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "The connection response timed out. Check the status in settings before starting again.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <Box component="main" sx={{ p: 2, minHeight: "100dvh", display: "grid", placeItems: "center" }}>
    <Paper sx={{ p: { xs: 2, sm: 3 }, width: "100%", maxWidth: 520 }}>
      <Stack gap={2}>
        <Typography component="h1" variant="h5" fontWeight={700}>Connect YouTube</Typography>
        {error ? <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>{error}</Alert> : channel ? <Alert severity="success">Connected to {channel}. Eligible report videos publish to Public automatically after report release, with no separate video review.</Alert> : <Typography color="text.secondary">Finish connecting the channel you selected with Google. Eligible submitted videos already in the queue may resume automatically. Connecting does not create uploads for historical reports.</Typography>}
        {ready || busy ? <Button variant="contained" sx={{ bgcolor: "primary.dark" }} disabled={!ready || busy} onClick={() => void complete()}>{busy ? "Confirming connection…" : "Finish connecting"}</Button> : null}
        <Button component={Link} href="/youtube" color="inherit" variant="outlined" disabled={busy}>Return to YouTube settings</Button>
      </Stack>
    </Paper>
  </Box>;
}
