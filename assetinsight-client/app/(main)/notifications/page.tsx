"use client";

import { Bell, Check, CheckCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "@/components/ui/toast";
import { notificationCacheKey, NotificationsService, type WorkspaceNotification } from "@/services/notifications";
import styles from "./Notifications.module.css";
import PreviewReminderContent from "@/components/notifications/PreviewReminderContent";
import { previewReminderDetails } from "@/lib/previewReminderNotification";
import { crmNotificationHref } from "@/lib/crmNotification";
import { useAuthContext } from "@/context/AuthContext";

type Filter = "all" | "new" | "seen";

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function NotificationsPage() {
  const { user } = useAuthContext();
  const ownerId = user?._id || user?.id;
  const [filter, setFilter] = useState<Filter>("all");
  const cacheKey = ownerId ? notificationCacheKey(1, 100, ownerId) : null;
  const { data, isLoading, error } = useSWR(cacheKey, () => NotificationsService.list(1, 100), { revalidateOnFocus: true });
  const items = useMemo(() => (data?.items || []).filter((item) => filter === "all" || (filter === "new" ? !item.read : item.read)), [data?.items, filter]);
  const seenCount = Math.max(0, (data?.total || 0) - (data?.unreadCount || 0));

  const refresh = () => mutate((key) => typeof key === "string" && key.startsWith("/notifications?") && key.endsWith(`&cacheOwner=${encodeURIComponent(ownerId || "")}`));
  const markRead = async (item: WorkspaceNotification) => {
    if (item.read) return;
    await NotificationsService.markRead(item.id);
    await refresh();
  };
  const markAllRead = async () => {
    await NotificationsService.markAllRead();
    await refresh();
    toast.success("All notifications marked as read");
  };
  const remove = async (item: WorkspaceNotification) => {
    await NotificationsService.remove(item.id);
    await refresh();
    toast.success("Notification removed");
  };

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Inbox</p>
          <h1>Notifications</h1>
          <p>Report, approval, release, and CRM activity in one place.</p>
        </div>
        {(data?.unreadCount || 0) > 0 ? <button onClick={() => void markAllRead()}><CheckCheck size={17} /> Mark all read</button> : null}
      </header>

      <section className={styles.workspace}>
        <div className={styles.tabs} role="tablist" aria-label="Notification filters">
          {(["all", "new", "seen"] as const).map((value) => {
            const count = value === "all" ? data?.total || 0 : value === "new" ? data?.unreadCount || 0 : seenCount;
            return <button key={value} role="tab" aria-selected={filter === value} data-active={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All" : value === "new" ? "New" : "Seen"}<span>{count}</span></button>;
          })}
        </div>

        <div className={styles.list}>
          {isLoading ? Array.from({ length: 5 }).map((_, index) => <div className={styles.skeleton} key={index} />) : error ? (
            <div className={styles.empty}>Unable to load notifications.</div>
          ) : items.length === 0 ? (
            <div className={styles.empty}><Bell size={34} /><strong>No {filter === "all" ? "notifications" : filter} notifications</strong><span>Your inbox is up to date.</span></div>
          ) : items.map((item) => (
            <article className={styles.row} data-unread={!item.read} key={item.id}>
              <span className={styles.rowIcon}><Bell size={18} /></span>
              <div className={styles.rowCopy}><div><strong>{item.title}</strong>{!item.read ? <span>New</span> : null}</div>
                {previewReminderDetails(item) ? <details className={styles.messageDetails} onToggle={(event) => {
                  if (event.currentTarget.open) void markRead(item).catch(() => undefined);
                }}>
                  <summary>Read message and report guidance</summary>
                  <PreviewReminderContent item={item} />
                </details> : <p>{item.body}</p>}
                {crmNotificationHref(item) ? <Link className="app-button app-button--secondary" href={crmNotificationHref(item)!} onClick={() => { void markRead(item).catch(() => undefined); }}>Open CRM</Link> : null}
                <time>{formatDate(item.createdAt)}</time></div>
              <div className={styles.actions}>
                {!item.read ? <button title="Mark read" aria-label={`Mark ${item.title} read`} onClick={() => void markRead(item)}><Check size={17} /></button> : null}
                <button title="Delete" aria-label={`Delete ${item.title}`} onClick={() => void remove(item)}><Trash2 size={17} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
