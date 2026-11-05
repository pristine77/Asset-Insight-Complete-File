"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";

type Recovery = { initialPreviewRetryEligible: boolean; initialPreviewRetryIneligibleReason?: string | null; initialPreviewRetryRevision?: string | null };

export default function InitialPreviewRetryAction({ reportId, disabled, onBusyChange, onAccepted, onReload }: {
  reportId: string; disabled: boolean; onBusyChange: (busy: boolean) => void;
  onAccepted: (message: string) => void; onReload: () => void;
}) {
  const [state, setState] = useState<Recovery | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const active = useRef(false);
  const flight = useRef(false);
  const mutationAbort = useRef<AbortController | null>(null);
  const endpoint = `/api/admin/preview-reports/${encodeURIComponent(reportId)}/retry-preview`;

  useEffect(() => {
    const controller = new AbortController(); active.current = true;
    setState(null); setError(""); setNeedsReview(false);
    fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json(); const value = body?.data;
      if (!response.ok || typeof value?.initialPreviewRetryEligible !== "boolean" ||
        (value.initialPreviewRetryIneligibleReason != null && typeof value.initialPreviewRetryIneligibleReason !== "string") ||
        (value.initialPreviewRetryEligible && !/^[a-f0-9]{64}$/.test(value.initialPreviewRetryRevision || ""))) throw new Error();
      if (!controller.signal.aborted) setState(value);
    }).catch(() => { if (!controller.signal.aborted) setError("Preview recovery could not be checked. Refresh this report before trying again."); });
    return () => { active.current = false; controller.abort(); mutationAbort.current?.abort(); onBusyChange(false); };
  }, [endpoint, onBusyChange]);

  const retry = async () => {
    if (!active.current || flight.current || disabled || needsReview || !state?.initialPreviewRetryEligible || !state.initialPreviewRetryRevision) return;
    flight.current = true; setBusy(true); onBusyChange(true); setError("");
    const controller = new AbortController(); mutationAbort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: state.initialPreviewRetryRevision }), signal: controller.signal });
      const body = await response.json().catch(() => ({})); const receipt = body?.data;
      const ready = receipt?.job_status === "done" && receipt?.preview_available === true;
      if (response.status !== 202 || receipt?.reportId !== reportId || receipt?.retry_stage !== "initial_preview" ||
        (!ready && !["queued", "processing"].includes(receipt?.job_status))) throw new Error(response.status === 409 ? "This report changed. Refresh and review its recovery status." : "Retry could not be confirmed. Processing may already have started. Refresh this report before trying again.");
      if (!active.current || controller.signal.aborted) return;
      setOpen(false);
      onAccepted(ready ? "The preview is ready. Its owner can review it before submitting." : "Preview processing queued on the same report. Its owner must review the preview before submitting.");
    } catch (cause) {
      if (!active.current) return;
      setNeedsReview(true); setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Retry confirmation timed out. Refresh this report before trying again.");
    } finally {
      window.clearTimeout(timer); flight.current = false;
      if (active.current) { setBusy(false); onBusyChange(false); }
    }
  };

  return <>
    {state?.initialPreviewRetryEligible ? <Button variant="contained" disabled={disabled || busy} onClick={() => setOpen(true)}>Retry preview processing</Button> : null}
    {state?.initialPreviewRetryEligible === false ? <Alert severity="info" sx={{ width: "100%" }}>{state.initialPreviewRetryIneligibleReason || "Automatic preview recovery is unavailable. Keep this report and contact support."}</Alert> : null}
    {error && !open ? <Alert severity="warning" sx={{ width: "100%" }}>{error} <Button onClick={onReload}>Refresh recovery status</Button></Alert> : null}
    <Dialog open={open} onClose={() => { if (!flight.current) setOpen(false); }} fullWidth maxWidth="sm" aria-labelledby="initial-preview-retry-title">
      <DialogTitle id="initial-preview-retry-title">Retry preview processing?</DialogTitle>
      <DialogContent dividers>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        <Typography>Use this report’s saved upload to prepare an editable preview on the same report. Its owner must review the preview before submitting. This does not approve, release or send a report to an auction platform.</Typography>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1, p: 2 }}>
        <Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        {needsReview ? <Button variant="contained" onClick={onReload}>Refresh recovery status</Button>
          : <Button variant="contained" disabled={busy || disabled} onClick={() => void retry()}>{busy ? "Starting preview processing…" : "Confirm preview retry"}</Button>}
      </DialogActions>
    </Dialog>
  </>;
}
