import { Router } from "express";
import { protect } from "../middleware/auth.middleware.js";
import { postReportActivityEvents } from "../controller/reportActivity.controller.js";
const router = Router();
router.post("/events", protect, postReportActivityEvents);
export default router;
