"use client";

import { ArrowLeft, ArrowRightLeft, Calendar, Mail, Paperclip, Phone, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import BottomDrawer from "@/components/BottomDrawer";
import CrmService, { CRM_LOST_REASONS, CRM_LOST_REASON_LABELS, CRM_MAX_ATTACHMENT_BYTES, CRM_MAX_ATTACHMENTS, CRM_SPECIALIZATION_OPTIONS, CRM_STATUSES, CRM_STATUS_LABELS, crmErrorMessage, crmStatusChange, isCrmId, safeCrmUrl, type CrmLostReason, type CrmTaskItem, type CrmTaskStatus } from "@/services/crm";
import CrmContactDetails from "./CrmContactDetails";
import CrmEmailComposer from "./CrmEmailComposer";
import CrmTaskHistory from "./CrmTaskHistory";
import CrmVoiceControls from "./CrmVoiceControls";
import { crmDate, crmPersonLabel, crmPhoneOptions, crmReminderText, type CrmDetailUser } from "./crmDetailHelpers";
import { useCrmVoiceInput } from "./useCrmVoiceInput";
import { useCrmOnline, useCrmRead } from "./useCrmRead";
import { crmMutationOutcomeUnknown } from "./crmAuxiliaryHelpers";
import styles from "./CrmTaskDetail.module.css";

export type CrmTaskDetailProps = {
  taskId: string;
  ownerId: string;
  user: CrmDetailUser;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
};
type Draft = { comment: string; status?: CrmTaskStatus; lostReason?: CrmLostReason; attachments: File[]; recording: File | null };
const emptyDraft = (): Draft => ({ comment: "", attachments: [], recording: null });

export default function CrmTaskDetail(props: CrmTaskDetailProps) {
  return <TaskDetailSession key={`${props.ownerId}:${props.taskId}`} {...props} />;
}

function TaskDetailSession({ taskId, ownerId, user, onClose, onChanged }: CrmTaskDetailProps) {
  const [tab, setTab] = useState<"activity" | "details">("activity");
  const [view, setView] = useState<"task" | "email" | "transfer">("task");
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPhones, setShowPhones] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [calendarLink, setCalendarLink] = useState<string | undefined>();
  const [calendarExported, setCalendarExported] = useState(false);
  const [calendarPending, setCalendarPending] = useState(false);
  const [emailDirty, setEmailDirty] = useState(false);
  const [historyDirty, setHistoryDirty] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<"close" | "task" | "email" | "transfer" | "activity" | "details" | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const readers = useRef(new Set<AbortController>());
  const attachmentsInput = useRef<HTMLInputElement>(null);
  const recordingInput = useRef<HTMLInputElement>(null);
  const { mutate: mutateCache } = useSWRConfig();
  const online = useCrmOnline();
  const valid = Boolean(ownerId && isCrmId(taskId));
  const voice = useCrmVoiceInput({
    transcribe: (audio, signal) => CrmService.transcribeCommentAudio({ audio }, { signal }),
    onText: (text) => setDraft((current) => ({ ...current, comment: current.comment.trim() ? `${current.comment}\n${text}` : text })),
  });

  useEffect(() => {
    mounted.current = true;
    const activeReaders = readers.current;
    return () => { mounted.current = false; activeReaders.forEach((controller) => controller.abort()); activeReaders.clear(); };
  }, []);

  const read = useCallback(async <T,>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    readers.current.add(controller);
    try { return await action(controller.signal); }
    finally { readers.current.delete(controller); }
  }, []);

  const taskQuery = useCrmRead(valid ? `crm:${ownerId}:task:${taskId}` : null, (signal) => CrmService.getTask(taskId, { signal }));
  const historyPrefix = `crm:${ownerId}:task-history:${taskId}:`;
  const historyQuery = useCrmRead(valid && view === "task" && tab === "activity" ? `${historyPrefix}${page}` : null,
    (signal) => CrmService.getTaskUpdates(taskId, { page, limit: 20 }, { signal }));
  const agentsQuery = useCrmRead(valid && view === "transfer" ? `crm:${ownerId}:transfer-agents` : null,
    (signal) => CrmService.listTransferAgents({ signal }));
  const accessFailure = (taskQuery.error as { response?: { status?: number } } | undefined)?.response?.status;
  const historyFailure = (historyQuery.error as { response?: { status?: number } } | undefined)?.response?.status;
  const historyDenied = historyFailure === 401 || historyFailure === 403 || historyFailure === 404;
  const task = accessFailure === 401 || accessFailure === 403 || accessFailure === 404 || historyDenied ? undefined : taskQuery.data;
  const status = draft.status || task?.status || "new_lead";
  const lostReason = draft.lostReason ?? task?.lostReason;
  const phones = task ? crmPhoneOptions(task) : [];
  const taskDirty = Boolean(voice.busy || draft.comment || draft.attachments.length || draft.recording || (draft.status && draft.status !== task?.status) || (draft.lostReason && draft.lostReason !== task?.lostReason));
  const transferDirty = Boolean(agentId || transferNote);

  useEffect(() => { if (!online) voice.cancel(); }, [online]);

  async function runAction<T>(action: () => Promise<T>, accept: (result: T) => void | Promise<void>) {
    if (locked.current || !mounted.current) return false;
    if (!online) { setError("You're offline. Reconnect before making changes."); return false; }
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setUncertain(false);
    try {
      let result: T;
      try { result = await action(); }
      catch (cause) {
        if (mounted.current) { setError(crmErrorMessage(cause)); setUncertain(crmMutationOutcomeUnknown(cause)); }
        return false;
      }
      if (!mounted.current) return false;
      await accept(result);
      return true;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function mutateTask(message: string, action: () => Promise<CrmTaskItem>) {
    return runAction(action, async (item) => {
      const { updates, ...detail } = item;
      setNotice(message);
      await taskQuery.mutate({ value: { ...detail, updateCount: updates?.length ?? detail.updateCount }, receivedAt: Date.now() }, { revalidate: false });
      if (!mounted.current) return;
      // All cached history pages belong to this exact owner and task. A refresh
      // failure cannot turn an accepted mutation into a request to retry it.
      await Promise.allSettled([
        mutateCache((key) => typeof key === "string" && key.startsWith(historyPrefix), undefined, { revalidate: true }),
        Promise.resolve().then(onChanged),
      ]);
    });
  }

  async function saveUpdate() {
    if (!task || voice.busy || locked.current) return;
    if (status === "lost" && !lostReason) { setError("Select a reason before marking this task as Lost."); return; }
    const accepted = await mutateTask("Update saved.", () => CrmService.submitTaskUpdate(taskId, {
      comment: draft.comment,
      ...crmStatusChange(task.status, status, lostReason),
      ...(status === "lost" && lostReason !== task.lostReason ? { lostReason } : {}),
      attachments: draft.attachments, recording: draft.recording,
    }));
    if (accepted && mounted.current) { setDraft(emptyDraft()); setPage(1); }
  }

  function addFiles(files: File[], recording = false) {
    if (!files.length) return;
    if (files.some((file) => !file.size || file.size > CRM_MAX_ATTACHMENT_BYTES)) { setError("Choose nonempty files no larger than 50 MiB each."); return; }
    if (!recording && draft.attachments.length + files.length > CRM_MAX_ATTACHMENTS) { setError("You can attach up to 10 files to one update."); return; }
    setError("");
    setDraft((current) => recording ? { ...current, recording: files[0] } : { ...current, attachments: [...current.attachments, ...files] });
  }

  async function exportCalendar() {
    if (calendarExported || calendarPending) return;
    await runAction(async () => {
      const connection = await read((signal) => CrmService.getOutlookCalendarStatus({ signal }));
      if (!mounted.current) throw new DOMException("Task closed", "AbortError");
      if (!connection.connected) throw new Error("Connect Outlook from the CRM Outlook tab before adding this task.");
      try { return await CrmService.addTaskToOutlookCalendar(taskId); }
      catch (cause) {
        const responseStatus = (cause as { response?: { status?: number } })?.response?.status;
        if (!responseStatus || responseStatus >= 500) throw new Error(`${crmErrorMessage(cause)} Check Outlook before trying again; an event may already have been created.`);
        throw cause;
      }
    }, (result) => {
      if ("pending" in result && result.pending) {
        setCalendarPending(true);
        setCalendarLink(undefined);
        setNotice(result.message);
        return;
      }
      setCalendarExported(true);
      setCalendarLink(safeCrmUrl(result.webLink));
      setNotice("Task added to Outlook.");
    });
  }

  function changeView(next: typeof view) {
    voice.cancel();
    setEmailDirty(false);
    setView(next);
    setError("");
    setShowPhones(false);
  }

  function showView(next: typeof view) {
    if (locked.current) return;
    if (next === view) return;
    if ((view === "email" && emailDirty) || (view === "transfer" && transferDirty) || (view === "task" && (historyDirty || voice.busy))) { setDiscardTarget(next); return; }
    changeView(next);
  }

  function requestClose() {
    if (locked.current) return;
    if (discardTarget) { setDiscardTarget(null); return; }
    if (taskDirty || emailDirty || transferDirty || historyDirty) { setDiscardTarget("close"); return; }
    onClose();
  }

  function discard() {
    const target = discardTarget;
    setDiscardTarget(null);
    if (target === "close") { onClose(); return; }
    if (view === "transfer") { setAgentId(""); setTransferNote(""); }
    setHistoryDirty(false);
    if (target === "activity" || target === "details") { voice.cancel(); setTab(target); return; }
    if (target) changeView(target);
  }

  async function transfer() {
    if (!agentId) { setError("Select a CRM agent to request this transfer."); return; }
    await runAction(() => CrmService.requestTaskTransfer(taskId, { toUserId: agentId, note: transferNote.trim() || undefined }), async () => {
      setNotice("Transfer request sent. The task stays assigned to you until it is accepted.");
      setAgentId(""); setTransferNote(""); setView("task");
      await Promise.allSettled([Promise.resolve().then(onChanged)]);
    });
  }

  return <BottomDrawer open title="Task details" description={null} onClose={requestClose} closeDisabled={busy} dismissOnBackdrop={!busy}>
    <div className={styles.root}>
      {!valid ? <p className="app-alert app-alert--error" role="alert">This task link is invalid.</p> : null}
      {taskQuery.isLoading ? <p className={styles.loading} role="status">Loading task…</p> : null}
      {taskQuery.error ? <div className="app-alert app-alert--error" role="alert">{crmErrorMessage(taskQuery.error, "Could not load this task.")} <button className={styles.textButton} type="button" onClick={() => void taskQuery.mutate().catch(() => undefined)}><RefreshCw size={15} aria-hidden />Retry task</button></div> : null}
      {historyDenied && !taskQuery.error ? <div className="app-alert app-alert--error" role="alert">{crmErrorMessage(historyQuery.error, "This task is no longer available to you.")} <button className={styles.textButton} type="button" onClick={() => void Promise.allSettled([taskQuery.mutate(), historyQuery.mutate()])}>Refresh task access</button></div> : null}
      {error ? <p className={`app-alert app-alert--error ${styles.notice}`} role="alert">{error}</p> : null}
      {uncertain ? <div className={`app-alert app-alert--warning ${styles.notice}`} role="status">The request may already have completed. Check the activity, transfer inbox, or Outlook before retrying; another saved update records another contact attempt.<button className={styles.textButton} type="button" disabled={busy || !online} onClick={() => { setView("task"); setTab("activity"); void Promise.allSettled([taskQuery.mutate(), mutateCache((key) => typeof key === "string" && key.startsWith(historyPrefix), undefined, { revalidate: true })]); }}>Refresh task and activity</button></div> : null}
      {!online ? <p className={`app-alert ${styles.notice}`} role="status">You're offline. You can keep editing; reconnect to save or use CRM actions.</p> : null}
      {discardTarget ? <section className={styles.confirmation} role="alertdialog" aria-label="Discard unsaved changes" aria-modal="false"><p>Discard unsaved changes?</p><p className={styles.muted}>Your draft has not been saved.</p><div className={styles.inlineActions}><button type="button" className="app-button app-button--secondary" autoFocus onClick={() => setDiscardTarget(null)}>Keep editing</button><button type="button" className="app-button app-button--danger" onClick={discard}>Discard changes</button></div></section> : null}
      {notice ? <p className={`app-alert ${styles.notice}`} role="status">{notice}{calendarLink ? <> <a href={calendarLink} target="_blank" rel="noopener noreferrer">Open event</a></> : null}</p> : null}
      {task ? <>
        <header className={styles.identity}>
          <h3 className={styles.name}>{task.clientName}</h3>
          {task.companyName ? <p className={styles.company}>{task.companyName}</p> : null}
          <div className={styles.meta}><span className="app-chip app-chip--accent">{CRM_STATUS_LABELS[task.status] || task.status}</span><span>Due {crmDate(task.dueDate)}</span></div>
          <div className={styles.actions}>
            <button type="button" className="app-button app-button--secondary" disabled={busy || !phones.length} aria-expanded={showPhones} onClick={() => setShowPhones((current) => !current)}><Phone size={17} aria-hidden />Call</button>
            <button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => showView("email")}><Mail size={17} aria-hidden />Email</button>
            <button type="button" className="app-button app-button--secondary" disabled={busy || !online} onClick={() => showView("transfer")}><ArrowRightLeft size={17} aria-hidden />Transfer</button>
            <button type="button" className="app-button app-button--secondary" disabled={busy || !online || calendarExported || calendarPending} onClick={() => void exportCalendar()}><Calendar size={17} aria-hidden />{calendarPending ? "Outlook sync pending" : calendarExported ? "Added to Outlook" : "Add to Outlook"}</button>
          </div>
          <p className={styles.muted}>Follow-ups refresh their existing event; other tasks create a new calendar event.</p>
          {showPhones ? <div className={styles.phoneList} aria-label="Choose a phone number">{phones.map((phone) => <a className={styles.textButton} key={phone.href} href={phone.href}><Phone size={14} aria-hidden /><span>{phone.value} <span className={styles.muted}>({phone.label})</span></span></a>)}</div> : null}
        </header>
        {view === "email" ? <CrmEmailComposer clientName={task.clientName} email={task.email} user={user} onBack={() => showView("task")} onDirtyChange={setEmailDirty} /> : null}
        {view === "transfer" ? <section className={styles.section} aria-label="Transfer task">
          <button type="button" className={styles.textButton} disabled={busy} onClick={() => showView("task")}><ArrowLeft size={16} aria-hidden />Back to task</button><h3 className={styles.sectionTitle}>Transfer task</h3>
          <p className={styles.muted}>Select a CRM agent. They can accept or reject your request.</p>
          {agentsQuery.isLoading ? <p role="status">Loading agents…</p> : null}
          {agentsQuery.error ? <div className="app-alert app-alert--error" role="alert">{crmErrorMessage(agentsQuery.error)} <button className={styles.textButton} type="button" onClick={() => void agentsQuery.mutate().catch(() => undefined)}>Retry agents</button></div> : null}
          {agentsQuery.data?.length === 0 ? <p className={styles.muted}>No CRM agents are available for transfer.</p> : null}
          {agentsQuery.data?.filter((agent) => agent._id !== ownerId).map((agent) => <label className={styles.agentOption} key={agent._id}><input type="radio" name="transfer-agent" value={agent._id} checked={agentId === agent._id} onChange={() => setAgentId(agent._id)} disabled={busy} /><span><strong>{crmPersonLabel(agent)}</strong><span className={styles.muted} style={{ display: "block" }}>{[agent.crmAddress, agent.crmQuadrant, agent.crmSpecializations?.map((value) => CRM_SPECIALIZATION_OPTIONS.find((option) => option.value === value)?.label || value).join(", ")].filter(Boolean).join(" · ")}</span></span></label>)}
          <label className={styles.field}>Transfer note (optional)<textarea className={`app-field ${styles.comment}`} value={transferNote} onChange={(event) => setTransferNote(event.target.value)} disabled={busy} /></label><button type="button" className="app-button app-button--primary" disabled={busy || !online || !agentId} onClick={() => void transfer()}>{busy ? "Sending…" : "Send transfer request"}</button>
        </section> : null}
        {view === "task" ? <>
          <div className={styles.tabs} role="tablist" aria-label="Task sections">{(["activity", "details"] as const).map((value) => <button type="button" role="tab" id={`crm-${value}-${taskId}`} aria-selected={tab === value} aria-controls={`crm-panel-${value}-${taskId}`} className={styles.tab} key={value} disabled={busy} onClick={() => { if (value === tab) return; if (historyDirty || voice.busy) { setDiscardTarget(value); return; } voice.cancel(); setTab(value); }}>{value === "activity" ? "Activity" : "Details"}</button>)}</div>
          {tab === "details" ? <div role="tabpanel" id={`crm-panel-details-${taskId}`} aria-labelledby={`crm-details-${taskId}`}><CrmContactDetails task={task} /></div> : <div role="tabpanel" id={`crm-panel-activity-${taskId}`} aria-labelledby={`crm-activity-${taskId}`}>
            <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void saveUpdate(); }} aria-label="Log follow-up">
              <h3 className={styles.sectionTitle}>Log follow-up</h3>
              <label className={styles.field}>Stage<select className="app-field" value={status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as CrmTaskStatus }))} disabled={busy}>{CRM_STATUSES.map((stage) => <option key={stage} value={stage}>{CRM_STATUS_LABELS[stage]}</option>)}</select></label>
              {status === "lost" ? <label className={styles.field}>Lost reason<select className="app-field" value={lostReason || ""} onChange={(event) => setDraft((current) => ({ ...current, lostReason: event.target.value as CrmLostReason }))} disabled={busy}><option value="">Select a reason</option>{CRM_LOST_REASONS.map((reason) => <option key={reason} value={reason}>{CRM_LOST_REASON_LABELS[reason]}</option>)}</select></label> : null}
              <label className={styles.field}>Comment<textarea className={`app-field ${styles.comment}`} value={draft.comment} onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))} placeholder="Add a note about this follow-up…" disabled={busy} /></label>
              <div className={styles.tools}>
                <button type="button" className={styles.textButton} disabled={busy} onClick={() => attachmentsInput.current?.click()}><Paperclip size={18} aria-hidden />Attach files</button>
                <CrmVoiceControls voice={voice} disabled={busy || !online} />
                <input ref={attachmentsInput} className={styles.fileInput} type="file" multiple aria-label="Attach files to update" tabIndex={-1} disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
              </div>
              {draft.attachments.length ? <ul className={styles.files}>{draft.attachments.map((file, index) => <li className={styles.file} key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" className={styles.textButton} aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setDraft((current) => ({ ...current, attachments: current.attachments.filter((_, i) => i !== index) }))}><X size={14} aria-hidden /></button></li>)}</ul> : null}
              <details><summary className={styles.muted}>Recording attachment</summary><button type="button" className={styles.textButton} disabled={busy} onClick={() => recordingInput.current?.click()}>Attach an audio file</button><input ref={recordingInput} className={styles.fileInput} type="file" accept="audio/*" aria-label="Attach audio recording" tabIndex={-1} disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files || []), true); event.target.value = ""; }} />{draft.recording ? <div className={styles.file}><span>{draft.recording.name}</span><button type="button" className={styles.textButton} disabled={busy} onClick={() => setDraft((current) => ({ ...current, recording: null }))}>Remove audio</button></div> : null}<p className={styles.muted}>Up to 10 attachments and one recording, 50 MiB each.</p></details>
              <p className={styles.muted}>Each update records a contact attempt.</p>
              <button type="submit" className={`app-button app-button--primary ${styles.fullButton}`} disabled={busy || !online || voice.busy}>{busy ? "Saving…" : "Save update"}</button>
              <p className={styles.muted}>{crmReminderText(status, lostReason)}</p>
            </form>
            <CrmTaskHistory taskId={taskId} ownerId={ownerId} data={historyQuery.data} loading={historyQuery.isLoading} error={historyQuery.error ? crmErrorMessage(historyQuery.error, "Could not load activity.") : undefined} page={page} onPage={setPage} onRefresh={() => void historyQuery.mutate().catch(() => undefined)} busy={busy || !online} mutate={mutateTask} onDirtyChange={setHistoryDirty} />
          </div>}
        </> : null}
      </> : null}
    </div>
  </BottomDrawer>;
}
