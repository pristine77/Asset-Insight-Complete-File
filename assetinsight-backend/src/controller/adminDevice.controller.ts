import { Request, Response } from "express";
import DeviceRegistration, {
  DEVICE_STATUSES,
  type DeviceStatus,
} from "../models/deviceRegistration.model.js";
import SecurityAuditEvent from "../models/securityAuditEvent.model.js";
import DeviceAccessChallenge from "../models/deviceAccessChallenge.model.js";
import UserIpObservation from "../models/userIpObservation.model.js";
import User from "../models/user.model.js";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import {
  DeviceApiError,
  deviceErrorBody,
  getDeviceSupportContact,
  normalizeIp,
  setDeviceSupportContact,
  writeSecurityAudit,
} from "../service/deviceAccessService.js";
import { sendDeviceDecisionEmail } from "../utils/sendVerificationEmail.js";
import {
  disconnectProposalValuationDevice,
  disconnectProposalValuationUserIp,
} from "../service/proposalValuationRealtimeService.js";

/**
 * Administrative control plane for device access and user-scoped IP restrictions.
 *
 * Device decisions are security state transitions, not ordinary CRUD. Mutations use
 * conditional database filters to reject stale admin actions, require reasons for
 * sensitive changes, invalidate credentials where needed, and append an audit event.
 * Route middleware is expected to establish the authenticated administrator.
 */

const MAX_PAGE_SIZE = 100;

function pagination(req: Request) {
  // A hard ceiling protects admin searches and their population joins from accidental
  // unbounded reads while preserving the established page/limit response contract.
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(req.query.limit || "20"), 10) || 20)
  );
  return { page, limit, skip: (page - 1) * limit };
}

function safeText(value: unknown, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function requiredReason(req: Request, action: string) {
  const reason = safeText(req.body?.reason);
  if (!reason) {
    throw new DeviceApiError(400, "AUDIT_REASON_REQUIRED", `An audit reason is required to ${action}.`);
  }
  return reason;
}

function adminError(res: Response, error: unknown) {
  if (error instanceof DeviceApiError) {
    return res.status(error.status).json(deviceErrorBody(error));
  }
  console.error("Admin device operation failed:", error);
  return res.status(500).json({
    code: "DEVICE_ADMIN_ERROR",
    message: "Unable to complete this device security operation.",
  });
}

function statusFromQuery(req: Request): DeviceStatus | undefined {
  const raw = safeText(req.query.status || req.query.tab, 40);
  const aliases: Record<string, DeviceStatus> = {
    new: "pending",
    new_requests: "pending",
    rerequests: "rerequest_pending",
    re_requests: "rerequest_pending",
  };
  const resolved = aliases[raw] || raw;
  return (DEVICE_STATUSES as readonly string[]).includes(resolved)
    ? (resolved as DeviceStatus)
    : undefined;
}

async function matchingUserIds(search: string) {
  if (!search) return undefined;
  // User text is escaped before becoming a regex so search remains literal and cannot
  // inject an expensive or semantically broader regular expression.
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const users = await User.find({
    role: "user",
    $or: [
      { email: { $regex: escaped, $options: "i" } },
      { username: { $regex: escaped, $options: "i" } },
      { companyName: { $regex: escaped, $options: "i" } },
    ],
  })
    .select("_id")
    .limit(500)
    .lean();
  return users.map((user) => user._id);
}

function serializeDevice(device: any, observations: any[] = []) {
  // Device and IP data are stored separately. This projection joins only observations
  // associated with both the same user and device, preventing cross-user leakage.
  const id = String(device._id);
  const userId = String(device.user?._id || device.user);
  const ips = observations
    .filter(
      (observation) =>
        String(observation.user?._id || observation.user) === userId &&
        (observation.devices || []).some((deviceId: unknown) => String(deviceId) === id)
    )
    .map((observation) => ({
      id: String(observation._id),
      ip: observation.ip,
      blocked: Boolean(observation.blocked),
      reason: observation.blockReason,
      firstSeenAt: observation.firstSeenAt,
      lastSeenAt: observation.lastSeenAt,
      count: observation.count,
    }));
  return {
    id,
    user: device.user,
    platform: device.platform,
    formFactor: device.formFactor,
    displayName: device.displayName,
    metadata: device.metadata || {},
    status: device.status,
    requestCount: device.requestCount,
    requestHistory: device.requestHistory,
    requestedAt: device.lastRequestAt || device.createdAt,
    lastRequestAt: device.lastRequestAt,
    decidedBy: device.decidedBy,
    decidedAt: device.decidedAt,
    decisionReason: device.decisionReason,
    approvedVia: device.approvedVia,
    lastSeenAt: device.lastSeenAt,
    lastIp: device.lastIp,
    ips,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

export async function listDevices(req: Request, res: Response) {
  try {
    const { page, limit, skip } = pagination(req);
    const query: Record<string, unknown> = {};
    const status = statusFromQuery(req);
    if (status) query.status = status;
    const platform = safeText(req.query.platform, 20);
    if (["web", "android", "ios"].includes(platform)) query.platform = platform;
    const search = safeText(req.query.search, 120);
    const userIds = await matchingUserIds(search);
    if (userIds) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const ipMatches = await UserIpObservation.find({
        ip: { $regex: escaped, $options: "i" },
      })
        .select("devices")
        .limit(500)
        .lean();
      const matchingDeviceIds = ipMatches.flatMap((entry: any) => entry.devices || []);
      query.$or = [
        { user: { $in: userIds } },
        { displayName: { $regex: escaped, $options: "i" } },
        { _id: { $in: matchingDeviceIds } },
      ];
    }
    const createdAt: Record<string, Date> = {};
    const from = new Date(String(req.query.from || ""));
    const to = new Date(String(req.query.to || ""));
    if (!Number.isNaN(from.getTime())) createdAt.$gte = from;
    if (!Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      createdAt.$lte = to;
    }
    if (Object.keys(createdAt).length) {
      query.$and = [
        {
          $or: [
            { lastRequestAt: createdAt },
            { lastRequestAt: { $exists: false }, createdAt },
          ],
        },
      ];
    }

    const [total, devices] = await Promise.all([
      DeviceRegistration.countDocuments(query),
      DeviceRegistration.find(query)
        .populate("user", "email username companyName contactEmail contactPhone deviceApprovalMode")
        .populate("decidedBy", "email username role")
        .sort({ lastRequestAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    const ids = devices.map((device: any) => device._id);
    const observations = ids.length
      ? await UserIpObservation.find({ devices: { $in: ids } }).lean()
      : [];
    // Security decisions can change at any time; stale cached rows could prompt an
    // administrator to act on a device that has already transitioned.
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      devices: devices.map((device: any) => serializeDevice(device, observations)),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function getDeviceSummary(_req: Request, res: Response) {
  try {
    const [counts, blockedIps] = await Promise.all([
      DeviceRegistration.aggregate<{ _id: DeviceStatus; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      UserIpObservation.countDocuments({ blocked: true }),
    ]);
    const summary: Record<string, number> = Object.fromEntries(
      DEVICE_STATUSES.map((status) => [status, 0])
    );
    counts.forEach((entry) => {
      summary[entry._id] = entry.count;
    });
    summary.blocked_ips = blockedIps;
    summary.requests = summary.pending + summary.rerequest_pending;
    res.setHeader("Cache-Control", "no-store");
    return res.json({ summary });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function getDeviceDetail(req: Request, res: Response) {
  try {
    const device = await DeviceRegistration.findById(req.params.id)
      .populate("user", "email username companyName contactEmail contactPhone deviceApprovalMode")
      .populate("decidedBy", "email username role")
      .lean();
    if (!device) throw new DeviceApiError(404, "DEVICE_NOT_FOUND", "Device was not found.");
    const [observations, audit] = await Promise.all([
      UserIpObservation.find({ user: (device as any).user._id })
        .populate("blockedBy unblockedBy", "email username role")
        .sort({ lastSeenAt: -1 })
        .lean(),
      SecurityAuditEvent.find({
        $or: [{ device: device._id }, { targetUser: (device as any).user._id }],
      })
        .populate("actor", "email username role")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    return res.json({
      device: serializeDevice(device, observations),
      ipObservations: observations.map((entry: any) => ({
        id: String(entry._id),
        ip: entry.ip,
        blocked: entry.blocked,
        blockReason: entry.blockReason,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        count: entry.count,
        blockedAt: entry.blockedAt,
        blockedBy: entry.blockedBy,
        unblockedAt: entry.unblockedAt,
        unblockedBy: entry.unblockedBy,
      })),
      audit,
    });
  } catch (error) {
    return adminError(res, error);
  }
}

async function notifyDecision(device: any, approved: boolean) {
  // Notification is deliberately best effort and follows the committed decision.
  // Email-provider failure must not roll back or misreport the security state change.
  try {
    const user = await User.findById(device.user).select("email").lean();
    if (!user?.email) return;
    const support = await getDeviceSupportContact();
    await sendDeviceDecisionEmail(user.email, {
      approved,
      deviceName: device.displayName,
      reason: device.decisionReason,
      supportName: support.name,
      supportEmail: support.email,
      supportPhone: support.phone,
    });
  } catch (error) {
    console.error("Device decision email failed:", error);
  }
}

export async function approveDevice(req: AdminAuthRequest, res: Response) {
  try {
    const scope = req.body?.scope === "all_devices" ? "all_devices" : "device";
    const reason = scope === "all_devices" ? requiredReason(req, "approve all devices") : safeText(req.body?.reason);
    const now = new Date();
    const decisionUpdate = reason
      ? { $set: { decisionReason: reason } }
      : { $unset: { decisionReason: "" } };
    // The expected-state predicate is a compare-and-set guard: only the first admin
    // acting on a pending request can commit a decision; later attempts receive 409.
    const device = await DeviceRegistration.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["pending", "rerequest_pending"] } },
      {
        $set: {
          status: "approved",
          approvedVia: scope,
          decidedBy: req.userId,
          decidedAt: now,
          ...(decisionUpdate.$set || {}),
        },
        ...(decisionUpdate.$unset ? { $unset: decisionUpdate.$unset } : {}),
      },
      { returnDocument: "after" }
    );
    if (!device) {
      throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "Another administrator already changed this device.");
    }
    if (scope === "all_devices") {
      // Account-wide approval records the policy and brings other pending devices into
      // the same approved state so subsequent sign-ins observe one coherent policy.
      await Promise.all([
        User.updateOne(
          { _id: device.user, role: "user" },
          {
            $set: {
              deviceApprovalMode: "all_devices",
              deviceApprovalModeChangedAt: now,
              deviceApprovalModeChangedBy: req.userId,
            },
          }
        ),
        DeviceRegistration.updateMany(
          {
            user: device.user,
            _id: { $ne: device._id },
            status: { $in: ["pending", "rerequest_pending"] },
          },
          {
            $set: {
              status: "approved",
              approvedVia: "all_devices",
              decidedBy: req.userId,
              decidedAt: now,
              decisionReason: reason,
            },
          }
        ),
      ]);
    }
    await writeSecurityAudit({
      action: scope === "all_devices" ? "device.approved_all" : "device.approved",
      actorType: "admin",
      actor: req.userId,
      targetUser: device.user,
      device: device._id,
      reason,
      before: { status: "pending" },
      after: { status: "approved", scope },
      req,
    });
    void notifyDecision(device, true);
    return res.json({ device: serializeDevice(device) });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function rejectDevice(req: AdminAuthRequest, res: Response) {
  try {
    const reason = safeText(req.body?.reason);
    const decisionUpdate = reason
      ? { $set: { decisionReason: reason } }
      : { $unset: { decisionReason: "" } };
    const device = await DeviceRegistration.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["pending", "rerequest_pending"] } },
      {
        $set: {
          status: "rejected",
          decidedBy: req.userId,
          decidedAt: new Date(),
          ...(decisionUpdate.$set || {}),
        },
        ...(decisionUpdate.$unset ? { $unset: decisionUpdate.$unset } : {}),
      },
      { returnDocument: "after" }
    );
    if (!device) throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "Device state changed.");
    await writeSecurityAudit({
      action: "device.rejected",
      actorType: "admin",
      actor: req.userId,
      targetUser: device.user,
      device: device._id,
      reason,
      before: { status: "pending" },
      after: { status: "rejected" },
      req,
    });
    void notifyDecision(device, false);
    return res.json({ device: serializeDevice(device) });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function revokeDevice(req: AdminAuthRequest, res: Response) {
  try {
    const reason = requiredReason(req, "revoke this device");
    const device = await DeviceRegistration.findOneAndUpdate(
      { _id: req.params.id, status: "approved" },
      {
        $set: {
          status: "revoked",
          decidedBy: req.userId,
          decidedAt: new Date(),
          decisionReason: reason,
        },
        $inc: { sessionVersion: 1 },
      },
      { returnDocument: "after" }
    );
    if (!device) throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "Device state changed.");
    disconnectProposalValuationDevice(String(device._id), "device-revoked");
    // Revocation must invalidate both long-lived refresh credentials and outstanding
    // approval exchanges; incrementing sessionVersion also rejects already-issued state.
    await User.updateOne(
      { _id: device.user },
      { $pull: { refreshTokens: { deviceId: device._id } } }
    );
    await DeviceAccessChallenge.deleteMany({ device: device._id });
    await writeSecurityAudit({
      action: "device.revoked",
      actorType: "admin",
      actor: req.userId,
      targetUser: device.user,
      device: device._id,
      reason,
      before: { status: "approved" },
      after: { status: "revoked" },
      req,
    });
    return res.json({ device: serializeDevice(device) });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function restoreDevice(req: AdminAuthRequest, res: Response) {
  try {
    const reason = requiredReason(req, "restore this device");
    const device = await DeviceRegistration.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["rejected", "revoked"] } },
      {
        $set: {
          status: "approved",
          approvedVia: "device",
          decidedBy: req.userId,
          decidedAt: new Date(),
          decisionReason: reason,
        },
      },
      { returnDocument: "after" }
    );
    if (!device) throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "Device state changed.");
    // Restoration re-enables the registration but intentionally does not restore old
    // credentials. Clearing them forces a fresh authentication on the approved device.
    await User.updateOne(
      { _id: device.user },
      { $pull: { refreshTokens: { deviceId: device._id } } }
    );
    await DeviceAccessChallenge.deleteMany({ device: device._id });
    await writeSecurityAudit({
      action: "device.restored",
      actorType: "admin",
      actor: req.userId,
      targetUser: device.user,
      device: device._id,
      reason,
      before: { status: "restricted" },
      after: { status: "approved", reauthenticationRequired: true },
      req,
    });
    return res.json({ device: serializeDevice(device), reauthenticationRequired: true });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function updateDeviceApprovalPolicy(req: AdminAuthRequest, res: Response) {
  try {
    const mode = req.body?.mode;
    if (!(["per_device", "all_devices"] as const).includes(mode)) {
      throw new DeviceApiError(400, "INVALID_DEVICE_POLICY", "Invalid device approval policy.");
    }
    const reason = requiredReason(req, mode === "all_devices" ? "approve all devices" : "disable approve all");
    const user = await User.findOne({ _id: req.params.userId, role: "user" });
    if (!user) throw new DeviceApiError(404, "USER_NOT_FOUND", "User was not found.");
    const before = user.deviceApprovalMode || "per_device";
    user.deviceApprovalMode = mode;
    user.deviceApprovalModeChangedAt = new Date();
    user.deviceApprovalModeChangedBy = req.userId as any;
    await user.save({ validateBeforeSave: false });
    // Enabling the broad policy resolves existing pending requests; disabling it is
    // prospective and does not unexpectedly revoke devices already approved.
    if (mode === "all_devices") {
      await DeviceRegistration.updateMany(
        { user: user._id, status: { $in: ["pending", "rerequest_pending"] } },
        {
          $set: {
            status: "approved",
            approvedVia: "all_devices",
            decidedBy: req.userId,
            decidedAt: new Date(),
            decisionReason: reason,
          },
        }
      );
    }
    await writeSecurityAudit({
      action: mode === "all_devices" ? "device.policy_all_enabled" : "device.policy_all_disabled",
      actorType: "admin",
      actor: req.userId,
      targetUser: user._id,
      reason,
      before: { mode: before },
      after: { mode },
      req,
    });
    return res.json({ userId: String(user._id), deviceApprovalMode: mode });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function listDeviceIps(req: Request, res: Response) {
  try {
    const { page, limit, skip } = pagination(req);
    const query: Record<string, unknown> = {};
    if (String(req.query.blocked || "") === "true") query.blocked = true;
    const search = safeText(req.query.search, 120);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const [userIds, devices] = await Promise.all([
        matchingUserIds(search),
        DeviceRegistration.find({
          displayName: { $regex: escaped, $options: "i" },
        })
          .select("_id")
          .limit(500)
          .lean(),
      ]);
      query.$or = [
        { ip: { $regex: escaped, $options: "i" } },
        { user: { $in: userIds || [] } },
        { devices: { $in: devices.map((device) => device._id) } },
      ];
    }
    const [total, observations] = await Promise.all([
      UserIpObservation.countDocuments(query),
      UserIpObservation.find(query)
        .populate("user", "email username companyName")
        .populate("devices", "displayName platform formFactor status")
        .populate("blockedBy unblockedBy", "email username role")
        .sort({ blocked: -1, lastSeenAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    return res.json({
      ipObservations: observations.map((entry: any) => ({ ...entry, id: String(entry._id) })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    return adminError(res, error);
  }
}

async function changeIpBlock(req: AdminAuthRequest, res: Response, blocked: boolean) {
  try {
    const reason = requiredReason(req, blocked ? "block this IP" : "unblock this IP");
    const beforeState = blocked ? false : true;
    const now = new Date();
    // Requiring the previous boolean state gives IP actions the same optimistic
    // concurrency behavior as device decisions and avoids duplicate audit events.
    const observation = await UserIpObservation.findOneAndUpdate(
      { _id: req.params.id, blocked: beforeState },
      {
        $set: blocked
          ? {
              blocked: true,
              blockReason: reason,
              blockedAt: now,
              blockedBy: req.userId,
              unblockedAt: undefined,
              unblockedBy: undefined,
            }
          : {
              blocked: false,
              blockReason: reason,
              unblockedAt: now,
              unblockedBy: req.userId,
            },
      },
      { returnDocument: "after" }
    );
    if (!observation) throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "IP block state changed.");
    if (blocked) {
      disconnectProposalValuationUserIp(
        String(observation.user),
        observation.ip,
        "ip-blocked"
      );
    }
    await writeSecurityAudit({
      action: blocked ? "ip.blocked" : "ip.unblocked",
      actorType: "admin",
      actor: req.userId,
      targetUser: observation.user,
      ipObservation: observation._id,
      reason,
      before: { blocked: beforeState, ip: observation.ip },
      after: { blocked, ip: observation.ip },
      req,
    });
    return res.json({ ipObservation: { ...observation.toObject(), id: String(observation._id) } });
  } catch (error) {
    return adminError(res, error);
  }
}

export const blockDeviceIp = (req: AdminAuthRequest, res: Response) =>
  changeIpBlock(req, res, true);
export const unblockDeviceIp = (req: AdminAuthRequest, res: Response) =>
  changeIpBlock(req, res, false);

export async function manuallyBlockDeviceIp(req: AdminAuthRequest, res: Response) {
  try {
    const email = safeText(req.body?.userEmail, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new DeviceApiError(400, "INVALID_USER_EMAIL", "Enter a valid user email address.");
    }
    const ip = normalizeIp(req.body?.ip);
    if (
      ip === "unknown" ||
      ip === "0.0.0.0" ||
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("127.")
    ) {
      throw new DeviceApiError(
        400,
        "INVALID_IP_ADDRESS",
        "Enter a valid client IPv4 or IPv6 address. Loopback and unspecified addresses cannot be blocked."
      );
    }
    const reason = requiredReason(req, "block this IP");
    const user = await User.findOne({ email, role: "user" }).select("_id email").lean();
    if (!user) {
      throw new DeviceApiError(404, "USER_NOT_FOUND", "No ordinary user has that email address.");
    }
    // IP restrictions are scoped to a user rather than globally; shared office or
    // carrier addresses must not accidentally block unrelated accounts.
    const existing = await UserIpObservation.findOne({ user: user._id, ip });
    if (existing?.blocked) {
      throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "This IP is already blocked for that user.");
    }
    const now = new Date();
    let observation;
    try {
      observation = existing
        ? await UserIpObservation.findOneAndUpdate(
            { _id: existing._id, blocked: false },
            {
              $set: {
                blocked: true,
                blockReason: reason,
                blockedAt: now,
                blockedBy: req.userId,
              },
              $unset: { unblockedAt: "", unblockedBy: "" },
            },
            { returnDocument: "after" }
          )
        : await UserIpObservation.create({
            user: user._id,
            ip,
            devices: [],
            firstSeenAt: now,
            lastSeenAt: now,
            count: 0,
            source: "admin",
            blocked: true,
            blockReason: reason,
            blockedAt: now,
            blockedBy: req.userId,
          });
    } catch (error: any) {
      // The unique index is the final concurrency guard when two administrators create
      // the same previously unseen observation at the same time.
      if (error?.code === 11000) {
        throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "This IP is already registered for that user. Refresh and try again.");
      }
      throw error;
    }
    if (!observation) {
      throw new DeviceApiError(409, "DEVICE_STATE_CHANGED", "The IP block state changed. Refresh and try again.");
    }
    disconnectProposalValuationUserIp(
      String(user._id),
      ip,
      "ip-blocked"
    );
    await writeSecurityAudit({
      action: "ip.blocked_manual",
      actorType: "admin",
      actor: req.userId,
      targetUser: user._id,
      ipObservation: observation._id,
      reason,
      before: { blocked: false, ip, previouslyObserved: Boolean(existing) },
      after: { blocked: true, ip, source: existing ? existing.source : "admin" },
      req,
    });
    return res.status(existing ? 200 : 201).json({
      ipObservation: { ...observation.toObject(), id: String(observation._id) },
    });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function deleteDeviceRegistration(req: AdminAuthRequest, res: Response) {
  try {
    const reason = requiredReason(req, "delete this device registration");
    const device = await DeviceRegistration.findOneAndDelete({ _id: req.params.id });
    if (!device) {
      throw new DeviceApiError(404, "DEVICE_NOT_FOUND", "Device registration was not found.");
    }
    disconnectProposalValuationDevice(String(device._id), "device-deleted");
    // Remove all capabilities and reverse references tied to the deleted registration;
    // otherwise a stale challenge or refresh token could outlive its security record.
    await Promise.all([
      User.updateOne(
        { _id: device.user },
        { $pull: { refreshTokens: { deviceId: device._id } } }
      ),
      DeviceAccessChallenge.deleteMany({ device: device._id }),
      UserIpObservation.updateMany(
        { devices: device._id },
        { $pull: { devices: device._id } }
      ),
    ]);
    await writeSecurityAudit({
      action: "device.deleted",
      actorType: "admin",
      actor: req.userId,
      targetUser: device.user,
      device: device._id,
      reason,
      before: {
        status: device.status,
        displayName: device.displayName,
        platform: device.platform,
      },
      after: { registrationDeleted: true, nextSignInRequiresRegistration: true },
      req,
    });
    return res.json({
      deleted: true,
      deviceId: String(device._id),
      userId: String(device.user),
      nextSignInRequiresRegistration: true,
    });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function getDeviceSecuritySettings(_req: Request, res: Response) {
  try {
    return res.json({ supportContact: await getDeviceSupportContact() });
  } catch (error) {
    return adminError(res, error);
  }
}

export async function updateDeviceSecuritySettings(req: AdminAuthRequest, res: Response) {
  try {
    const before = await getDeviceSupportContact();
    const contact = await setDeviceSupportContact(req.body?.supportContact || req.body, req.userId);
    await writeSecurityAudit({
      action: "device.support_contact_updated",
      actorType: "admin",
      actor: req.userId,
      reason: safeText(req.body?.reason),
      before,
      after: contact,
      req,
    });
    return res.json({ supportContact: contact });
  } catch (error) {
    return adminError(res, error);
  }
}
