import { Router } from "express";
import {
  createLotListing,
  uploadMiddleware,
  getLotListings,
  getLotListingProgress,
  getLotListingById,
  deleteLotListing,
  getLotListingPreview,
  getLotListingSubmittedPreview,
  updateLotListingPreview,
  refreshLotListingSpecPdf,
  submitLotListingForApproval,
  resubmitLotListing,
  uploadLotListingPreviewLotImages,
} from "../controller/lotListing.controller.js";
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

const router = Router();

// Create new lot listing
router.post("/upload-session", protect, createUploadSession("lotListing"));
router.get("/upload-session/:sessionId/targets", protect, getSmartUploadTargets("lotListing"));
router.post("/upload-session/:sessionId/confirm-files", protect, confirmSmartUploadFiles("lotListing"));
router.post("/upload-session/:sessionId/detect-dividers", protect, startSmartUploadDetection("lotListing"));
router.get("/upload-session/:sessionId/smart-grouping", protect, getSmartUploadGrouping("lotListing"));
router.patch("/upload-session/:sessionId/smart-grouping", protect, updateSmartUploadGrouping("lotListing"));
router.delete("/upload-session/:sessionId", protect, cancelSmartUploadSession("lotListing"));
router.post("/upload-session/:sessionId/files/:fileId/verify", protect, verifyUploadSessionFile("lotListing"));
router.post("/upload-session/:sessionId/files/:fileId", protect, uploadSessionFallbackMiddleware("lotListing"), uploadUploadSessionFile("lotListing"));
router.post("/upload-session/:sessionId/complete", protect, completeUploadSession("lotListing"));
router.get("/upload-session/:sessionId/status", protect, getUploadSessionStatus("lotListing"));
router.post("/", protect, uploadMiddleware, createLotListing);

// Get all lot listings for current user
router.get("/", protect, getLotListings);

// Get progress for a specific job
router.get("/progress/:id", protect, getLotListingProgress);

// Preview endpoints
router.get("/:id/preview", protect, getLotListingPreview);
router.get("/:id/submitted-preview", protect, getLotListingSubmittedPreview);
router.put("/:id/preview", protect, updateLotListingPreview);
router.post("/:id/preview/lots/:lotKey/images", protect, uploadMiddleware, uploadLotListingPreviewLotImages);
router.post("/:id/preview/spec-pdf", protect, refreshLotListingSpecPdf);

// Submit for approval
router.post("/:id/submit-approval", protect, submitLotListingForApproval);

// Resubmit (regenerate files)
router.post("/:id/resubmit", protect, resubmitLotListing);
router.post("/:id/retry-processing", protect, resubmitLotListing);

// Get specific lot listing by ID
router.get("/:id", protect, getLotListingById);

// Delete lot listing
router.delete("/:id", protect, deleteLotListing);

export default router;
