import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  AuctionsoftClientError,
  getAuctionsoftConfigStatus,
  getAuctionManagementTask,
  listAuctionManagementTasks,
  markAuctionManagementTaskOpened,
} from "../service/auctionsoftClient.js";

const router = Router();

router.use(protect, (req, res, next) => {
  if ((req as any).user?.isReviewAccount !== true) return next();
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.path === "/status") return res.json({ enabled: false, configured: false, reviewAccount: true });
  if (req.method === "GET" && req.path === "/tasks") return res.json({ data: [] });
  return res.status(403).json({ code: "REVIEW_ACCOUNT_ISOLATED", message: "This review account is not connected to live auction assignments." });
});

const allowedStatuses = new Set(["incoming", "in_progress", "completed"]);

function handleError(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AuctionsoftClientError) {
    res.status(error.statusCode).json({
      message,
      code: error.code,
      upstreamStatus: error.upstreamStatus,
    });
    return;
  }
  const status = /not configured/i.test(message) ? 503 : 502;
  res.status(status).json({ message, code: "auction_management_proxy_error" });
}

router.get("/status", (_req, res) => {
  res.json(getAuctionsoftConfigStatus());
});

router.get("/tasks", async (req, res) => {
  try {
    const status = String(req.query.status || "incoming");
    const normalized = allowedStatuses.has(status) ? status : "incoming";
    const result = await listAuctionManagementTasks(normalized as any);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/tasks/:taskId", async (req, res) => {
  try {
    res.json(await getAuctionManagementTask(req.params.taskId));
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/tasks/:taskId/opened", async (req, res) => {
  try {
    res.json(await markAuctionManagementTaskOpened(req.params.taskId));
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
