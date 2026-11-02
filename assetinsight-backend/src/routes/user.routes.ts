import { Router } from "express";
import {
  getUserProfile,
  deleteUserAccount,
  updateUserProfile,
  uploadUserCv,
  deleteUserCv,
  uploadUserAvatar,
  deleteUserAvatar,
} from "../controller/user.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import upload, { uploadAvatarImage, uploadDocxOnly, appraiserSignatureUpload, appraiserCvPdfUpload } from "../utils/multerStorage.js";
import { updateAppraiserProfile, uploadAppraiserSignature, deleteAppraiserSignature, uploadAppraiserCvPdf, deleteAppraiserCvPdf } from "../controller/appraiserProfile.controller.js";

const router = Router();

router.get("/me", protect, getUserProfile);
router.put("/", protect, updateUserProfile);
router.patch("/", protect, updateUserProfile);
router.delete("/", protect, deleteUserAccount);
// CV upload/delete
router.post("/cv", protect, uploadDocxOnly.single("cv"), uploadUserCv);
router.delete("/cv", protect, deleteUserCv);
router.post("/avatar", protect, uploadAvatarImage.single("avatar"), uploadUserAvatar);
router.delete("/avatar", protect, deleteUserAvatar);
// Appraiser profile printed on Salvage appraisal reports (owner, 2026-11-01).
router.patch("/appraiser-profile", protect, updateAppraiserProfile);
router.post("/appraiser-profile/signature", protect, appraiserSignatureUpload.single("signature"), uploadAppraiserSignature);
router.delete("/appraiser-profile/signature", protect, deleteAppraiserSignature);
router.post("/appraiser-profile/cv", protect, appraiserCvPdfUpload.single("cv"), uploadAppraiserCvPdf);
router.delete("/appraiser-profile/cv", protect, deleteAppraiserCvPdf);

export default router; 
