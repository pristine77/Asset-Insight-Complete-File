import { createHash } from "node:crypto";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob, { type IReportJob } from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import User from "../models/user.model.js";
import { getCanonicalLotListingPreview } from "../utils/reportPreviewAvailability.js";
import { buildReportJobOutbox, ensureReportJobOutbox, shouldUseMongoReportQueue, type ReportJobExecutionContext } from "../utils/reportJobMongoQueue.js";
import { initialPreviewRetrySnapshotFilter, retainedInitialPreviewSources, verifyRetainedInitialPreviewObjects } from "./auctioneerInitialPreviewRetryService.js";
import { resolvePersistedR2StorageTarget, resolveR2ObjectLocationFromUrl } from "../utils/r2Storage/r2Upload.js";

type Kind = "asset" | "lotListing";
type Access = { actorId: string; scope: "owner" | "admin" };
type Input = Access & { reportType: Kind; reportId: string };
const MODE = "retained_initial_preview_retry";
const active = ["queued", "processing"];
const model = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const owner = (report: any) => String(report.user?._id || report.user || "");
const canonical = (value: any): any => {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const fail = (message: string, statusCode = 409, code = "INITIAL_PREVIEW_RETRY_CONFLICT") => Object.assign(new Error(message), { statusCode, code });
const sourceError = () => fail("The complete original upload could not be verified. Keep this report and contact support; do not upload a duplicate.", 409, "INITIAL_PREVIEW_RETRY_SOURCE_UNAVAILABLE");
const storageTarget = (value: any) => { try { return resolvePersistedR2StorageTarget(value); } catch { throw sourceError(); } };
const preview = (kind: Kind, report: any) => kind === "asset" ? report.preview_data : getCanonicalLotListingPreview({ ...report, status: "error" });
const submitted = (report: any) => Boolean(report.preview_submitted_at || report.approval_requested_at || report.approval_processed_at || report.released_at || ["pending_approval", "approved", "declined"].includes(report.status));
const hasArtifacts = (report: any) => [report.preview_files, report.files].some(files => files && Object.values(files).some(value => typeof value === "string" && value.trim()));
const sourceHash = (payload: any) => hash({ ...payload, progressId: undefined, retainedPreviewRetry: undefined });
// Incoming jobs can deliver to an external board after analysis. Their dedicated
// actions must retain that authority; generic recovery only prepares a preview.
const hasIncomingIdentity = (value: any) => Boolean(value?.auctioneerWorkItem || value?.auctioneer_work_item_id ||
  value?.auctionsoft != null || value?.auctionsoft_task_id || value?.auctionsoftTaskId);

async function assertActor(access: Access) {
  if (!access.actorId || !await User.exists({ _id: access.actorId, isBlocked: { $ne: true }, ...(access.scope === "admin" ? { role: "superadmin" } : {}) })) {
    throw fail("Your access changed. Sign in again before retrying.", 403, "INITIAL_PREVIEW_RETRY_ACCESS_CHANGED");
  }
}

async function load(input: Input) {
  await assertActor(input);
  const report = await model(input.reportType).findOne({ _id: input.reportId, ...(input.scope === "owner" ? { user: input.actorId } : {}) })
    .select("+report_job_outbox +report_recovery +job_execution_token").lean();
  if (!report) throw fail("Report not found.", 404);
  return report;
}

function problem(kind: Kind, report: any): string | null {
  if (hasIncomingIdentity(report) || hasIncomingIdentity(report.details)) return "Incoming auction reports use their existing retry action.";
  if (report.adminArchivedAt || report.is_draft_preview || submitted(report)) return "This report is no longer eligible for initial preview recovery.";
  if (preview(kind, report) != null || hasArtifacts(report)) return "A saved preview or generated file already exists. Open it and use the normal review action.";
  if (report.status !== "error" || report.job_status !== "error" || !report.job_id || report.job_execution_token || report.report_job_outbox ||
    report.files_generating || report.files_regenerating || report.files_regeneration_pending || report.excel_regenerating) return "This report is already processing or is not a failed initial preview.";
  if (report.report_recovery?.manualReviewRequired) return "Support must review this report before it can be retried.";
  if (!shouldUseMongoReportQueue()) return "Preview recovery is temporarily unavailable.";
  return null;
}

/** Only the immutable accepted session and terminal initial job authorize reuse. */
async function retainedSource(kind: Kind, report: any) {
  const job: any = await ReportJob.findOne({ reportId: String(report._id), progressId: report.job_id,
    type: kind === "asset" ? "asset-preview" : "lot-listing-preview", status: "failed", targetStatus: "preview" }).lean();
  if (!job || job.executionToken || job.lockedBy || job.leaseUntil || job.lastError !== report.job_error) throw sourceError();
  const payload = job.payload;
  if (String(payload?.user?.id || "") !== owner(report) || String(payload?.[kind === "asset" ? "reportId" : "listingId"] || "") !== String(report._id) ||
    payload?.progressId !== report.job_id || !payload.details || payload.details.draft_preview ||
    hasIncomingIdentity(payload) || hasIncomingIdentity(payload.details) || payload.eventIdentityRetry) throw sourceError();
  const files = retainedInitialPreviewSources(payload);
  const sessionId = String(payload.details.upload_session_id || "");
  if (!/^[a-f\d]{24}$/i.test(sessionId)) throw sourceError();
  const session: any = await ReportUploadSession.findOne({ _id: sessionId, type: kind, user: owner(report), reportId: String(report._id) }).lean();
  const sessionHash = verifySession(session, files);
  return { job, payload, sessionId, sessionHash, sourceHash: sourceHash(payload) };
}

function verifySession(session: any, files: any[]): string {
  if (!session || session.cleanupStartedAt || session.supersededAt || !["completed", "queued", "processed", "failed"].includes(session.status) ||
    session.smartUpload || hasIncomingIdentity(session) || hasIncomingIdentity(session.details) ||
    !Array.isArray(session.files) || session.files.length > 15000 || session.files.length !== files.length ||
    session.expectedFileCount !== files.length || session.expectedImageCount !== files.filter(file => file.fieldname === "images").length ||
    session.expectedVideoCount !== files.filter(file => file.fieldname === "videos").length) throw sourceError();
  const bucket = storageTarget({ r2Bucket: session.r2Bucket, r2PublicBaseUrl: session.r2PublicBaseUrl }).bucketName;
  const manifest = new Map<string, any>();
  for (const file of session.files) {
    if (!file.key || manifest.has(file.key)) throw sourceError();
    manifest.set(file.key, file);
  }
  const seen = new Set<string>();
  for (const file of files) {
    const source = manifest.get(file.r2Key);
    const location = typeof file.r2PublicUrl === "string" ? resolveR2ObjectLocationFromUrl(file.r2PublicUrl) : null;
    if (!source || seen.has(file.r2Key) || storageTarget({ r2Bucket: file.r2Bucket }).bucketName !== bucket ||
      !location || location.bucketName !== bucket || location.key !== file.r2Key ||
      Number(source.verifiedSize || source.size) !== file.size || source.fieldname !== file.fieldname ||
      ["lotIndex", "imageIndex", "captureOrder", "originalOrder", "role"].some(key => source[key] !== file[key])) throw sourceError();
    seen.add(file.r2Key);
  }
  return hash({ id: String(session._id), owner: String(session.user), reportId: session.reportId, type: session.type,
    jobId: session.jobId, bucket, files: session.files, manifestHash: session.manifestHash, details: session.details });
}

function revision(kind: Kind, report: any, source: Awaited<ReturnType<typeof retainedSource>>) {
  return hash({ kind, report, jobId: String(source.job._id),
    sourceHash: source.sourceHash, sessionHash: source.sessionHash });
}

export async function getInitialPreviewRetryState(input: Input) {
  const report = await load(input);
  let reason = problem(input.reportType, report);
  let baseRevision: string | null = null;
  if (!reason) {
    try {
      const source = await retainedSource(input.reportType, report);
      if (await ReportJob.exists({ reportId: input.reportId, status: { $in: active } })) reason = "This report already has active processing work.";
      else baseRevision = revision(input.reportType, report, source);
    } catch (error: any) {
      if (error?.statusCode === 409) reason = error.message;
      else throw error;
    }
  }
  await assertActor(input);
  return { initialPreviewRetryEligible: !reason, initialPreviewRetryIneligibleReason: reason, initialPreviewRetryRevision: baseRevision };
}

function isReplay(input: Input & { baseRevision: string }, report: any) {
  const receipt = report.report_recovery;
  return receipt?.mode === MODE && receipt.actorId === input.actorId && receipt.actorScope === input.scope && receipt.ownerId === owner(report) &&
    receipt.sourceRevision === input.baseRevision && receipt.jobId === report.job_id && !hasIncomingIdentity(report) &&
    !hasIncomingIdentity(report.details) && !report.adminArchivedAt &&
    !report.is_draft_preview && !submitted(report) && (active.includes(report.job_status) || (report.job_status === "done" && preview(input.reportType, report) != null));
}

async function accepted(kind: Kind, report: any) {
  if (report.report_job_outbox) {
    try { await ensureReportJobOutbox(kind, String(report._id), String(report.report_job_outbox.token)); }
    catch { console.warn("[InitialPreviewRetry] Durable preview handoff awaits dispatch", { reportId: String(report._id), kind }); }
  }
  return { message: "The same report is queued to verify its original photos and prepare a preview. Review it before submitting.", data: {
    reportId: String(report._id), reportType: kind, job_id: report.job_id, job_status: report.job_status,
    retry_stage: "initial_preview", preview_available: report.job_status === "done" && preview(kind, report) != null,
    downloadable: false, files_generating: false, files_regenerating: false,
  } };
}

export async function retryRetainedInitialPreview(input: Input & { baseRevision: string }) {
  const report = await load(input);
  if (isReplay(input, report)) return accepted(input.reportType, report);
  const reason = problem(input.reportType, report);
  if (reason) throw fail(reason);
  const source = await retainedSource(input.reportType, report);
  if (input.baseRevision !== revision(input.reportType, report, source)) throw fail("This report changed. Refresh and check preview recovery before retrying.");
  const filter = initialPreviewRetrySnapshotFilter(input.reportType, report);
  for (const key of ["auctionsoft", "auctionsoft_task_id", "auctionsoftTaskId", "auctioneer_work_item_id"]) {
    filter.$and.push({ $expr: { $eq: [{ $ifNull: [`$${key}`, null] }, null] } } as any);
  }
  await assertActor(input);
  if (await ReportJob.exists({ reportId: input.reportId, status: { $in: active } })) throw fail("This report already has active processing work.");
  const freshSource = await retainedSource(input.reportType, report);
  if (freshSource.sourceHash !== source.sourceHash || freshSource.sessionHash !== source.sessionHash || String(freshSource.job._id) !== String(source.job._id)) throw sourceError();
  const token = `preview-retry-${hash({ report: input.reportId, revision: input.baseRevision }).slice(0, 40)}`;
  const proof = { version: 1, originalJobId: String(source.job._id), sourceHash: source.sourceHash, sessionId: source.sessionId,
    sessionHash: source.sessionHash, actorId: input.actorId, actorScope: input.scope, ownerId: owner(report) };
  const outbox = buildReportJobOutbox({ type: source.job.type, reportId: input.reportId, progressId: token, token,
    targetStatus: "preview", maxAttempts: 1, idempotencyKey: `retained-preview-retry:${input.reportType}:${input.reportId}:${input.baseRevision}`,
    payload: { ...source.payload, progressId: token, retainedPreviewRetry: proof } });
  const audit = { mode: MODE, actorId: input.actorId, actorScope: input.scope, ownerId: owner(report), sourceRevision: input.baseRevision,
    sourceJobId: String(source.job._id), previousJobId: report.job_id, jobId: token, requestedAt: new Date() };
  const claimed = await model(input.reportType).findOneAndUpdate(filter, {
    $set: { status: "processing", job_id: token, job_status: "queued", queued_at: new Date(),
      files_generating: false, files_regenerating: false, generation_target_status: "preview", report_job_outbox: outbox, report_recovery: audit,
      generation_progress: { stage: "queued", phase: "processing", progressPercent: 0, message: "Queued to verify original photos and prepare a preview", updatedAt: new Date() } },
    $unset: { job_error: 1, error_message: 1, job_execution_token: 1 }, $push: { report_recovery_history: audit },
  }, { returnDocument: "after" }).select("+report_job_outbox +report_recovery").lean();
  if (!claimed) {
    const current = await load(input);
    if (isReplay(input, current)) return accepted(input.reportType, current);
    throw fail("This report changed while retrying. Refresh before trying again.");
  }
  return accepted(input.reportType, claimed);
}

/** Executes only after a durable, actor-requested claim, before any analysis. */
export async function verifyRetainedPreviewRetrySources(job: IReportJob, context: ReportJobExecutionContext) {
  const proof = job.payload?.retainedPreviewRetry;
  if (!proof) return;
  const kind: Kind = job.type === "asset-preview" ? "asset" : "lotListing";
  if (proof.version !== 1 || !["owner", "admin"].includes(proof.actorScope) || !proof.actorId || !proof.ownerId ||
    (proof.actorScope === "owner" && proof.actorId !== proof.ownerId) ||
    sourceHash(job.payload) !== proof.sourceHash || String(job.payload?.user?.id) !== proof.ownerId ||
    hasIncomingIdentity(job.payload) || hasIncomingIdentity(job.payload?.details)) throw sourceError();
  const assertOwned = async () => {
    await context.assertOwned();
    await assertActor({ actorId: proof.actorId, scope: proof.actorScope });
    const current = await model(kind).findOne({ _id: job.reportId, user: proof.ownerId, job_id: job.progressId,
      status: "processing", job_status: { $in: active }, adminArchivedAt: null, is_draft_preview: { $ne: true }, auctioneerWorkItem: null })
      .select("+report_recovery").lean();
    if (!current || current.report_recovery?.mode !== MODE || current.report_recovery?.jobId !== job.progressId ||
      current.report_recovery?.actorId !== proof.actorId || current.report_recovery?.manualReviewRequired || submitted(current) ||
      hasIncomingIdentity(current) || hasIncomingIdentity(current.details) ||
      preview(kind, current) != null || hasArtifacts(current)) throw fail("This initial preview attempt is no longer current.");
    const original: any = await ReportJob.findOne({ _id: proof.originalJobId, reportId: job.reportId, type: job.type, status: "failed", targetStatus: "preview" }).lean();
    if (!original || original.executionToken || original.lockedBy || original.leaseUntil || sourceHash(original.payload) !== proof.sourceHash) throw sourceError();
    const session = await ReportUploadSession.findOne({ _id: proof.sessionId, type: kind, user: proof.ownerId, reportId: job.reportId }).lean();
    if (verifySession(session, retainedInitialPreviewSources(job.payload)) !== proof.sessionHash) throw sourceError();
  };
  await verifyRetainedInitialPreviewObjects(job.payload, assertOwned);
}
