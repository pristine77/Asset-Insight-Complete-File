import { Router } from "express";
import {
  deleteReportDraft,
  deleteReportDraftByClientId,
  deleteReportDraftMedia,
  confirmReportDraftMedia,
  createReportDraftMediaTargets,
  getReportDraft,
  getReportDraftByClientId,
  listReportDrafts,
  processReportDraftPreview,
  promoteReportDraftPreview,
  streamReportDraftMedia,
  uploadReportDraftMedia,
  upsertReportDraft,
} from "../controller/reportDraft.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { reportDraftUpload } from "../utils/multerStorage.js";

const router = Router();

router.get("/", protect, listReportDrafts);
router.post("/", protect, upsertReportDraft);
router.get("/client/:clientDraftId", protect, getReportDraftByClientId);
router.delete("/client/:clientDraftId", protect, deleteReportDraftByClientId);
router.get("/:id/media/:clientFileId/content", protect, streamReportDraftMedia);
router.post("/:id/process-preview", protect, processReportDraftPreview);
router.post("/:id/promote-preview", protect, promoteReportDraftPreview);
router.get("/:id", protect, getReportDraft);
router.delete("/:id", protect, deleteReportDraft);
router.post("/:id/media/targets", protect, createReportDraftMediaTargets);
router.post("/:id/media/confirm", protect, confirmReportDraftMedia);
router.post("/:id/media", protect, reportDraftUpload.array("files", 5000), uploadReportDraftMedia);
router.delete("/:id/media", protect, deleteReportDraftMedia);

export default router;
