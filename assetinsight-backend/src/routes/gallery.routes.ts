import { Router } from "express";
import {
  transformImage, 
  downloadZip,
  downloadSingle,
  getCloudinaryUrl,
  getCloudinaryPresets,
} from "../controller/gallery.controller.js";
import {
  updateReportImage,
  uploadImageFromUrl,
} from "../controller/imageEnhance.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.use(protect);

// Transform image with settings (size, quality, format) - local processing
router.get("/transform", transformImage);

// Get Cloudinary-optimized URL for an image
router.get("/cloudinary-url", getCloudinaryUrl);

// Get available Cloudinary presets
router.get("/cloudinary-presets", getCloudinaryPresets);

// Download single image (proxy to avoid CORS)
router.post("/download-single", downloadSingle);

// Download multiple images as zip with settings
router.post("/download-zip", downloadZip);

// Image enhancement - upload from URL to Cloudinary
router.post("/upload-from-url", uploadImageFromUrl);

// Image enhancement - update image URL in report
router.post("/update-image", updateReportImage);

export default router;
