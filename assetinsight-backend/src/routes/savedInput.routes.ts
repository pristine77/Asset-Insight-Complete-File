import { Router } from "express";
import {
  createSavedInput,
  getSavedInputs,
  getSavedInputById,
  updateSavedInput,
  deleteSavedInput,
  saveAutoDraft,
  getAutoDraft,
  deleteAutoDraft,
} from "../controller/savedInput.controller.js";
import {
  draftUpload,
  uploadDraftImages,
  deleteDraftImages,
  deleteSpecificDraftImages,
} from "../controller/draftUpload.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

// Draft image upload routes (must be before /:id to avoid conflicts)
router.post("/draft/upload", protect, draftUpload.array('images', 100), uploadDraftImages);
router.delete("/draft/images", protect, deleteDraftImages);
router.post("/draft/delete-images", protect, deleteSpecificDraftImages);

// Draft metadata routes
router.post("/draft", protect, saveAutoDraft);
router.get("/draft", protect, getAutoDraft);
router.delete("/draft", protect, deleteAutoDraft);

// Regular saved input routes
router.post("/", protect, createSavedInput);
router.get("/", protect, getSavedInputs);
router.get("/:id", protect, getSavedInputById);
router.put("/:id", protect, updateSavedInput);
router.delete("/:id", protect, deleteSavedInput);

export default router;
