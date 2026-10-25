import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import { getCaptureInventory, putCaptureInventory } from "../controller/captureInventory.controller.js";

const router = Router();
router.put("/:captureId", protect, putCaptureInventory);
router.get("/:captureId", protect, getCaptureInventory);
export default router;
