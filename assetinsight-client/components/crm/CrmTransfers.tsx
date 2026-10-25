"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw, X } from "lucide-react";
import { CrmService, crmErrorMessage, isCrmId, type CrmTaskTransferItem, type CrmTransferStatus } from "@/services/crm";
import { useCrmPanelMutation } from "./useCrmPanelMutation";
import styles from "./CrmAuxiliary.module.css";

export type CrmTransfersProps = { ownerId: string; onChanged: () => void; onOpenTask: (taskId: string) => void };
const TRANSFER_LABELS: Record<CrmTransferStatus, string> = { pending: "Pending", accepted: "Accepted", rejected: "Rejected", cancelled: "Cancelled" };
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function dateLabel(value?: string) {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? DATE.format(date) : "Date not available";
}

function Transfers({ ownerId, onChanged, onOpenTask }: CrmTransfersProps) {
  const [filter, setFilter] = useState<CrmTransferStatus>("pending");
  const [reload, setReload] = useState(0);
  const key = `${ownerId}:${filter}`;
  const [snapshot, setSnapshot] = useState<{ key: string; items: CrmTaskTransferItem[]; error: string; loading: boolean }>({ key: "", items: [], error: "", loading: true });
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const rejectOpener = useRef<HTMLButtonElement | null>(null);
  const statusSelect = useRef<HTMLSelectElement>(null);
  const mutation = useCrmPanelMutation();

  useEffect(() => {
    const controller = new AbortController();
    const request = ++generation.current;
    setSnapshot((current) => ({ key, items: current.key === key ? current.items : [], error: "", loading: true }));
    void CrmService.getMyTransferRequests({ status: filter }, { signal: controller.signal }).then((items) => {
      if (!controller.signal.aborted && generation.current === request) setSnapshot({ key, items, error: "", loading: false });
    }).catch((error) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (!controller.signal.aborted && generation.current === request) setSnapshot((current) => ({ key, items: current.key === key && status !== 401 && status !== 403 && status !== 404 ? current.items : [], error: crmErrorMessage(error, "Transfer requests could not be loaded."), loading: false }));
    });
    return () => { controller.abort(); };
  }, [key, filter, reload]);
  useEffect(() => { if (rejectId) rejectButton.current?.focus(); }, [rejectId]);

  const current = snapshot.key === key ? snapshot : { items: [], loading: true, error: "" };
  const respond = (item: CrmTaskTransferItem, action: "accept" | "reject") => {
    if (item.status !== "pending" || filter !== "pending" || mutation.isLocked()) return;
    setNotice("");
    void mutation.run((signal) => CrmService.respondToTransferRequest(item._id, action, { signal }), () => {
      setRejectId(null);
      setSnapshot((saved) => ({ ...saved, items: saved.items.filter((entry) => entry._id !== item._id) }));
      setNotice(action === "accept" ? "Transfer accepted. The task is now assigned to you." : "Transfer rejected.");
      setReload((value) => value + 1);
      requestAnimationFrame(() => statusSelect.current?.focus());
      onChanged();
    });
  };

  return <section className={styles.transfers} aria-label="CRM transfers" aria-busy={mutation.busy}>
    <header className={styles.transferToolbar}>
      <div><h2>Transfer requests</h2><p>Requests sent to you. Showing up to the latest 100 for each status.</p></div>
      <div className={styles.toolbarActions}>
        <label className="app-label"><span className="sr-only">Transfer status</span><select ref={statusSelect} className="app-field" value={filter} disabled={mutation.busy} onChange={(event) => { setFilter(event.target.value as CrmTransferStatus); setRejectId(null); setNotice(""); mutation.setError(""); }}>
          {Object.entries(TRANSFER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button type="button" className="app-button app-button--secondary app-button--icon" aria-label="Refresh transfers" disabled={current.loading || mutation.busy} onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} aria-hidden /></button>
      </div>
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {mutation.busy ? <p className={styles.notice} role="status">Saving your decision…</p> : null}
    {current.error ? <div className="app-alert app-alert--error" role="alert">{current.error}</div> : null}
    {mutation.error ? <div className="app-alert app-alert--error" role="alert"><div>{mutation.error}{mutation.uncertain ? <p className={styles.errorHint}>Refresh the requests before trying again; this decision may already have been saved.</p> : null}</div></div> : null}
    {current.loading && !current.items.length ? <div className={styles.empty} role="status"><span className="app-spinner" aria-hidden />Loading transfer requests…</div> : !current.items.length && !current.error ? <div className={styles.empty}><strong>No {filter} transfer requests</strong><span>{filter === "pending" ? "New requests from other CRM agents will appear here." : "Choose another status to view more requests."}</span></div> : <ul className={styles.transferList} aria-busy={current.loading}>
      {current.items.map((item) => <li className={styles.transferRow} key={item._id}>
        <div className={styles.transferMain}><strong>{item.leadId?.clientName || item.leadId?.title || "Task no longer available"}</strong><span>From {item.fromUserId?.username || item.fromUserId?.email || "CRM agent"}</span>{item.note ? <p>{item.note}</p> : null}<time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time></div>
        <div className={styles.transferActions} role="group" aria-label={`Transfer actions for ${item.leadId?.clientName || "task"}`}><span className="app-chip">{TRANSFER_LABELS[item.status] || item.status}</span>
          {item.status === "pending" && filter === "pending" ? <div className={styles.rowButtons}>
            <button type="button" className="app-button app-button--secondary" disabled={mutation.busy} onClick={(event) => { rejectOpener.current = event.currentTarget; setRejectId(item._id); }}><X size={15} aria-hidden />Reject</button>
            <button type="button" className="app-button app-button--primary" disabled={mutation.busy} onClick={() => respond(item, "accept")}><Check size={15} aria-hidden />Accept</button>
          </div> : item.status === "accepted" && isCrmId(item.leadId?._id) ? <button type="button" className="app-button app-button--secondary" onClick={() => onOpenTask(item.leadId!._id)}><ArrowRight size={15} aria-hidden />Open task</button> : null}
        </div>
        {rejectId === item._id ? <div className={styles.confirmation} role="group" aria-label="Confirm transfer rejection"><p>Reject this transfer request? The task will stay with its current agent.</p><div className={styles.rowButtons}><button type="button" className="app-button app-button--secondary" disabled={mutation.busy} onClick={() => { setRejectId(null); requestAnimationFrame(() => rejectOpener.current?.focus()); }}>Keep pending</button><button ref={rejectButton} type="button" className="app-button app-button--danger" disabled={mutation.busy} onClick={() => respond(item, "reject")}>Reject transfer</button></div></div> : null}
      </li>)}
    </ul>}
  </section>;
}

export default function CrmTransfers(props: CrmTransfersProps) {
  return <Transfers key={props.ownerId} {...props} />;
}
