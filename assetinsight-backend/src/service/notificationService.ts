/**
 * Persists an in-app notification before attempting transient push delivery. This
 * ordering guarantees users retain a durable notification even when Expo or individual
 * device tokens fail; push errors are therefore logged and intentionally not surfaced
 * as failures of the underlying business operation.
 */
import User from "../models/user.model.js";
import AppNotification from "../models/notification.model.js";
import { buildPushMessages, sendExpoPushNotifications } from "../utils/expoPush.js";

export type NotificationCategory = "crm" | "report";

type NotificationData = Record<string, unknown>;

export type NotifyUserInput = {
  userId: string;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  data?: NotificationData;
  tokens?: string[] | null;
  sendPush?: boolean;
  /** Narrow opt-in for delivery workflows with durable request identities. */
  notificationId?: string;
  /** A bounded push projection; persisted inbox content remains unchanged. */
  pushBody?: string;
  pushData?: NotificationData;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTokens(tokens?: string[] | null): string[] {
  return Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((token) => normalizeString(token))
        .filter(Boolean)
    )
  );
}

async function resolveTokens(userId: string, explicitTokens?: string[] | null): Promise<string[]> {
  const directTokens = normalizeTokens(explicitTokens);
  if (directTokens.length > 0) {
    return directTokens;
  }

  const user = await User.findById(userId).select("expoPushTokens").lean();
  return normalizeTokens(((user as any)?.expoPushTokens || []) as string[]);
}

export async function notifyUser(input: NotifyUserInput) {
  const userId = normalizeString(input.userId);
  if (!userId) {
    throw new Error("notifyUser requires userId");
  }

  const values = {
    user: userId,
    category: input.category,
    type: input.type,
    title: input.title,
    body: input.body,
    data: input.data || {},
  };
  let notification: any;
  if (input.notificationId) {
    const result = await AppNotification.updateOne({ _id: input.notificationId }, { $setOnInsert: values }, { upsert: true });
    notification = await AppNotification.findById(input.notificationId);
    if (!notification || String(notification.user) !== userId || notification.type !== input.type) {
      throw new Error("Notification delivery identity conflict");
    }
    // An ambiguous persistence retry can retrieve the same inbox item, but it
    // must not cause another push alert for that deterministic notification.
    if (result.upsertedCount !== 1) return notification;
  } else {
    notification = await AppNotification.create(values);
  }

  if (input.sendPush === false) {
    return notification;
  }

  try {
    const tokens = await resolveTokens(userId, input.tokens);
    if (tokens.length === 0) {
      return notification;
    }

    const pushData: NotificationData = {
      ...(input.pushData ?? input.data ?? {}),
      type: input.type,
      category: input.category,
      notificationId: String((notification as any)._id),
      createdAt: (notification as any).createdAt instanceof Date
        ? (notification as any).createdAt.toISOString()
        : new Date().toISOString(),
    };

    const messages = buildPushMessages(tokens, {
      title: input.title,
      body: input.pushBody ?? input.body,
      data: pushData,
      channelId: "app-notifications",
    });

    if (messages.length > 0) {
      await sendExpoPushNotifications(messages);
    }
  } catch (error) {
    console.error("[NotificationService] Push send failed", {
      userId,
      type: input.type,
      error,
    });
  }

  return notification;
}

export async function markNotificationAsReadForUser(notificationId: string, userId: string) {
  await AppNotification.updateOne(
    { _id: notificationId, user: userId, readAt: null, deletedAt: null },
    { $set: { readAt: new Date() } }
  );
}

export async function markAllNotificationsAsReadForUser(userId: string) {
  await AppNotification.updateMany(
    { user: userId, readAt: null, deletedAt: null },
    { $set: { readAt: new Date() } }
  );
}

export async function deleteNotificationForUser(notificationId: string, userId: string) {
  return AppNotification.updateOne(
    { _id: notificationId, user: userId, deletedAt: null },
    { $set: { deletedAt: new Date() } }
  );
}
