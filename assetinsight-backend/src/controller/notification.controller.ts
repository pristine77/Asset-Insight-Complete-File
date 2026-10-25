import { Response } from "express";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import AppNotification from "../models/notification.model.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import {
  deleteNotificationForUser,
  markAllNotificationsAsReadForUser,
  markNotificationAsReadForUser,
} from "../service/notificationService.js";

/**
 * Authenticated notification inbox and Expo push-token endpoints.
 *
 * Every inbox query is scoped to the current user. Mutation helpers receive both
 * notification and user identifiers so a guessed notification id cannot cross the
 * ownership boundary enforced by the service.
 */

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const registerPushToken = async (req: AuthRequest, res: Response) => {
  try {
    const token = normalizeString(req.body?.token);
    if (!token || !token.startsWith("ExponentPushToken[")) {
      return res.status(400).json({ message: "Invalid Expo push token" });
    }

    // `$addToSet` makes mobile retries idempotent and prevents duplicate deliveries
    // when the same installation registers its token more than once.
    await User.updateOne({ _id: req.userId }, { $addToSet: { expoPushTokens: token } });
    return res.status(200).json({ message: "Push token registered" });
  } catch (error) {
    console.error("registerPushToken error", error);
    return res.status(500).json({ message: "Failed to register push token" });
  }
};

export const unregisterPushToken = async (req: AuthRequest, res: Response) => {
  try {
    const token = normalizeString(req.body?.token);
    if (!token || !token.startsWith("ExponentPushToken[")) {
      return res.status(400).json({ message: "Invalid Expo push token" });
    }

    await User.updateOne({ _id: req.userId }, { $pull: { expoPushTokens: token } });
    return res.status(200).json({ message: "Push token unregistered" });
  } catch (error) {
    console.error("unregisterPushToken error", error);
    return res.status(500).json({ message: "Failed to unregister push token" });
  }
};

export const listNotifications = async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(parseInt(normalizeString(req.query.page) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(normalizeString(req.query.limit) || "50", 10) || 50, 1), 100);
    const skip = (page - 1) * limit;
    const inboxFilter = { user: req.userId, deletedAt: null };

    // The page, total and unread badge are computed from the same ownership/soft-delete
    // filter so the response remains internally consistent from the client's view.
    const [items, total, unreadCount] = await Promise.all([
      AppNotification.find(inboxFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AppNotification.countDocuments(inboxFilter),
      AppNotification.countDocuments({ ...inboxFilter, readAt: null }),
    ]);

    return res.status(200).json({
      items: (items || []).map((item: any) => ({
        id: String(item._id),
        category: item.category,
        type: item.type,
        title: item.title,
        body: item.body,
        data: item.data || {},
        createdAt: item.createdAt,
        readAt: item.readAt || null,
        read: Boolean(item.readAt),
      })),
      unreadCount,
      page,
      limit,
      total,
    });
  } catch (error) {
    console.error("listNotifications error", error);
    return res.status(500).json({ message: "Failed to load notifications" });
  }
};

/** Fetch durable message details after a bounded push envelope is opened. */
export const getNotification = async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  const id = normalizeString(req.params.id);
  if (!/^[a-f\d]{24}$/i.test(id) || !mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: "Notification not found" });
  }
  try {
    const item: any = await AppNotification.findOne({ _id: id, user: req.userId, deletedAt: null }).lean();
    if (!item) return res.status(404).json({ message: "Notification not found" });
    return res.json({ item: {
      id: String(item._id), category: item.category, type: item.type,
      title: item.title, body: item.body, data: item.data || {},
      createdAt: item.createdAt, readAt: item.readAt || null, read: Boolean(item.readAt),
    } });
  } catch {
    return res.status(500).json({ message: "Unable to load notification details" });
  }
};

export const markNotificationAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const notificationId = normalizeString(req.params.id);
    if (!notificationId) {
      return res.status(400).json({ message: "Notification id is required" });
    }

    await markNotificationAsReadForUser(notificationId, String(req.userId || ""));
    return res.status(200).json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("markNotificationAsRead error", error);
    return res.status(500).json({ message: "Failed to mark notification as read" });
  }
};

export const markAllNotificationsAsRead = async (req: AuthRequest, res: Response) => {
  try {
    await markAllNotificationsAsReadForUser(String(req.userId || ""));
    return res.status(200).json({ message: "Notifications marked as read" });
  } catch (error) {
    console.error("markAllNotificationsAsRead error", error);
    return res.status(500).json({ message: "Failed to mark notifications as read" });
  }
};

export const deleteNotification = async (req: AuthRequest, res: Response) => {
  try {
    const notificationId = normalizeString(req.params.id);
    if (!notificationId) {
      return res.status(400).json({ message: "Notification id is required" });
    }

    // Deletion is ownership-scoped and soft at the service layer, preserving audit
    // history while immediately removing the item from this user's inbox.
    const result = await deleteNotificationForUser(notificationId, String(req.userId || ""));
    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const inboxFilter = { user: req.userId, deletedAt: null };
    const [total, unreadCount] = await Promise.all([
      AppNotification.countDocuments(inboxFilter),
      AppNotification.countDocuments({ ...inboxFilter, readAt: null }),
    ]);

    return res.status(200).json({ message: "Notification deleted", unreadCount, total });
  } catch (error) {
    console.error("deleteNotification error", error);
    return res.status(500).json({ message: "Failed to delete notification" });
  }
};
