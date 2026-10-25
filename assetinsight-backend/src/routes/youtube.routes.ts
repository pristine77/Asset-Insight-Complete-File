import { Router } from "express";
import { adminProtect } from "../middleware/admin.middleware.js";
import { completeAdminYoutube, connectAdminYoutube, disconnectAdminYoutube, getAdminYoutubeStatus, revokeAdminYoutube, eraseAdminYoutubeData, acknowledgeAdminYoutubeRevocation } from "../controller/youtubeConnection.controller.js";
import { listAdminYoutubeVideos, retryAdminYoutubePublication, reviewAdminYoutubeVideo } from "../controller/youtubeVideos.controller.js";

const router = Router();
router.use(adminProtect);
router.get("/status", getAdminYoutubeStatus);
router.get("/videos", listAdminYoutubeVideos);
router.post("/videos/:id/retry-publication", retryAdminYoutubePublication);
router.post("/videos/:id/review", reviewAdminYoutubeVideo);
router.post("/connect", connectAdminYoutube);
router.post("/complete", completeAdminYoutube);
router.post("/disconnect", disconnectAdminYoutube);
router.post("/revoke", revokeAdminYoutube);
router.post("/erase-data", eraseAdminYoutubeData);
router.post("/acknowledge-revocation", acknowledgeAdminYoutubeRevocation);
export default router;
