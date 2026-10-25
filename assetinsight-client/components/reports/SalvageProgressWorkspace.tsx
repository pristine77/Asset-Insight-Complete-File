"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, Eye, LoaderCircle, RefreshCw, Square, ArrowLeft } from "lucide-react";
import { SalvageService, salvageHasPreview, salvageIsProcessing, salvagePreviewPath, type SalvageReport } from "@/services/salvage";
import { salvageSystemText } from "@/lib/salvagePresentation";
import styles from "./SalvagePreviewWorkspace.module.css";

const labels: Record<string, string> = { preparing_preview: "Preparing your preview", preview_ready: "Preview ready", generating_files: "Creating report files",
  awaiting_approval: "Awaiting approval", awaiting_release: "Awaiting release", ready: "Report ready", error: "Processing needs attention", stopped: "Processing stopped" };
const message = (cause: unknown, fallback: string) => salvageSystemText((cause as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
  || (cause as Error)?.message, fallback);

/** A durable report status destination. Completion never navigates into the editor. */
export default function SalvageProgressWorkspace({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [report, setReport] = useState<SalvageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const epoch = useRef(0), fetching = useRef(false), mutating = useRef(false);
  const load = useCallback(async () => {
    if (fetching.current || mutating.current) return;
    fetching.current = true; setRefreshing(true);
    const current = epoch.current;
    try {
      const response = await SalvageService.getPreview(reportId);
      if (epoch.current !== current) return;
      setReport(response.data); setError(null); setConflict(false);
    } catch (cause) {
      if (epoch.current === current) setError(message(cause, "Could not refresh progress. Your saved report is still available; reconnect and refresh."));
    } finally {
      if (epoch.current === current) { fetching.current = false; setLoading(false); setRefreshing(false); }
    }
  }, [reportId]);

  useEffect(() => {
    epoch.current += 1; fetching.current = false; mutating.current = false;
    setReport(null); setLoading(true); setBusy(null); setError(null); setNotice(null); setConflict(false);
    void load();
    return () => { epoch.current += 1; };
  }, [load]);
  const processing = report ? salvageIsProcessing(report) : false;
  useEffect(() => {
    const refresh = () => { if (!document.hidden && navigator.onLine !== false) void load(); };
    const timer = window.setInterval(refresh, processing ? 5000 : 30000);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, processing]);

  const run = async (action: "cancel" | "retry") => {
    if (!report || mutating.current || fetching.current || conflict || !Number.isInteger(report.revision)) return;
    if (action === "cancel" && (!report.can_cancel || !report.job_id || !processing)) return;
    if (action === "retry" && !["error", "cancelled"].includes(report.status)) return;
    if (!window.confirm(action === "cancel"
      ? "Stop this report's current processing? Saved photos and edits are kept. Work already sent for processing may still finish and incur charges, but this stopped run will not publish files. You can edit an available preview or resume this report later."
      : "Resume processing this saved report? Completed work is reused where available. Remaining assessment work may incur charges. This does not create another report or re-upload your photos.")) return;
    mutating.current = true; setBusy(action); setError(null); setNotice(null);
    const current = ++epoch.current;
    try {
      const response = action === "cancel" ? await SalvageService.cancel(reportId, report.revision, report.job_id!)
        : await SalvageService.retry(reportId, report.revision);
      if (epoch.current !== current) return;
      setReport(response.data);
      setNotice(action === "cancel" ? "Processing stopped. Your saved photos and edits have been kept." : "Processing resumed on this report. You can leave and return to this progress page.");
      window.dispatchEvent(new Event("cv:report-created"));
    } catch (cause) {
      if (epoch.current !== current) return;
      const code = (cause as { response?: { data?: { code?: string } } })?.response?.data?.code;
      const changed = code === "SALVAGE_REVISION_CONFLICT" || code === "SALVAGE_GENERATION_CONFLICT";
      setConflict(changed);
      setError(changed ? "This report changed on another device. Refresh to see the current run before trying again."
        : message(cause, "The request could not be confirmed. Refresh progress before trying again."));
    } finally {
      if (epoch.current === current) { mutating.current = false; setBusy(null); }
    }
  };
  const openable = Boolean(report && !processing && salvageHasPreview(report));
  const stopped = report?.status === "cancelled" || report?.workflow_stage === "stopped";
  const failed = report?.status === "error" || report?.generation_state === "error";
  const stage = report ? labels[report.workflow_stage || ""] || (processing ? "Report processing" : stopped ? "Processing stopped" : "Report status") : "Loading report";
  const steps = report?.workflow_steps?.length ? report.workflow_steps : report ? [{ key: report.workflow_stage || "report", label: stage,
    status: processing ? "active" as const : stopped ? "cancelled" as const : failed ? "error" as const : ["awaiting_approval", "awaiting_release"].includes(report.workflow_stage || "") ? "pending" as const : "completed" as const }] : [];

  return <main className={`${styles.page} ${styles.progressPage}`} aria-label="Salvage report progress">
    <header className={styles.header}><div><h1>Salvage report progress</h1><p className={styles.muted}>{report?.file_number || "Saved report"}</p></div>
      <div className={styles.actions}><button type="button" className="app-button" disabled={Boolean(busy)} onClick={() => router.push("/reports")}><ArrowLeft className="size-4" /> Reports</button>
        <button type="button" className="app-button" disabled={Boolean(busy) || refreshing} onClick={() => void load()}><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh progress</button></div></header>
    {error ? <p role="alert" className={`${styles.notice} ${styles.error}`}>{error}</p> : null}
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    {loading ? <p role="status" className={styles.notice}>Loading saved report progress…</p> : report ? <>
      <section className={styles.section} aria-label="Processing status"><div className={styles.sectionHeading}><h2 aria-live="polite">{stage}</h2><span className={styles.muted}>Saved revision {report.revision}</span></div>
        <p className={styles.muted}>{salvageSystemText(report.workflow_message, processing ? "You can leave this page safely. Processing continues on your saved report; return here to check each step." : stopped ? "No new work will start for this stopped run. Continue from the saved report when ready." : "Open the preview when you are ready to review. It will not open automatically.")}</p>
        {processing ? <progress className={styles.progress} aria-label="Salvage processing progress" max={100} value={Math.max(0, Math.min(100, Number(report.workflow_progress_percent) || 0))} /> : null}
        <ol className={styles.processingSteps} aria-label="Report processing steps">{steps.map((step) => <li key={step.key} data-state={step.status}>
          {step.status === "completed" ? <CheckCircle2 className="size-5" aria-hidden /> : step.status === "active" ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : <Circle className="size-5" aria-hidden />}
          <span>{salvageSystemText(step.label)}<small>{({ pending: "Waiting", active: "In progress", completed: "Complete", error: "Needs attention", cancelled: "Stopped" })[step.status]}</small></span>
        </li>)}</ol>
        {failed ? <p className={`${styles.notice} ${styles.error}`}>{salvageSystemText(report.job_error, "Processing could not finish. Review your saved progress and resume when ready.")}</p> : null}
        {stopped && !openable ? <p className={styles.muted}>The first preview was not completed. Resume processing to finish the preview from your saved photos; no re-upload is needed.</p> : null}
      </section>
      <section className={styles.section}><div className={styles.actions}>
        <button type="button" className="app-button app-button--primary" disabled={!openable || Boolean(busy) || refreshing} onClick={() => router.push(salvagePreviewPath(reportId))}><Eye className="size-4" /> Open preview</button>
        {processing && report.can_cancel ? <button type="button" className="app-button" disabled={Boolean(busy) || refreshing || conflict || !report.job_id} onClick={() => void run("cancel")}><Square className="size-4" /> {busy === "cancel" ? "Stopping…" : "Stop processing"}</button> : null}
        {(stopped || failed) ? <button type="button" className="app-button" disabled={Boolean(busy) || refreshing || conflict} onClick={() => void run("retry")}><RefreshCw className="size-4" /> {busy === "retry" ? "Resuming…" : "Resume processing"}</button> : null}
      </div><p className={`${styles.muted} mt-3`}>{processing ? "To edit an existing preview, stop the current run first. Saved originals and edits remain attached to this report." : "Open preview to review and edit. Save changes, then submit to create updated files. Approval is a separate step."}</p></section>
    </> : null}
  </main>;
}
