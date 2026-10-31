import { Router } from "express";
import { 
  createAssetReport, 
  uploadMiddleware, 
  getAssetReports, 
  getAssetProgress,
  getPreviewData,
  updatePreviewData,
  submitForApproval,
  approveReport,
  declineReport,
  getSubmittedReports,
  getSubmittedPreviewData,
  resubmitReport,
  getAllApprovedReports,
  deleteAssetReport,
  getAssetCategorySpecs,
  refreshPreviewSpecPdf,
  uploadPreviewLotImages,
  getAssetMergeCandidates,
  mergeAssetReports,
} from "../controller/asset.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { uploadSessionFallbackMiddleware } from "../utils/multerStorage.js";
import {
  completeUploadSession,
  getUploadSessionStatus,
  createUploadSession,
  uploadUploadSessionFile,
  verifyUploadSessionFile,
} from "../controller/reportUploadSession.controller.js";
import {
  cancelSmartUploadSession,
  confirmSmartUploadFiles,
  getSmartUploadGrouping,
  getSmartUploadTargets,
  startSmartUploadDetection,
  updateSmartUploadGrouping,
} from "../controller/smartUpload.controller.js";
import {
  exportAssetProposalValuationExcel,
  getAssetProposalValuation,
  getAssetProposalValuationEvaluatorOptions,
  getAssetProposalValuations,
  regenerateAssetProposalValuation,
  replaceAssetProposalValuationEvaluators,
  saveAssetProposalValuation,
  streamAssetProposalValuationEvents,
} from "../controller/assetProposalValuation.controller.js";

const router = Router();

// Asset report creation and listing
router.post("/upload-session", protect, createUploadSession("asset"));
router.get("/upload-session/:sessionId/targets", protect, getSmartUploadTargets("asset"));
router.post("/upload-session/:sessionId/confirm-files", protect, confirmSmartUploadFiles("asset"));
router.post("/upload-session/:sessionId/detect-dividers", protect, startSmartUploadDetection("asset"));
router.get("/upload-session/:sessionId/smart-grouping", protect, getSmartUploadGrouping("asset"));
router.patch("/upload-session/:sessionId/smart-grouping", protect, updateSmartUploadGrouping("asset"));
router.delete("/upload-session/:sessionId", protect, cancelSmartUploadSession("asset"));
router.post("/upload-session/:sessionId/files/:fileId/verify", protect, verifyUploadSessionFile("asset"));
router.post("/upload-session/:sessionId/files/:fileId", protect, uploadSessionFallbackMiddleware("asset"), uploadUploadSessionFile("asset"));
router.post("/upload-session/:sessionId/complete", protect, completeUploadSession("asset"));
router.get("/upload-session/:sessionId/status", protect, getUploadSessionStatus("asset"));
router.post("/merge", protect, mergeAssetReports);
router.post("/", protect, uploadMiddleware, createAssetReport);
router.get("/", protect, getAssetReports);
router.get("/category-specs", protect, getAssetCategorySpecs);
router.get("/progress/:id", protect, getAssetProgress);
router.get("/proposal-valuations", protect, getAssetProposalValuations);
router.get(
  "/:id/proposal-valuation/evaluator-options",
  protect,
  getAssetProposalValuationEvaluatorOptions
);
router.put(
  "/:id/proposal-valuation/evaluators",
  protect,
  replaceAssetProposalValuationEvaluators
);
router.get(
  "/:id/proposal-valuation/export",
  protect,
  exportAssetProposalValuationExcel
);
router.get(
  "/:id/proposal-valuation/events",
  protect,
  streamAssetProposalValuationEvents
);
router.post(
  "/:id/proposal-valuation/regenerate",
  protect,
  regenerateAssetProposalValuation
);
router.get("/:id/proposal-valuation", protect, getAssetProposalValuation);
router.patch("/:id/proposal-valuation", protect, saveAssetProposalValuation);
router.delete("/:id", protect, deleteAssetReport);

// Preview workflow endpoints
router.get("/:id/preview", protect, getPreviewData);
router.get("/:id/merge-candidates", protect, getAssetMergeCandidates);
router.put("/:id/preview", protect, updatePreviewData);
router.post("/:id/preview/lots/:lotKey/images", protect, uploadMiddleware, uploadPreviewLotImages);
router.post("/:id/preview/spec-pdf", protect, refreshPreviewSpecPdf);
router.post("/:id/submit-approval", protect, submitForApproval);

// Submitted reports (pending_approval and approved) - for edit & resubmit
router.get("/submitted", protect, getSubmittedReports);
router.get("/:id/submitted-preview", protect, getSubmittedPreviewData);
router.post("/:id/resubmit", protect, resubmitReport);
router.post("/:id/retry-processing", protect, resubmitReport);

// Admin approval endpoints
router.post("/:id/approve", protect, approveReport);
router.post("/:id/decline", protect, declineReport);

// Gallery - all approved reports with images
router.get("/all-approved", protect, getAllApprovedReports);

export default router;
