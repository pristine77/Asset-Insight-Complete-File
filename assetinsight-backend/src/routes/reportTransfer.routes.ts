import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import { deleteReportTransferGrant, getReportTransferStatus, getReportTransferTargets, parseReportTransferFile, postReportTransferComplete, postReportTransferEvent, postReportTransferFile, postReportTransferGrant, postReportTransferVerify, requireReportTransfer } from "../controller/reportTransfer.controller.js";

const router = Router();
router.post("/grant", protect, postReportTransferGrant);
router.use("/:type/:sessionId", requireReportTransfer);
router.delete("/:type/:sessionId/grant", deleteReportTransferGrant);
router.get("/:type/:sessionId/status", getReportTransferStatus);
router.get("/:type/:sessionId/targets", getReportTransferTargets);
router.post("/:type/:sessionId/files/:fileId/verify", postReportTransferVerify);
router.post("/:type/:sessionId/files/:fileId", parseReportTransferFile, postReportTransferFile);
router.post("/:type/:sessionId/complete", postReportTransferComplete);
router.post("/:type/:sessionId/events", postReportTransferEvent);
export default router;
