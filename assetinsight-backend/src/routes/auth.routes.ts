import express from "express";
import {
  signup,
  login,
  verifyEmail,
  resendVerificationCode,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  resetPasswordByCode,
} from "../controller/auth.controller.js";
import {
  deviceRequestStatus,
  exchangeDeviceApproval,
  registerDevice,
  rerequestDevice,
} from "../controller/deviceAccess.controller.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/refresh-token", refreshToken);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification-code", resendVerificationCode);
router.post("/logout", logout);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password-code", resetPasswordByCode);
router.post("/reset-password/:token", resetPassword);
router.post("/device-requests/register", registerDevice);
router.get("/device-requests/status", deviceRequestStatus);
router.post("/device-requests/exchange", exchangeDeviceApproval);
router.post("/device-requests/rerequest", rerequestDevice);

export default router;
