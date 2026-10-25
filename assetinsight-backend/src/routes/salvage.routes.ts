import { Router } from "express";
import { createSalvageReport, uploadMiddleware, getSalvageReports, getSalvageProgress, getSalvagePreview, patchSalvagePreview, submitSalvagePreview, researchSalvagePreview, cancelSalvageReport } from '../controller/salvage.controller.js';
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.post('/', protect, uploadMiddleware, createSalvageReport);
router.get('/', protect, getSalvageReports);
router.get('/progress/:id', protect, getSalvageProgress);
router.get('/:id/preview', protect, getSalvagePreview);
router.patch('/:id/preview', protect, patchSalvagePreview);
router.post('/:id/research', protect, researchSalvagePreview);
router.post('/:id/cancel', protect, cancelSalvageReport);
router.post('/:id/submit', protect, submitSalvagePreview);
router.post('/:id/resubmit', protect, submitSalvagePreview);
router.post('/:id/generate-files', protect, submitSalvagePreview);
router.post('/:id/retry', protect, submitSalvagePreview);

export default router;
