/**
 * User authentication and account-recovery HTTP boundary.
 *
 * Password verification, email codes and refresh-token rotation are exposed through
 * deliberately distinct flows. Responses avoid returning credential material beyond
 * the issued tokens, while one-time codes, expiry and persisted token state provide the
 * replay and revocation controls required by clients.
 */
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import User, { CRM_SPECIALIZATION_VALUES } from "../models/user.model.js";
import {
  sendVerificationCode,
  sendPasswordResetCode,
  sendPasswordResetLink,
} from "../utils/sendVerificationEmail.js";
import { attachUserCapabilities } from "../utils/userCapabilities.js";
import crypto from "crypto";
import {
  beginDeviceAwareSession,
  assertDeviceSessionContext,
  DeviceApiError,
  deviceErrorBody,
  refreshDeviceBoundAccessToken,
} from "../service/deviceAccessService.js";

dotenv.config();

const CRM_SPECIALIZATION_SET = new Set<string>(CRM_SPECIALIZATION_VALUES as readonly string[]);

async function saveAuthState(user: any) {
  await user.save({ validateBeforeSave: false });
}

function getSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasPassword(value: unknown): value is string {
  // Whitespace is part of a password; only reject an entirely blank value.
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCode(value: unknown): string {
  const code = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return /^\d{6}$/.test(code) ? code : "";
}

function sendAuthError(res: Response, error: unknown, fallback: string) {
  if (error instanceof DeviceApiError) {
    return res.status(error.status).json(deviceErrorBody(error));
  }
  return res.status(500).json({
    message: fallback,
    ...(process.env.NODE_ENV !== "production"
      ? { error: getSafeErrorMessage(error) }
      : {}),
  });
}

function normalizeCrmSpecializations(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => CRM_SPECIALIZATION_SET.has(item))
    )
  );
}

export const signup = async (req: Request, res: Response) => {
  const {
    email,
    password,
    companyName,
    contactEmail,
    contactPhone,
    companyAddress,
    username,
    crmSpecializations,
  } = req.body ?? {};

  try {
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !hasPassword(password) || typeof username !== "string" || !username.trim()) {
      return res.status(400).json({ message: "Email, username and password are required." });
    }
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const newUser = new User({
      email: normalizedEmail,
      password: hashedPassword,
      username,
      companyName,
      contactEmail,
      contactPhone,
      companyAddress,
      crmSpecializations: normalizeCrmSpecializations(crmSpecializations),
      authProvider: "email",
      verificationCode,
      verificationCodeExpires,
    });

    await newUser.save();

    try {
      await sendVerificationCode(normalizedEmail, verificationCode);
      res.status(201).json({
        message:
          "Signup successful. Please check your email for a verification code.",
      });
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      // Optional: Decide if you want to proceed without email verification or return an error
      res.status(500).json({
        message: "User created, but failed to send verification email.",
      });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  try {
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Email and password are required." });
    }

    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !hasPassword(password)) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const user = await User.findOne({ email: normalizedEmail }).select("+password");
    if (!user || (user.authProvider && user.authProvider !== "email")) {
      return res.status(404).json({
        message: "User not found or not registered with email/password.",
      });
    }

    if (!user.isVerified) {
      return res
        .status(403)
        .json({ code: "EMAIL_NOT_VERIFIED", message: "Please verify your email before logging in." });
    }

    if ((user as any).isBlocked) {
      return res.status(403).json({ message: "Your account is blocked." });
    }

    if (!user.password) {
      return res.status(400).json({
        message: "This account has no password set. Please reset your password.",
      });
    }
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const result = await beginDeviceAwareSession(user, req);
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("User Login Error:", error);
    return sendAuthError(res, error, "Login failed. Please try again.");
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  const { email, verificationCode } = req.body ?? {};

  try {
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = normalizeCode(verificationCode);
    if (!normalizedEmail || !normalizedCode) {
      return res.status(400).json({ message: "Email and a valid verification code are required." });
    }
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified." });
    }

    if (user.verificationCode !== normalizedCode) {
      return res.status(400).json({ message: "Invalid verification code." });
    }

    if (
      !user.verificationCodeExpires ||
      user.verificationCodeExpires <= new Date()
    ) {
      return res
        .status(400)
        .json({ message: "Verification code has expired." });
    }

    // Do not consume a valid code if the installation cannot start its normal
    // registration/approval flow. The client can retry with its same identity.
    await assertDeviceSessionContext(user, req);

    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationCodeExpires = undefined;

    await saveAuthState(user);
    const result = await beginDeviceAwareSession(
      user,
      req,
      "Email verified successfully."
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Email Verification Error:", error);
    return sendAuthError(
      res,
      error,
      "Something went wrong during email verification."
    );
  }
};

export const resendVerificationCode = async (req: Request, res: Response) => {
  const { email } = req.body ?? {};

  try {
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return res.status(400).json({ message: "Email is required." });
    }
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified." });
    }

    const verificationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.verificationCode = verificationCode;
    user.verificationCodeExpires = verificationCodeExpires;
    await saveAuthState(user);

    await sendVerificationCode(normalizedEmail, verificationCode);

    res.status(200).json({
      message: "A new verification code has been sent to your email.",
    });
  } catch (error) {
    console.error("Resend Verification Code Error:", error);
    res.status(500).json({
      message: "Something went wrong while resending the verification code.",
    });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    return res.status(401).json({ message: "Refresh token not provided" });
  }

  try {
    return res.json(await refreshDeviceBoundAccessToken(req, token));
  } catch (error) {
    if (error instanceof DeviceApiError) {
      return res.status(error.status).json(deviceErrorBody(error));
    }
    return res.status(403).json({
      code: "INVALID_REFRESH_TOKEN",
      message: "Invalid refresh token",
    });
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const { email, clientType } = req.body ?? {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedClientType = typeof clientType === "string" ? clientType.toLowerCase().trim() : "";

  try {
    if (!normalizedEmail) {
      return res.status(400).json({ message: "Email is required." });
    }
    // Normalize email to lowercase for case-insensitive comparison
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      // To prevent user enumeration, we send a generic success message even if the user doesn't exist.
      return res.status(200).json({
        message:
          normalizedClientType === "mobile"
            ? "If an account with that email exists, a password reset code has been sent."
            : "If an account with that email exists, a password reset link has been sent.",
      });
    }

    if (normalizedClientType === "mobile") {
      const passwordResetCode = Math.floor(100000 + Math.random() * 900000).toString();
      user.passwordResetCode = passwordResetCode;
      user.passwordResetCodeExpires = new Date(Date.now() + 10 * 60 * 1000);
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;

      await saveAuthState(user);
      await sendPasswordResetCode(user.email, passwordResetCode);

      return res.status(200).json({
        message:
          "If an account with that email exists, a password reset code has been sent.",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");

    user.passwordResetToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
    user.passwordResetCode = undefined;
    user.passwordResetCodeExpires = undefined;

    await saveAuthState(user);

    const webResetUrl = `${
      process.env.CLIENT_URL || "http://localhost:3000"
    }/reset-password.html?token=${encodeURIComponent(resetToken)}`;

    await sendPasswordResetLink(user.email, webResetUrl);

    res.status(200).json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    // Do not reveal specific errors to the client.
    res.status(200).json({
      message:
        normalizedClientType === "mobile"
          ? "If an account with that email exists, a password reset code has been sent."
          : "If an account with that email exists, a password reset link has been sent.",
    });
  }
};

export const resetPasswordByCode = async (req: Request, res: Response) => {
  const { email, code, password } = req.body ?? {};

  try {
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = normalizeCode(code);
    if (!normalizedEmail || !normalizedCode || !hasPassword(password)) {
      return res.status(400).json({ message: "Email, a valid reset code and a new password are required." });
    }
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    if (!user) {
      return res.status(400).json({ message: "Invalid password reset code." });
    }

    if (user.passwordResetCode !== normalizedCode) {
      return res.status(400).json({ message: "Invalid password reset code." });
    }

    if (
      !user.passwordResetCodeExpires ||
      user.passwordResetCodeExpires <= new Date()
    ) {
      return res.status(400).json({ message: "Password reset code has expired." });
    }

    // Validate the installation before consuming the reset code or changing
    // the password. A failed device check must leave the reset attempt intact.
    await assertDeviceSessionContext(user, req);

    const hashedPassword = await bcrypt.hash(password, 12);

    user.password = hashedPassword;
    user.passwordResetCode = undefined;
    user.passwordResetCodeExpires = undefined;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.set("refreshTokens", [] as any);

    await saveAuthState(user);

    const result = await beginDeviceAwareSession(
      user,
      req,
      "Password has been reset successfully."
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Reset Password By Code Error:", error);
    return sendAuthError(
      res,
      error,
      "An error occurred while resetting the password."
    );
  }
};

export const logout = async (req: Request, res: Response) => {
  const { token } = req.body;
  if (token) {
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const decoded: any = jwt.decode(token);
      if (decoded?.id) {
        await User.findByIdAndUpdate(decoded.id, {
          $pull: { refreshTokens: { tokenHash } } as any,
        });
      }
    } catch {
      // ignore errors — always succeed
    }
  }
  return res.status(200).json({ message: "Logged out" });
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body ?? {};

  try {
    if (!hasPassword(password)) {
      return res.status(400).json({ message: "A new password is required." });
    }
    // Hash the token from the URL to match the one stored in the DB
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }, // Check if the token is not expired
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Password reset token is invalid or has expired." });
    }

    await assertDeviceSessionContext(user, req);

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Update user's password and clear the reset token fields
    user.password = hashedPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.passwordResetCode = undefined;
    user.passwordResetCodeExpires = undefined;

    // Invalidate any existing refresh tokens by clearing them
    user.set("refreshTokens", [] as any);

    await saveAuthState(user);

    const result = await beginDeviceAwareSession(
      user,
      req,
      "Password has been reset successfully."
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Reset Password Error:", error);
    return sendAuthError(
      res,
      error,
      "An error occurred while resetting the password."
    );
  }
};
