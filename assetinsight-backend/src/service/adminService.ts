/**
 * Owns administrator credential lifecycle and bootstrap seeding. Password material is
 * hashed at this boundary, duplicate identities are rejected consistently, and the
 * seed operation remains repeatable so deployment startup cannot create extra accounts.
 */
import bcrypt from "bcryptjs";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";

export interface SeedResult {
  created: boolean;
  email: string;
}

export const seedSuperAdmin = async (params?: {
  email?: string;
  password?: string;
  username?: string;
  companyName?: string;
}) => {
  const emailInput = params?.email || process.env.SUPERADMIN_EMAIL;
  const email = String(emailInput || "").trim().toLowerCase();
  const password = params?.password || process.env.SUPERADMIN_PASSWORD;
  const username = params?.username || "superadmin";
  const companyName = params?.companyName || process.env.SUPERADMIN_COMPANY || "Asset Insight";

  if (!email || !password) {
    throw new Error("Missing SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD");
  }

  let user = await User.findOne({ email });
  if (user) {
    // Ensure role and verification are correct
    if (user.role !== "superadmin") {
      user.role = "superadmin" as any;
    }
    if (!user.isVerified) {
      user.isVerified = true;
    }
    await user.save();
    return { created: false, email } as SeedResult;
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  user = new User({
    email,
    password: hashedPassword,
    username,
    companyName,
    role: "superadmin",
    isVerified: true,
    authProvider: "email",
  } as any);

  await user.save();
  return { created: true, email } as SeedResult;
};

export const validateAdminCredentials = async (email: string, password: string) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail }).select("+password role isVerified isBlocked");
  if (!user) return null;
  if (!user.password) return null;
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return null;
  if (!user.isVerified) return null;
  if (user.role !== "admin" && user.role !== "superadmin") return null;
  if ((user as any).isBlocked) return null;
  return user;
};

export const listAdmins = async () => {
  return User.find({ role: { $in: ["admin", "superadmin"] } }).select("-password -refreshTokens -refreshToken").sort({ role: 1, createdAt: -1 });
};

export const createAdmin = async (params: { email: string; username?: string; password?: string; companyName?: string; }) => {
  const email = String(params.email || "").trim().toLowerCase();
  const exists = await User.findOne({ email });
  if (exists) {
    throw new Error("User with this email already exists");
  }
  const password = params.password || Math.random().toString(36).slice(-10) + "A1";
  const hashedPassword = await bcrypt.hash(password, 12);
  const user = new User({
    email,
    username: params.username || email.split("@")[0],
    companyName: params.companyName,
    role: "admin",
    isVerified: true,
    isBlocked: false,
    password: hashedPassword,
    authProvider: "email",
  } as any);
  await user.save();

  const adminUrl = "https://admin.assetinsightvaluation.com/login";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f9fafb;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#e11d48 0%,#be123c 100%);padding:32px 40px;text-align:center;">
              <div style="display:inline-block;background:#ffffff;border-radius:12px;padding:12px 20px;margin-bottom:16px;">
                <span style="font-size:24px;font-weight:700;color:#e11d48;">Asset Insight</span>
              </div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">Welcome to Admin Portal</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 20px;color:#374151;font-size:16px;line-height:1.6;">
                Congratulations! You have been granted <strong style="color:#e11d48;">Admin access</strong> to the Asset Insight platform.
              </p>
              
              <!-- Credentials Box -->
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:24px;margin:24px 0;">
                <h3 style="margin:0 0 16px;color:#991b1b;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Your Login Credentials</h3>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #fecaca;">
                      <span style="color:#6b7280;font-size:13px;">Email</span><br/>
                      <span style="color:#111827;font-size:15px;font-weight:500;">${email}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;">
                      <span style="color:#6b7280;font-size:13px;">Temporary Password</span><br/>
                      <code style="display:inline-block;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 12px;color:#111827;font-size:15px;font-weight:600;font-family:monospace;">${password}</code>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA Button -->
              <div style="text-align:center;margin:32px 0;">
                <a href="${adminUrl}" style="display:inline-block;background:linear-gradient(135deg,#e11d48 0%,#be123c 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:10px;box-shadow:0 4px 14px rgba(225,29,72,0.35);">
                  Sign In to Admin Portal
                </a>
              </div>

              <p style="margin:24px 0 0;color:#6b7280;font-size:14px;line-height:1.6;text-align:center;">
                For security, we recommend changing your password after your first login.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:24px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                © ${new Date().getFullYear()} Asset Insight. All rights reserved.<br/>
                <a href="${adminUrl}" style="color:#e11d48;text-decoration:none;">${adminUrl.replace('https://', '')}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  try {
    await sendEmail(email, "Your Asset Insight Admin Access", html);
  } catch (e) {
    // Log and proceed; admin can resend later
    console.error("Failed to send admin invite email:", e);
  }
  return user;
};

export const deleteAdminById = async (id: string) => {
  const user = await User.findById(id);
  if (!user) throw new Error("User not found");
  if (user.role === "superadmin") throw new Error("Cannot delete superadmin");
  await User.findByIdAndDelete(id);
};

export const setAdminBlocked = async (id: string, blocked: boolean) => {
  const user = await User.findById(id);
  if (!user) throw new Error("User not found");
  if (user.role === "superadmin") throw new Error("Cannot block superadmin");
  user.set("isBlocked", blocked);
  await user.save();
  return user;
};

export const updateAdminPassword = async (id: string, password: string) => {
  const normalizedPassword = String(password || "");
  if (normalizedPassword.trim().length < 6) {
    throw new Error("Password must be at least 6 characters long");
  }

  const user = await User.findById(id).select("+password role");
  if (!user) throw new Error("User not found");
  if (user.role !== "admin" && user.role !== "superadmin") {
    throw new Error("User is not an admin account");
  }

  user.password = await bcrypt.hash(normalizedPassword, 12);
  await user.save();
  return user;
};
