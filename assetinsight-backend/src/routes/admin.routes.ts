import express, { NextFunction, Request, Response } from "express";
import { adminLogin, me, getAdmins, postAdmin, deleteAdmin, blockAdmin, changeAdminPassword, getAdminReports, getSameContractReports, archiveAdminReport, restoreAdminReport, getAdminStats, getDesktopDashboardStats, getDashboardAnalytics, refreshAdminToken, getUsers, getAdminUserProfile, updateAdminUserProfile, getReportCreators, getReportApprovers, updateUserReportApprover, getReleaseManagers, updateUserReleaseManager, getPreviewSupervisorSetting, updatePreviewSupervisorSetting, releaseAdminReport, blockUserByAdmin, deleteUserByAdmin, getMonthlyStats, approveLotListing, declineLotListing, getSpecWebSearchSetting, updateSpecWebSearchSetting, getAssetApprovalThresholdSetting, updateAssetApprovalThresholdSetting } from "../controller/admin.controller.js";
import {
  downloadReport,
  deleteReport,
  getReportPreview,
  getAdminCrDisclaimers,
  rerunAdminExcelAndCr,
  saveAdminCrDisclaimers,
  downloadAdminCrDocx,
  downloadAdminSpecPdf,
  streamAdminSpecPdf,
  saveAssetAdminScheduleSheet,
} from "../controller/pdfReport.controller.js";
import { adminProtect, requireSuperadmin } from "../middleware/admin.middleware.js";
import { requireAccessibleAdminReport } from "../middleware/adminReportAccess.middleware.js";
import { getPendingReports, approveReport, rejectReport } from "../controller/approval.controller.js";
import {
  listApiKeys,
  postApiKey,
  renameApiKey,
  revokeApiKey,
} from "../controller/apiKey.controller.js";
import { getReportJobStats } from "../controller/reportJob.controller.js";
import upload, { apkReleaseUpload } from "../utils/multerStorage.js";
import {
  addSpecSheetField,
  bulkSaveSpecSheetFields,
  createSpecSheetCategory,
  createSpecSheetParent,
  deleteSpecSheetCategory,
  deleteSpecSheetField,
  deleteSpecSheetParent,
  extractSpecSheetFields,
  getSpecSheetRegistryJson,
  importSpecSheetWorkbook,
  listSpecSheetCategories,
  listSpecSheetParents,
  reorderSpecSheetFields,
  updateSpecSheetCategory,
  updateSpecSheetField,
  updateSpecSheetParent,
} from "../controller/specSheet.controller.js";
import {
  apkUploadTokenProtect,
  completeAdminApkRelease,
  createAdminApkUploadToken,
  listAdminApkReleases,
  uploadAdminApkRelease,
} from "../controller/appVersion.controller.js";
import {
  getPerformanceStats,
  getPerformanceUserStats,
} from "../controller/admin.controller.js";
import {
  approveDevice,
  blockDeviceIp,
  deleteDeviceRegistration,
  getDeviceDetail,
  getDeviceSecuritySettings,
  getDeviceSummary,
  listDeviceIps,
  listDevices,
  manuallyBlockDeviceIp,
  rejectDevice,
  restoreDevice,
  revokeDevice,
  unblockDeviceIp,
  updateDeviceApprovalPolicy,
  updateDeviceSecuritySettings,
} from "../controller/adminDevice.controller.js";
import {
  getAdminExcelConditionReports,
  patchAdminExcelConditionReports,
  regenerateAdminExcel,
} from "../controller/excelConditionReport.controller.js";
import {
  deleteAdminDraftPreview,
  deleteAdminPreviewReport,
  getAdminDraftPreviews,
  getAdminPreviewReport,
  getAdminPreviewReports,
  getAdminPreviewTransferUsers,
  getAdminPreviewReminder,
  sendAdminPreviewReminder,
  resubmitAdminPreviewReport,
  transferAdminPreviewReport,
} from "../controller/adminPreviewReports.controller.js";
import {
  downloadReleasedAppraisalArtifact,
  getReleasedAppraisalAnalysis,
  listReleasedAppraisals,
  requestReleasedAppraisalAnalysis,
} from "../controller/releasedAppraisal.controller.js";
import {
  exportAdminProposalValuationExcel,
  getAdminProposalValuationEvaluatorOptions,
} from "../controller/assetProposalValuation.controller.js";
import { getAdminCaptureInventories, getAdminCaptureUsers, getAdminCaptureDetail, deleteAdminCaptureHistory } from "../controller/captureInventory.controller.js";

const router = express.Router();

const handleApkReleaseUpload = (req: Request, res: Response, next: NextFunction) => {
  apkReleaseUpload.single("apk")(req, res, (error: any) => {
    if (!error) return next();
    const status = error?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const interrupted = /unexpected end|aborted|premature/i.test(String(error?.message || ""));
    return res.status(status).json({
      message: interrupted
        ? "The APK upload was interrupted before completion. Please retry the upload."
        : error?.message || "Failed to receive APK upload",
    });
  });
};

// Admin login (only admin or superadmin roles)
router.post("/login", adminLogin);
// Refresh access token using refresh token
router.post("/refresh", refreshAdminToken);

// Who am I (requires admin)
router.get("/me", adminProtect, me);

// Operational capture metadata is available to both administrator roles.
router.get("/capture-inventory/users", adminProtect, getAdminCaptureUsers);
router.get("/report-activity/users", adminProtect, getAdminCaptureUsers);
router.get("/report-activity", adminProtect, listReportActivity);
router.get("/report-activity/:id/events", adminProtect, getReportActivityEvents);
router.get("/report-activity/:id/lots", adminProtect, getReportActivityLots);
router.get("/report-activity/:id", adminProtect, getReportActivity);
router.delete("/report-activity/:id", adminProtect, requireSuperadmin, removeReportActivity);
router.get("/capture-inventory", adminProtect, getAdminCaptureInventories);
router.get("/capture-inventory/:id", adminProtect, getAdminCaptureDetail);
router.delete("/capture-inventory/:id", adminProtect, deleteAdminCaptureHistory);

// Admin management (superadmin only)
router.get("/admins", adminProtect, requireSuperadmin, getAdmins);
router.post("/admins", adminProtect, requireSuperadmin, postAdmin);
router.delete("/admins/:id", adminProtect, requireSuperadmin, deleteAdmin);
router.patch("/admins/:id/block", adminProtect, requireSuperadmin, blockAdmin);
router.patch("/admins/:id/password", adminProtect, requireSuperadmin, changeAdminPassword);

// Users management (admins and superadmins)
router.get("/users", adminProtect, getUsers);
router.get("/users/:id/profile", adminProtect, getAdminUserProfile);
router.patch("/users/:id/profile", adminProtect, updateAdminUserProfile);
router.get("/report-approvers", adminProtect, getReportApprovers);
router.get("/report-creators", adminProtect, getReportCreators);
router.patch("/users/:id/report-approver", adminProtect, updateUserReportApprover);
router.get("/release-managers", adminProtect, getReleaseManagers);
router.patch("/users/:id/release-manager", adminProtect, updateUserReleaseManager);
router.get("/preview-supervisor", adminProtect, getPreviewSupervisorSetting);
router.patch("/preview-supervisor", adminProtect, updatePreviewSupervisorSetting);
router.patch("/users/:id/block", adminProtect, blockUserByAdmin);
router.delete("/users/:id", adminProtect, deleteUserByAdmin);
router.patch(
  "/users/:userId/device-approval-policy",
  adminProtect,
  updateDeviceApprovalPolicy
);

// Device registration, approval, and exact per-user IP controls
router.get("/devices/summary", adminProtect, getDeviceSummary);
router.get("/devices", adminProtect, listDevices);
router.get("/devices/:id", adminProtect, getDeviceDetail);
router.post("/devices/:id/approve", adminProtect, approveDevice);
router.post("/devices/:id/reject", adminProtect, rejectDevice);
router.post("/devices/:id/revoke", adminProtect, revokeDevice);
router.post("/devices/:id/restore", adminProtect, restoreDevice);
router.delete("/devices/:id", adminProtect, deleteDeviceRegistration);
router.get("/device-ips", adminProtect, listDeviceIps);
router.post("/device-ips/block", adminProtect, manuallyBlockDeviceIp);
router.post("/device-ips/:id/block", adminProtect, blockDeviceIp);
router.post("/device-ips/:id/unblock", adminProtect, unblockDeviceIp);
router.get("/device-security-settings", adminProtect, getDeviceSecuritySettings);
router.patch("/device-security-settings", adminProtect, updateDeviceSecuritySettings);

// API key management (superadmin only)
router.get("/api-keys", adminProtect, requireSuperadmin, listApiKeys);
router.post("/api-keys", adminProtect, requireSuperadmin, postApiKey);
router.patch("/api-keys/:id", adminProtect, requireSuperadmin, renameApiKey);
router.delete("/api-keys/:id", adminProtect, requireSuperadmin, revokeApiKey);

// APK release management (superadmin only)
router.get("/apk-releases", adminProtect, requireSuperadmin, listAdminApkReleases);
router.post("/apk-releases/upload-token", adminProtect, requireSuperadmin, createAdminApkUploadToken);
router.post("/apk-releases/complete", adminProtect, requireSuperadmin, completeAdminApkRelease);
router.post(
  "/apk-releases",
  adminProtect,
  requireSuperadmin,
  handleApkReleaseUpload,
  uploadAdminApkRelease
);
router.post(
  "/apk-releases/direct",
  apkUploadTokenProtect,
  requireSuperadmin,
  handleApkReleaseUpload,
  uploadAdminApkRelease
);

// Spec Sheet management (admins and superadmins)
router.get("/spec-sheet/registry-json", adminProtect, getSpecSheetRegistryJson);
router.post("/spec-sheet/import-workbook", adminProtect, upload.single("file"), importSpecSheetWorkbook);
router.get("/spec-sheet/parents", adminProtect, listSpecSheetParents);
router.post("/spec-sheet/parents", adminProtect, createSpecSheetParent);
router.patch("/spec-sheet/parents/:id", adminProtect, updateSpecSheetParent);
router.delete("/spec-sheet/parents/:id", adminProtect, deleteSpecSheetParent);
router.get("/spec-sheet/categories", adminProtect, listSpecSheetCategories);
router.post("/spec-sheet/categories", adminProtect, createSpecSheetCategory);
router.patch("/spec-sheet/categories/:id", adminProtect, updateSpecSheetCategory);
router.delete("/spec-sheet/categories/:id", adminProtect, deleteSpecSheetCategory);
router.post("/spec-sheet/categories/:id/fields", adminProtect, addSpecSheetField);
router.post("/spec-sheet/categories/:id/fields/bulk", adminProtect, bulkSaveSpecSheetFields);
router.patch("/spec-sheet/categories/:id/fields/reorder", adminProtect, reorderSpecSheetFields);
router.patch("/spec-sheet/categories/:id/fields/:fieldId", adminProtect, updateSpecSheetField);
router.delete("/spec-sheet/categories/:id/fields/:fieldId", adminProtect, deleteSpecSheetField);
router.post(
  "/spec-sheet/categories/:id/extract-fields",
  adminProtect,
  upload.single("file"),
  extractSpecSheetFields
);

// Preview report management (superadmin only)
router.get("/preview-reports/drafts", adminProtect, requireSuperadmin, getAdminDraftPreviews);
router.delete(
  "/preview-reports/drafts/:id",
  adminProtect,
  requireSuperadmin,
  deleteAdminDraftPreview
);
router.get("/preview-reports", adminProtect, requireSuperadmin, getAdminPreviewReports);
router.get(
  "/preview-reports/transfer-users",
  adminProtect,
  requireSuperadmin,
  getAdminPreviewTransferUsers
);
router.post(
  "/preview-reports/:id/transfer",
  adminProtect,
  requireSuperadmin,
  transferAdminPreviewReport
);
router.post(
  "/preview-reports/:id/reminder",
  adminProtect,
  requireSuperadmin,
  sendAdminPreviewReminder
);
router.get("/preview-reports/:id/reminder", adminProtect, requireSuperadmin, getAdminPreviewReminder);
router.get("/preview-reports/:id", adminProtect, requireSuperadmin, getAdminPreviewReport);
router.post("/preview-reports/:id/resubmit", adminProtect, requireSuperadmin, resubmitAdminPreviewReport);
router.delete(
  "/preview-reports/:id",
  adminProtect,
  requireSuperadmin,
  deleteAdminPreviewReport
);

// Approved report management (admins and superadmins)
router.get("/released-appraisals", adminProtect, listReleasedAppraisals);
router.get(
  "/released-appraisals/:id/artifacts/:kind/download",
  adminProtect,
  downloadReleasedAppraisalArtifact
);
router.get(
  "/released-appraisals/:id/analysis",
  adminProtect,
  getReleasedAppraisalAnalysis
);
router.post(
  "/released-appraisals/:id/analysis",
  adminProtect,
  requestReleasedAppraisalAnalysis
);
router.get("/reports", adminProtect, getAdminReports);
router.get("/reports/same-contract", adminProtect, getSameContractReports);
// Report actions (admins and superadmins)
router.get(
  "/reports/:id/proposal-valuation/evaluator-options",
  adminProtect,
  requireAccessibleAdminReport,
  getAdminProposalValuationEvaluatorOptions
);
router.get(
  "/reports/:id/proposal-valuation/export",
  adminProtect,
  requireAccessibleAdminReport,
  exportAdminProposalValuationExcel
);
router.get("/reports/:id/preview", adminProtect, requireAccessibleAdminReport, getReportPreview);
router.get(
  "/reports/:id/spec-pdf/download",
  adminProtect,
  requireAccessibleAdminReport,
  downloadAdminSpecPdf
);
router.get(
  "/reports/:id/spec-pdf",
  adminProtect,
  requireAccessibleAdminReport,
  streamAdminSpecPdf
);
router.get(
  "/reports/:id/cr-docx",
  adminProtect,
  requireAccessibleAdminReport,
  downloadAdminCrDocx
);
router.get(
  "/reports/:id/cr-disclaimers",
  adminProtect,
  requireAccessibleAdminReport,
  getAdminCrDisclaimers
);
router.patch(
  "/reports/:id/cr-disclaimers",
  adminProtect,
  requireAccessibleAdminReport,
  saveAdminCrDisclaimers
);
router.post(
  "/reports/:id/rerun-excel-cr",
  adminProtect,
  requireAccessibleAdminReport,
  rerunAdminExcelAndCr
);
router.get(
  "/reports/:id/excel-condition-reports",
  adminProtect,
  requireAccessibleAdminReport,
  getAdminExcelConditionReports
);
router.patch(
  "/reports/:id/excel-condition-reports",
  adminProtect,
  requireAccessibleAdminReport,
  patchAdminExcelConditionReports
);
router.post(
  "/reports/:id/regenerate-excel",
  adminProtect,
  requireAccessibleAdminReport,
  regenerateAdminExcel
);
router.patch(
  "/reports/:id/asset-schedule-sheet",
  adminProtect,
  requireAccessibleAdminReport,
  saveAssetAdminScheduleSheet
);
router.patch(
  "/reports/:id/archive",
  adminProtect,
  requireAccessibleAdminReport,
  archiveAdminReport
);
router.patch(
  "/reports/:id/restore",
  adminProtect,
  requireAccessibleAdminReport,
  restoreAdminReport
);
router.post(
  "/reports/:id/release",
  adminProtect,
  requireAccessibleAdminReport,
  releaseAdminReport
);
router.get(
  "/reports/:id/download",
  adminProtect,
  requireAccessibleAdminReport,
  downloadReport
);
router.delete(
  "/reports/:id",
  adminProtect,
  requireAccessibleAdminReport,
  deleteReport
);

// Assigned approvals (admins and superadmins)
router.get("/reports/pending", adminProtect, getPendingReports);
router.patch("/reports/:id/approve", adminProtect, approveReport);
router.patch("/reports/:id/reject", adminProtect, rejectReport);

// Lot Listing approvals
router.patch("/lot-listings/:id/approve", adminProtect, approveLotListing);
router.patch("/lot-listings/:id/decline", adminProtect, declineLotListing);

// Dashboard and performance analytics (superadmin only)
router.get("/stats", adminProtect, requireSuperadmin, getAdminStats);
router.get("/stats/desktop-dashboard", adminProtect, requireSuperadmin, getDesktopDashboardStats);
router.get("/stats/performance", adminProtect, requireSuperadmin, getPerformanceStats);
router.get(
  "/stats/performance/users/:id",
  adminProtect,
  requireSuperadmin,
  getPerformanceUserStats
);
router.get("/stats/monthly", adminProtect, requireSuperadmin, getMonthlyStats);
router.get(
  "/stats/dashboard-analytics",
  adminProtect,
  requireSuperadmin,
  getDashboardAnalytics
);
router.get("/report-jobs/stats", adminProtect, requireSuperadmin, getReportJobStats);
router.get("/spec-web-search", adminProtect, requireSuperadmin, getSpecWebSearchSetting);
router.patch("/spec-web-search", adminProtect, requireSuperadmin, updateSpecWebSearchSetting);
router.get(
  "/asset-approval-threshold",
  adminProtect,
  requireSuperadmin,
  getAssetApprovalThresholdSetting
);
router.patch(
  "/asset-approval-threshold",
  adminProtect,
  requireSuperadmin,
  updateAssetApprovalThresholdSetting
);
export default router;
import { listReportActivity, getReportActivity, getReportActivityEvents, getReportActivityLots, removeReportActivity } from "../controller/reportActivity.controller.js";
