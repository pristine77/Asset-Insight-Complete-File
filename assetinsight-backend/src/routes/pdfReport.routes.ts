import express from "express";
import { convertAssignedPreviewCurrency } from "../controller/reportCurrencyConversion.controller.js";
import {
  approveAssignedApproval,
  getAssignedApprovalPreview,
  getAssignedAssetApprovalPreview,
  getAssignedApprovals,
  rejectAssignedApproval,
  refreshAssignedAssetApprovalPreviewSpecPdf,
  resubmitAssignedApprovalPreview,
  resubmitAssignedAssetApprovalPreview,
  updateAssignedApprovalPreview,
  updateAssignedAssetApprovalPreview,
  uploadAssignedAssetApprovalPreviewLotImages,
} from "../controller/approval.controller.js";
import {
  downloadReport,
  deleteReport,
  getAllReports,
  getReportPreview,
  getReportsByUser,
  getReportStats,
  downloadReportCrDocx,
  downloadReportCr,
  openReportCr,
} from "../controller/pdfReport.controller.js";
import {
  getAssignedReleases,
  releaseAssignedReport,
} from "../controller/release.controller.js";
import { uploadMiddleware } from "../controller/asset.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { reviewReportOwnerOnly } from "../middleware/reviewReport.middleware.js";
import { getDashboardAnalytics } from "../controller/dashboardAnalytics.controller.js";

const router = express.Router();
const ownReviewReport = [protect, reviewReportOwnerOnly];

router.get("/", protect, getAllReports);
router.get("/myreports", protect, getReportsByUser);
router.get("/assigned-approvals", protect, getAssignedApprovals);
router.get("/assigned-releases", protect, getAssignedReleases);
router.post("/assigned-releases/:id/release", ownReviewReport, releaseAssignedReport);
router.get("/assigned-approvals/:id/preview", ownReviewReport, getAssignedApprovalPreview);
router.put("/assigned-approvals/:id/preview", ownReviewReport, updateAssignedApprovalPreview);
router.post("/assigned-approvals/:id/preview/currency-conversion", ownReviewReport, convertAssignedPreviewCurrency);
router.post("/assigned-approvals/:id/preview/lots/:lotKey/images", ownReviewReport, uploadMiddleware, uploadAssignedAssetApprovalPreviewLotImages);
router.post("/assigned-approvals/:id/preview/spec-pdf", ownReviewReport, refreshAssignedAssetApprovalPreviewSpecPdf);
router.post("/assigned-approvals/:id/preview/resubmit", ownReviewReport, resubmitAssignedApprovalPreview);
router.get("/assigned-approvals/:id/asset-preview", ownReviewReport, getAssignedAssetApprovalPreview);
router.put("/assigned-approvals/:id/asset-preview", ownReviewReport, updateAssignedAssetApprovalPreview);
router.post("/assigned-approvals/:id/resubmit", ownReviewReport, resubmitAssignedAssetApprovalPreview);
router.post("/assigned-approvals/:id/approve", ownReviewReport, approveAssignedApproval);
router.post("/assigned-approvals/:id/reject", ownReviewReport, rejectAssignedApproval);
router.get("/stats", protect, getReportStats);
router.get("/dashboard-analytics", protect, getDashboardAnalytics);
router.get("/:id/preview", ownReviewReport, getReportPreview);
router.get("/:id/cr-docx", ownReviewReport, downloadReportCrDocx);
router.get("/:id/cr/download", ownReviewReport, downloadReportCr);
router.get("/:id/cr", ownReviewReport, openReportCr);
router.get("/:id/download", ownReviewReport, downloadReport);
router.delete("/:id", ownReviewReport, deleteReport);

export default router;
