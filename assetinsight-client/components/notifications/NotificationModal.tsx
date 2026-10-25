"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bell, CheckCheck, ChevronRight, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import {
  notificationCacheKey,
  NotificationsService,
  type WorkspaceNotification,
} from "@/services/notifications";
import styles from "./NotificationModal.module.css";
import { previewReminderDetails } from "@/lib/previewReminderNotification";
import { crmNotificationHref } from "@/lib/crmNotification";
import PreviewReminderContent from "./PreviewReminderContent";
import { useAuthContext } from "@/context/AuthContext";

function notificationHref(item: WorkspaceNotification) {
  const crmHref = crmNotificationHref(item);
  if (crmHref) return crmHref;
  const data = item.data || {};
  for (const key of ["href", "url", "path", "route"] as const) {
    const value = data[key];
    if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) {
      return value;
    }
  }
  return "/reports";
}

function relativeDate(value: string) {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

export default function NotificationModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuthContext();
  const ownerId = user?._id || user?.id;
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<WorkspaceNotification | null>(null);
  const returnFocusRef = useRef<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const cacheKey = ownerId ? notificationCacheKey(1, 10, ownerId) : null;
  const { data, isLoading, error } = useSWR(cacheKey, () => NotificationsService.list(1, 10), {
    revalidateOnFocus: true,
  });

  useEffect(() => {
    const previous = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && panelRef.current) {
        const controls = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex='0']"));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const items = useMemo(() => data?.items || [], [data?.items]);

  useEffect(() => {
    if (selected) detailRef.current?.focus();
    else if (returnFocusRef.current) {
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-notification-id]") || [])
        .find((element) => element.dataset.notificationId === returnFocusRef.current)?.focus();
    }
  }, [selected]);

  const refreshNotificationCaches = async () => {
    await mutate((key) => typeof key === "string" && key.startsWith("/notifications?") && key.endsWith(`&cacheOwner=${encodeURIComponent(ownerId || "")}`));
  };

  const markRead = async (item: WorkspaceNotification) => {
    if (!item.read) {
      try {
        await NotificationsService.markRead(item.id);
        await refreshNotificationCaches();
      } catch { /* Keep the full message readable during an offline read receipt. */ }
    }
  };

  const markAllRead = async () => {
    await NotificationsService.markAllRead();
    await refreshNotificationCaches();
  };

  const remove = async (item: WorkspaceNotification) => {
    await NotificationsService.remove(item.id);
    await refreshNotificationCaches();
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-modal-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <span className={styles.iconFrame} aria-hidden><Bell size={19} /></span>
            <div>
              <h2 id="notification-modal-title">Notifications</h2>
              <p>{data?.unreadCount || 0} unread</p>
            </div>
          </div>
          <div className={styles.headerActions}>
            {(data?.unreadCount || 0) > 0 ? (
              <button type="button" className={styles.textButton} onClick={() => void markAllRead()}>
                <CheckCheck size={16} /> Mark all read
              </button>
            ) : null}
            <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close notifications">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className={styles.list}>
          {selected ? <div ref={detailRef} tabIndex={-1} className={styles.messagePane}>
            <button type="button" className={styles.backButton} onClick={() => setSelected(null)}><ArrowLeft size={16} /> Back to notifications</button>
            <PreviewReminderContent item={selected} onOpenPreview={onClose} />
          </div> : isLoading ? (
            Array.from({ length: 4 }).map((_, index) => <div className={styles.skeleton} key={index} />)
          ) : error ? (
            <div className={styles.state}>Notifications could not be loaded. Try again shortly.</div>
          ) : items.length === 0 ? (
            <div className={styles.state}><Bell size={28} /><strong>You are all caught up</strong><span>New report and CRM updates will appear here.</span></div>
          ) : (
            items.map((item) => (
              <article className={styles.item} data-unread={!item.read} key={item.id}>
                <Link
                  className={styles.itemLink}
                  data-notification-id={item.id}
                  href={notificationHref(item)}
                  onClick={(event) => {
                    void markRead(item);
                    if (previewReminderDetails(item)) {
                      event.preventDefault();
                      returnFocusRef.current = item.id;
                      setSelected(item);
                    } else onClose();
                  }}
                >
                  <span className={styles.unreadDot} aria-hidden />
                  <span className={styles.itemCopy}>
                    <strong>{item.title}</strong>
                    <span>{item.body}</span>
                    <small>{relativeDate(item.createdAt)}</small>
                  </span>
                  <ChevronRight size={17} aria-hidden />
                </Link>
                <button type="button" className={styles.deleteButton} onClick={() => void remove(item)} aria-label={`Delete ${item.title}`}>
                  <Trash2 size={15} />
                </button>
              </article>
            ))
          )}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            onClick={() => {
              router.push("/notifications");
              onClose();
            }}
          >
            Open notification center <ChevronRight size={16} />
          </button>
        </footer>
      </div>
    </div>
  );
}
