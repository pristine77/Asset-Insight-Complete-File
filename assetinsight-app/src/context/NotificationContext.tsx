import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import {
  deleteNotification as deleteNotificationRequest,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NotificationCategory,
  NotificationInboxResponse,
  NotificationItem,
  registerForPushNotifications,
  sendPushTokenToServer,
} from "../services/notificationService";
import { useAuth } from "./AuthContext";

interface NotificationContextType {
  notifications: NotificationItem[];
  unreadCount: number;
  totalCount: number;
  loading: boolean;
  refreshing: boolean;
  lastOpenedNotification: NotificationItem | null;
  refreshNotifications: () => Promise<void>;
  markAsRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  deleteNotification: (id: string) => Promise<void>;
  openNotification: (item: NotificationItem) => Promise<void>;
  clearLastOpenedNotification: () => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  totalCount: 0,
  loading: false,
  refreshing: false,
  lastOpenedNotification: null,
  refreshNotifications: async () => {},
  markAsRead: async () => {},
  markAllRead: async () => {},
  deleteNotification: async () => {},
  openNotification: async () => {},
  clearLastOpenedNotification: () => {},
});

function getNotificationCategory(data?: Record<string, unknown> | null): NotificationCategory {
  if (data?.category === "crm") return "crm";
  if (typeof data?.type === "string" && data.type.startsWith("crm_")) return "crm";
  return "report";
}

function buildNotificationItem(notification: Notifications.Notification, read: boolean): NotificationItem {
  const content = notification.request.content;
  const rawData = (content.data as Record<string, unknown>) || {};
  const notificationId =
    typeof rawData.notificationId === "string" && rawData.notificationId
      ? rawData.notificationId
      : notification.request.identifier;
  const createdAt =
    typeof rawData.createdAt === "string" && rawData.createdAt
      ? rawData.createdAt
      : new Date().toISOString();

  return {
    id: notificationId,
    category: getNotificationCategory(rawData),
    type: typeof rawData.type === "string" ? rawData.type : "",
    title: content.title || "Notification",
    body: content.body || "",
    requiresDetails: rawData.type === "preview_review_reminder",
    data: rawData,
    createdAt,
    read,
    readAt: read ? new Date().toISOString() : null,
  };
}

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastOpenedNotification, setLastOpenedNotification] = useState<NotificationItem | null>(null);
  const notificationListener = useRef<Notifications.Subscription | null>(null);
  const responseListener = useRef<Notifications.Subscription | null>(null);
  const notificationsRef = useRef<NotificationItem[]>([]);
  const unreadCountRef = useRef(0);
  const totalCountRef = useRef(0);
  const lastHandledNotificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  useEffect(() => {
    unreadCountRef.current = unreadCount;
    void Notifications.setBadgeCountAsync(Math.max(0, unreadCount)).catch((error) => {
      console.error("[Notifications] Failed to update badge count:", error);
    });
    if (unreadCount === 0) {
      void Notifications.dismissAllNotificationsAsync().catch((error) => {
        console.error("[Notifications] Failed to clear delivered notifications:", error);
      });
    }
  }, [unreadCount]);

  const applyInbox = useCallback((response: NotificationInboxResponse) => {
    notificationsRef.current = response.items;
    unreadCountRef.current = response.unreadCount;
    totalCountRef.current = response.total;
    setNotifications(response.items);
    setUnreadCount(response.unreadCount);
    setTotalCount(response.total);
  }, []);

  const refreshNotifications = useCallback(async () => {
    if (!user?._id) {
      setNotifications([]);
      setUnreadCount(0);
      setTotalCount(0);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    try {
      const response = await fetchNotifications({ limit: 100 });
      applyInbox(response);
    } catch (error) {
      console.error("[Notifications] Failed to fetch inbox:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyInbox, user?._id]);

  const silentRefreshNotifications = useCallback(async () => {
    if (!user?._id) return;
    try {
      const response = await fetchNotifications({ limit: 100 });
      applyInbox(response);
    } catch (error) {
      console.error("[Notifications] Silent refresh failed:", error);
    } finally {
      setLoading(false);
    }
  }, [applyInbox, user?._id]);

  const markAsRead = useCallback(async (id: string) => {
    if (!id) return;

    const existing = notificationsRef.current.find((entry) => entry.id === id);
    if (existing && !existing.read) {
      const nextUnreadCount = Math.max(0, unreadCountRef.current - 1);
      unreadCountRef.current = nextUnreadCount;
      setUnreadCount(nextUnreadCount);
    }

    setNotifications((prev) => {
      const nextNotifications = prev.map((entry) =>
        entry.id === id && !entry.read
          ? { ...entry, read: true, readAt: new Date().toISOString() }
          : entry
      );
      notificationsRef.current = nextNotifications;
      return nextNotifications;
    });

    try {
      await markNotificationRead(id);
      await silentRefreshNotifications();
    } catch (error) {
      console.error("[Notifications] Failed to mark notification as read:", error);
      await silentRefreshNotifications();
    }
  }, [silentRefreshNotifications]);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => {
      const nextNotifications = prev.map((entry) => ({
        ...entry,
        read: true,
        readAt: entry.readAt || new Date().toISOString(),
      }));
      notificationsRef.current = nextNotifications;
      return nextNotifications;
    });
    unreadCountRef.current = 0;
    setUnreadCount(0);

    try {
      await markAllNotificationsRead();
      await silentRefreshNotifications();
    } catch (error) {
      console.error("[Notifications] Failed to mark all notifications as read:", error);
      await silentRefreshNotifications();
    }
  }, [silentRefreshNotifications]);

  const deleteNotification = useCallback(async (id: string) => {
    if (!id) return;

    const existing = notificationsRef.current.find((entry) => entry.id === id);
    const nextNotifications = notificationsRef.current.filter((entry) => entry.id !== id);
    notificationsRef.current = nextNotifications;
    setNotifications(nextNotifications);
    const nextTotalCount = Math.max(0, totalCountRef.current - (existing ? 1 : 0));
    totalCountRef.current = nextTotalCount;
    setTotalCount(nextTotalCount);

    if (existing && !existing.read) {
      const nextUnreadCount = Math.max(0, unreadCountRef.current - 1);
      unreadCountRef.current = nextUnreadCount;
      setUnreadCount(nextUnreadCount);
    }

    try {
      const result = await deleteNotificationRequest(id);
      if (result && Number.isFinite(result.unreadCount)) {
        const nextUnreadCount = Math.max(0, result.unreadCount);
        unreadCountRef.current = nextUnreadCount;
        setUnreadCount(nextUnreadCount);
      }
      if (result && Number.isFinite(result.total)) {
        const serverTotalCount = Math.max(0, result.total);
        totalCountRef.current = serverTotalCount;
        setTotalCount(serverTotalCount);
      }
      await silentRefreshNotifications();
    } catch (error) {
      console.error("[Notifications] Failed to delete notification:", error);
      await silentRefreshNotifications();
    }
  }, [silentRefreshNotifications]);

  const openNotification = useCallback(async (item: NotificationItem) => {
    const nextItem = notificationsRef.current.find((entry) => entry.id === item.id) || item;

    if ((nextItem.type || nextItem.data?.type) === "preview_review_reminder") {
      // Saved guidance must remain readable even while a read receipt is offline.
      setLastOpenedNotification({
        ...nextItem,
        read: true,
        readAt: nextItem.readAt || new Date().toISOString(),
      });
      if (!nextItem.read && nextItem.id) void markAsRead(nextItem.id);
      return;
    }

    if (!nextItem.read && nextItem.id) {
      await markAsRead(nextItem.id);
    }

    setLastOpenedNotification({
      ...nextItem,
      read: true,
      readAt: nextItem.readAt || new Date().toISOString(),
    });
  }, [markAsRead]);

  const clearLastOpenedNotification = useCallback(() => {
    setLastOpenedNotification(null);
  }, []);

  useEffect(() => {
    if (!user?._id) {
      setNotifications([]);
      setUnreadCount(0);
      setTotalCount(0);
      setLastOpenedNotification(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      setLoading(true);

      const token = await registerForPushNotifications();
      if (!cancelled && token) {
        await sendPushTokenToServer(token);
      }

      if (!cancelled) {
        await silentRefreshNotifications();
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [silentRefreshNotifications, user?._id]);

  useEffect(() => {
    if (!user?._id) return;

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void silentRefreshNotifications();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [silentRefreshNotifications, user?._id]);

  useEffect(() => {
    notificationListener.current = Notifications.addNotificationReceivedListener(() => {
      void silentRefreshNotifications();
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const interactedItem = buildNotificationItem(response.notification, true);
      if (lastHandledNotificationIdRef.current === interactedItem.id) {
        return;
      }

      lastHandledNotificationIdRef.current = interactedItem.id;
      void silentRefreshNotifications();
      void openNotification(interactedItem);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response?.notification) return;

        const interactedItem = buildNotificationItem(response.notification, true);
        if (lastHandledNotificationIdRef.current === interactedItem.id) {
          return;
        }

        lastHandledNotificationIdRef.current = interactedItem.id;
        void silentRefreshNotifications();
        void openNotification(interactedItem);
      })
      .catch((error) => {
        console.error("[Notifications] Failed to get last notification response:", error);
      });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, [openNotification, silentRefreshNotifications]);

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      totalCount,
      loading,
      refreshing,
      lastOpenedNotification,
      refreshNotifications,
      markAsRead,
      markAllRead,
      deleteNotification,
      openNotification,
      clearLastOpenedNotification,
    }),
    [
      clearLastOpenedNotification,
      deleteNotification,
      lastOpenedNotification,
      loading,
      markAllRead,
      markAsRead,
      notifications,
      openNotification,
      refreshNotifications,
      refreshing,
      totalCount,
      unreadCount,
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
