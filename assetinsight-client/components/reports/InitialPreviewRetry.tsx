"use client";

import { useEffect, useRef, useState } from "react";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import { getInitialPreviewRetry, retryInitialPreview, type InitialPreviewKind, type InitialPreviewRetryState } from "@/services/initialPreviewRetry";

export default function InitialPreviewRetry({ reportId, kind, onQueued }: {
  reportId: string; kind: InitialPreviewKind; onQueued: () => void;
}) {
  const [state, setState] = useState<InitialPreviewRetryState | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState("");
  const [reload, setReload] = useState(0);
  const flight = useRef(false);
  const current = useRef<(() => boolean) | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const session = captureAuthSession();
    const valid = () => !controller.signal.aborted && isAuthSessionCurrent(session);
    current.current = valid;
    setState(null); setChecking(true); setError(""); setAccepted(""); setBusy(false);
    getInitialPreviewRetry(kind, reportId, controller.signal).then(value => {
      if (valid()) setState(value);
    }).catch(() => {
      if (valid()) setError("Retry availability could not be checked. Keep this report and check again.");
    }).finally(() => { if (valid()) setChecking(false); });
    return () => { controller.abort(); mutationAbort.current?.abort(); };
  }, [kind, reportId, reload]);

  const retry = async () => {
    const valid = current.current;
    if (!valid?.() || flight.current || !state?.initialPreviewRetryEligible || !state.initialPreviewRetryRevision) return;
    flight.current = true; setBusy(true); setError("");
    const controller = new AbortController(); mutationAbort.current = controller;
    try {
      const result = await retryInitialPreview(kind, reportId, state.initialPreviewRetryRevision, controller.signal);
      if (!valid()) return;
      setState(null);
      setAccepted(result === "ready" ? "The preview is ready. Refresh and review it before submitting." : "Preview processing queued on this report. Review the preview before submitting.");
      onQueued();
    } catch (cause) {
      if (!valid()) return;
      setState(null);
      const status = (cause as { response?: { status?: number } })?.response?.status;
      setError(status === 409 ? "This report changed. Refresh it before retrying."
        : status === 401 || status === 403 ? "Your session or access changed. Sign in again and refresh this report."
        : "Retry could not be confirmed. Processing may already have started. Refresh this report before trying again.");
    } finally {
      flight.current = false;
      if (valid()) setBusy(false);
    }
  };

  return <div className="mt-2" data-testid="initial-preview-retry">
    {checking ? <p role="status">Checking preview recovery…</p> : null}
    {accepted ? <p role="status">{accepted}</p> : null}
    {error ? <><p role="alert">{error}</p><button type="button" className="mt-2 underline" onClick={() => { onQueued(); setReload(value => value + 1); }}>Refresh recovery status</button></> : null}
    {state?.initialPreviewRetryEligible ? <>
      <p>Use this report’s saved upload to prepare its preview. Review it before submitting.</p>
      <button type="button" className="app-button app-button--primary mt-2" disabled={busy} onClick={() => void retry()}>{busy ? "Starting preview processing…" : "Retry preview processing"}</button>
    </> : !checking && !error && !accepted ? <p>{state?.initialPreviewRetryIneligibleReason || "Automatic recovery is unavailable. Keep this report and contact support to check its uploaded photos."}</p> : null}
  </div>;
}
