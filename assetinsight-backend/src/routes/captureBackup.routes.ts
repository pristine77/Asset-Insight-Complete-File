import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import { deleteBackupGrant, getBackupOriginal, getBackupPlanDetail, getBackupPlanStatus, getBackupPlans, postBackupConfirm, postBackupEvent, postBackupGrant, postBackupPlan, postBackupTargets, postUnregisteredBackupEvent, readBackupAuthentication, requireBackupGrant } from "../controller/captureBackup.controller.js";

const router = Router();
router.post("/grant", protect, postBackupGrant);
router.delete("/grant", requireBackupGrant, deleteBackupGrant);
router.post("/events", requireBackupGrant, postUnregisteredBackupEvent);
router.post("/plans", requireBackupGrant, postBackupPlan);
router.get("/plans", readBackupAuthentication, getBackupPlans);
// The backup credential is write/status-only, never a media download credential.
router.get("/plans/:id/media/:clientFileId/content", protect, getBackupOriginal);
router.get("/plans/:id", readBackupAuthentication, getBackupPlanDetail);
router.get("/plans/:id/status", readBackupAuthentication, getBackupPlanStatus);
router.post("/plans/:id/targets", requireBackupGrant, postBackupTargets);
router.post("/plans/:id/confirm", requireBackupGrant, postBackupConfirm);
router.post("/plans/:id/events", requireBackupGrant, postBackupEvent);
export default router;
