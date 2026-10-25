import { Router } from "express";
import {
  getAdminSupportActivity,
  getAdminSupportAgents,
  getAdminSupportConversationById,
  getAdminSupportConversations,
  getAdminSupportDashboard,
  getAdminSupportMessages,
  getAdminSupportTodoQueue,
  getAdminSupportTodos,
  getSupportConversationById,
  getSupportConversations,
  getSupportMessages,
  getSupportUploadConstraints,
  patchAdminSupportConversation,
  patchAdminSupportTodo,
  postAdminSupportAttachmentConfirm,
  postAdminSupportAttachmentPresign,
  postAdminSupportAttachmentUpload,
  postAdminSupportMessage,
  postAdminSupportNote,
  postAdminSupportRead,
  postAdminSupportTodo,
  postSupportAttachmentConfirm,
  postSupportAttachmentPresign,
  postSupportAttachmentUpload,
  postSupportConversation,
  postSupportMessage,
  postSupportRead,
} from "../controller/support.controller.js";
import {
  adminProtect,
  requireSupportDeveloper,
} from "../middleware/admin.middleware.js";
import { protect } from "../middleware/auth.middleware.js";
import {
  getAnnouncementRecipients,
  getAnnouncements,
  postAnnouncement,
} from "../controller/announcement.controller.js";

const router = Router();

// Authenticate and authorize the entire developer namespace in one place. The
// capability check intentionally reads req.user populated by adminProtect, so
// revocation takes effect on the next request even while an old JWT is valid.
// Keep this prefix before parameterized customer routes so "admin" is never
// interpreted as a conversation identifier.
router.use("/admin", adminProtect, requireSupportDeveloper);

router.get("/admin/constraints", getSupportUploadConstraints);
router.get("/admin/announcements/recipients", getAnnouncementRecipients);
router.get("/admin/announcements", getAnnouncements);
router.post("/admin/announcements", postAnnouncement);
router.get("/admin/agents", getAdminSupportAgents);
router.get("/admin/dashboard", getAdminSupportDashboard);
router.get("/admin/todos", getAdminSupportTodoQueue);
router.get("/admin/conversations", getAdminSupportConversations);
router.get(
  "/admin/conversations/:conversationId",
  getAdminSupportConversationById
);
router.patch(
  "/admin/conversations/:conversationId",
  patchAdminSupportConversation
);
router.get(
  "/admin/conversations/:conversationId/messages",
  getAdminSupportMessages
);
router.post(
  "/admin/conversations/:conversationId/messages",
  postAdminSupportMessage
);
router.post(
  "/admin/conversations/:conversationId/notes",
  postAdminSupportNote
);
router.post(
  "/admin/conversations/:conversationId/read",
  postAdminSupportRead
);
router.post(
  "/admin/conversations/:conversationId/attachments/upload",
  postAdminSupportAttachmentUpload
);
router.post(
  "/admin/conversations/:conversationId/attachments/presign",
  postAdminSupportAttachmentPresign
);
router.post(
  "/admin/conversations/:conversationId/attachments/:attachmentId/confirm",
  postAdminSupportAttachmentConfirm
);
router.get(
  "/admin/conversations/:conversationId/todos",
  getAdminSupportTodos
);
router.post(
  "/admin/conversations/:conversationId/todos",
  postAdminSupportTodo
);
router.patch(
  "/admin/conversations/:conversationId/todos/:todoId",
  patchAdminSupportTodo
);
router.get(
  "/admin/conversations/:conversationId/activity",
  getAdminSupportActivity
);

router.get("/constraints", protect, getSupportUploadConstraints);
router.get("/conversations", protect, getSupportConversations);
router.post("/conversations", protect, postSupportConversation);
router.get("/conversations/:conversationId", protect, getSupportConversationById);
router.get("/conversations/:conversationId/messages", protect, getSupportMessages);
router.post("/conversations/:conversationId/messages", protect, postSupportMessage);
router.post("/conversations/:conversationId/read", protect, postSupportRead);
router.post(
  "/conversations/:conversationId/attachments/upload",
  protect,
  postSupportAttachmentUpload
);
router.post(
  "/conversations/:conversationId/attachments/presign",
  protect,
  postSupportAttachmentPresign
);
router.post(
  "/conversations/:conversationId/attachments/:attachmentId/confirm",
  protect,
  postSupportAttachmentConfirm
);

export default router;
