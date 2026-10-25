import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { CaptureBackupGrant, CaptureBackupObject, CaptureBackupPlan } from "../models/captureBackup.model.js";
import User from "../models/user.model.js";
import { verifyProtectedDeviceRequest } from "./deviceAccessService.js";
import { ActivityError, drainReportActivity, persistActivityEntry } from "./reportActivityService.js";
import { activityHash } from "../utils/reportActivitySnapshot.js";
import { createCaptureBackupPresignedPutUrl, getCaptureBackupR2Bucket, streamCaptureBackupObject, headCaptureBackupObject } from "../utils/r2Storage/r2Upload.js";

const GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const PUT_LIFETIME_SECONDS = 15 * 60;
const MAX_PHOTOS = 5000;
const MAX_VIDEOS = 1000;
const MAX_FILES = MAX_PHOTOS + MAX_VIDEOS;
const MAX_BYTES = 20 * 1024 ** 3;
const MAX_BATCH = 100;
export class BackupError extends Error {
  constructor(message: string, public statusCode = 400, public code = "INVALID_CAPTURE_BACKUP") { super(message); }
}
export type BackupRequest = Request & { userId?: string; user?: any; deviceId?: string; backupGrant?: any; backupDevice?: any };
function fail(message: string, status = 400, code = "INVALID_CAPTURE_BACKUP"): never { throw new BackupError(message, status, code); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function backupBucket(): string {
  try { return getCaptureBackupR2Bucket(); }
  catch { return fail("Automatic backup requires configured private storage. Open the app and contact Operations.", 503, "BACKUP_STORAGE_NOT_CONFIGURED"); }
}
const identity = (value: unknown, name: string, max = 160) => {
  if (typeof value !== "string" || !new RegExp(`^[a-zA-Z0-9._:-]{1,${max}}$`).test(value)) fail(`Invalid ${name}.`);
  return value as string;
};
const integer = (value: unknown, name: string, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) fail(`Invalid ${name}.`);
  return Number(value);
};
function onlyKeys(raw: any, allowed: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) fail("Unsupported backup fields.");
}
function text(value: unknown, max: number, name: string) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`Invalid ${name}.`);
  return value as string;
}
// Copy into ordinary JSON and reject local storage paths, embedded bytes and
// prototype/query operators. Nothing from this snapshot is executed or submitted.
function metadata(value: any, depth = 0): any {
  if (depth > 20) fail("Backup metadata is nested too deeply.");
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("Invalid metadata number."); return value; }
  if (typeof value === "string") {
    if (/^(?:(?:file|content|ph|assets-library|asset):\/{1,2}|data:[^,\s]*,)|^\/(?:data|storage|private|Users|var)\//i.test(value)) fail("Backup metadata cannot contain local media paths or embedded bytes.");
    return text(value, 100_000, "metadata text");
  }
  if (Array.isArray(value)) return value.map(item => metadata(item, depth + 1));
  if (typeof value !== "object") fail("Invalid metadata value.");
  const entries = Object.entries(value);
  if (entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key) || key.startsWith("$"))) fail("Invalid metadata property.");
  return Object.fromEntries(entries.map(([key, item]) => [key, metadata(item, depth + 1)]));
}
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function normalizeBackupSnapshot(raw: any) {
  onlyKeys(raw, ["clientDraftId", "captureId", "type", "revision", "contractNo", "title", "formData", "lots", "media", "activeLotIdx"]);
  if (Buffer.byteLength(JSON.stringify(raw)) > 2 * 1024 * 1024) fail("Backup metadata exceeds 2 MiB.", 413);
  if (!["asset", "lotListing"].includes(raw.type)) fail("Invalid backup report type.");
  if (!raw.formData || typeof raw.formData !== "object" || Array.isArray(raw.formData)) fail("Backup form metadata is required.");
  if (!Array.isArray(raw.lots) || raw.lots.length > 1000 || !Array.isArray(raw.media) || raw.media.length > MAX_FILES) fail("Backup exceeds the lot or media limit.", 413);
  if (raw.media.filter((file: any) => file?.slot !== "video").length > MAX_PHOTOS || raw.media.filter((file: any) => file?.slot === "video").length > MAX_VIDEOS) fail("Backup exceeds the 5,000-photo or 1,000-video limit.", 413);
  const lots = metadata(raw.lots);
  const lotIds = new Set<string>();
  for (const lot of lots) {
    if (!lot || typeof lot !== "object" || Array.isArray(lot)) fail("Invalid backup lot.");
    const id = identity(lot.id ?? lot.lotId, "lot ID", 200);
    if (lotIds.has(id)) fail("Backup lot IDs must be unique.");
    lotIds.add(id);
  }
  const fileIds = new Set<string>(), positions = new Set<string>();
  let totalBytes = 0;
  const media = (raw.media as any[]).map((file: any, originalOrder: number) => {
    onlyKeys(file, ["clientFileId", "lotId", "slot", "index", "name", "mimeType", "size", "sha256", "localKey", "mediaId", "captureOrder", "originalOrder", "lastModified"]);
    const clientFileId = identity(file.clientFileId, "file ID", 200), lotId = identity(file.lotId, "media lot ID", 200);
    if (fileIds.has(clientFileId) || !lotIds.has(lotId)) fail("Backup media must have unique identities and an existing lot.");
    fileIds.add(clientFileId);
    if (!["main", "extra", "video"].includes(file.slot)) fail("Invalid media slot.");
    if (typeof file.mimeType !== "string" || !/^(?:image\/(?:jpeg|png|webp|avif|heic|heif)|video\/(?:mp4|quicktime))$/.test(file.mimeType) || (file.slot === "video") !== file.mimeType.startsWith("video/")) fail("Unsupported backup media type.");
    const size = integer(file.size, "original byte size", file.slot === "video" ? 512 * 1024 ** 2 : 50 * 1024 ** 2);
    if (!size || typeof file.sha256 !== "string" || !/^[a-f\d]{64}$/.test(file.sha256)) fail("Every backup original needs a positive byte size and SHA-256 digest.");
    totalBytes += size;
    const index = integer(file.index, "media index", MAX_FILES);
    if (typeof file.name !== "string" || /[\\/]/.test(file.name)) fail("Backup filenames cannot contain local paths.");
    const position = `${lotId}\0${file.slot}\0${index}`;
    if (positions.has(position)) fail("Backup media positions must be unique.");
    positions.add(position);
    return { clientFileId, lotId, slot: file.slot, index, name: text(file.name, 300, "filename"), mimeType: file.mimeType, size, sha256: file.sha256,
      localKey: identity(file.localKey ?? clientFileId, "local media identity", 240), mediaId: identity(file.mediaId ?? clientFileId, "media identity", 200),
      captureOrder: integer(file.captureOrder ?? index, "capture order"), originalOrder: integer(file.originalOrder ?? originalOrder, "original order"), lastModified: integer(file.lastModified ?? 0, "last modified time") };
  });
  if (totalBytes > MAX_BYTES) fail("Backup originals exceed 20 GiB.", 413);
  const snapshot = { clientDraftId: identity(raw.clientDraftId, "draft ID"), captureId: identity(raw.captureId, "capture ID"), type: raw.type as "asset" | "lotListing",
    revision: integer(raw.revision, "capture revision"), contractNo: text(raw.contractNo ?? "", 160, "contract number"), title: text(raw.title ?? "", 300, "title"),
    formData: metadata(raw.formData), lots, media, activeLotIdx: integer(raw.activeLotIdx ?? 0, "active lot", Math.max(0, lots.length - 1)) };
  return { snapshot, contentHash: digest(JSON.stringify(canonical(snapshot))) };
}

export async function issueBackupGrant(req: BackupRequest) {
  backupBucket();
  const raw = req.headers.authorization?.split(" ")[1] || "";
  const claims = jwt.decode(raw) as { id: string; did?: string; dv?: number } | null;
  if (!claims?.did || !req.user || String(claims.id) !== String(req.userId)) fail("Sign in on an approved mobile device to enable backup.", 403, "BACKUP_DEVICE_REQUIRED");
  const device = await verifyProtectedDeviceRequest(req.user, claims, req, { requireDevice: true });
  if (!device || !["android", "ios"].includes(device.platform)) fail("Background backup requires an approved mobile device.", 403, "BACKUP_DEVICE_REQUIRED");
  const token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + GRANT_LIFETIME_MS);
  await CaptureBackupGrant.findOneAndUpdate({ _id: digest(`${req.userId}\0${device._id}`) }, {
    $set: { user: req.userId, device: device._id, sessionVersion: device.sessionVersion, tokenHash: digest(token), expiresAt, revokedAt: null },
  }, { upsert: true, runValidators: true });
  return { ownerId: String(req.userId), token, expiresAt: expiresAt.toISOString() };
}

export async function authenticateBackupGrant(req: BackupRequest) {
  const token = req.get("X-Capture-Backup-Grant");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail("Background backup authorization is required.", 401, "BACKUP_AUTHENTICATION_REQUIRED");
  const grant = await CaptureBackupGrant.findOne({ tokenHash: digest(token), revokedAt: null, expiresAt: { $gt: new Date() } }).lean() as any;
  if (!grant) fail("Open the app and sign in to renew background backup.", 401, "BACKUP_AUTHENTICATION_REQUIRED");
  const user = await User.findById(grant.user).select("-password");
  if (!user || user.isBlocked) fail("This account cannot continue background backup.", 403, "BACKUP_ACCOUNT_UNAVAILABLE");
  const device = await verifyProtectedDeviceRequest(user, { id: String(user._id), did: String(grant.device), dv: grant.sessionVersion }, req, { requireDevice: true });
  if (!device || !["android", "ios"].includes(device.platform)) fail("This device cannot continue background backup.", 403, "BACKUP_DEVICE_REQUIRED");
  req.user = user; req.userId = String(user._id); req.deviceId = String(device._id); req.backupGrant = grant; req.backupDevice = device;
}
// Recheck after slow provider operations. A revoked/expired grant cannot publish
// a verification receipt just because it was valid when the request began.
async function assertGrantCurrent(req: BackupRequest) { await authenticateBackupGrant(req); }
export async function revokeBackupGrant(req: BackupRequest) {
  await CaptureBackupGrant.updateOne({ _id: req.backupGrant._id, tokenHash: digest(req.get("X-Capture-Backup-Grant") || "") }, { $set: { revokedAt: new Date() } });
  return { revoked: true };
}

async function boundedMap<T, R>(items: T[], work: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
  const result: R[] = new Array(items.length); let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await work(items[index]); } catch (error) { failed = true; throw error; }
    }
  }));
  return result;
}
function ownerFilter(req: BackupRequest) { return { user: req.userId, ...(req.backupGrant ? { device: req.deviceId } : {}) }; }
export async function readBackupPlan(req: BackupRequest) {
  const id = String(req.params.id || "");
  if (!/^[a-f\d]{64}$/.test(id)) fail("Backup was not found.", 404, "BACKUP_NOT_FOUND");
  const plan = await CaptureBackupPlan.findOne({ _id: id, ...ownerFilter(req) }).lean() as any;
  if (!plan) fail("Backup was not found for this account and device.", 404, "BACKUP_NOT_FOUND");
  return plan;
}
async function objectsFor(plan: any, selected?: string[]) {
  const bucket = backupBucket();
  const files = selected ? plan.media.filter((file: any) => selected.includes(file.clientFileId)) : plan.media;
  const rows = await CaptureBackupObject.find({ _id: { $in: files.map((file: any) => file.objectId) }, user: plan.user, device: plan.device, captureId: plan.captureId }).lean() as any[];
  if (rows.some(row => row.r2Bucket !== bucket || row.r2Key !== `capture-backups/${plan.user}/${plan.device}/${row._id}`)) fail("This backup belongs to a different private storage configuration. Contact Operations before restoring or resuming it.", 503, "BACKUP_STORAGE_CONFIGURATION_CHANGED");
  return new Map<string, any>(rows.map(row => [row._id, row]));
}
const isVerified = (object: any) => !!object?.verifiedAt && object.verifiedSize === object.size && object.verifiedSha256 === object.sha256;
function receipt(plan: any, objects: Map<string, any>) {
  const verified = plan.media.filter((file: any) => isVerified(objects.get(file.objectId))).length;
  return { id: String(plan._id), ownerId: String(plan.user), clientDraftId: plan.clientDraftId, captureId: plan.captureId, type: plan.type, revision: plan.revision,
    status: plan.completedAt && verified === plan.media.length ? "complete" : "pending", total: plan.media.length, verified,
    createdAt: plan.createdAt, completedAt: plan.completedAt || null };
}
export async function getBackupPlan(req: BackupRequest) {
  const plan = await readBackupPlan(req), objects = await objectsFor(plan);
  const data = receipt(plan, objects);
  return { ...data, contractNo: plan.contractNo, title: plan.title, formData: plan.formData, lots: plan.lots, activeLotIdx: plan.activeLotIdx,
    media: plan.media.map(({ objectId, ...file }: any) => ({ ...file,
      ...(data.status === "complete" && data.verified === data.total && isVerified(objects.get(objectId))
        ? { verifiedSize: file.size, uploadedAt: objects.get(objectId).verifiedAt,
          contentPath: `/capture-backups/plans/${plan._id}/media/${encodeURIComponent(file.clientFileId)}/content` } : {}) })) };
}
export async function getBackupStatus(req: BackupRequest) {
  const plan = await readBackupPlan(req);
  return receipt(plan, await objectsFor(plan));
}
export async function listBackupPlans(req: BackupRequest) {
  if (Object.keys(req.query).some(key => !["page", "limit", "clientDraftId", "captureId", "type"].includes(key))) fail("Unsupported backup list filter.");
  const page = integer(Number(req.query.page ?? 1), "page", 100000), limit = integer(Number(req.query.limit ?? 25), "limit", 50);
  if (!page || !limit) fail("Invalid backup page.");
  const filter: any = ownerFilter(req);
  for (const key of ["clientDraftId", "captureId"]) if (req.query[key]) filter[key] = identity(req.query[key], key);
  if (req.query.type) { if (!["asset", "lotListing"].includes(String(req.query.type))) fail("Invalid backup type."); filter.type = req.query.type; }
  const [plans, total] = await Promise.all([CaptureBackupPlan.find(filter).select("user device clientDraftId captureId type revision createdAt completedAt contractNo title media.objectId").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), CaptureBackupPlan.countDocuments(filter)]);
  const items = await boundedMap(plans as any[], async plan => ({ ...receipt(plan, await objectsFor(plan)), contractNo: plan.contractNo, title: plan.title }));
  return { items, total, page, limit };
}

function backupActivity(plan: any, req: BackupRequest, action: string, eventId: string, objects: Map<string, any>, observation?: any) {
  const streamId = activityHash(`${plan.user}\0${plan.type}\0${plan.captureId}`), receivedAt = new Date();
  const verified = (file: any) => isVerified(objects.get(file.objectId));
  const data = { backupPlanId: plan.unregistered ? null : plan._id, backupRevision: plan.revision, backupReason: observation?.reason || null,
    backupCounts: plan.unregistered ? null : { totalFiles: plan.media.length, verifiedFiles: plan.media.filter(verified).length,
      totalPhotos: plan.media.filter((file: any) => file.slot !== "video").length,
      verifiedPhotos: plan.media.filter((file: any) => file.slot !== "video" && verified(file)).length },
    backupCountAuthority: plan.unregistered ? null : "server_verified", beforeCounts: null, afterCounts: null, fields: [], lots: [] };
  const source = req.backupDevice?.platform || "unknown";
  const suppliedVersion = observation?.appVersion ?? req.get("X-App-Version");
  const appVersion = typeof suppliedVersion === "string" && /^[A-Za-z0-9 ._()+-]{1,80}$/.test(suppliedVersion) ? suppliedVersion : null;
  return { stream: { _id: streamId, activityId: plan.captureId, owner: plan.user, reportType: plan.type, captureId: plan.captureId, contract: plan.contractNo, source },
    event: { _id: activityHash(`${streamId}\0${eventId}`), activity: streamId, owner: plan.user, actor: observation ? plan.user : null, actorRole: observation ? "user" : "system",
      eventId, authority: observation ? "device" : "server", source, action, outcome: observation ? "requested" : "completed",
      sequence: observation?.sequence ?? null, sequenceScope: observation ? `backup:${plan.device}:${plan.captureId}` : null, device: String(plan.device), appVersion,
      observedAt: observation?.observedAt ? new Date(observation.observedAt) : null, receivedAt, data,
      // Receipt counts can advance between exact event retries. Conflict identity
      // binds only the original immutable observation; first receipt stays saved.
      contentHash: activityHash(JSON.stringify({ plan: plan._id, action, observation: observation || null })) } };
}
async function completePlan(plan: any, req: BackupRequest, objects: Map<string, any>) {
  if (!plan.media.every((file: any) => isVerified(objects.get(file.objectId)))) return plan;
  if (!plan.completedAt) {
    await assertGrantCurrent(req);
    const event = backupActivity(plan, req, "backup_completed", `backup:${plan._id}:complete`, objects);
    const updated = await CaptureBackupPlan.findOneAndUpdate({ _id: plan._id, user: req.userId, device: req.deviceId, completedAt: null }, {
      $set: { completedAt: new Date() }, $push: { activity_outbox: event },
    }, { returnDocument: "after" }).lean();
    plan = updated || await CaptureBackupPlan.findById(plan._id).lean();
  }
  // The outbox is durable before success; the shared recovery loop retries a
  // failed activity dispatch without uploading media or creating report jobs.
  await drainReportActivity(CaptureBackupPlan, plan._id).catch(() => undefined);
  return plan;
}
export async function registerBackupPlan(req: BackupRequest) {
  const { snapshot, contentHash } = normalizeBackupSnapshot(req.body);
  const id = digest(`${req.userId}\0${req.deviceId}\0${snapshot.type}\0${snapshot.clientDraftId}\0${snapshot.revision}`);
  let plan = await CaptureBackupPlan.findById(id).select("+contentHash").lean() as any;
  if (plan && plan.contentHash !== contentHash) fail("This capture revision already has different backup metadata.", 409, "BACKUP_REVISION_CONFLICT");
  if (!plan) {
    const bucket = backupBucket();
    const media = snapshot.media.map(file => ({ ...file, objectId: digest(`${req.userId}\0${req.deviceId}\0${snapshot.captureId}\0${file.sha256}\0${file.size}\0${file.mimeType}`) }));
    const unique = new Map(media.map(file => [file.objectId, file]));
    const existing = new Set((await CaptureBackupObject.find({ _id: { $in: [...unique.keys()] }, user: req.userId, device: req.deviceId }).select("_id").lean()).map((object: any) => object._id));
    const missing = [...unique.values()].filter(file => !existing.has(file.objectId));
    if (missing.length) await CaptureBackupObject.bulkWrite(missing.map(file => ({ updateOne: { filter: { _id: file.objectId }, update: { $setOnInsert: {
      user: req.userId, device: req.deviceId, captureId: snapshot.captureId, sha256: file.sha256, size: file.size, mimeType: file.mimeType,
      r2Key: `capture-backups/${req.userId}/${req.deviceId}/${file.objectId}`, r2Bucket: bucket,
    } }, upsert: true } })), { ordered: false }).catch((error: any) => { if (error?.code !== 11000 || error?.writeErrors?.some((item: any) => item.code !== 11000)) throw error; });
    await assertGrantCurrent(req);
    try { plan = await CaptureBackupPlan.create({ _id: id, user: req.userId, device: req.deviceId, ...snapshot, media, contentHash }); }
    catch (error: any) {
      if (error?.code !== 11000) throw error;
      plan = await CaptureBackupPlan.findById(id).select("+contentHash").lean();
      if (plan?.contentHash !== contentHash) fail("This capture revision already has different backup metadata.", 409, "BACKUP_REVISION_CONFLICT");
    }
  }
  const objects = await objectsFor(plan);
  plan = await completePlan(plan, req, objects);
  return receipt(plan, objects);
}

function requestedFiles(raw: any, plan: any) {
  onlyKeys(raw, ["fileIds"]);
  if (!Array.isArray(raw.fileIds) || raw.fileIds.length < 1 || raw.fileIds.length > MAX_BATCH || new Set(raw.fileIds).size !== raw.fileIds.length) fail(`Select 1–${MAX_BATCH} unique backup file IDs.`);
  const known = new Set(plan.media.map((file: any) => file.clientFileId));
  const ids = raw.fileIds.map((value: any) => identity(value, "file ID", 200));
  if (ids.some((value: string) => !known.has(value))) fail("A requested original is outside this backup plan.", 409, "BACKUP_MEDIA_MISMATCH");
  return ids as string[];
}
export async function backupTargets(req: BackupRequest) {
  const plan = await readBackupPlan(req), ids = requestedFiles(req.body, plan), objects = await objectsFor(plan, ids);
  const expiresAt = new Date(Math.min(Date.now() + PUT_LIFETIME_SECONDS * 1000, new Date(req.backupGrant.expiresAt).getTime()));
  const targets = await boundedMap(ids, async clientFileId => {
    const file = plan.media.find((entry: any) => entry.clientFileId === clientFileId), object = objects.get(file.objectId);
    if (!object) fail("The saved backup target is unavailable.", 409, "BACKUP_MEDIA_MISMATCH");
    if (isVerified(object)) return { clientFileId, alreadyUploaded: true };
    return { clientFileId, alreadyUploaded: false, expiresAt: expiresAt.toISOString(),
      uploadUrl: await createCaptureBackupPresignedPutUrl(object.r2Bucket, object.r2Key, object.mimeType, object.size, Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))),
      headers: { "Content-Type": object.mimeType, "Content-Length": String(object.size), "If-None-Match": "*" } };
  });
  await assertGrantCurrent(req);
  return { targets };
}

async function verifyOriginal(object: any, req: BackupRequest) {
  if (isVerified(object)) return;
  const head = await headCaptureBackupObject(object.r2Bucket, object.r2Key);
  if (head.size !== object.size || !head.etag) fail("The saved backup original has a different size. Keep the local original.", 409, "BACKUP_ORIGINAL_MISMATCH");
  const source = await streamCaptureBackupObject(object.r2Bucket, object.r2Key, { ifMatch: head.etag });
  let bytes = 0;
  const hash = createHash("sha256");
  const timeout = setTimeout(() => source.stream.destroy(new Error("Backup verification timed out")), 60000);
  try {
    if (source.contentLength !== object.size || source.etag !== head.etag) fail("The saved backup original changed during verification.", 409, "BACKUP_ORIGINAL_MISMATCH");
    for await (const chunk of source.stream) {
      bytes += chunk.length;
      if (bytes > object.size) fail("The backup original exceeds its expected size.", 409, "BACKUP_ORIGINAL_MISMATCH");
      hash.update(chunk);
    }
    if (bytes !== object.size || hash.digest("hex") !== object.sha256) fail("The backup original does not match its SHA-256 digest. Keep the local original.", 409, "BACKUP_ORIGINAL_MISMATCH");
  } finally { clearTimeout(timeout); source.stream.destroy(); }
  await assertGrantCurrent(req);
  await CaptureBackupObject.updateOne({ _id: object._id, user: req.userId, device: req.deviceId, verifiedAt: null }, {
    $set: { verifiedAt: new Date(), verifiedSize: object.size, verifiedSha256: object.sha256 },
  });
}
export async function confirmBackupFiles(req: BackupRequest) {
  let plan = await readBackupPlan(req);
  const ids = requestedFiles(req.body, plan), selected = await objectsFor(plan, ids);
  if (selected.size !== new Set(plan.media.filter((file: any) => ids.includes(file.clientFileId)).map((file: any) => file.objectId)).size) fail("The saved backup target is unavailable.", 409, "BACKUP_MEDIA_MISMATCH");
  await boundedMap([...selected.values()], object => verifyOriginal(object, req));
  await assertGrantCurrent(req);
  const objects = await objectsFor(plan);
  plan = await completePlan(plan, req, objects);
  return receipt(plan, objects);
}

function normalizeBackupObservation(raw: any) {
  onlyKeys(raw, ["eventId", "sequence", "action", "reason", "observedAt", "appVersion"]);
  const eventId = identity(raw.eventId, "backup event ID", 160), sequence = integer(raw.sequence, "event sequence");
  if (!sequence || !["backup_started", "backup_paused", "backup_resumed", "backup_interrupted"].includes(raw.action) ||
    !["user_pause", "draft_deleted", "network_unavailable", "system_interruption", "authentication_required", "unknown"].includes(raw.reason)) fail("Invalid backup event.");
  if ((raw.action === "backup_paused") !== ["user_pause", "draft_deleted"].includes(raw.reason)) fail("Only an explicit user pause or draft deletion may be recorded as backup_paused.");
  if (raw.observedAt !== undefined && (typeof raw.observedAt !== "string" || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)))) fail("Invalid device observation time.");
  if (raw.appVersion !== undefined && (typeof raw.appVersion !== "string" || !/^[A-Za-z0-9 ._()+-]{1,80}$/.test(raw.appVersion))) fail("Invalid app version.");
  const observation = { sequence, action: raw.action, reason: raw.reason, observedAt: raw.observedAt || null, appVersion: raw.appVersion || null };
  return { eventId, observation };
}
export async function recordBackupEvent(req: BackupRequest) {
  const plan = await readBackupPlan(req);
  const { eventId, observation } = normalizeBackupObservation(req.body);
  const entry = backupActivity(plan, req, observation.action, `backup:${plan._id}:${eventId}`, await objectsFor(plan), observation);
  await persistActivityEntry(entry);
  return { eventId, accepted: true };
}
export async function recordUnregisteredBackupEvent(req: BackupRequest) {
  const raw = req.body;
  onlyKeys(raw, ["clientDraftId", "captureId", "type", "revision", "contractNo", "eventId", "sequence", "action", "reason", "observedAt", "appVersion"]);
  const clientDraftId = identity(raw.clientDraftId, "draft ID"), captureId = identity(raw.captureId, "capture ID"), revision = integer(raw.revision, "capture revision");
  if (!["asset", "lotListing"].includes(raw.type)) fail("Invalid backup report type.");
  const contractNo = text(raw.contractNo ?? "", 160, "contract number");
  const { eventId, observation } = normalizeBackupObservation(Object.fromEntries(Object.entries(raw).filter(([key]) => ["eventId", "sequence", "action", "reason", "observedAt", "appVersion"].includes(key))));
  const id = digest(`${req.userId}\0${req.deviceId}\0${raw.type}\0${clientDraftId}\0${revision}`);
  const existing = await CaptureBackupPlan.findOne({ _id: id, user: req.userId, device: req.deviceId }).lean() as any;
  if (existing && existing.captureId !== captureId) fail("Backup observation does not match this capture.", 409, "BACKUP_REVISION_CONFLICT");
  const plan = existing || { _id: id, user: req.userId, device: req.deviceId, type: raw.type, clientDraftId, captureId, revision, contractNo, unregistered: true };
  const entry = backupActivity(plan, req, observation.action, `backup:${id}:${eventId}`, existing ? await objectsFor(existing) : new Map(), observation);
  await persistActivityEntry(entry);
  return { eventId, accepted: true };
}

/** Owner-authenticated restore only; grants cannot download stored originals. */
export async function backupOriginal(req: BackupRequest) {
  const plan = await readBackupPlan(req), objects = await objectsFor(plan);
  if (!plan.completedAt || plan.media.some((file: any) => !isVerified(objects.get(file.objectId)))) fail("This backup revision is incomplete. Keep the local originals.", 409, "BACKUP_INCOMPLETE");
  const file = plan.media.find((item: any) => item.clientFileId === req.params.clientFileId);
  if (!file) fail("Backup original not found.", 404, "BACKUP_NOT_FOUND");
  const object = objects.get(file.objectId);
  const source = await streamCaptureBackupObject(object.r2Bucket, object.r2Key);
  if (source.contentLength !== object.size) { source.stream.destroy(); fail("This backup original could not be verified. Keep the local original.", 409, "BACKUP_ORIGINAL_MISMATCH"); }
  return { source, mimeType: object.mimeType, size: object.size };
}

export { ActivityError };
