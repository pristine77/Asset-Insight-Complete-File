/**
 * Implements device-bound authentication as a challenge and registration state machine.
 * Hashed reinstall identity, single-use challenge updates, session-version revocation,
 * and IP audit records prevent replay or silent device rebinding. Metadata is sanitized
 * before persistence because every field crosses an untrusted client boundary.
 */
import crypto from "crypto";
import net from "net";
import { Request } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import DeviceAccessChallenge from "../models/deviceAccessChallenge.model.js";
import DeviceRegistration, {
  type DeviceStatus,
} from "../models/deviceRegistration.model.js";
import SecurityAuditEvent from "../models/securityAuditEvent.model.js";
import UserIpObservation from "../models/userIpObservation.model.js";
import User from "../models/user.model.js";
import {
  getSystemSettingValue,
  setSystemSettingValue,
} from "./systemSettingsService.js";
import { attachUserCapabilities } from "../utils/userCapabilities.js";

export const DEVICE_SECURITY_SETTING_KEY = "device_security_contact";
export const DEVICE_RESTRICTED_CODES = new Set([
  "DEVICE_CONTEXT_REQUIRED",
  "DEVICE_PENDING",
  "DEVICE_REREQUEST_PENDING",
  "DEVICE_REJECTED",
  "DEVICE_REVOKED",
  "IP_BLOCKED",
]);

export type DeviceAuthState =
  | "authenticated"
  | "registration_required"
  | "pending"
  | "rerequest_pending"
  | "rejected"
  | "revoked"
  | "ip_blocked";

export interface DeviceSupportContact {
  name: string;
  email: string;
  phone: string;
}

export interface DeviceContextInput {
  installationKey?: unknown;
  reinstallId?: unknown;
  platform?: unknown;
  formFactor?: unknown;
  displayName?: unknown;
  metadata?: unknown;
}

export class DeviceApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const hashValue = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

function hashReinstallIdentity(reinstallId: string) {
  // A dedicated secret is recommended in production so reinstall identifiers
  // remain unlinkable even if another signing secret is rotated or exposed.
  const pepper =
    process.env.DEVICE_REINSTALL_ID_SECRET ||
    process.env.JWT_REFRESH_SECRET ||
    process.env.JWT_SECRET;
  if (!pepper) {
    throw new DeviceApiError(
      503,
      "DEVICE_SECURITY_CONFIGURATION_REQUIRED",
      "Native device recovery is not configured."
    );
  }
  return crypto
    .createHmac("sha256", pepper)
    .update(`asset-insight-native-reinstall-v1|android|${reinstallId}`)
    .digest("hex");
}

function normalizeReinstallIdentity(value: unknown): string | undefined {
  const reinstallId = stringValue(value, 160)?.toLowerCase();
  if (!reinstallId) return undefined;
  if (!/^android:v1:[a-f0-9]{64}$/.test(reinstallId)) {
    throw new DeviceApiError(
      400,
      "INVALID_DEVICE_CONTEXT",
      "Invalid Android reinstall identity."
    );
  }
  return hashReinstallIdentity(reinstallId);
}

export const isDeviceApprovalEnforced = () =>
  /^(on|true|1|enforce|enabled)$/i.test(
    String(process.env.DEVICE_APPROVAL_ENFORCEMENT || "off").trim()
  );

export function normalizeIp(raw: unknown): string {
  let value = String(raw || "").trim();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close > 0) value = value.slice(1, close);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.startsWith("::ffff:")) value = value.slice(7);
  const version = net.isIP(value);
  if (version === 4) return value;
  if (version === 6) {
    try {
      const hostname = new URL(`http://[${value}]/`).hostname;
      return hostname.slice(1, -1).toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }
  return "unknown";
}

export function getRequestIp(req: Request): string {
  // Express derives req.ip from the socket plus the configured trusted-proxy hop
  // count. Never read a client-supplied IP field or X-Forwarded-For directly.
  return normalizeIp(req.ip || req.socket.remoteAddress);
}

function stringValue(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  return normalized ? normalized.slice(0, max) : undefined;
}

const SENSITIVE_METADATA_KEY =
  /(^|_)(deviceid|mediaid|groupid|token|secret|password|authorization|cookie|raw)(_|$)/i;
const UNSAFE_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeValue(value: unknown, depth: number): unknown {
  // Camera capabilities contain nested device -> resolution -> width/height
  // values. Keep enough depth for those fields while retaining strict array
  // and object-size bounds below.
  if (depth > 6 || value == null) return undefined;
  if (typeof value === "string") return stringValue(value, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 60);
    const output = Object.create(null) as Record<string, unknown>;
    for (const [rawKey, rawValue] of entries) {
      if (UNSAFE_METADATA_KEYS.has(rawKey.toLowerCase())) continue;
      const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
      if (!key || UNSAFE_METADATA_KEYS.has(key.toLowerCase()) || SENSITIVE_METADATA_KEY.test(key)) continue;
      const sanitized = sanitizeValue(rawValue, depth + 1);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  }
  return undefined;
}

export function sanitizeDeviceMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function normalizeDeviceContext(value: unknown) {
  const source = (value && typeof value === "object" ? value : {}) as DeviceContextInput;
  const installationKey = stringValue(source.installationKey, 512);
  if (!installationKey || installationKey.length < 32) {
    throw new DeviceApiError(
      428,
      "DEVICE_CONTEXT_REQUIRED",
      "A valid device installation key is required.",
      { authState: "registration_required" }
    );
  }
  const platform = stringValue(source.platform, 20);
  const formFactor = stringValue(source.formFactor, 20);
  if (!platform || !["web", "android", "ios"].includes(platform)) {
    throw new DeviceApiError(400, "INVALID_DEVICE_CONTEXT", "Invalid device platform.");
  }
  if (!formFactor || !["desktop", "mobile", "tablet"].includes(formFactor)) {
    throw new DeviceApiError(400, "INVALID_DEVICE_CONTEXT", "Invalid device form factor.");
  }
  const reinstallIdentityHash = normalizeReinstallIdentity(source.reinstallId);
  if (reinstallIdentityHash && platform !== "android") {
    throw new DeviceApiError(
      400,
      "INVALID_DEVICE_CONTEXT",
      "A reinstall identity can only be used by an Android installation."
    );
  }
  return {
    installationKey,
    installationKeyHash: hashValue(installationKey),
    platform: platform as "web" | "android" | "ios",
    formFactor: formFactor as "desktop" | "mobile" | "tablet",
    displayName:
      stringValue(source.displayName, 160) ||
      `${platform === "web" ? "Web" : platform === "ios" ? "iOS" : "Android"} ${formFactor}`,
    metadata: sanitizeDeviceMetadata(source.metadata),
    reinstallIdentityHash,
  };
}

function requestDeviceContext(req: Request): DeviceContextInput {
  const bodyContext =
    req.body?.deviceContext && typeof req.body.deviceContext === "object"
      ? (req.body.deviceContext as DeviceContextInput)
      : {};
  const bodyKey = stringValue(bodyContext.installationKey, 512);
  const headerKey = stringValue(req.get("x-device-key"), 512);
  const bodyReinstallId = stringValue(bodyContext.reinstallId, 160);
  const headerReinstallId = stringValue(req.get("x-device-reinstall-id"), 160);

  // The body and headers describe the same installation. Reject ambiguity
  // instead of silently binding a session to whichever value is read first.
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new DeviceApiError(
      401,
      "DEVICE_IDENTITY_MISMATCH",
      "The device installation identity did not match."
    );
  }
  if (
    bodyReinstallId &&
    headerReinstallId &&
    bodyReinstallId.toLowerCase() !== headerReinstallId.toLowerCase()
  ) {
    throw new DeviceApiError(
      401,
      "DEVICE_IDENTITY_MISMATCH",
      "The Android installation identity did not match."
    );
  }

  const reinstallId = bodyReinstallId || headerReinstallId;
  return {
    installationKey: bodyKey || headerKey,
    reinstallId,
    platform:
      bodyContext.platform ||
      stringValue(req.get("x-device-platform"), 20) ||
      (reinstallId ? "android" : undefined),
    formFactor:
      bodyContext.formFactor ||
      stringValue(req.get("x-device-form-factor"), 20) ||
      (reinstallId ? "mobile" : undefined),
    displayName: bodyContext.displayName,
    metadata: bodyContext.metadata,
  };
}

function assertAccountAvailable(user: any): void {
  if (user.isBlocked) {
    throw new DeviceApiError(403, "ACCOUNT_BLOCKED", "Your account is blocked.");
  }
}

function assertDeviceIdentityMatches(
  device: any,
  context: ReturnType<typeof normalizeDeviceContext>,
  supportContact: DeviceSupportContact
): void {
  if (device && context.reinstallIdentityHash && device.platform !== "android") {
    throw new DeviceApiError(
      401,
      "DEVICE_IDENTITY_MISMATCH",
      "This installation key is not bound to an Android device.",
      { authState: "registration_required", supportContact }
    );
  }
  if (device?.reinstallIdentityHash && context.reinstallIdentityHash &&
    device.reinstallIdentityHash !== context.reinstallIdentityHash) {
    throw new DeviceApiError(
      401,
      "DEVICE_IDENTITY_MISMATCH",
      "This installation key belongs to a different Android device.",
      { authState: "registration_required", supportContact }
    );
  }
}

export async function assertDeviceSessionContext(user: any, req: Request): Promise<void> {
  assertAccountAvailable(user);
  if (!isDeviceApprovalEnforced() || user.role !== "user") return;
  const context = normalizeDeviceContext(requestDeviceContext(req));
  const supportContact = await requireSupportContact();
  const device = await DeviceRegistration.findOne({
    user: user._id,
    installationKeyHash: context.installationKeyHash,
  }).select("platform +reinstallIdentityHash");
  // Read-only admission before a one-time code/password mutation. Enrollment,
  // pending approval and device/IP restrictions still use the normal session
  // path; a known identity mismatch must not consume the recovery credential.
  assertDeviceIdentityMatches(device, context, supportContact);
}

export async function getDeviceSupportContact(): Promise<DeviceSupportContact> {
  const stored = await getSystemSettingValue<Partial<DeviceSupportContact>>(
    DEVICE_SECURITY_SETTING_KEY,
    {}
  );
  return {
    name: stringValue(stored?.name || process.env.DEVICE_SUPPORT_NAME, 120) || "",
    email: stringValue(stored?.email || process.env.DEVICE_SUPPORT_EMAIL, 200) || "",
    phone: stringValue(stored?.phone || process.env.DEVICE_SUPPORT_PHONE, 80) || "",
  };
}

export function validateSupportContact(value: unknown): DeviceSupportContact {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const contact = {
    name: stringValue(source.name, 120) || "",
    email: stringValue(source.email, 200)?.toLowerCase() || "",
    phone: stringValue(source.phone, 80) || "",
  };
  if (contact.name.length < 2) {
    throw new DeviceApiError(400, "INVALID_SUPPORT_CONTACT", "Support name is required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    throw new DeviceApiError(400, "INVALID_SUPPORT_CONTACT", "A valid support email is required.");
  }
  if (!/^[+()\-\s0-9]{7,30}$/.test(contact.phone)) {
    throw new DeviceApiError(400, "INVALID_SUPPORT_CONTACT", "A valid support phone is required.");
  }
  return contact;
}

export async function setDeviceSupportContact(
  value: unknown,
  actorId?: string
): Promise<DeviceSupportContact> {
  const contact = validateSupportContact(value);
  await setSystemSettingValue(DEVICE_SECURITY_SETTING_KEY, contact, actorId);
  return contact;
}

async function requireSupportContact(): Promise<DeviceSupportContact> {
  try {
    return validateSupportContact(await getDeviceSupportContact());
  } catch {
    throw new DeviceApiError(
      503,
      "DEVICE_SECURITY_CONFIGURATION_REQUIRED",
      "Device approval cannot be enabled until support contact details are configured."
    );
  }
}

export async function writeSecurityAudit(input: {
  action: string;
  actorType: "admin" | "user" | "system";
  actor?: string | mongoose.Types.ObjectId;
  targetUser?: string | mongoose.Types.ObjectId;
  device?: string | mongoose.Types.ObjectId;
  ipObservation?: string | mongoose.Types.ObjectId;
  reason?: string;
  before?: unknown;
  after?: unknown;
  req?: Request;
}) {
  return SecurityAuditEvent.create({
    action: input.action,
    actorType: input.actorType,
    actor: input.actor,
    targetUser: input.targetUser,
    device: input.device,
    ipObservation: input.ipObservation,
    reason: stringValue(input.reason, 1000),
    before: input.before,
    after: input.after,
    requestIp: input.req ? getRequestIp(input.req) : undefined,
    userAgent: input.req ? stringValue(input.req.get("user-agent"), 500) : undefined,
  });
}

export async function recordIpObservation(
  userId: string | mongoose.Types.ObjectId,
  req: Request,
  deviceId?: string | mongoose.Types.ObjectId
) {
  const ip = getRequestIp(req);
  const now = new Date();
  const update: Record<string, unknown> = {
    $set: { lastSeenAt: now, source: "observed" },
    $setOnInsert: { firstSeenAt: now, blocked: false },
    $inc: { count: 1 },
  };
  if (deviceId) update.$addToSet = { devices: deviceId };
  return UserIpObservation.findOneAndUpdate(
    { user: userId, ip },
    update,
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function assertIpAllowed(
  userId: string | mongoose.Types.ObjectId,
  req: Request,
  deviceId?: string | mongoose.Types.ObjectId
) {
  const observation = await recordIpObservation(userId, req, deviceId);
  if (observation?.blocked) {
    throw new DeviceApiError(403, "IP_BLOCKED", "Access from this IP address is blocked.", {
      authState: "ip_blocked",
      reason: observation.blockReason,
      supportContact: await getDeviceSupportContact(),
    });
  }
  return observation;
}

async function createChallenge(
  purpose: "enrollment" | "status",
  userId: string | mongoose.Types.ObjectId,
  req: Request,
  deviceId?: string | mongoose.Types.ObjectId,
  installationKeyHash?: string,
  reinstallIdentityHash?: string
) {
  // Rate-limit issuance and cap live rows independently. Challenges are stored hashed,
  // so a database read cannot be exchanged for a session without the client-held token.
  const now = new Date();
  const recentCount = await DeviceAccessChallenge.countDocuments({
    user: userId,
    purpose,
    createdAt: { $gte: new Date(now.getTime() - 60_000) },
  });
  if (recentCount >= 20) {
    throw new DeviceApiError(
      429,
      "DEVICE_CHALLENGE_RATE_LIMITED",
      "Too many device access checks. Wait one minute and try again."
    );
  }
  const activeCap = purpose === "enrollment" ? 25 : 100;
  const excess = await DeviceAccessChallenge.find({
    user: userId,
    purpose,
    expiresAt: { $gt: now },
    consumedAt: { $exists: false },
  })
    .sort({ createdAt: -1 })
    .skip(activeCap - 1)
    .select("_id")
    .lean();
  if (excess.length) {
    await DeviceAccessChallenge.deleteMany({ _id: { $in: excess.map((item) => item._id) } });
  }
  const raw = crypto.randomBytes(32).toString("base64url");
  const lifetime = purpose === "enrollment" ? 15 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const challenge = await DeviceAccessChallenge.create({
    tokenHash: hashValue(raw),
    purpose,
    user: userId,
    device: deviceId,
    installationKeyHash,
    reinstallIdentityHash,
    expiresAt: new Date(now.getTime() + lifetime),
    createdIp: getRequestIp(req),
  });
  return { token: raw, expiresAt: challenge.expiresAt };
}

export function getChallengeToken(req: Request): string {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const bodyToken = stringValue((req.body as Record<string, unknown> | undefined)?.challengeToken, 1000);
  const token = bearer || bodyToken;
  if (!token) {
    throw new DeviceApiError(401, "DEVICE_CHALLENGE_REQUIRED", "Device challenge token is required.");
  }
  return token;
}

async function loadChallenge(
  token: string,
  purpose?: "enrollment" | "status"
) {
  const challenge = await DeviceAccessChallenge.findOne({
    tokenHash: hashValue(token),
    expiresAt: { $gt: new Date() },
    consumedAt: { $exists: false },
    ...(purpose ? { purpose } : {}),
  }).select("+tokenHash +installationKeyHash +reinstallIdentityHash");
  if (!challenge) {
    throw new DeviceApiError(
      401,
      "DEVICE_CHALLENGE_EXPIRED",
      "This device access request has expired. Sign in again."
    );
  }
  return challenge;
}

function statusCode(status: DeviceStatus): string {
  if (status === "pending") return "DEVICE_PENDING";
  if (status === "rerequest_pending") return "DEVICE_REREQUEST_PENDING";
  if (status === "rejected") return "DEVICE_REJECTED";
  if (status === "revoked") return "DEVICE_REVOKED";
  return status === "approved" ? "DEVICE_APPROVED" : "DEVICE_CONTEXT_REQUIRED";
}

function publicDevice(device: any) {
  const metadata = sanitizeDeviceMetadata(device.metadata);
  const camera =
    metadata.camera && typeof metadata.camera === "object" && !Array.isArray(metadata.camera)
      ? (metadata.camera as Record<string, unknown>)
      : {};
  const hardwareProfile =
    metadata.hardwareProfile &&
    typeof metadata.hardwareProfile === "object" &&
    !Array.isArray(metadata.hardwareProfile)
      ? (metadata.hardwareProfile as Record<string, unknown>)
      : {};
  const hardwareCamera =
    hardwareProfile.camera &&
    typeof hardwareProfile.camera === "object" &&
    !Array.isArray(hardwareProfile.camera)
      ? (hardwareProfile.camera as Record<string, unknown>)
      : {};
  return {
    id: String(device._id),
    status: device.status,
    displayName: device.displayName,
    platform: device.platform,
    formFactor: device.formFactor,
    requestCount: device.requestCount,
    requestedAt: device.lastRequestAt || device.createdAt,
    decidedAt: device.decidedAt,
    reason: device.decisionReason,
    lastIp: device.lastIp,
    camera: {
      verification: camera.verification,
      count: hardwareCamera.lensCount ?? camera.count,
      rearMaximumMegapixels: hardwareCamera.rearMaximumMegapixels,
      aggregateMegapixels: hardwareCamera.aggregateMegapixels,
    },
  };
}

function mergedDeviceMetadata(existing: unknown, incoming: Record<string, unknown>) {
  const current = sanitizeDeviceMetadata(existing);
  return {
    ...current,
    ...incoming,
    // Normal sign-in collects identity/storage details but deliberately does
    // not request camera permission. Preserve the last verified camera result.
    ...(!Object.prototype.hasOwnProperty.call(incoming, "camera") && current.camera
      ? { camera: current.camera }
      : {}),
  };
}

async function issueSession(user: any, device?: any, message?: string) {
  const did = device ? String(device._id) : undefined;
  const deviceVersion = device ? Number(device.sessionVersion || 0) : undefined;
  const claims = did
    ? { id: user._id, did, dv: deviceVersion }
    : { id: user._id };
  const accessToken = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "15m" });
  const refreshToken = jwt.sign(claims, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: "90d",
  });
  const decoded = jwt.decode(refreshToken) as { exp?: number } | null;
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const refreshRecord = {
    tokenHash: hashValue(refreshToken),
    expiresAt,
    createdAt: new Date(),
    ...(did ? { deviceId: device._id } : {}),
  };
  // Persist the refresh-token hash before returning either token. If storage fails, the
  // client receives no credential that the server cannot subsequently revoke or verify.
  await User.updateOne(
    { _id: user._id },
    { $pull: { refreshTokens: { expiresAt: { $lte: new Date() } } } }
  );
  const stored = await User.updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { $each: [refreshRecord], $slice: -20 } } }
  );
  if (!stored.matchedCount) {
    throw new DeviceApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot start a session.");
  }
  if (device) {
    await DeviceRegistration.updateOne(
      { _id: device._id },
      { $set: { lastSeenAt: new Date() } }
    );
  }
  const safeUser = await attachUserCapabilities(
    await User.findById(user._id).select("-password -refreshTokens -refreshToken")
  );
  return {
    authState: "authenticated" as const,
    ...(message ? { message } : {}),
    accessToken,
    refreshToken,
    user: safeUser,
    ...(device ? { device: publicDevice(device) } : {}),
  };
}

export async function beginDeviceAwareSession(
  user: any,
  req: Request,
  message?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  assertAccountAvailable(user);
  // Admin and feature-disabled flows retain the legacy session contract. Enforcement is
  // intentionally scoped to end-user accounts to avoid locking out the approval plane.
  if (!isDeviceApprovalEnforced() || user.role !== "user") {
    return { status: 200, body: await issueSession(user, undefined, message) };
  }
  const supportContact = await requireSupportContact();
  const context = normalizeDeviceContext(requestDeviceContext(req));
  const ipObservation = await assertIpAllowed(user._id, req);
  if (ipObservation.blocked) {
    return {
      status: 403,
      body: {
        authState: "ip_blocked",
        code: "IP_BLOCKED",
        message: "Access from this IP address is blocked.",
        reason: ipObservation.blockReason,
        supportContact,
      },
    };
  }

  let device = await DeviceRegistration.findOne({
    user: user._id,
    installationKeyHash: context.installationKeyHash,
  }).select("+installationKeyHash +reinstallIdentityHash");

  assertDeviceIdentityMatches(device, context, supportContact);
  if (device && context.reinstallIdentityHash && !device.reinstallIdentityHash) {
    // Seed the stronger Android identity only onto legacy rows where it is absent. The
    // compare-and-set plus unique index prevents two installations from racing to bind it.
    const deviceId = device._id;
    let seededNow = true;
    try {
      device = await DeviceRegistration.findOneAndUpdate(
        {
          _id: deviceId,
          user: user._id,
          $or: [
            { reinstallIdentityHash: { $exists: false } },
            { reinstallIdentityHash: null },
          ],
        },
        { $set: { reinstallIdentityHash: context.reinstallIdentityHash } },
        { returnDocument: "after" }
      ).select("+installationKeyHash +reinstallIdentityHash");
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new DeviceApiError(
          409,
          "DEVICE_STATE_CHANGED",
          "This Android device is already bound to another registration for this account. Sign in again."
        );
      }
      throw error;
    }
    if (!device) {
      const current = await DeviceRegistration.findById(deviceId).select(
        "+installationKeyHash +reinstallIdentityHash"
      );
      if (current?.reinstallIdentityHash !== context.reinstallIdentityHash) {
        throw new DeviceApiError(
          409,
          "DEVICE_STATE_CHANGED",
          "Device identity changed while signing in. Try again."
        );
      }
      device = current;
      seededNow = false;
    }
    if (seededNow) {
      await writeSecurityAudit({
        action: "device.reinstall_identity_seeded",
        actorType: "user",
        actor: user._id,
        targetUser: user._id,
        device: device._id,
        before: { reinstallRecoveryBound: false },
        after: { reinstallRecoveryBound: true },
        reason: "Existing Android installation enabled reinstall recovery during sign-in",
        req,
      });
    }
  }

  if (!device && context.reinstallIdentityHash) {
    const previous = await DeviceRegistration.findOne({
      user: user._id,
      platform: context.platform,
      reinstallIdentityHash: context.reinstallIdentityHash,
    }).select("+installationKeyHash +reinstallIdentityHash");

    if (previous) {
      const previousInstallationKeyHash = previous.installationKeyHash;
      const rebound = await DeviceRegistration.findOneAndUpdate(
        {
          _id: previous._id,
          user: user._id,
          platform: context.platform,
          reinstallIdentityHash: context.reinstallIdentityHash,
          installationKeyHash: previousInstallationKeyHash,
        },
        {
          $set: {
            installationKeyHash: context.installationKeyHash,
            displayName: context.displayName,
            metadata: mergedDeviceMetadata(previous.metadata, context.metadata),
            lastSeenAt: new Date(),
            lastIp: getRequestIp(req),
          },
          $inc: { sessionVersion: 1 },
        },
        { returnDocument: "after" }
      ).select("+installationKeyHash +reinstallIdentityHash");
      if (!rebound) {
        throw new DeviceApiError(
          409,
          "DEVICE_STATE_CHANGED",
          "This Android device was recovered by another sign-in. Try again."
        );
      }

      await Promise.all([
        User.updateOne(
          { _id: user._id },
          { $pull: { refreshTokens: { deviceId: rebound._id } } }
        ),
        DeviceAccessChallenge.deleteMany({
          user: user._id,
          $or: [
            { device: rebound._id },
            { installationKeyHash: previousInstallationKeyHash },
          ],
        }),
      ]);
      await writeSecurityAudit({
        action: "device.installation_rebound",
        actorType: "user",
        actor: user._id,
        targetUser: user._id,
        device: rebound._id,
        before: {
          status: previous.status,
          sessionVersion: previous.sessionVersion,
        },
        after: {
          status: rebound.status,
          sessionVersion: rebound.sessionVersion,
        },
        reason: "Android app reinstalled on an existing bound device",
        req,
      });
      device = rebound;
    }
  }

  if (!device) {
    const challenge = await createChallenge(
      "enrollment",
      user._id,
      req,
      undefined,
      context.installationKeyHash,
      context.reinstallIdentityHash
    );
    return {
      status: 200,
      body: {
        authState: "registration_required",
        code: "DEVICE_CONTEXT_REQUIRED",
        message: "This installation must be registered before it can access Asset Insight.",
        challengeToken: challenge.token,
        challengeExpiresAt: challenge.expiresAt,
        supportContact,
      },
    };
  }

  const refreshedDevice = await DeviceRegistration.findOneAndUpdate(
    { _id: device._id },
    {
      $set: {
        displayName: context.displayName,
        metadata: mergedDeviceMetadata(device.metadata, context.metadata),
        lastSeenAt: new Date(),
        lastIp: getRequestIp(req),
      },
    },
    { returnDocument: "after" }
  ).select("+installationKeyHash +reinstallIdentityHash");
  if (!refreshedDevice) {
    throw new DeviceApiError(404, "DEVICE_NOT_FOUND", "Device registration was not found.");
  }
  await assertIpAllowed(user._id, req, device._id);
  if (refreshedDevice.status === "approved") {
    return { status: 200, body: await issueSession(user, refreshedDevice, message) };
  }

  const challenge = await createChallenge("status", user._id, req, refreshedDevice._id);
  return {
    status: 200,
    body: {
      authState: refreshedDevice.status,
      code: statusCode(refreshedDevice.status),
      message: "This device is not approved for access.",
      challengeToken: challenge.token,
      challengeExpiresAt: challenge.expiresAt,
      device: publicDevice(refreshedDevice),
      reason: refreshedDevice.decisionReason,
      supportContact,
    },
  };
}

function readDeviceKey(req: Request): string {
  const header = stringValue(req.get("x-device-key"), 512);
  const body = stringValue((req.body as Record<string, unknown> | undefined)?.deviceKey, 512);
  const key = header || body;
  if (!key || key.length < 32) {
    throw new DeviceApiError(428, "DEVICE_CONTEXT_REQUIRED", "Device proof is required.");
  }
  return key;
}

function assertDeviceProof(req: Request, device: any) {
  const suppliedHash = hashValue(readDeviceKey(req));
  if (!device.installationKeyHash || device.installationKeyHash !== suppliedHash) {
    throw new DeviceApiError(401, "DEVICE_CONTEXT_REQUIRED", "Device proof did not match.");
  }
}

async function seedReinstallIdentityFromProof(
  user: any,
  device: any,
  req: Request
) {
  const suppliedHash = normalizeReinstallIdentity(
    req.get("x-device-reinstall-id")
  );
  if (!suppliedHash) return;
  if (device.platform !== "android") {
    throw new DeviceApiError(
      401,
      "DEVICE_IDENTITY_MISMATCH",
      "A native reinstall identity was supplied for a non-Android device.",
      {
        authState: "registration_required",
        supportContact: await getDeviceSupportContact(),
      }
    );
  }
  if (device.reinstallIdentityHash) {
    if (device.reinstallIdentityHash !== suppliedHash) {
      throw new DeviceApiError(
        401,
        "DEVICE_IDENTITY_MISMATCH",
        "This installation key belongs to a different Android device.",
        {
          authState: "registration_required",
          supportContact: await getDeviceSupportContact(),
        }
      );
    }
    return;
  }

  let seeded;
  try {
    seeded = await DeviceRegistration.findOneAndUpdate(
      {
        _id: device._id,
        user: user._id,
        platform: "android",
        $or: [
          { reinstallIdentityHash: { $exists: false } },
          { reinstallIdentityHash: null },
        ],
      },
      { $set: { reinstallIdentityHash: suppliedHash } },
      { returnDocument: "after" }
    ).select("+reinstallIdentityHash");
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }

  if (!seeded) {
    const current = await DeviceRegistration.findById(device._id).select(
      "+reinstallIdentityHash"
    );
    if (current?.reinstallIdentityHash === suppliedHash) return;
    throw new DeviceApiError(
      409,
      "DEVICE_STATE_CHANGED",
      "This Android device is already bound to another registration for this account. Sign in again."
    );
  }

  device.reinstallIdentityHash = suppliedHash;
  await writeSecurityAudit({
    action: "device.reinstall_identity_seeded",
    actorType: "user",
    actor: user._id,
    targetUser: user._id,
    device: device._id,
    before: { reinstallRecoveryBound: false },
    after: { reinstallRecoveryBound: true },
    reason: "Existing Android installation enabled reinstall recovery",
    req,
  });
}

function cameraVerification(metadata: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(metadata, "camera")) return undefined;
  const camera = metadata.camera;
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) return undefined;
  return stringValue((camera as Record<string, unknown>).verification, 40);
}

export async function registerDeviceRequest(req: Request) {
  const supportContact = await requireSupportContact();
  const challengeToken = getChallengeToken(req);
  const challenge = await loadChallenge(challengeToken, "enrollment");
  const context = normalizeDeviceContext({
    installationKey: readDeviceKey(req),
    reinstallId: req.body?.reinstallId,
    platform: req.body?.platform,
    formFactor: req.body?.formFactor,
    displayName: req.body?.displayName,
    metadata: req.body?.metadata,
  });
  if (
    !challenge.installationKeyHash ||
    challenge.installationKeyHash !== context.installationKeyHash ||
    challenge.reinstallIdentityHash !== context.reinstallIdentityHash
  ) {
    throw new DeviceApiError(
      401,
      "DEVICE_CHALLENGE_DEVICE_MISMATCH",
      "This enrollment challenge belongs to a different installation. Sign in again."
    );
  }
  const verification = cameraVerification(context.metadata);
  if (!verification || !["granted", "no_camera"].includes(verification)) {
    throw new DeviceApiError(
      422,
      "CAMERA_VERIFICATION_REQUIRED",
      "Camera access is required when camera hardware is available. Retry camera detection."
    );
  }
  await assertIpAllowed(challenge.user, req);
  const user = await User.findById(challenge.user);
  if (!user || user.role !== "user" || user.isBlocked) {
    throw new DeviceApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot request access.");
  }
  // Challenge consumption is an atomic state transition, not a read-then-write check;
  // only one concurrent registration request can win.
  const consumed = await DeviceAccessChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!consumed) {
    throw new DeviceApiError(409, "DEVICE_CHALLENGE_REPLAYED", "This enrollment token was already used.");
  }
  const now = new Date();
  const initialStatus: DeviceStatus =
    user.deviceApprovalMode === "all_devices" ? "approved" : "pending";
  let device;
  try {
    device = await DeviceRegistration.findOneAndUpdate(
      { user: user._id, installationKeyHash: context.installationKeyHash },
      {
        $setOnInsert: {
          user: user._id,
          installationKeyHash: context.installationKeyHash,
          status: initialStatus,
          requestCount: 1,
          requestHistory: [],
          lastRequestAt: now,
          ...(initialStatus === "approved"
            ? { approvedVia: "all_devices", decidedAt: now }
            : {}),
        },
        $set: {
          platform: context.platform,
          formFactor: context.formFactor,
          displayName: context.displayName,
          metadata: context.metadata,
          lastSeenAt: now,
          lastIp: getRequestIp(req),
          ...(context.reinstallIdentityHash
            ? { reinstallIdentityHash: context.reinstallIdentityHash }
            : {}),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).select("+installationKeyHash +reinstallIdentityHash");
  } catch (error: any) {
    if (error?.code === 11000 && context.reinstallIdentityHash) {
      throw new DeviceApiError(
        409,
        "DEVICE_STATE_CHANGED",
        "This Android device registration changed. Sign in again."
      );
    }
    throw error;
  }
  await recordIpObservation(user._id, req, device._id);
  await writeSecurityAudit({
    action: initialStatus === "approved" ? "device.auto_approved" : "device.requested",
    actorType: "user",
    actor: user._id,
    targetUser: user._id,
    device: device._id,
    after: { status: device.status, platform: device.platform, formFactor: device.formFactor },
    req,
  });
  const statusChallenge = await createChallenge("status", user._id, req, device._id);
  return {
    authState: device.status,
    code: statusCode(device.status),
    message:
      device.status === "approved"
        ? "This installation is approved and ready to exchange."
        : "Your device approval request was sent to an administrator.",
    challengeToken: statusChallenge.token,
    challengeExpiresAt: statusChallenge.expiresAt,
    device: publicDevice(device),
    supportContact,
  };
}

async function loadStatusDevice(req: Request) {
  const token = getChallengeToken(req);
  const challenge = await loadChallenge(token, "status");
  const device = await DeviceRegistration.findById(challenge.device).select(
    "+installationKeyHash"
  );
  if (!device || String(device.user) !== String(challenge.user)) {
    throw new DeviceApiError(404, "DEVICE_NOT_FOUND", "Device request was not found.");
  }
  assertDeviceProof(req, device);
  const observation = await assertIpAllowed(challenge.user, req, device._id);
  return { token, challenge, device, observation };
}

export async function getDeviceRequestStatus(req: Request) {
  const supportContact = await requireSupportContact();
  const { device, observation } = await loadStatusDevice(req);
  if (observation.blocked) {
    return {
      status: "ip_blocked",
      code: "IP_BLOCKED",
      reason: observation.blockReason,
      supportContact,
    };
  }
  return {
    status: device.status,
    code: statusCode(device.status),
    device: publicDevice(device),
    reason: device.decisionReason,
    supportContact,
  };
}

export async function exchangeApprovedDevice(req: Request) {
  const { challenge, device } = await loadStatusDevice(req);
  if (device.status !== "approved") {
    throw new DeviceApiError(403, statusCode(device.status), "This device is not approved.", {
      authState: device.status,
      reason: device.decisionReason,
      supportContact: await getDeviceSupportContact(),
    });
  }
  const consumed = await DeviceAccessChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!consumed) {
    throw new DeviceApiError(409, "DEVICE_CHALLENGE_REPLAYED", "Approval was already exchanged.");
  }
  const user = await User.findById(challenge.user);
  if (!user || user.isBlocked) {
    throw new DeviceApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot sign in.");
  }
  await writeSecurityAudit({
    action: "device.approval_exchanged",
    actorType: "user",
    actor: user._id,
    targetUser: user._id,
    device: device._id,
    req,
  });
  return issueSession(user, device);
}

export async function rerequestDeviceAccess(req: Request) {
  const supportContact = await requireSupportContact();
  const { challenge, device } = await loadStatusDevice(req);
  if (!["rejected", "revoked"].includes(device.status)) {
    throw new DeviceApiError(
      409,
      "DEVICE_STATE_CHANGED",
      "Only rejected or revoked devices can submit a new request."
    );
  }
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const updated = await DeviceRegistration.findOneAndUpdate(
    {
      _id: device._id,
      status: { $in: ["rejected", "revoked"] },
      $and: [
        {
          $or: [
            { lastRerequestAt: { $exists: false } },
            { lastRerequestAt: { $lte: oneMinuteAgo } },
          ],
        },
        {
          $expr: {
            $lt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$requestHistory", []] },
                    as: "requestedAt",
                    cond: { $gte: ["$$requestedAt", oneDayAgo] },
                  },
                },
              },
              5,
            ],
          },
        },
      ],
    },
    {
      $set: {
        status: "rerequest_pending",
        lastRequestAt: now,
        lastRerequestAt: now,
        lastSeenAt: now,
        lastIp: getRequestIp(req),
        ...(stringValue(req.body?.displayName, 160)
          ? { displayName: stringValue(req.body.displayName, 160) }
          : {}),
        ...(req.body?.metadata
          ? {
              metadata: mergedDeviceMetadata(
                device.metadata,
                sanitizeDeviceMetadata(req.body.metadata)
              ),
            }
          : {}),
      },
      $unset: {
        decisionReason: "",
        decidedAt: "",
        decidedBy: "",
      },
      $inc: { requestCount: 1 },
      $push: { requestHistory: now },
    },
    { returnDocument: "after" }
  ).select("+installationKeyHash");
  if (!updated) {
    const fresh = await DeviceRegistration.findById(device._id);
    const recent = (fresh?.requestHistory || []).filter(
      (entry: Date) => entry >= oneDayAgo
    );
    if (fresh?.lastRerequestAt && fresh.lastRerequestAt > oneMinuteAgo) {
      throw new DeviceApiError(429, "DEVICE_REREQUEST_COOLDOWN", "Wait one minute before re-requesting.", {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((fresh.lastRerequestAt.getTime() + 60_000 - Date.now()) / 1000)
        ),
      });
    }
    if (recent.length >= 5) {
      throw new DeviceApiError(
        429,
        "DEVICE_REREQUEST_LIMIT",
        "The maximum of five re-requests in 24 hours has been reached."
      );
    }
    throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "Device state changed. Refresh and try again.");
  }
  await DeviceAccessChallenge.updateOne(
    { _id: challenge._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: now } }
  );
  await writeSecurityAudit({
    action: "device.rerequested",
    actorType: "user",
    actor: updated.user,
    targetUser: updated.user,
    device: updated._id,
    before: { status: device.status },
    after: { status: updated.status, requestCount: updated.requestCount },
    req,
  });
  const nextChallenge = await createChallenge("status", updated.user, req, updated._id);
  return {
    authState: "rerequest_pending" as const,
    code: "DEVICE_REREQUEST_PENDING",
    message: "Your new request was sent to an administrator.",
    challengeToken: nextChallenge.token,
    challengeExpiresAt: nextChallenge.expiresAt,
    device: publicDevice(updated),
    supportContact,
  };
}

export async function verifyProtectedDeviceRequest(
  user: any,
  decoded: { id: string; did?: string; dv?: number },
  req: Request,
  options: { requireDevice?: boolean } = {}
) {
  // Approval is checked on every protected request. JWT expiry alone is insufficient:
  // status and sessionVersion provide immediate revocation without a token deny-list.
  if (!options.requireDevice && (!isDeviceApprovalEnforced() || user.role !== "user")) return undefined;
  if (!decoded.did) {
    throw new DeviceApiError(
      401,
      "DEVICE_CONTEXT_REQUIRED",
      "This session was not issued to an approved device.",
      { authState: "registration_required" }
    );
  }
  const device = await DeviceRegistration.findOne({
    _id: decoded.did,
    user: user._id,
  }).select("+installationKeyHash +reinstallIdentityHash");
  if (!device) {
    throw new DeviceApiError(401, "DEVICE_CONTEXT_REQUIRED", "Device registration was not found.");
  }
  assertDeviceProof(req, device);
  if (device.status !== "approved") {
    const challenge = await createChallenge("status", user._id, req, device._id);
    throw new DeviceApiError(403, statusCode(device.status), "This device is no longer approved.", {
      authState: device.status,
      reason: device.decisionReason,
      supportContact: await getDeviceSupportContact(),
      challengeToken: challenge.token,
      challengeExpiresAt: challenge.expiresAt,
      device: publicDevice(device),
    });
  }
  if (decoded.dv !== Number(device.sessionVersion || 0)) {
    throw new DeviceApiError(
      401,
      "DEVICE_CONTEXT_REQUIRED",
      "This device session was invalidated. Sign in again.",
      { authState: "registration_required", reauthenticationRequired: true }
    );
  }
  await assertIpAllowed(user._id, req, device._id);
  await seedReinstallIdentityFromProof(user, device, req);
  await DeviceRegistration.updateOne(
    { _id: device._id },
    { $set: { lastSeenAt: new Date(), lastIp: getRequestIp(req) } }
  );
  return device;
}

export async function refreshDeviceBoundAccessToken(req: Request, token: string) {
  let decoded: { id: string; did?: string; dv?: number };
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as {
      id: string;
      did?: string;
      dv?: number;
    };
  } catch {
    throw new DeviceApiError(403, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
  }
  const user = await User.findById(decoded.id).select("+refreshToken");
  if (!user) throw new DeviceApiError(403, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
  if (user.isBlocked) throw new DeviceApiError(403, "ACCOUNT_BLOCKED", "Account is blocked.");

  const now = new Date();
  const tokenHash = hashValue(token);
  const record = (user.refreshTokens || []).find(
    (entry: any) => entry.tokenHash === tokenHash && entry.expiresAt && entry.expiresAt > now
  );
  let valid = Boolean(record);
  // Raw legacy refresh tokens are accepted only while enforcement is disabled. Enabling
  // device security therefore requires migration through registration, not silent trust.
  if (!valid && !isDeviceApprovalEnforced()) {
    const legacyToken = (user as any).refreshToken;
    if (legacyToken && legacyToken === token) valid = true;
  }
  if (!valid) throw new DeviceApiError(403, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");

  if (isDeviceApprovalEnforced() && user.role === "user") {
    if (!decoded.did || !record?.deviceId || String(record.deviceId) !== decoded.did) {
      throw new DeviceApiError(
        401,
        "DEVICE_CONTEXT_REQUIRED",
        "Legacy sessions must register this device.",
        { authState: "registration_required" }
      );
    }
    await verifyProtectedDeviceRequest(user, decoded, req);
  }
  if (record) {
    const stillValid = await User.updateOne(
      {
        _id: user._id,
        refreshTokens: {
          $elemMatch: { tokenHash, expiresAt: { $gt: now } },
        },
      },
      { $pull: { refreshTokens: { expiresAt: { $lte: now } } } }
    );
    if (!stillValid.matchedCount) {
      throw new DeviceApiError(403, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
    }
  }
  const claims = decoded.did
    ? { id: user._id, did: decoded.did, dv: decoded.dv }
    : { id: user._id };
  return { accessToken: jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "15m" }) };
}

export async function cascadeDeleteSecurityRecords(userId: string) {
  // Resolve device ids first because audit rows may reference a device even when their
  // direct user fields are absent. Deletes are independent and can safely run together.
  const devices = await DeviceRegistration.find({ user: userId }).select("_id").lean();
  const deviceIds = devices.map((device) => device._id);
  await Promise.all([
    DeviceAccessChallenge.deleteMany({ user: userId }),
    UserIpObservation.deleteMany({ user: userId }),
    SecurityAuditEvent.deleteMany({
      $or: [{ targetUser: userId }, { actor: userId }, { device: { $in: deviceIds } }],
    }),
    DeviceRegistration.deleteMany({ user: userId }),
  ]);
}

export function deviceErrorBody(error: DeviceApiError) {
  return { code: error.code, message: error.message, ...error.details };
}
