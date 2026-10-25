import { Router } from "express";
import { reverseGeocodeBrowserLocation } from "../controller/browserLocation.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/reverse-geocode", protect, reverseGeocodeBrowserLocation);

export default router;
