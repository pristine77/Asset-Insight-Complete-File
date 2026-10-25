import express from "express";
import {
  downloadLatestAndroidApk,
  getLatestAndroidAppVersion,
} from "../controller/appVersion.controller.js";

const router = express.Router();

router.get("/android/latest", getLatestAndroidAppVersion);
router.get("/android/latest/download", downloadLatestAndroidApk);

export default router;
