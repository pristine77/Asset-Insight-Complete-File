"use client";

import { CalendarDays, ExternalLink, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CrmService, crmErrorMessage, type CrmBulkCalendarResponse, type CrmTaskSummary } from "@/services/crm";
import CrmTaskList from "./CrmTaskList";
import { useCrmOnline, useCrmRead } from "./useCrmRead";
import styles from "./CrmOutlook.module.css";

export default function CrmOutlook({ ownerId, onOpenTask, refreshVersion = 0 }: { ownerId: string; onOpenTask: (id: string) => void; refreshVersion?: number }) {
  const connection = useCrmRead(`crm:outlook:${ownerId}`, (signal) => CrmService.getOutlookCalendarStatus({ signal }));
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState<"connect" | "disconnect" | "export" | null>(null);
  const [authUrl, setAuthUrl] = useState<string>();
  const [error, setError] = useState("");
  const [result, setResult] = useState<CrmBulkCalendarResponse>();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const lock = useRef(false);
  const active = useRef(true);
  const connectController = useRef<AbortController | null>(null);
  const online = useCrmOnline();
  useEffect(() => { active.current = true; return () => { active.current = false; connectController.current?.abort(); }; }, []);
  function toggle(task: CrmTaskSummary) {
    if (lock.current) return;
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(task._id)) next.delete(task._id);
      else if (next.size < 100) next.add(task._id);
      return next;
    });
  }
  function togglePage(tasks: CrmTaskSummary[]) {
    if (lock.current) return;
    setSelected((old) => {
      const next = new Set(old);
      const remove = tasks.every((task) => next.has(task._id));
      for (const task of tasks) {
        if (remove) next.delete(task._id);
        else if (next.size < 100) next.add(task._id);
      }
      return next;
    });
  }
  async function connect() {
    if (lock.current || !online) return;
    lock.current = true; setBusy("connect"); setError("");
    const controller = new AbortController(); connectController.current = controller;
    try {
      const url = await CrmService.getOutlookCalendarAuthUrl({ signal: controller.signal });
      if (active.current) setAuthUrl(url);
    } catch (failure) { if (active.current) setError(crmErrorMessage(failure)); }
    finally { lock.current = false; if (active.current) setBusy(null); }
  }
  async function disconnect() {
    if (lock.current || !online) return;
    lock.current = true; setBusy("disconnect"); setError("");
    try {
      await CrmService.disconnectOutlookCalendar();
      if (!active.current) return;
      setConfirmDisconnect(false); setAuthUrl(undefined); setSelected(new Set()); setResult(undefined);
      await connection.mutate();
    } catch (failure) { if (active.current) setError(`${crmErrorMessage(failure)} Refresh connection status before trying again.`); }
    finally { lock.current = false; if (active.current) setBusy(null); }
  }
  async function exportTasks() {
    if (lock.current || !online || !connection.data?.connected || !selected.size) return;
    lock.current = true; setBusy("export"); setError(""); setResult(undefined);
    const ids = [...selected];
    try {
      const response = await CrmService.addTasksToOutlookCalendarBulk(ids);
      if (!active.current) return;
      setResult(response);
      // Clear the exact attempted selection, including ambiguous/omitted results.
      // An additional export always requires an explicit new selection.
      setSelected(new Set());
      const accounted = new Set([...response.created, ...response.failed, ...(response.pending || [])].map((item) => item.taskId));
      if (ids.some((id) => !accounted.has(id))) setError("Some selected tasks were not returned by the server. Check Outlook and your current task access before exporting them again.");
    } catch (failure) {
      if (active.current) {
        setSelected(new Set());
        setError(`${crmErrorMessage(failure)} The export may have reached Outlook. Check your calendar before selecting and exporting these tasks again.`);
      }
    } finally { lock.current = false; if (active.current) setBusy(null); }
  }
  return <section className={styles.panel} aria-label="Outlook calendar">
    <header className={styles.heading}><div className={styles.intro}><CalendarDays size={23} aria-hidden="true" /><div><h2>Outlook appointments</h2><p>Create calendar events from selected CRM tasks.</p></div></div><button className="app-button app-button--secondary app-button--icon" aria-label="Refresh Outlook connection" disabled={Boolean(busy) || connection.isValidating} onClick={() => void connection.mutate().catch(() => {})}><RefreshCw size={17} /></button></header>
    {connection.error && <div className={styles.error} role="alert">{crmErrorMessage(connection.error)} Refresh to check the connection.</div>}
    {!connection.data && !connection.error && <p role="status">Checking Outlook connection…</p>}
    {connection.data && <div className={styles.connection}><div><strong>{connection.data.connected ? "Connected" : "Not connected"}</strong><span>{connection.data.connected ? connection.data.email || "Microsoft Outlook" : connection.data.configured ? "Connect your Microsoft account to export appointments." : "Outlook integration is not configured. Contact your administrator."}</span></div>{connection.data.connected ? <button className="app-button app-button--secondary" disabled={Boolean(busy) || !online} onClick={() => setConfirmDisconnect(true)}><Unplug size={16} />Disconnect</button> : connection.data.configured && <button className="app-button app-button--primary" disabled={Boolean(busy) || !online} onClick={() => void connect()}>{busy === "connect" ? "Preparing connection…" : "Connect Outlook"}</button>}</div>}
    {authUrl && !connection.data?.connected && <div className={styles.notice}><a className="app-button app-button--primary" href={authUrl} target="_blank" rel="noopener noreferrer">Continue to Microsoft<ExternalLink size={16} /></a><span>Complete sign-in in the new tab, then refresh the connection here.</span></div>}
    {confirmDisconnect && <div className={styles.notice} role="group" aria-label="Confirm Outlook disconnection"><span>Disconnect Outlook? Existing calendar events are not deleted.</span><button className="app-button app-button--danger" disabled={Boolean(busy) || !online} onClick={() => void disconnect()}>{busy === "disconnect" ? "Disconnecting…" : "Confirm disconnect"}</button><button className="app-button app-button--secondary" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(false)}>Keep connected</button></div>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    {result && <div className={styles.results} role="status"><strong>{result.createdCount} confirmed · {result.failedCount} failed{result.pendingCount ? ` · ${result.pendingCount} pending` : ""}</strong>{result.created.map((entry) => entry.webLink && <a key={entry.taskId} href={entry.webLink} target="_blank" rel="noopener noreferrer">Open confirmed event<ExternalLink size={13} /></a>)}{result.failed.map((entry) => <p key={entry.taskId}>Task {entry.taskId}: {entry.reason || "Not exported"}</p>)}{result.pending?.map((entry) => <p key={entry.taskId}>Task {entry.taskId}: {entry.reason} No completed event is confirmed yet.</p>)}</div>}
    {connection.data?.connected && <><div className={styles.exportBar}><div><strong>{selected.size} of 100 tasks selected</strong><p>Selection can span pages and filters. Follow-ups refresh their existing event; other tasks create a new calendar event. Check Outlook before repeating an uncertain export.</p></div><div><button className="app-button app-button--secondary" disabled={!selected.size || Boolean(busy)} onClick={() => setSelected(new Set())}>Clear selection</button><button className="app-button app-button--primary" disabled={!selected.size || Boolean(busy) || !online} onClick={() => void exportTasks()}>{busy === "export" ? "Syncing events…" : "Export selected"}</button></div></div><CrmTaskList ownerId={ownerId} onOpenTask={onOpenTask} refreshVersion={refreshVersion} initialStatus="all" selection={{ ids: selected, disabled: Boolean(busy) || !online, onToggle: toggle, onPage: togglePage }} /></>}
  </section>;
}
