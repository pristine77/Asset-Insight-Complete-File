"use client";

import { ChevronLeft, ChevronRight, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import CrmService, { CRM_LOST_REASONS, CRM_LOST_REASON_LABELS, CRM_STATUSES, CRM_STATUS_LABELS, crmStatusChange, isCrmId, safeCrmUrl, type CrmPage, type CrmTaskItem, type CrmTaskUpdateEntry, type CrmTaskStatus, type CrmLostReason } from "@/services/crm";
import { crmDate, crmPersonId, crmPersonLabel } from "./crmDetailHelpers";
import styles from "./CrmTaskDetail.module.css";

export type CrmTaskMutation = (name: string, action: () => Promise<CrmTaskItem>) => Promise<boolean>;
type Props = {
  taskId: string;
  ownerId: string;
  data?: CrmPage<CrmTaskUpdateEntry>;
  loading: boolean;
  error?: string;
  page: number;
  onPage: (page: number) => void;
  onRefresh: () => void;
  busy: boolean;
  mutate: CrmTaskMutation;
  onDirtyChange?: (dirty: boolean) => void;
};
type EditState = { entry: CrmTaskUpdateEntry; comment: string; status: CrmTaskStatus; lostReason?: CrmLostReason };
type Removal = { updateId: string; kind: "update" | "attachment" | "recording"; url?: string };

export default function CrmTaskHistory({ taskId, ownerId, data, loading, error, page, onPage, onRefresh, busy, mutate, onDirtyChange }: Props) {
  const [editing, setEditing] = useState<EditState | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [validation, setValidation] = useState("");
  const editingDirty = Boolean(editing && (editing.comment !== (editing.entry.comment || "") || editing.status !== editing.entry.status || editing.lostReason !== editing.entry.lostReason));
  useEffect(() => { onDirtyChange?.(editingDirty); }, [editingDirty, onDirtyChange]);

  async function saveEdit() {
    if (!editing?.entry._id) return;
    if (editing.status === "lost" && !editing.lostReason) { setValidation("Select a lost reason."); return; }
    const changed = crmStatusChange(editing.entry.status, editing.status, editing.lostReason);
    const accepted = await mutate("Update edited.", () => CrmService.editTaskUpdate(taskId, editing.entry._id!, {
      comment: editing.comment, ...changed,
      ...(editing.status === "lost" && editing.lostReason !== editing.entry.lostReason ? { lostReason: editing.lostReason } : {}),
    }));
    if (accepted) { setEditing(null); setValidation(""); }
  }

  async function confirmRemoval() {
    if (!removal) return;
    const accepted = await mutate(removal.kind === "update" ? "Update deleted." : "Media removed.", () => {
      if (removal.kind === "attachment") return CrmService.deleteTaskUpdateAttachments(taskId, removal.updateId, [removal.url!]);
      if (removal.kind === "recording") return CrmService.deleteTaskUpdateRecording(taskId, removal.updateId);
      return CrmService.deleteTaskUpdate(taskId, removal.updateId);
    });
    if (accepted) setRemoval(null);
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : page;
  return (
    <section className={styles.activity} aria-label="Task activity">
      <h3 className={styles.sectionTitle}>Activity{data ? ` · ${data.total}` : ""}</h3>
      {error ? <div className="app-alert app-alert--error" role="alert">{error} <button type="button" className={styles.textButton} onClick={onRefresh}>Retry activity</button></div> : null}
      {loading ? <p className={styles.loading} role="status">Loading activity…</p> : null}
      {!loading && !error && data?.items.length === 0 ? <p className={styles.muted}>No activity yet for this lead.</p> : null}
      {!loading && data ? <ol className={styles.timeline}>
        {data.items.map((entry, index) => {
          const updateId = entry._id || "";
          const owned = Boolean(ownerId && crmPersonId(entry.createdBy) === ownerId && isCrmId(updateId) && !entry.isDeleted);
          const isEditing = editing?.entry._id === updateId;
          const recording = safeCrmUrl(entry.recordingUrl);
          return <li className={styles.timelineEntry} key={updateId || `${entry.createdAt}-${index}`}>
            <div className={styles.timelineHeader}><span className={styles.author}>{crmPersonId(entry.createdBy) === ownerId ? "You" : crmPersonLabel(entry.createdBy)}</span><time className={styles.muted} dateTime={entry.createdAt}>{crmDate(entry.createdAt, true)}</time>{entry.editedAt && !entry.isDeleted ? <span className={styles.muted}>Edited</span> : null}</div>
            {entry.isDeleted ? <p className={styles.timelineComment}>This update was deleted.</p> : <>
              {entry.comment ? <p className={styles.timelineComment}>{entry.comment}</p> : null}
              <p className={styles.timelineStage}><span className="app-chip app-chip--accent">{CRM_STATUS_LABELS[entry.status] || entry.status}</span>{entry.lostReason ? <span className={styles.muted}> · {CRM_LOST_REASON_LABELS[entry.lostReason]}</span> : null}</p>
              {entry.reminderDate ? <p className={styles.muted}>Reminder: {crmDate(entry.reminderDate, true)}</p> : null}
              {owned && !isEditing ? <div className={styles.inlineActions}>
                <button type="button" className={styles.textButton} disabled={busy || editingDirty} onClick={() => { setEditing({ entry, comment: entry.comment || "", status: entry.status, lostReason: entry.lostReason }); setValidation(""); setRemoval(null); }}><Pencil size={15} aria-hidden />Edit</button>
                <button type="button" className={`${styles.textButton} ${styles.danger}`} disabled={busy || editingDirty} onClick={() => { setRemoval({ updateId, kind: "update" }); setEditing(null); }}><Trash2 size={15} aria-hidden />Delete</button>
              </div> : null}
              {isEditing && editing ? <div className={styles.historyEditor}>
                <label className={styles.field}>Edit comment<textarea className={`app-field ${styles.comment}`} value={editing.comment} onChange={(event) => setEditing({ ...editing, comment: event.target.value })} disabled={busy} /></label>
                <label className={styles.field}>Update status<select className="app-field" value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value as CrmTaskStatus })} disabled={busy}>{CRM_STATUSES.map((status) => <option key={status} value={status}>{CRM_STATUS_LABELS[status]}</option>)}</select></label>
                {editing.status === "lost" ? <label className={styles.field}>Update lost reason<select className="app-field" value={editing.lostReason || ""} onChange={(event) => setEditing({ ...editing, lostReason: event.target.value as CrmLostReason })} disabled={busy}><option value="">Select a reason</option>{CRM_LOST_REASONS.map((reason) => <option key={reason} value={reason}>{CRM_LOST_REASON_LABELS[reason]}</option>)}</select></label> : null}
                <p className={styles.muted}>Changing this status can reset the task's due date and reminders. The latest remaining entry determines its current stage.</p>
                {validation ? <p className={styles.voiceError} role="alert">{validation}</p> : null}
                <div className={styles.inlineActions}><button type="button" className="app-button app-button--primary" disabled={busy} onClick={() => void saveEdit()}>Save changes</button><button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel edit</button></div>
              </div> : null}
              {entry.attachmentUrls?.length ? <div className={styles.media}>{entry.attachmentUrls.map((url, attachmentIndex) => {
                const href = safeCrmUrl(url);
                if (!href) return null;
                const image = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(href);
                return <div className={styles.mediaItem} key={`${url}-${attachmentIndex}`}><a className={styles.mediaLink} href={href} target="_blank" rel="noopener noreferrer">{image ? <img className={styles.thumbnail} src={href} alt={`Attachment ${attachmentIndex + 1}`} loading="lazy" decoding="async" /> : <><Paperclip size={14} aria-hidden />Attachment {attachmentIndex + 1}</>}</a>{owned ? <button type="button" className={`${styles.textButton} ${styles.danger}`} disabled={busy} onClick={() => setRemoval({ updateId, kind: "attachment", url })}>Remove attachment {attachmentIndex + 1}</button> : null}</div>;
              })}</div> : null}
              {recording ? <div><audio className={styles.audio} controls preload="none" src={recording} aria-label="Activity recording" />{owned ? <button type="button" className={`${styles.textButton} ${styles.danger}`} disabled={busy} onClick={() => setRemoval({ updateId, kind: "recording" })}>Remove recording</button> : null}</div> : null}
              {removal?.updateId === updateId ? <div className={styles.confirmation} role="group" aria-label="Confirm removal"><p>{removal.kind === "update" ? "Delete this update and its media? Its history entry will remain marked as deleted." : `Remove this ${removal.kind} from the update?`}</p><div className={styles.inlineActions}><button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => setRemoval(null)}>Cancel removal</button><button type="button" className="app-button app-button--danger" disabled={busy} onClick={() => void confirmRemoval()}>Confirm {removal.kind === "update" ? "delete update" : `remove ${removal.kind}`}</button></div></div> : null}
            </>}
          </li>;
        })}
      </ol> : null}
      {(data?.total || 0) > 0 || page > 1 ? <nav className={styles.pagination} aria-label="Activity pages"><span>Page {page} of {pages}</span><div className={styles.inlineActions}><button type="button" className="app-button app-button--secondary" aria-label="Previous activity page" disabled={page <= 1 || loading || busy || editingDirty} onClick={() => { setEditing(null); setRemoval(null); onPage(page - 1); }}><ChevronLeft size={16} aria-hidden />Previous</button><button type="button" className="app-button app-button--secondary" aria-label="Next activity page" disabled={page >= pages || loading || busy || editingDirty} onClick={() => { setEditing(null); setRemoval(null); onPage(page + 1); }}>Next<ChevronRight size={16} aria-hidden /></button></div></nav> : null}
    </section>
  );
}
