import { Router } from "express";
import { createSalvageReport, uploadMiddleware, getSalvageReports, getSalvageProgress, getSalvagePreview, patchSalvagePreview, submitSalvagePreview, researchSalvagePreview, cancelSalvageReport,
  addSalvageAppendixHandler, updateSalvageAppendicesHandler } from '../controller/salvage.controller.js';
import { salvageAppendixUpload } from "../utils/multerStorage.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.post('/', protect, uploadMiddleware, createSalvageReport);
router.get('/', protect, getSalvageReports);
router.get('/progress/:id', protect, getSalvageProgress);
router.get('/:id/preview', protect, getSalvagePreview);
router.patch('/:id/preview', protect, patchSalvagePreview);
router.post('/:id/research', protect, researchSalvagePreview);
router.post('/:id/cancel', protect, cancelSalvageReport);
// Appendices: uploaded PDFs and photos printed after the report (owner, 2026-11-01).
router.post('/:id/appendices', protect, salvageAppendixUpload.single("file"), addSalvageAppendixHandler);
router.patch('/:id/appendices', protect, updateSalvageAppendicesHandler);
router.post('/:id/submit', protect, submitSalvagePreview);
router.post('/:id/resubmit', protect, submitSalvagePreview);
router.post('/:id/generate-files', protect, submitSalvagePreview);
router.post('/:id/retry', protect, submitSalvagePreview);

export default router;
