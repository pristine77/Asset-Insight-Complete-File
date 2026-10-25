import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  addBulkCrmTasksToMsOutlookCalendar,
  addCrmTaskToMsOutlookCalendar,
  addCrmLeadReplyForAdmin,
  autoFindCrmClientsForAdmin,
  deleteCrmImportFileAndLeads,
  deleteCrmLeadForAdmin,
  deleteCrmLeadUpdateAttachmentsForAdmin,
  deleteCrmLeadUpdateForAdmin,
  deleteCrmLeadUpdateRecordingForAdmin,
  deleteCrmTaskUpdate,
  deleteCrmTaskUpdateAttachments,
  deleteCrmTaskUpdateRecording,
  disconnectMsOutlookCalendar,
  editCrmLeadUpdateForAdmin,
  editCrmTaskUpdate,
  getCrmLeadDetailsForAdmin,
  getCrmAutoFindOptionsForAdmin,
  getCrmImportJobForAdmin,
  getCrmAutoFindRunForAdmin,
  getRevenueRadarForAdmin,
  updateCrmLeadForAdmin,
  getMsOutlookCalendarAuthUrl,
  getMsOutlookCalendarStatus,
  getMyCrmTransferRequests,
  getMyCrmDashboard,
  getMyCrmFollowUps,
  getMyCrmTasks,
  getMyCrmTaskDetails,
  getMyCrmTaskUpdates,
  importCrmLeadsFromExcel,
  importAutoFoundCrmClientsForAdmin,
  listCrmAssignmentUploadLeadsForAdmin,
  listCrmAssignmentsByUpload,
  listCrmTransfersForAdmin,
  listCrmTransferAgents,
  listCrmImportFilesForAdmin,
  listCrmImportJobsForAdmin,
  listCrmLeadsForAdmin,
  listCrmUsers,
  msOutlookCalendarOAuthCallback,
  registerPushToken,
  reassignCrmAssignmentUploadLeadsForAdmin,
  reassignCrmLeadsNearestForAdmin,
  requestCrmTaskTransfer,
  respondCrmTaskTransferRequest,
  setCrmAgentStatus,
  quickAddCrmLeadForAdmin,
  quickAddMyCrmLead,
  startRevenueRadarSearchForAdmin,
  stopCrmAutoFindRunForAdmin,
  updateCrmUserProfile,
  rewriteEmailWithAI,
  submitCrmTaskUpdate,
  transcribeCrmCommentAudio,
} from "../controller/crm.controller.js";
import { adminProtect, requireSuperadmin } from "../middleware/admin.middleware.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

const memoryStorage = multer.memoryStorage();

const crmImportTempDirectory = path.join(os.tmpdir(), "asset-insight-crm-imports");
fs.mkdirSync(crmImportTempDirectory, { recursive: true });

// Keep large workbooks out of the API heap. The controller streams this
// temporary file to R2 before enqueueing the durable import job.
const crmImportDiskStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, crmImportTempDirectory),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    callback(null, `${Date.now()}-${randomUUID()}${extension}`);
  },
});

const excelUpload = multer({
  storage: crmImportDiskStorage,
  // The controller's shared parser owns extension, MIME, and signature checks so
  // every rejected upload returns the same stable JSON error contract.
  fileFilter: (_req, _file, cb) => cb(null, true),
  limits: {
    fileSize: Number(process.env.CRM_IMPORT_MAX_UPLOAD_BYTES || 150 * 1024 * 1024),
  },
});

const spreadsheetUpload = (req: Request, res: Response, next: NextFunction) => {
  excelUpload.single("file")(req, res, (error: any) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        code: "FILE_TOO_LARGE",
        message: "The spreadsheet exceeds the CRM upload size limit.",
      });
    }
    return res.status(400).json({
      code: "INVALID_FILE_TYPE",
      message: "The spreadsheet upload could not be read.",
    });
  });
};

const crmTaskUpdateUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 15,
  },
});

const crmCommentTranscriptionUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

// Admin & Superadmin CRM management
router.get("/admin/users", adminProtect, listCrmUsers);
router.patch("/admin/users/:id/agent", adminProtect, setCrmAgentStatus);
router.patch("/admin/users/:id/crm-profile", adminProtect, updateCrmUserProfile);
router.post(
  "/admin/leads/import",
  adminProtect,
  spreadsheetUpload,
  importCrmLeadsFromExcel
);
router.get("/admin/leads/auto-find/options", adminProtect, getCrmAutoFindOptionsForAdmin);
router.post("/admin/leads/auto-find", adminProtect, autoFindCrmClientsForAdmin);
router.get("/admin/leads/auto-find/runs/:runId", adminProtect, getCrmAutoFindRunForAdmin);
router.post("/admin/leads/auto-find/runs/:runId/stop", adminProtect, stopCrmAutoFindRunForAdmin);
router.post("/admin/leads/auto-find/import", adminProtect, importAutoFoundCrmClientsForAdmin);
router.get("/admin/leads/import-jobs", adminProtect, listCrmImportJobsForAdmin);
router.get("/admin/leads/import-jobs/:jobId", adminProtect, getCrmImportJobForAdmin);
router.get(
  "/admin/revenue-radar",
  adminProtect,
  requireSuperadmin,
  getRevenueRadarForAdmin
);
router.post(
  "/admin/revenue-radar/search",
  adminProtect,
  requireSuperadmin,
  startRevenueRadarSearchForAdmin
);

// Admin & Superadmin CRM lead monitoring
router.get("/admin/leads", adminProtect, listCrmLeadsForAdmin);
router.post("/admin/leads/quick-add", adminProtect, quickAddCrmLeadForAdmin);
router.post("/admin/leads/reassign-nearest", adminProtect, reassignCrmLeadsNearestForAdmin);
router.get("/admin/leads/:id", adminProtect, getCrmLeadDetailsForAdmin);
router.patch("/admin/leads/:id", adminProtect, updateCrmLeadForAdmin);
router.delete("/admin/leads/:id", adminProtect, deleteCrmLeadForAdmin);
router.post("/admin/leads/:id/reply", adminProtect, addCrmLeadReplyForAdmin);
router.patch("/admin/leads/:id/updates/:updateId", adminProtect, editCrmLeadUpdateForAdmin);
router.delete("/admin/leads/:id/updates/:updateId", adminProtect, deleteCrmLeadUpdateForAdmin);
router.delete(
  "/admin/leads/:id/updates/:updateId/attachments",
  adminProtect,
  deleteCrmLeadUpdateAttachmentsForAdmin
);
router.delete(
  "/admin/leads/:id/updates/:updateId/recording",
  adminProtect,
  deleteCrmLeadUpdateRecordingForAdmin
);
router.get("/admin/import-files", adminProtect, listCrmImportFilesForAdmin);
router.get("/admin/assignments-by-upload", adminProtect, listCrmAssignmentsByUpload);
router.get("/admin/assignments-by-upload/:sourceBatchId/leads", adminProtect, listCrmAssignmentUploadLeadsForAdmin);
router.patch("/admin/assignments-by-upload/:sourceBatchId/reassign", adminProtect, reassignCrmAssignmentUploadLeadsForAdmin);
router.get("/admin/transfers", adminProtect, listCrmTransfersForAdmin);
router.delete("/admin/import-files/:batchId", adminProtect, requireSuperadmin, deleteCrmImportFileAndLeads);

// CRM agent app endpoints
router.get("/tasks/dashboard", protect, getMyCrmDashboard);
router.get("/tasks/follow-ups", protect, getMyCrmFollowUps);
router.get("/tasks/my", protect, getMyCrmTasks);
router.post("/tasks/quick-add", protect, quickAddMyCrmLead);
router.get("/calendar/ms/outlook/status", protect, getMsOutlookCalendarStatus);
router.get("/calendar/ms/outlook/auth-url", protect, getMsOutlookCalendarAuthUrl);
router.get("/calendar/ms/outlook/callback", msOutlookCalendarOAuthCallback);
router.delete("/calendar/ms/outlook/disconnect", protect, disconnectMsOutlookCalendar);
router.post("/tasks/:id/calendar/ms/outlook", protect, addCrmTaskToMsOutlookCalendar);
router.post("/tasks/calendar/ms/outlook/bulk", protect, addBulkCrmTasksToMsOutlookCalendar);
router.get("/tasks/transfer/agents", protect, listCrmTransferAgents);
router.post("/tasks/:id/transfer", protect, requestCrmTaskTransfer);
router.get("/tasks/transfers/my", protect, getMyCrmTransferRequests);
router.get("/tasks/:id/updates", protect, getMyCrmTaskUpdates);
router.get("/tasks/:id", protect, getMyCrmTaskDetails);
router.patch("/tasks/transfers/:requestId", protect, respondCrmTaskTransferRequest);
router.post(
  "/tasks/comment/transcribe",
  protect,
  crmCommentTranscriptionUpload.single("audio"),
  transcribeCrmCommentAudio
);
router.patch(
  "/tasks/:id/update",
  protect,
  crmTaskUpdateUpload.fields([
    { name: "attachments", maxCount: 10 },
    { name: "recording", maxCount: 1 },
  ]),
  submitCrmTaskUpdate
);
router.patch("/tasks/:id/updates/:updateId", protect, editCrmTaskUpdate);
router.delete("/tasks/:id/updates/:updateId", protect, deleteCrmTaskUpdate);
router.delete("/tasks/:id/updates/:updateId/attachments", protect, deleteCrmTaskUpdateAttachments);
router.delete("/tasks/:id/updates/:updateId/recording", protect, deleteCrmTaskUpdateRecording);
router.post("/tasks/email/rewrite", protect, rewriteEmailWithAI);
router.post("/push-token", protect, registerPushToken);

export default router;
