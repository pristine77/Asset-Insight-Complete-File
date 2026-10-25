import { Router } from "express";
import { 
  createRealEstate, 
  createRealEstateQueued, 
  uploadMiddleware, 
  getRealEstateReports, 
  getRealEstateProgress,
  getPreviewData,
  updatePreviewData,
  submitForApproval,
  getSubmittedReports,
  getSubmittedPreviewData,
  resubmitReport,
  approveReport,
  declineReport,
  getPendingReports,
  getAllApprovedReports,
  deleteRealEstateReport,
} from '../controller/realEstate.controller.js';
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

// Default: queued background processing with PREVIEW WORKFLOW
// Creates report with status='preview' for user editing before submission
router.post('/', protect, uploadMiddleware, createRealEstateQueued);
// Optional: synchronous generation for debugging/legacy
router.post('/sync', protect, uploadMiddleware, createRealEstate);

// Route to get all real estate reports for the logged-in user
router.get('/', protect, getRealEstateReports);
router.get('/progress/:id', protect, getRealEstateProgress);
router.delete('/:id', protect, deleteRealEstateReport);

// Preview workflow routes
router.get('/preview/:id', protect, getPreviewData);
router.put('/preview/:id', protect, updatePreviewData);
router.post('/preview/:id/submit', protect, submitForApproval);

// Submitted reports (pending_approval and approved) - for edit & resubmit
router.get('/submitted', protect, getSubmittedReports);
router.get('/:id/submitted-preview', protect, getSubmittedPreviewData);
router.post('/:id/resubmit', protect, resubmitReport);

// Admin approval routes
router.get('/admin/pending', protect, getPendingReports);
router.post('/admin/:id/approve', protect, approveReport);
router.post('/admin/:id/decline', protect, declineReport);

// Gallery - all approved reports with images
router.get('/all-approved', protect, getAllApprovedReports);

export default router;
