import { NextFunction, Response, Router } from "express";
import {
  claimAuctioneerWork,
  closeAuctioneerContractPartController,
  continueAuctioneerWork,
  continueQueuedAuctioneerWork,
  deleteAuctioneerClaim,
  getAuctioneerDeliveries,
  getAuctioneerDelivery,
  getAuctioneerIncoming,
  getAuctioneerIncomingSummaryController,
  getAuctioneerCapturePermissionController,
  reopenAuctioneerContractPartController,
  getAuctioneerSetup,
  getAuctioneerStatus,
  reconcileAuctioneerDeliveryController,
  sendAuctioneerDelivery,
} from "../controller/auctioneer2.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { getAuctioneer2ConfigStatus } from "../service/auctioneer2Client.js";

const router = Router();

router.use(protect);
// Review accounts never read or mutate the live partner's customer queue.
router.use((req: AuthRequest, res, next) => {
  if (req.user?.isReviewAccount !== true) return next();
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.path === "/status") {
    return res.json({ success: true, data: { enabled: false, configured: false, reachable: false, baseUrl: "", verificationEndpoint: null, reviewAccount: true } });
  }
  if (req.method === "GET" && req.path === "/incoming/summary") return res.json({ availableCount: 0 });
  if (req.method === "GET" && ["/incoming", "/deliveries"].includes(req.path)) return res.json({ success: true, data: [] });
  return res.status(403).json({ success: false, code: "REVIEW_ACCOUNT_ISOLATED", message: "This review account is not connected to live auction assignments." });
});
router.get("/status", getAuctioneerStatus);

router.use((_req: AuthRequest, res: Response, next: NextFunction) => {
  const status = getAuctioneer2ConfigStatus();
  if (!status.enabled) {
    return res.status(503).json({
      success: false,
      message: "Auctioneer 2.0 is disabled.",
      code: "auctioneer2_disabled",
    });
  }
  if (!status.configured) {
    return res.status(503).json({
      success: false,
      message: "Auctioneer 2.0 is not configured.",
      code: "auctioneer2_not_configured",
    });
  }
  return next();
});

router.get("/incoming", getAuctioneerIncoming);
router.get("/incoming/summary", getAuctioneerIncomingSummaryController);
router.post("/incoming/:cycleKey/claim", claimAuctioneerWork);
router.get("/work-items/:id/setup", getAuctioneerSetup);
router.post("/work-items/:id/continue", continueAuctioneerWork);
router.post("/work-items/:id/continue-upload", continueQueuedAuctioneerWork);
router.delete("/work-items/:id/claim", deleteAuctioneerClaim);
router.get("/deliveries", getAuctioneerDeliveries);
router.get("/deliveries/:id", getAuctioneerDelivery);
router.post("/deliveries/:id/send", sendAuctioneerDelivery);
router.post("/deliveries/:id/reconcile", reconcileAuctioneerDeliveryController);
// Close the signed-in user's own part of a contract when nothing is left to send.
router.post("/contracts/:contractId/close-my-part", closeAuctioneerContractPartController);
router.get("/contracts/:contractId/capture-permission", getAuctioneerCapturePermissionController);
router.post("/contracts/:contractId/reopen", reopenAuctioneerContractPartController);

export default router;
