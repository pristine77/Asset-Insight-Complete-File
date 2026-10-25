"use client";

import Link from "next/link";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { CrmService, CRM_STATUS_LABELS, crmErrorMessage, type CrmDashboardTask } from "@/services/crm";
import { useCrmOnline, useCrmRead } from "./useCrmRead";
import styles from "./CrmDashboard.module.css";

type Props = { ownerId: string; onOpenTask: (id: string) => void; onAddLead?: () => void };
type FollowUp = "overdue" | "upcoming";
const followUpHref = (group: FollowUp) => `/crm/tasks?status=all&due=${group}`;
const formatCount = (value: number) => value.toLocaleString();
function dateLabel(value: string, full = false) {
  return new Date(value).toLocaleString(undefined, full
    ? { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

function FollowUpRow({ task, overdue, onOpen }: { task: CrmDashboardTask; overdue: boolean; onOpen: (id: string) => void }) {
  return <li className={styles.followUpRow}>
    <button type="button" className={styles.taskButton} onClick={() => onOpen(task._id)} aria-label={`Open task for ${task.clientName || task.title || "Unnamed contact"}`} aria-describedby={`crm-follow-up-meta-${task._id}`}>
      <span className={styles.contact}><strong>{task.clientName || task.title || "Unnamed contact"}</strong><span>{task.companyName || "Company not recorded"}</span></span>
      <span className={styles.stageColumn}><span className={styles.fieldLabel}>Stage</span><span className={styles.stage} data-warning={task.status === "decision_pending"}>{CRM_STATUS_LABELS[task.status]}</span></span>
      <span className={styles.dueColumn}><span className={styles.fieldLabel}>Due</span><time dateTime={task.dueDate} title={dateLabel(task.dueDate, true)} data-overdue={overdue}>{dateLabel(task.dueDate)}</time></span>
      <ChevronRight size={17} aria-hidden="true" />
      <span className="sr-only" id={`crm-follow-up-meta-${task._id}`}>{task.companyName || "Company not recorded"}. Stage: {CRM_STATUS_LABELS[task.status]}. Due: {dateLabel(task.dueDate, true)}.</span>
    </button>
  </li>;
}

export default function CrmDashboard({ ownerId, onOpenTask, onAddLead }: Props) {
  const [group, setGroup] = useState<FollowUp>("overdue");
  const tabs = useRef<Partial<Record<FollowUp, HTMLButtonElement | null>>>({});
  const online = useCrmOnline();
  const query = useCrmRead(ownerId ? `crm:dashboard:${ownerId}` : null, (signal) => CrmService.getDashboard({ signal }));
  const snapshot = query.data;
  const responseStatus = (query.error as { response?: { status?: number } } | undefined)?.response?.status;
  const accessDenied = responseStatus === 401 || responseStatus === 403 || responseStatus === 404;
  const statusCounts = snapshot ? Object.fromEntries(snapshot.statusCounts.map((entry) => [entry._id, entry.count])) : undefined;
  const metrics = snapshot ? [
    { label: "Total leads", count: snapshot.total, href: "/crm/tasks?status=all" },
    { label: "Imported", count: snapshot.leadSourceCounts.generic, href: "/crm/tasks?status=all&leadSource=generic" },
    { label: "Organic", count: snapshot.leadSourceCounts.organic, href: "/crm/tasks?status=all&leadSource=organic" },
    { label: "Next 7 days", count: snapshot.dueCounts.upcoming, href: followUpHref("upcoming") },
    { label: "Overdue", count: snapshot.dueCounts.overdue, href: followUpHref("overdue") },
    { label: "Lost", count: statusCounts!.lost, href: "/crm/tasks?status=lost" },
  ] : [];
  const tasks = snapshot ? group === "overdue" ? snapshot.overdueTasks : snapshot.upcomingTasks : [];
  const refresh = () => { void query.mutate().catch(() => undefined); };

  return <section className={styles.dashboard} aria-labelledby="crm-dashboard-heading">
    <header className={styles.heading}>
      <div><h1 id="crm-dashboard-heading">CRM dashboard</h1><p>Your assigned leads and next steps.</p></div>
      <div className={styles.actions}>
        <button type="button" className="app-button app-button--secondary" onClick={refresh} disabled={query.isValidating || !online || !ownerId}><RefreshCw size={17} aria-hidden="true" />{query.isValidating && snapshot ? "Refreshing…" : "Refresh"}</button>
        {onAddLead ? <button type="button" className={`app-button app-button--primary ${styles.addButton}`} onClick={onAddLead} disabled={!online || !ownerId || accessDenied}><Plus size={18} aria-hidden="true" />Add lead</button> : null}
      </div>
    </header>
    {!online ? <p className={styles.notice} role="status">You're offline.{snapshot ? " Showing the last loaded dashboard." : " Reconnect to load your dashboard."}</p> : null}
    {query.error ? <div className={styles.error} role="alert"><p>{crmErrorMessage(query.error, "CRM dashboard unavailable.")}</p>{snapshot ? <p>Showing the last loaded dashboard. Refresh to check for changes.</p> : null}<button type="button" className={styles.textButton} disabled={query.isValidating || !online} onClick={refresh}>Retry dashboard</button></div> : null}
    {!snapshot ? <div className={styles.unavailable} role="status" aria-busy={query.isLoading}>{query.error ? "Dashboard unavailable" : !ownerId ? "Sign in to view your assigned leads." : "Loading CRM dashboard…"}</div> : <>
      <div>
        <nav className={styles.metricBand} aria-label="CRM lead totals">{metrics.map((metric) => <Link className={styles.metric} href={metric.href} aria-label={`${metric.label} ${formatCount(metric.count)}`} key={metric.label} prefetch={false}><span>{metric.label}</span><strong>{formatCount(metric.count)}</strong><ChevronRight size={18} aria-hidden="true" /></Link>)}</nav>
        <p className={styles.updated} role="status">{query.error || !online ? "Last loaded" : "Last updated"} <time dateTime={snapshot.asOf}>{dateLabel(snapshot.asOf, true)}</time></p>
      </div>
      <div className={styles.panels}>
        <section className={`${styles.panel} ${styles.followUps}`} aria-labelledby="crm-follow-up-heading">
          <h2 id="crm-follow-up-heading">Follow-ups</h2>
          <div className={styles.tabs} role="tablist" aria-label="Follow-up due window">{(["overdue", "upcoming"] as const).map((value) => <button type="button" className={styles.tab} role="tab" key={value} id={`crm-follow-up-${value}`} ref={(node) => { tabs.current[value] = node; }} aria-controls="crm-follow-up-rows" aria-label={`${value === "overdue" ? "Overdue" : "Next 7 days"} ${formatCount(snapshot.dueCounts[value])}`} aria-selected={group === value} tabIndex={group === value ? 0 : -1} onClick={() => setGroup(value)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "overdue" : event.key === "End" ? "upcoming" : value === "overdue" ? "upcoming" : "overdue";
            setGroup(next); tabs.current[next]?.focus();
          }}>{value === "overdue" ? "Overdue" : "Next 7 days"}<span>{formatCount(snapshot.dueCounts[value])}</span></button>)}</div>
          <div role="tabpanel" id="crm-follow-up-rows" aria-labelledby={`crm-follow-up-${group}`}>
            {tasks.length ? <ul className={styles.followUpList}>{tasks.map((task) => <FollowUpRow key={task._id} task={task} overdue={group === "overdue"} onOpen={onOpenTask} />)}</ul> : <p className={styles.empty}>{group === "overdue" ? "No overdue tasks." : "No upcoming tasks in the next 7 days."}</p>}
            <Link href={followUpHref(group)} className={styles.viewAll} prefetch={false}>View {group === "overdue" ? "overdue" : "upcoming"} tasks<ChevronRight size={16} aria-hidden="true" /></Link>
          </div>
        </section>
        <section className={`${styles.panel} ${styles.pipeline}`} aria-labelledby="crm-pipeline-heading">
          <h2 id="crm-pipeline-heading">Pipeline</h2><p className={styles.pipelineDescription}>All assigned leads.</p>
          <ul className={styles.pipelineList}>{snapshot.statusCounts.map((entry) => <li key={entry._id}><Link href={`/crm/tasks?status=${entry._id}`} className={styles.pipelineRow} aria-label={`${CRM_STATUS_LABELS[entry._id]}: ${formatCount(entry.count)} of ${formatCount(snapshot.total)} leads`} prefetch={false}><span className={styles.pipelineLabel}>{CRM_STATUS_LABELS[entry._id]}</span><span className={styles.pipelineCount}>{formatCount(entry.count)}</span><span className={styles.track} aria-hidden="true"><span style={{ width: `${snapshot.total ? entry.count / snapshot.total * 100 : 0}%` }} /></span></Link></li>)}</ul>
        </section>
      </div>
    </>}
  </section>;
}
