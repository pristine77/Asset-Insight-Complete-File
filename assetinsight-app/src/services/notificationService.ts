import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import api from "./api";

const PUSH_TOKEN_STORAGE_KEY = "cv_expo_push_token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type NotificationCategory = "crm" | "report";

export type NotificationItem = {
  id: string;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  createdAt: string;
  read: boolean;
  readAt?: string | null;
  /** Push envelopes contain no full message; hydrate through the owner-only API. */
  requiresDetails?: boolean;
};

export type NotificationInboxResponse = {
  items: NotificationItem[];
  unreadCount: number;
  page: number;
  limit: number;
  total: number;
};

export type NotificationDeleteResponse = {
  unreadCount: number;
  total: number;
};

function normalizeNotificationItem(item: any): NotificationItem {
  return {
    id: String(item?.id || item?._id || ""),
    category: item?.category === "crm" ? "crm" : "report",
    type: typeof item?.type === "string" ? item.type : "",
    title: typeof item?.title === "string" ? item.title : "Notification",
    body: typeof item?.body === "string" ? item.body : "",
    data: item?.data && typeof item.data === "object" ? item.data : {},
    createdAt:
      typeof item?.createdAt === "string" && item.createdAt
        ? item.createdAt
        : new Date().toISOString(),
    read: Boolean(item?.read || item?.readAt),
    readAt: typeof item?.readAt === "string" ? item.readAt : null,
  };
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log("[Notifications] Must use physical device for push notifications");
    return null;
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("[Notifications] Permission not granted");
      return null;
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: projectId || undefined,
    });
    const token = tokenData.data;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("app-notifications", {
        name: "App Notifications",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#2563EB",
        sound: "default",
      });
    }

    return token;
  } catch (error) {
    console.error("[Notifications] Failed to register:", error);
    return null;
  }
}

export async function sendPushTokenToServer(token: string): Promise<void> {
  try {
    await api.post("/notifications/push-token", { token });
    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
  } catch (error) {
    console.error("[Notifications] Failed to send token to server:", error);
  }
}

export async function unregisterStoredPushTokenFromServer(): Promise<void> {
  const token = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);

  try {
    if (token) {
      await api.delete("/notifications/push-token", {
        data: { token },
      });
    }
  } catch (error) {
    console.error("[Notifications] Failed to unregister token:", error);
  } finally {
    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
  }
}

export async function fetchNotifications(params?: {
  page?: number;
  limit?: number;
}): Promise<NotificationInboxResponse> {
  const { data } = await api.get("/notifications", {
    params: {
      page: params?.page || 1,
      limit: params?.limit || 50,
    },
  });

  return {
    items: Array.isArray(data?.items) ? data.items.map(normalizeNotificationItem) : [],
    unreadCount: Number(data?.unreadCount || 0),
    page: Number(data?.page || 1),
    limit: Number(data?.limit || params?.limit || 50),
    total: Number(data?.total || 0),
  };
}

export async function markNotificationRead(id: string): Promise<void> {
  await api.patch(`/notifications/${encodeURIComponent(id)}/read`);
}

export async function fetchNotification(id: string, signal?: AbortSignal): Promise<NotificationItem> {
  const { data } = await api.get(`/notifications/${encodeURIComponent(id)}`, { signal });
  if (!data?.item || String(data.item.id || data.item._id || "") !== id || typeof data.item.body !== "string" || !data.item.body.trim()) {
    throw new Error("Notification details are unavailable");
  }
  return normalizeNotificationItem(data.item);
}

export async function markAllNotificationsRead(): Promise<void> {
  await api.patch("/notifications/read-all");
}

export async function deleteNotification(id: string): Promise<NotificationDeleteResponse | null> {
  const { data } = await api.delete(`/notifications/${encodeURIComponent(id)}`);
  if (!data || typeof data !== "object") {
    return null;
  }
  if (data.unreadCount === undefined && data.total === undefined) {
    return null;
  }

  return {
    unreadCount: Number(data.unreadCount || 0),
    total: Number(data.total || 0),
  };
}
