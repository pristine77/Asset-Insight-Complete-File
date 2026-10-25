import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mail = vi.hoisted(() => ({
  verification: vi.fn().mockResolvedValue(undefined),
  code: vi.fn().mockResolvedValue(undefined),
  link: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({
  sendVerificationCode: mail.verification,
  sendPasswordResetCode: mail.code,
  sendPasswordResetLink: mail.link,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let Device: typeof import("../src/models/deviceRegistration.model.js")["default"];
let Challenge: typeof import("../src/models/deviceAccessChallenge.model.js")["default"];
const key = "auth-recovery-installation-key-".padEnd(64, "a");
const context = { installationKey: key, platform: "android", formFactor: "mobile" };
const oldPassword = "OriginalPassword123!";
const nextPassword = " ChangedPassword123! ";
const resetToken = "isolated-reset-token-".padEnd(64, "b");
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
type Flow = "verify" | "code" | "token";
const flows: Flow[] = ["verify", "code", "token"];

async function fixture(flow: Flow, extra: Record<string, unknown> = {}) {
  return User.create({
    email: "auth-recovery@example.test", username: "Auth recovery fixture",
    password: await bcrypt.hash(oldPassword, 4), authProvider: "email", role: "user",
    isVerified: flow !== "verify",
    verificationCode: "123456", verificationCodeExpires: new Date(Date.now() + 60_000),
    passwordResetCode: "654321", passwordResetCodeExpires: new Date(Date.now() + 60_000),
    passwordResetToken: hash(resetToken), passwordResetExpires: new Date(Date.now() + 60_000),
    refreshTokens: [{ tokenHash: "old-session-hash", expiresAt: new Date(Date.now() + 60_000) }],
    ...extra,
  });
}

function recovery(flow: Flow, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const route = flow === "verify" ? "verify-email" : flow === "code" ? "reset-password-code" : `reset-password/${resetToken}`;
  return request(app).post(`/api/auth/${route}`).set(headers).send({
    email: " AUTH-RECOVERY@example.test ", verificationCode: "123456", code: "654321",
    password: nextPassword, ...body,
  });
}

async function authSnapshot(id: unknown) {
  return User.findById(id).select("+password isVerified verificationCode verificationCodeExpires passwordResetCode passwordResetCodeExpires passwordResetToken passwordResetExpires refreshTokens").lean();
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: Device } = await import("../src/models/deviceRegistration.model.js"));
  ({ default: Challenge } = await import("../src/models/deviceAccessChallenge.model.js"));
});
beforeEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.db!.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.each(flows)("%s recovery device admission", (flow) => {
  it.each([
    ["missing context", {}, {}, 428, "DEVICE_CONTEXT_REQUIRED"],
    ["short key", { deviceContext: { ...context, installationKey: "short" } }, {}, 428, "DEVICE_CONTEXT_REQUIRED"],
    ["invalid platform", { deviceContext: { ...context, platform: "other" } }, {}, 400, "INVALID_DEVICE_CONTEXT"],
    ["invalid form factor", { deviceContext: { ...context, formFactor: "other" } }, {}, 400, "INVALID_DEVICE_CONTEXT"],
    ["body/header disagreement", { deviceContext: context }, { "X-Device-Key": "z".repeat(64) }, 401, "DEVICE_IDENTITY_MISMATCH"],
    ["malformed reinstall ID", { deviceContext: { ...context, reinstallId: "invalid" } }, {}, 400, "INVALID_DEVICE_CONTEXT"],
  ] as const)("preserves credentials and code on %s", async (_name, body, headers, status, code) => {
    const user = await fixture(flow);
    const before = await authSnapshot(user._id);
    const result = await recovery(flow, body, headers);
    expect(result.status).toBe(status);
    expect(result.body.code).toBe(code);
    expect(result.body).not.toHaveProperty("accessToken");
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it("preserves the code and password on a known Android identity mismatch", async () => {
    const user = await fixture(flow);
    await Device.create({
      user: user._id, installationKeyHash: hash(key), platform: "android", formFactor: "mobile",
      displayName: "Existing phone", status: "approved", reinstallIdentityHash: "0".repeat(64),
    });
    const before = await authSnapshot(user._id);
    const result = await recovery(flow, { deviceContext: { ...context, reinstallId: `android:v1:${"e".repeat(64)}` } });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe("DEVICE_IDENTITY_MISMATCH");
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it("preserves recovery credentials for a blocked account", async () => {
    const user = await fixture(flow, { isBlocked: true });
    const before = await authSnapshot(user._id);
    const result = await recovery(flow, { deviceContext: context });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("ACCOUNT_BLOCKED");
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it("does not consume credentials when device support configuration is unavailable", async () => {
    const user = await fixture(flow);
    const before = await authSnapshot(user._id);
    vi.stubEnv("DEVICE_SUPPORT_NAME", "");
    vi.stubEnv("DEVICE_SUPPORT_EMAIL", "");
    vi.stubEnv("DEVICE_SUPPORT_PHONE", "");
    try {
      const result = await recovery(flow, { deviceContext: context });
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("DEVICE_SECURITY_CONFIGURATION_REQUIRED");
      expect(await authSnapshot(user._id)).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects expired recovery credentials without changing account data", async () => {
    const expired = new Date(Date.now() - 1_000);
    const user = await fixture(flow, {
      verificationCodeExpires: expired, passwordResetCodeExpires: expired, passwordResetExpires: expired,
    });
    const before = await authSnapshot(user._id);
    const result = await recovery(flow, { deviceContext: context });
    expect(result.status).toBe(400);
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it("allows the same credential to recover after a missing-context refusal, but not a successful replay", async () => {
    await fixture(flow);
    const refused = await recovery(flow);
    expect(refused.status).toBe(428);
    const corrected = await recovery(flow, { deviceContext: context });
    expect(corrected.status).toBe(200);
    expect(corrected.body.authState).toBe("registration_required");
    const repeated = await recovery(flow, { deviceContext: context });
    expect(repeated.status).toBe(400);
    expect(await Challenge.countDocuments()).toBe(1);
  });

  it.each(["android", "ios", "web"])("supports %s headers and enters normal enrollment without bypassing approval", async (platform) => {
    const user = await fixture(flow);
    const result = await recovery(flow, {}, {
      "X-Device-Key": key, "X-Device-Platform": platform,
      "X-Device-Form-Factor": platform === "web" ? "desktop" : "mobile",
    });
    expect(result.status).toBe(200);
    expect(result.body.authState).toBe("registration_required");
    expect(result.body.challengeToken).toBeTypeOf("string");
    expect(result.body).not.toHaveProperty("accessToken");
    const saved = await authSnapshot(user._id);
    if (flow === "verify") {
      expect(saved?.isVerified).toBe(true);
      expect(saved?.verificationCode).toBeUndefined();
    } else {
      expect(saved?.passwordResetCode).toBeUndefined();
      expect(saved?.passwordResetToken).toBeUndefined();
      expect(saved?.refreshTokens).toEqual([]);
      expect(await bcrypt.compare(nextPassword, String(saved?.password))).toBe(true);
    }
  });

  it.each(["approved", "pending", "rejected", "revoked"])("retains %s device gate after successful recovery", async (status) => {
    const user = await fixture(flow);
    await Device.create({
      user: user._id, installationKeyHash: hash(key), platform: "android", formFactor: "mobile",
      displayName: "Existing phone", status,
    });
    const result = await recovery(flow, { deviceContext: context });
    expect(result.status).toBe(200);
    expect(result.body.authState).toBe(status === "approved" ? "authenticated" : status);
    if (status === "approved") expect(result.body.accessToken).toBeTypeOf("string");
    else expect(result.body).not.toHaveProperty("accessToken");
  });
});

describe("signup, sign-in and recovery input consistency", () => {
  it("preserves exact passwords from signup through verification and subsequent sign-in", async () => {
    const signup = await request(app).post("/api/auth/signup").send({
      email: " SIGNUP@example.test ", username: "Signup fixture", password: nextPassword,
    });
    expect(signup.status).toBe(201);
    const user = await User.findOne({ email: "signup@example.test" });
    expect(mail.verification).toHaveBeenCalledWith(user.email, user.verificationCode);
    const notVerified = await request(app).post("/api/auth/login").send({ email: user.email, password: nextPassword, deviceContext: context });
    expect(notVerified.status).toBe(403);
    expect(notVerified.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED", message: "Please verify your email before logging in." });
    const verified = await request(app).post("/api/auth/verify-email").send({
      email: user.email, verificationCode: user.verificationCode, deviceContext: context,
    });
    expect(verified.status).toBe(200);
    const signedIn = await request(app).post("/api/auth/login").send({ email: user.email, password: nextPassword, deviceContext: context });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.authState).toBe("registration_required");
    const trimmed = await request(app).post("/api/auth/login").send({ email: user.email, password: nextPassword.trim(), deviceContext: context });
    expect(trimmed.status).toBe(400);
    expect(trimmed.body.message).toBe("Invalid credentials");
  });

  it.each([
    ["signup", { email: {}, password: oldPassword, username: "fixture" }],
    ["signup", { email: "bad@example.test", password: "   ", username: "fixture" }],
    ["signup", { email: "bad@example.test", password: oldPassword, username: {} }],
    ["login", { email: {}, password: oldPassword }],
    ["verify-email", { email: {}, verificationCode: "123456" }],
    ["verify-email", { email: "auth-recovery@example.test", verificationCode: {} }],
    ["resend-verification-code", { email: {} }],
    ["forgot-password", { email: {} }],
    ["reset-password-code", { email: {}, code: "654321", password: oldPassword }],
    ["reset-password-code", { email: "auth-recovery@example.test", code: {}, password: oldPassword }],
    ["reset-password-code", { email: "auth-recovery@example.test", code: "654321", password: {} }],
    [`reset-password/${resetToken}`, { password: {} }],
    [`reset-password/${resetToken}`, { password: "   " }],
  ])("rejects malformed %s input without changing authentication records", async (route, body) => {
    const user = await fixture("verify");
    const before = await authSnapshot(user._id);
    const result = await request(app).post(`/api/auth/${route}`).send(body);
    expect(result.status).toBe(400);
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(mail.verification).not.toHaveBeenCalled();
    expect(mail.code).not.toHaveBeenCalled();
    expect(mail.link).not.toHaveBeenCalled();
  });

  it("rejects verification without an expiry instead of consuming a legacy code", async () => {
    const user = await fixture("verify", { verificationCodeExpires: undefined });
    const before = await authSnapshot(user._id);
    const result = await recovery("verify", { deviceContext: context });
    expect(result.status).toBe(400);
    expect(result.body.message).toBe("Verification code has expired.");
    expect(await authSnapshot(user._id)).toEqual(before);
  });

  it("does not verify a legacy account when both the saved and submitted code are absent", async () => {
    const user = await fixture("verify", {
      verificationCode: undefined, verificationCodeExpires: undefined,
    });
    const before = await authSnapshot(user._id);
    const result = await recovery("verify", { verificationCode: undefined, deviceContext: context });
    expect(result.status).toBe(400);
    expect(await authSnapshot(user._id)).toEqual(before);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it("allows resend without installation context and replaces only the verification code", async () => {
    const user = await fixture("verify");
    const result = await request(app).post("/api/auth/resend-verification-code").send({ email: ` ${user.email.toUpperCase()} ` });
    expect(result.status).toBe(200);
    const saved = await authSnapshot(user._id);
    expect(saved?.isVerified).toBe(false);
    expect(saved?.verificationCode).toMatch(/^\d{6}$/);
    expect(mail.verification).toHaveBeenCalledWith(user.email, saved?.verificationCode);
    expect(await Challenge.countDocuments()).toBe(0);
  });

  it.each(["mobile", "web"])("sends %s reset instructions without requiring an approved device or revealing unknown accounts", async (clientType) => {
    const user = await fixture("code");
    const known = await request(app).post("/api/auth/forgot-password").send({ email: user.email, clientType });
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "unknown@example.test", clientType });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    const saved = await authSnapshot(user._id);
    if (clientType === "mobile") {
      expect(mail.code).toHaveBeenCalledWith(user.email, saved?.passwordResetCode);
      expect(mail.code).toHaveBeenCalledTimes(1);
      expect(mail.link).not.toHaveBeenCalled();
    } else {
      expect(mail.link).toHaveBeenCalledTimes(1);
      expect(mail.code).not.toHaveBeenCalled();
    }
    expect(await Challenge.countDocuments()).toBe(0);
  });
});
