import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  deleteNotification,
  listNotifications,
  getNotification,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  registerPushToken,
  unregisterPushToken,
} from "../controller/notification.controller.js";

const router = Router();

router.post("/push-token", protect, registerPushToken);
router.delete("/push-token", protect, unregisterPushToken);
router.get("/", protect, listNotifications);
router.get("/:id", protect, getNotification);
router.patch("/read-all", protect, markAllNotificationsAsRead);
router.patch("/:id/read", protect, markNotificationAsRead);
router.delete("/:id", protect, deleteNotification);

export default router;
