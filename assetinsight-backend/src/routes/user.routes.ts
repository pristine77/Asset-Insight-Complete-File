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
import upload, { uploadAvatarImage, uploadDocxOnly } from "../utils/multerStorage.js";

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

export default router; 
