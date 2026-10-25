"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, WifiOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { useAuthContext } from "@/context/AuthContext";
import type { AuthUser } from "@/services/auth";
import { isCrmId, type GetMyTasksParams } from "@/services/crm";
import CrmTaskList from "./CrmTaskList";
import { crmTaskQueryString, legacyCrmDestination, parseCrmTaskQuery, type CrmPageName } from "./crmRoutePolicy";
import { useCrmOnline } from "./useCrmRead";
import styles from "./CrmWorkspace.module.css";

const panelLoading = () => <div className={styles.loading} role="status">Opening CRM tools…</div>;
const CrmDashboard = dynamic(() => import("./CrmDashboard"), { loading: panelLoading });
const CrmTaskDetail = dynamic(() => import("./CrmTaskDetail"), { loading: panelLoading });
const CrmLeadForm = dynamic(() => import("./CrmLeadForm"), { loading: panelLoading });
const CrmCoverageScreen = dynamic(() => import("./CrmCoverageScreen"), { loading: panelLoading });
const CrmTransfers = dynamic(() => import("./CrmTransfers"), { loading: panelLoading });
const CrmOutlook = dynamic(() => import("./CrmOutlook"), { loading: panelLoading });

const PAGE_COPY: Record<Exclude<CrmPageName, "dashboard">, { title: string; description: string }> = {
  tasks: { title: "Tasks", description: "Your assigned leads and follow-ups." },
  transfers: { title: "Transfers", description: "Review requests from other CRM agents." },
  outlook: { title: "Outlook Calendar", description: "Create appointments from your CRM tasks." },
  coverage: { title: "Coverage", description: "Your service address, areas and specializations." },
};

export default function CrmWorkspace({ page = "dashboard" }: { page?: CrmPageName }) {
  const { user, loading, loggingOut, deviceAccess } = useAuthContext();
  if (loading || loggingOut) return <div className="app-page" role="status">Loading your CRM access…</div>;
  if (user?.isCrmAgent !== true || deviceAccess) return <div className="app-page"><section className={`app-surface ${styles.empty}`}><h1 className="app-title">CRM access required</h1><p>This workspace is available to enabled CRM agents. Contact your administrator to request access.</p></section></div>;
  return <AuthorizedCrmWorkspace key={user._id} user={user} page={page} />;
}

function AuthorizedCrmWorkspace({ user, page }: { user: AuthUser; page: CrmPageName }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { mutate } = useSWRConfig();
  const [leadOpen, setLeadOpen] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const online = useCrmOnline();
  const legacy = page === "dashboard" ? legacyCrmDestination(new URLSearchParams(searchParams)) : null;
  const rawTask = searchParams.get("task");
  const taskId = isCrmId(rawTask) ? rawTask : null;
  const canAddLead = !user.role || user.role === "user";
  useEffect(() => { if (legacy) router.replace(legacy, { scroll: false }); }, [legacy, router]);
  const changed = useCallback(() => {
    setRefreshVersion((value) => value + 1);
    void mutate(`crm:dashboard:${user._id}`, undefined, { revalidate: true }).catch(() => undefined);
  }, [mutate, user._id]);
  const openTask = useCallback((id: string) => {
    if (!isCrmId(id)) return;
    const next = new URLSearchParams(page === "tasks" || page === "outlook" || page === "transfers" ? searchParams : undefined);
    next.delete("view"); next.set("task", id);
    const destination = page === "outlook" || page === "transfers" ? pathname : "/crm/tasks";
    router.push(`${destination}?${next}`, { scroll: false });
  }, [page, pathname, router, searchParams]);
  const closeTask = useCallback(() => {
    const next = new URLSearchParams(searchParams); next.delete("task");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [pathname, router, searchParams]);
  const updateQuery = useCallback((query: GetMyTasksParams, options?: { replace?: boolean }) => {
    const next = crmTaskQueryString(query);
    const href = `/crm/tasks${next ? `?${next}` : ""}`;
    if (options?.replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [router]);
  if (legacy) return <div className="app-page" role="status">Opening your CRM link…</div>;
  return <div className={`app-page ${styles.page}`}>
    {page !== "dashboard" && <header className={styles.heading}><div><h1 className="app-title">{PAGE_COPY[page].title}</h1><p>{PAGE_COPY[page].description}</p></div>{page === "tasks" && canAddLead && <button className="app-button app-button--primary" disabled={!online} onClick={() => setLeadOpen(true)}><Plus size={17} />Add lead</button>}</header>}
    {!online && page !== "dashboard" && <div className={styles.notice} role="status"><WifiOff size={18} />You’re offline. Previously loaded tasks may be visible; reconnect before making changes.</div>}
    {rawTask && !taskId && <div className={styles.error} role="alert">This task link is invalid. Select a task to continue.</div>}
    {page === "dashboard" && <CrmDashboard ownerId={user._id} onOpenTask={openTask} onAddLead={canAddLead ? () => setLeadOpen(true) : undefined} />}
    {page === "tasks" && <div className={`app-surface ${styles.workspace}`}><CrmTaskList ownerId={user._id} onOpenTask={openTask} refreshVersion={refreshVersion} query={parseCrmTaskQuery(searchParams)} navigationKey={searchParams.toString()} onQueryChange={updateQuery} /></div>}
    {page === "transfers" && <div className={`app-surface ${styles.workspace}`}><CrmTransfers ownerId={user._id} onChanged={changed} onOpenTask={openTask} /></div>}
    {page === "outlook" && <div className={`app-surface ${styles.workspace}`}><CrmOutlook ownerId={user._id} onOpenTask={openTask} refreshVersion={refreshVersion} /></div>}
    {page === "coverage" && <CrmCoverageScreen ownerId={user._id} />}
    {taskId && <CrmTaskDetail key={`${user._id}:${taskId}`} taskId={taskId} ownerId={user._id} user={{ id: user._id, name: user.username, company: user.companyName, email: user.email, phone: user.contactPhone }} onClose={closeTask} onChanged={changed} />}
    {leadOpen && <CrmLeadForm ownerId={user._id} onClose={() => setLeadOpen(false)} onCreated={(id) => { setLeadOpen(false); changed(); router.push(`/crm/tasks?task=${encodeURIComponent(id)}`, { scroll: false }); }} />}
  </div>;
}
