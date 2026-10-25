import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import User from "../models/user.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import { ReportTransferGrant, ReportTransferDelivery } from "../models/reportTransfer.model.js";
import { ReportActivityEvent } from "../models/reportActivity.model.js";
import { DeviceApiError, verifyProtectedDeviceRequest } from "./deviceAccessService.js";
import { ActivityError, drainReportActivity } from "./reportActivityService.js";
import { activityHash } from "../utils/reportActivitySnapshot.js";
import { resolvePersistedR2StorageTarget } from "../utils/r2Storage/r2Upload.js";

export type TransferRequest = AuthRequest & { transferGrant?: any; transferSession?: any; transferDevice?: any };
export class TransferError extends Error {
  constructor(message: string, public statusCode = 400, public code = "INVALID_REPORT_TRANSFER") { super(message); }
}
function fail(message: string, status = 400, code = "INVALID_REPORT_TRANSFER"): never { throw new TransferError(message, status, code); }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function reportTransferSnapshotHash(session: any) {
  // The server's immutable manifest hash binds order, roles, sizes and lot
  // positions. Do not reload/re-hash 5,000 file records for every per-file HEAD.
  // Fallback object-key/verification receipts are transport state, not edits.
  return digest(JSON.stringify(canonical({ type: session.type, clientSubmissionId: session.clientSubmissionId, manifestHash: session.manifestHash, details: session.details })));
}
function scope(type: unknown, sessionId: unknown) {
  if (!["asset", "lotListing"].includes(String(type)) || typeof sessionId !== "string" || !/^[a-f\d]{24}$/i.test(sessionId)) fail("Upload session was not found.", 404, "REPORT_TRANSFER_NOT_FOUND");
  return { type: type as "asset" | "lotListing", _id: sessionId };
}
async function readSession(user: string, type: unknown, sessionId: unknown, full = false) {
  const session = await ReportUploadSession.findOne({ ...scope(type, sessionId), user }).select(full ? "+activity_stream_id +activity_id" :
    "type status user reportId jobId clientSubmissionId manifestHash details smartUpload cleanupStartedAt capture_id expectedFileCount +activity_stream_id +activity_id").lean() as any;
  if (!session) fail("Upload session was not found for this account.", 404, "REPORT_TRANSFER_NOT_FOUND");
  if (session.smartUpload || session.details?.draft_preview || session.cleanupStartedAt) fail("This upload cannot continue as a background report transfer. Reopen its saved review.", 409, "REPORT_TRANSFER_UNAVAILABLE");
  if (!session.clientSubmissionId || !session.manifestHash || (full && (!session.files.length || session.expectedFileCount !== session.files.length || session.files.some((file: any) => !Number.isSafeInteger(file.size) || file.size <= 0)))) fail("This upload needs a complete immutable file manifest before background transfer.", 409, "REPORT_TRANSFER_MANIFEST_REQUIRED");
  return session;
}
async function approvedDevice(user: any, claims: any, req: TransferRequest) {
  try {
    const device = await verifyProtectedDeviceRequest(user, claims, req, { requireDevice: true });
    if (!device || !["android", "ios"].includes(device.platform)) fail("Background report transfer requires an approved mobile device.", 403, "REPORT_TRANSFER_DEVICE_REQUIRED");
    return device;
  } catch (error) {
    if (error instanceof DeviceApiError) fail("Open the app to review this device's access before continuing the upload.", error.status >= 500 ? 503 : error.status === 403 ? 403 : 401, "REPORT_TRANSFER_AUTHENTICATION_REQUIRED");
    throw error;
  }
}
/** Bearer authentication ran first. Foreground metadata recovery never rotates
 * or reveals the background worker's encrypted capability. */
export async function verifyForegroundTransferDevice(req: AuthRequest) {
  const claims = jwt.decode(req.headers.authorization?.split(" ")[1] || "") as any;
  if (!claims?.did || !req.user || String(claims.id) !== req.userId) fail("Sign in on an approved mobile device to continue this capture.", 403, "REPORT_TRANSFER_DEVICE_REQUIRED");
  return approvedDevice(req.user, claims, req);
}
export async function hasCurrentTransferGrant(session: any, device: any, userId: string) {
  return Boolean(await ReportTransferGrant.exists({ user: userId, device: device._id, sessionId: session._id, type: session.type,
    sessionVersion: device.sessionVersion, snapshotHash: reportTransferSnapshotHash(session), revokedAt: null, expiresAt: { $gt: new Date() } }));
}
export async function issueReportTransferGrant(req: TransferRequest) {
  if (!req.body || Object.keys(req.body).some(key => !["type", "sessionId"].includes(key))) fail("Only the report type and existing upload session may be authorized.");
  const claims = jwt.decode(req.headers.authorization?.split(" ")[1] || "") as any;
  if (!claims?.did || !req.user || String(claims.id) !== req.userId) fail("Sign in on an approved mobile device to queue this upload.", 403, "REPORT_TRANSFER_DEVICE_REQUIRED");
  const device = await approvedDevice(req.user, claims, req);
  const session = await readSession(req.userId!, req.body.type, req.body.sessionId, true);
  if (resolvePersistedR2StorageTarget(session).generation !== "current") fail("This upload predates the storage migration and cannot accept new background transfers.", 409, "REPORT_TRANSFER_UNAVAILABLE");
  const token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + 7 * 86400000);
  const deliveryId = digest(`${req.userId}\0${session._id}`);
  await ReportTransferDelivery.updateOne({ _id: deliveryId }, { $setOnInsert: { user: req.userId, sessionId: session._id, type: session.type } }, { upsert: true });
  await ReportTransferGrant.findOneAndUpdate({ _id: digest(`${req.userId}\0${device._id}\0${session._id}`) }, {
    $set: { user: req.userId, device: device._id, sessionVersion: device.sessionVersion, sessionId: session._id, type: session.type,
      snapshotHash: reportTransferSnapshotHash(session), tokenHash: digest(token), expiresAt, revokedAt: null },
  }, { upsert: true, runValidators: true });
  if (["queued", "processed"].includes(session.status)) await wakeReportTransferNotification(session);
  return { ownerId: req.userId, sessionId: String(session._id), type: session.type, token, expiresAt: expiresAt.toISOString() };
}
/** Exact acceptance wakes only an existing explicit transfer intent. */
export async function wakeReportTransferNotification(session: any) {
  await ReportTransferDelivery.updateOne({ _id: digest(`${session.user}\0${session._id}`), state: { $in: ["waiting", "accepted"] } },
    { $set: { readyAt: new Date(), nextCheckAt: new Date() } });
}
export async function authenticateReportTransfer(req: TransferRequest) {
  const token = req.get("X-Report-Transfer-Grant");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail("Background upload authorization is required.", 401, "REPORT_TRANSFER_AUTHENTICATION_REQUIRED");
  const grant = await ReportTransferGrant.findOne({ tokenHash: digest(token), revokedAt: null, expiresAt: { $gt: new Date() } }).select("+snapshotHash").lean() as any;
  if (!grant) fail("Open the app to renew this upload's authorization.", 401, "REPORT_TRANSFER_AUTHENTICATION_REQUIRED");
  if (String(grant.sessionId) !== req.params.sessionId || grant.type !== req.params.type) fail("This authorization belongs to a different upload.", 403, "REPORT_TRANSFER_SCOPE_MISMATCH");
  const user = await User.findById(grant.user).select("-password");
  if (!user || user.isBlocked) fail("This account cannot continue its background upload.", 403, "REPORT_TRANSFER_ACCOUNT_UNAVAILABLE");
  const device = await approvedDevice(user, { id: String(user._id), did: String(grant.device), dv: grant.sessionVersion }, req);
  const session = await readSession(String(user._id), grant.type, String(grant.sessionId));
  if (reportTransferSnapshotHash(session) !== grant.snapshotHash) fail("The saved upload changed. Reopen its review before continuing.", 409, "REPORT_TRANSFER_SNAPSHOT_CHANGED");
  req.user = user; req.userId = String(user._id); req.deviceId = String(device._id);
  req.transferGrant = grant; req.transferSession = session; req.transferDevice = device;
  req.assertTransferAuthorization = () => authenticateReportTransfer(req);
}
export async function revokeReportTransferGrant(req: TransferRequest) {
  await ReportTransferGrant.updateOne({ _id: req.transferGrant._id, tokenHash: digest(req.get("X-Report-Transfer-Grant") || "") }, { $set: { revokedAt: new Date() } });
  return { revoked: true };
}
export async function recordReportTransferEvent(req: TransferRequest) {
  const raw = req.body;
  if (!raw || Object.keys(raw).some(key => !["eventId", "sequence", "action", "reason", "observedAt", "appVersion"].includes(key))) fail("Unsupported upload observation fields.");
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(raw.eventId || "") || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) fail("Invalid upload event identity or sequence.");
  if (!["upload_queued", "upload_paused", "upload_resumed", "upload_interrupted", "upload_failed"].includes(raw.action)) fail("Invalid upload observation action.");
  const reason = raw.reason ?? "unknown";
  if (!["user_pause", "system_stop", "network_unavailable", "authentication_required", "unknown"].includes(reason) ||
      (raw.action === "upload_paused" ? reason !== "user_pause" : reason === "user_pause")) fail("Only an explicit Pause can be attributed to the user.");
  if (raw.observedAt !== undefined && (typeof raw.observedAt !== "string" || raw.observedAt.length > 50 || !Number.isFinite(Date.parse(raw.observedAt)))) fail("Invalid upload observation time.");
  if (raw.appVersion !== undefined && (typeof raw.appVersion !== "string" || !/^[A-Za-z0-9 ._()+-]{1,80}$/.test(raw.appVersion))) fail("Invalid app version.");
  const session = req.transferSession, activityId = session.activity_id || session.capture_id || session.clientSubmissionId;
  const streamId = session.activity_stream_id || activityHash(`${req.userId}\0${session.type}\0${activityId}`);
  const eventId = activityHash(`${streamId}\0${raw.eventId}`), contentHash = activityHash(JSON.stringify(canonical(raw)));
  const prior = await ReportActivityEvent.findById(eventId).select("+contentHash").lean() as any;
  if (prior && prior.contentHash !== contentHash) throw new ActivityError("The event ID was reused with different content.", 409, "ACTIVITY_EVENT_CONFLICT");
  const [counts] = await ReportUploadSession.aggregate([{ $match: { _id: session._id, user: session.user } }, { $project: { totalFiles: { $size: "$files" }, verifiedFiles: { $size: { $filter: {
    input: "$files", as: "file", cond: { $and: [{ $ne: [{ $ifNull: ["$$file.uploadedAt", null] }, null] }, { $eq: ["$$file.verifiedSize", "$$file.size"] }, { $gt: ["$$file.size", 0] }] },
  } } } } }]);
  if (!counts) fail("The upload observation could not be verified.", 409, "REPORT_TRANSFER_UNAVAILABLE");
  const entry = { stream: { _id: streamId, activityId, owner: req.userId, reportType: session.type, captureId: session.capture_id || null,
    submissionId: session.clientSubmissionId, uploadSessionId: String(session._id), contract: String(session.details?.contract_no || ""), source: req.transferDevice.platform },
    event: { _id: eventId, activity: streamId, eventId: raw.eventId, contentHash, owner: req.userId, actor: req.userId, actorRole: req.user.role,
      authority: "device", source: req.transferDevice.platform, action: raw.action, outcome: raw.action === "upload_failed" ? "failed" : "completed",
      sequence: raw.sequence, sequenceScope: `transfer:${req.deviceId}:${session._id}`, observedAt: raw.observedAt ? new Date(raw.observedAt) : null,
      receivedAt: new Date(), device: req.deviceId, appVersion: raw.appVersion || null,
      data: { uploadSessionId: String(session._id), uploadReason: reason, uploadCounts: { totalFiles: counts.totalFiles, verifiedFiles: counts.verifiedFiles },
        uploadCountAuthority: "server_verified", beforeCounts: null, afterCounts: null, fields: [], lots: [] } } };
  if (!prior) {
    await req.assertTransferAuthorization?.();
    const saved = await ReportTransferGrant.updateOne({ _id: req.transferGrant._id, tokenHash: digest(req.get("X-Report-Transfer-Grant") || ""), revokedAt: null,
      expiresAt: { $gt: new Date() }, "activity_outbox.event._id": { $ne: eventId }, "activity_outbox.99": { $exists: false } }, { $push: { activity_outbox: entry } });
    if (!saved.matchedCount) {
      const pending = await ReportTransferGrant.findById(req.transferGrant._id).select("+activity_outbox").lean() as any;
      const existing = pending?.activity_outbox.find((item: any) => item.event._id === eventId);
      const dispatched = !existing ? await ReportActivityEvent.findById(eventId).select("+contentHash").lean() as any : null;
      if (!existing && !dispatched) fail("Upload observations are waiting to synchronize. Retry this same event.", 503, "REPORT_TRANSFER_EVENTS_PENDING");
      if ((existing?.event.contentHash || dispatched?.contentHash) !== contentHash) throw new ActivityError("The event ID was reused with different content.", 409, "ACTIVITY_EVENT_CONFLICT");
    }
  }
  await drainReportActivity(ReportTransferGrant, req.transferGrant._id);
  const { ReportActivity } = await import("../models/reportActivity.model.js");
  const removed = Boolean(await ReportActivity.exists({ _id: streamId, removedAt: { $ne: null } }));
  return { acknowledgements: [{ eventId: raw.eventId, activityId, removed }] };
}
