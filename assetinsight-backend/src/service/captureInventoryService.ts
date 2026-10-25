import { createHash } from "node:crypto";
import mongoose from "mongoose";
import CaptureInventory from "../models/captureInventory.model.js";
import User from "../models/user.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import ReportJob from "../models/reportJob.model.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";

export class CaptureInventoryError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public data?: unknown) {
    super(message);
  }
}
const fail = (message: string): never => { throw new CaptureInventoryError(400, "INVALID_CAPTURE_INVENTORY", message); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LOTS = 1_000;
const MAX_PHOTOS = 5_000;

export function normalizeCaptureId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return fail("captureId must be a UUID.");
  return value.toLowerCase();
}

/** Optional additive report provenance; absence leaves every legacy path intact. */
export function optionalCaptureId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeCaptureId(value);
}

function object(value: unknown, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${label} must be an object.`);
  const result = value as Record<string, any>;
  if (Object.keys(result).some((key) => !keys.includes(key))) return fail(`${label} contains unsupported fields.`);
  return result;
}
function text(value: unknown, maximum: number, label: string, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return fail(`${label} is invalid.`);
  const normalized = value.trim();
  if (required && !normalized) return fail(`${label} is required.`);
  if (/(?:^|\s)(?:data:|file:|content:|\/(?:Users|storage|data|sdcard|private|var|home|tmp)\/|[a-z]:\\)/i.test(normalized)) return fail(`${label} must not contain local paths or image bytes.`);
  return normalized;
}
function count(value: unknown, label: string, maximum = MAX_PHOTOS): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) return fail(`${label} must be a whole number from 0 to ${maximum}.`);
  return value;
}
function date(value: unknown, label: string): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return fail(`${label} must be an ISO timestamp or null.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 2000 || parsed.getUTCFullYear() > 2100) return fail(`${label} is invalid.`);
  return parsed;
}

export function normalizeCaptureSnapshot(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > 512 * 1024) throw new CaptureInventoryError(413, "CAPTURE_TOO_LARGE", "Capture metadata exceeds 512 KiB.");
  const input = object(value, ["schemaVersion", "revision", "reportType", "clientSubmissionId", "contractNo", "device", "localStatus", "lots", "deviceCreatedAt", "deviceSavedAt", "firstCapturedAt", "lastCapturedAt"], "Capture metadata");
  if (input.schemaVersion !== 1) return fail("schemaVersion must be 1.");
  const revision = count(input.revision, "revision", Number.MAX_SAFE_INTEGER);
  if (!revision) return fail("revision must be at least 1.");
  if (!["asset", "lotListing"].includes(input.reportType)) return fail("reportType must be asset or lotListing.");
  if (!["saved", "paused", "discarded"].includes(input.localStatus)) return fail("localStatus must be saved, paused or discarded.");
  const device = object(input.device, ["installationId", "appVersion", "platform"], "device");
  if (!["android", "ios"].includes(device.platform)) return fail("device.platform must be android or ios.");
  const installationId = text(device.installationId, 200, "device.installationId", true);
  if (!/^[a-zA-Z0-9._:-]+$/.test(installationId)) return fail("device.installationId is invalid.");
  if (!Array.isArray(input.lots) || input.lots.length > MAX_LOTS) return fail(`lots must contain at most ${MAX_LOTS} entries.`);
  const seen = new Set<string>();
  const lots = input.lots.map((raw: unknown) => {
    const lot = object(raw, ["id", "lotNumber", "title", "mainPhotoCount", "extraPhotoCount", "availablePhotoCount", "missingPhotoCount"], "Lot");
    const id = text(lot.id, 160, "Lot id", true);
    if (seen.has(id)) return fail("Every lot must have a distinct stable id.");
    seen.add(id);
    const mainPhotoCount = count(lot.mainPhotoCount, "mainPhotoCount");
    const extraPhotoCount = count(lot.extraPhotoCount, "extraPhotoCount");
    const availablePhotoCount = count(lot.availablePhotoCount, "availablePhotoCount");
    const missingPhotoCount = count(lot.missingPhotoCount, "missingPhotoCount");
    if (availablePhotoCount + missingPhotoCount !== mainPhotoCount + extraPhotoCount) return fail("Available and missing photo counts must add up to each lot's total photos.");
    return { id, lotNumber: text(lot.lotNumber, 80, "Lot number"), title: text(lot.title, 300, "Lot title"), mainPhotoCount, extraPhotoCount, availablePhotoCount, missingPhotoCount };
  });
  const totals = lots.reduce((sum, lot) => ({
    lotCount: sum.lotCount + 1,
    mainPhotoCount: sum.mainPhotoCount + lot.mainPhotoCount,
    extraPhotoCount: sum.extraPhotoCount + lot.extraPhotoCount,
    availablePhotoCount: sum.availablePhotoCount + lot.availablePhotoCount,
    missingPhotoCount: sum.missingPhotoCount + lot.missingPhotoCount,
    photoCount: sum.photoCount + lot.mainPhotoCount + lot.extraPhotoCount,
  }), { lotCount: 0, mainPhotoCount: 0, extraPhotoCount: 0, availablePhotoCount: 0, missingPhotoCount: 0, photoCount: 0 });
  if (totals.photoCount > MAX_PHOTOS) return fail(`Capture inventory cannot exceed ${MAX_PHOTOS} photos.`);
  const clientSubmissionId = text(input.clientSubmissionId, 160, "clientSubmissionId");
  if (clientSubmissionId && !/^[a-zA-Z0-9._:-]+$/.test(clientSubmissionId)) return fail("clientSubmissionId is invalid.");
  return {
    schemaVersion: 1, revision, reportType: input.reportType as "asset" | "lotListing",
    clientSubmissionId, contractNo: text(input.contractNo, 160, "contractNo"),
    installationId, platform: device.platform as "android" | "ios",
    appVersion: text(device.appVersion, 80, "device.appVersion"),
    localStatus: input.localStatus as "saved" | "paused" | "discarded", lots, counts: totals,
    deviceCreatedAt: date(input.deviceCreatedAt, "deviceCreatedAt"),
    deviceSavedAt: date(input.deviceSavedAt, "deviceSavedAt"),
    firstCapturedAt: date(input.firstCapturedAt, "firstCapturedAt"),
    lastCapturedAt: date(input.lastCapturedAt, "lastCapturedAt"),
  };
}

const inventoryId = (userId: string, captureId: string) => sha(`${userId}:${captureId}`);
function ack(row: any) {
  return { id: String(row._id), captureId: row.captureId, revision: row.revision,
    acknowledgedRevision: row.revision, syncedAt: row.lastReceivedAt, removed: Boolean(row.removedAt) };
}
function assertNotRemoved(row: any) {
  if (row?.removedAt) throw new CaptureInventoryError(410, "CAPTURE_REMOVED", "This discarded capture history was removed. It cannot be restored by an old device sync.", ack(row));
}

export async function saveCaptureInventory(input: { userId: string; deviceId?: string; captureId: unknown; body: unknown }) {
  const captureId = normalizeCaptureId(input.captureId);
  const normalized = normalizeCaptureSnapshot(input.body);
  const { installationId, ...snapshot } = normalized;
  const installationHash = sha(`${input.userId}:${installationId}`);
  const contentHash = sha(JSON.stringify({ ...snapshot, installationHash }));
  const id = inventoryId(input.userId, captureId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current: any = await CaptureInventory.findOne({ _id: id, user: input.userId }).select("+contentHash +installationHash").lean();
    assertNotRemoved(current);
    if (current) {
      if (current.installationHash !== installationHash || (current.deviceRegistration && String(current.deviceRegistration) !== input.deviceId)) {
        throw new CaptureInventoryError(409, "CAPTURE_DEVICE_CONFLICT", "This capture belongs to a different device installation.");
      }
      if (current.reportType !== snapshot.reportType || (current.clientSubmissionId && current.clientSubmissionId !== snapshot.clientSubmissionId)) {
        throw new CaptureInventoryError(409, "CAPTURE_IDENTITY_CONFLICT", "The saved capture's report type or submission identity cannot be changed.");
      }
      if (current.revision > snapshot.revision) throw new CaptureInventoryError(409, "STALE_CAPTURE_REVISION", "A newer capture revision is already synchronized.", ack(current));
      if (current.revision === snapshot.revision) {
        if (current.contentHash !== contentHash) throw new CaptureInventoryError(409, "CAPTURE_REVISION_CONFLICT", "This revision contains different capture metadata.", ack(current));
        return { data: ack(current), idempotent: true };
      }
      if (current.localStatus === "discarded" && snapshot.localStatus !== "discarded") throw new CaptureInventoryError(409, "CAPTURE_DISCARDED", "Discarded capture history cannot be reopened. Start a new capture.");
    }
    const now = new Date();
    try {
      const row = await CaptureInventory.findOneAndUpdate(
        current ? { _id: id, user: input.userId, revision: current.revision, removedAt: null }
          : { _id: id, revision: { $exists: false } },
        { $set: { ...snapshot, contentHash, installationHash, lastReceivedAt: now,
          ...(input.deviceId ? { deviceRegistration: input.deviceId } : {}) },
          $setOnInsert: { user: input.userId, captureId, firstReceivedAt: now, removedAt: null } },
        { returnDocument: "after", upsert: !current, runValidators: true, setDefaultsOnInsert: true },
      ).lean();
      if (row) return { data: ack(row), idempotent: false };
    } catch (error: any) { if (Number(error?.code) !== 11000) throw error; }
  }
  throw new CaptureInventoryError(409, "CAPTURE_SYNC_CONFLICT", "Capture metadata changed during synchronization. Retry the same revision.");
}

export async function getCaptureAcknowledgement(userId: string, value: unknown) {
  const captureId = normalizeCaptureId(value);
  const row = await CaptureInventory.findOne({ _id: inventoryId(userId, captureId), user: userId }).select("captureId revision lastReceivedAt removedAt").lean();
  if (!row) throw new CaptureInventoryError(404, "CAPTURE_NOT_FOUND", "Capture metadata has not synchronized yet.");
  assertNotRemoved(row);
  return { data: ack(row) };
}

const emptyServerState = () => ({
  stage: "not_uploaded", uploadedPhotoCount: null as number | null, expectedPhotoCount: null as number | null,
  reportId: null as string | null, uploadSessionId: null as string | null,
  uploadStartedAt: null as Date | null, uploadCompletedAt: null as Date | null,
  acceptedAt: null as Date | null, previewSubmittedAt: null as Date | null,
  processingCompletedAt: null as Date | null, filesReady: false, previewAvailable: false,
  issue: null as string | null,
});
const countArray = (expression: any) => ({ $size: { $ifNull: [expression, []] } });
const safeOwner = (user: any, id: unknown) => ({ id: String(id), username: user?.username || "", email: user?.email || "", companyName: user?.companyName || "", isBlocked: Boolean(user?.isBlocked) });
const captureLinkMatches = (row: any, source: any) => !source?.capture_id || source.capture_id === row.captureId;

/** Batch narrow projections: no source media, URLs, tokens, job payloads or raw errors escape. */
async function serverStates(rows: any[]) {
  const states = new Map(rows.map((row) => [String(row._id), emptyServerState()]));
  const linked = rows.filter((row) => row.clientSubmissionId);
  if (!linked.length) return states;
  const pairs = linked.map((row) => ({ user: row.user, type: row.reportType, clientSubmissionId: row.clientSubmissionId }));
  const sessions: any[] = await ReportUploadSession.aggregate([
    { $match: { $or: pairs } },
    { $project: { user: 1, type: 1, clientSubmissionId: 1, capture_id: 1, reportId: 1, jobId: 1, status: 1,
      expectedImageCount: 1, uploadStartedAt: 1, uploadCompletedAt: 1, queuedAt: 1, cleanupStartedAt: 1,
      uploadedPhotoCount: countArray({ $filter: { input: { $ifNull: ["$files", []] }, as: "file",
        cond: { $and: [{ $ne: ["$$file.fieldname", "videos"] }, { $ne: [{ $ifNull: ["$$file.uploadedAt", null] }, null] }] } } }) } },
  ]).option({ maxTimeMS: 10_000 });
  const reports: any[] = [];
  for (const type of ["asset", "lotListing"] as const) {
    const matches = linked.filter((row) => row.reportType === type).map((row) => ({ user: row.user, client_submission_id: row.clientSubmissionId }));
    if (!matches.length) continue;
    const model = type === "asset" ? AssetReport : LotListing;
    const found = await model.aggregate([
      { $match: { $or: matches } },
      { $project: { user: 1, client_submission_id: 1, capture_id: 1, job_id: 1, status: 1, job_status: 1, release_status: 1,
        queued_at: 1, processing_started_at: 1, processing_completed_at: 1, preview_submitted_at: 1, approval_requested_at: 1,
        files_generating: 1, files_regenerating: 1, artifact_repair_required: 1, generation_target_status: 1,
        files: 1, preview_files: 1, adminArchivedAt: 1,
        previewLotCount: countArray(type === "lotListing" ? { $ifNull: ["$preview_data.lots", "$lots"] } : "$preview_data.lots"),
        outbox: { type: "$report_job_outbox.type", reportId: "$report_job_outbox.reportId", progressId: "$report_job_outbox.progressId", present: { $ne: [{ $ifNull: ["$report_job_outbox.token", null] }, null] } } } },
    ]).option({ maxTimeMS: 10_000 });
    reports.push(...found.map((report: any) => ({ ...report, reportType: type })));
  }
  const jobMatches = reports.filter((report) => report.job_id).map((report) => ({
    reportId: String(report._id), progressId: report.job_id,
    type: report.reportType === "asset" ? "asset-preview" : "lot-listing-preview",
  }));
  // Initial producers use these exact preview job types, never classifiers.
  const jobs = jobMatches.length ? await ReportJob.find({ $or: jobMatches }).select("reportId progressId type status createdAt").maxTimeMS(10_000).lean() : [];
  for (const row of linked) {
    const state = states.get(String(row._id))!;
    const session = sessions.find((item) => String(item.user) === String(row.user) && item.type === row.reportType && item.clientSubmissionId === row.clientSubmissionId && captureLinkMatches(row, item));
    const report = reports.find((item) => String(item.user) === String(row.user) && item.reportType === row.reportType && item.client_submission_id === row.clientSubmissionId && captureLinkMatches(row, item));
    if (session) {
      state.uploadSessionId = String(session._id);
      state.expectedPhotoCount = Number.isSafeInteger(session.expectedImageCount) && session.expectedImageCount >= 0 ? session.expectedImageCount : null;
      state.uploadedPhotoCount = Number(session.uploadedPhotoCount ?? 0);
      state.uploadStartedAt = session.uploadStartedAt || null;
      state.uploadCompletedAt = session.uploadCompletedAt || null;
      state.stage = session.status === "failed" || session.cleanupStartedAt ? "error" : "uploading";
      if (state.stage === "error") state.issue = "The upload needs attention. Open the saved upload on the originating device.";
    }
    if (!report) continue;
    state.reportId = String(report._id);
    const job: any = jobs.find((item: any) => String(item.reportId) === String(report._id) && item.progressId === report.job_id);
    const outbox = report.outbox;
    const expectedJobType = row.reportType === "asset" ? "asset-preview" : "lot-listing-preview";
    const exactOutbox = outbox?.present && outbox.type === expectedJobType && String(outbox.reportId) === String(report._id) && outbox.progressId === report.job_id;
    const previewAvailable = report.previewLotCount > 0;
    const resolved = resolveReportGenerationStateForProfile(row.reportType, { ...report, preview_data: { lots: previewAvailable ? [{ present: true }] : [] } }, report.files, report.preview_files);
    const accepted = Boolean(job || exactOutbox || previewAvailable || report.processing_started_at || report.preview_submitted_at || resolved.files_ready);
    if (!accepted) continue; // An upload placeholder is not a submitted report.
    state.acceptedAt = session?.queuedAt || report.queued_at || job?.createdAt || report.processing_started_at || null;
    state.previewSubmittedAt = report.preview_submitted_at || null;
    state.processingCompletedAt = report.processing_completed_at || null;
    const stoppedInitialJob = ["failed", "cancelled"].includes(job?.status);
    state.filesReady = resolved.files_ready && resolved.generation_state === "ready" && !stoppedInitialJob;
    state.previewAvailable = previewAvailable && !report.adminArchivedAt;
    state.stage = stoppedInitialJob || resolved.workflow_stage === "error" ? "error"
      : state.filesReady ? "completed"
        : resolved.workflow_stage === "preview_ready" ? "preview_ready"
          : resolved.workflow_stage === "generating_files" ? "generating_files" : "processing";
    state.issue = state.stage === "error" ? "Report processing needs attention. Open its saved preview to review the current error." : null;
  }
  return states;
}

const recordProjection = "-lots -removedBy -removedAt";
async function presentRows(rows: any[]) {
  const [owners, states] = await Promise.all([
    User.find({ _id: { $in: [...new Set(rows.map((row) => String(row.user)))] } }).select("username email companyName isBlocked").maxTimeMS(5_000).lean(),
    serverStates(rows),
  ]);
  return rows.map((row) => {
    const owner = owners.find((user: any) => String(user._id) === String(row.user));
    return { id: String(row._id), captureId: row.captureId, schemaVersion: row.schemaVersion, revision: row.revision,
      reportType: row.reportType, clientSubmissionId: row.clientSubmissionId, contractNo: row.contractNo, localStatus: row.localStatus,
      creator: safeOwner(owner, row.user), device: { platform: row.platform, appVersion: row.appVersion,
        registrationId: row.deviceRegistration ? String(row.deviceRegistration) : null, verified: Boolean(row.deviceRegistration) },
      deviceCreatedAt: row.deviceCreatedAt, deviceSavedAt: row.deviceSavedAt, firstCapturedAt: row.firstCapturedAt,
      lastCapturedAt: row.lastCapturedAt, firstReceivedAt: row.firstReceivedAt, lastReceivedAt: row.lastReceivedAt,
      counts: row.counts, server: states.get(String(row._id)) };
  });
}

export function capturePagination(pageValue: unknown, limitValue: unknown, maximum = 100) {
  const parse = (value: unknown, fallback: number, max: number) => {
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) return fail("Invalid pagination.");
    return n;
  };
  return { page: parse(pageValue, 1, 10_000), limit: parse(limitValue, 25, maximum) };
}
function searchRegex(value: unknown) {
  const search = text(value, 120, "search");
  return search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
}
export async function listCaptureInventory(query: Record<string, any>) {
  const { page, limit } = capturePagination(query.page, query.limit);
  const filter: Record<string, any> = { removedAt: null };
  if (query.userId) {
    if (!mongoose.isValidObjectId(query.userId)) return fail("Invalid user filter.");
    filter.user = new mongoose.Types.ObjectId(query.userId);
  }
  if (query.reportType) {
    if (!["asset", "lotListing"].includes(query.reportType)) return fail("Invalid report type filter.");
    filter.reportType = query.reportType;
  }
  if (query.localStatus) {
    if (!["saved", "paused", "discarded"].includes(query.localStatus)) return fail("Invalid local status filter.");
    filter.localStatus = query.localStatus;
  }
  const search = searchRegex(query.search);
  if (search) filter.$or = [{ contractNo: search }, { captureId: search }, { clientSubmissionId: search }];
  const received: Record<string, Date> = {};
  for (const [key, operator, ending] of [["receivedFrom", "$gte", false], ["receivedTo", "$lte", true]] as const) {
    if (!query[key]) continue;
    const value = query[key];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail(`${key} must be YYYY-MM-DD.`);
    const parsed = new Date(`${value}T${ending ? "23:59:59.999" : "00:00:00.000"}Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return fail(`${key} is invalid.`);
    received[operator] = parsed;
  }
  if (received.$gte && received.$lte && received.$gte > received.$lte) return fail("Received date range is reversed.");
  if (Object.keys(received).length) filter.lastReceivedAt = received;
  const [rows, total] = await Promise.all([
    CaptureInventory.find(filter).select(recordProjection).sort({ lastReceivedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).maxTimeMS(10_000).lean(),
    CaptureInventory.countDocuments(filter).maxTimeMS(10_000),
  ]);
  return { data: { items: await presentRows(rows), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } };
}
export async function listCaptureUsers(query: Record<string, any>) {
  const { limit } = capturePagination(1, query.limit, 50);
  const regex = searchRegex(query.search);
  const filter = regex ? { $or: [{ username: regex }, { email: regex }, { companyName: regex }] } : {};
  const users = await User.find(filter).select("username email companyName isBlocked").sort({ username: 1, _id: 1 }).limit(limit + 1).maxTimeMS(5_000).lean();
  return { data: { items: users.slice(0, limit).map((user: any) => safeOwner(user, user._id)), hasMore: users.length > limit } };
}
function adminId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new CaptureInventoryError(404, "CAPTURE_NOT_FOUND", "Capture history was not found.");
  return value;
}
export async function getAdminCaptureInventory(value: unknown, query: Record<string, any>) {
  const id = adminId(value);
  const { page, limit } = capturePagination(query.lotsPage, query.lotsLimit);
  const row: any = await CaptureInventory.findOne({ _id: id, removedAt: null })
    .select({ lots: { $slice: [(page - 1) * limit, limit] } }).maxTimeMS(10_000).lean();
  if (!row) throw new CaptureInventoryError(404, "CAPTURE_NOT_FOUND", "Capture history was not found.");
  const [presented] = await presentRows([row]);
  const lotsTotal = Number(row.counts?.lotCount || 0);
  return { data: { ...presented, lots: row.lots || [], lotsPage: page, lotsLimit: limit, lotsTotal, lotsPages: Math.max(1, Math.ceil(lotsTotal / limit)) } };
}
export async function removeCaptureHistory(value: unknown, body: unknown, actorId: string) {
  const id = adminId(value);
  const input = object(body, ["revision"], "Removal request");
  const revision = count(input.revision, "revision", Number.MAX_SAFE_INTEGER);
  const current: any = await CaptureInventory.findById(id).select("revision localStatus removedAt").lean();
  if (!current) throw new CaptureInventoryError(404, "CAPTURE_NOT_FOUND", "Capture history was not found.");
  if (current.removedAt) return { data: { id, removed: true }, idempotent: true };
  if (current.localStatus !== "discarded") throw new CaptureInventoryError(409, "CAPTURE_NOT_DISCARDED", "Only explicitly discarded capture history can be removed.");
  if (current.revision !== revision) throw new CaptureInventoryError(409, "STALE_CAPTURE_REVISION", "Capture history changed. Reload before removing it.");
  const row = await CaptureInventory.findOneAndUpdate({ _id: id, revision, localStatus: "discarded", removedAt: null }, {
    $set: { removedAt: new Date(), removedBy: actorId, lots: [] },
    $unset: { counts: "", contentHash: "", installationHash: "", deviceRegistration: "", platform: "", appVersion: "", contractNo: "", clientSubmissionId: "", reportType: "", localStatus: "", deviceCreatedAt: "", deviceSavedAt: "", firstCapturedAt: "", lastCapturedAt: "" },
  }, { returnDocument: "after" }).lean();
  if (!row) throw new CaptureInventoryError(409, "CAPTURE_SYNC_CONFLICT", "Capture history changed. Reload before removing it.");
  return { data: { id, removed: true }, idempotent: false };
}
