import { createHash } from "node:crypto";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob, { type IReportJob } from "../models/reportJob.model.js";
import { getCanonicalLotListingPreview } from "../utils/reportPreviewAvailability.js";
import { buildReportJobOutbox, ensureReportJobOutbox, shouldUseMongoReportQueue, type ReportJobExecutionContext } from "../utils/reportJobMongoQueue.js";
import { headR2Object, resolvePersistedR2StorageTarget } from "../utils/r2Storage/r2Upload.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import { lotListingArtifactPublicationAvailableCondition } from "./lotListingArtifactPublicationService.js";
import { AUCTIONEER_EVENT_REQUIRED_MESSAGE, recoverInitialAuctioneerEventIdentity } from "./auctioneerEventResolutionService.js";

type Kind = "asset" | "lotListing";
const mode = "owner_initial_event_retry";
const activeStatuses = ["queued", "processing"];
const modelFor = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const ownerId = (report: any) => String(report?.user?._id || report?.user || "");
const conflict = (message: string, code = "AUCTIONEER_INITIAL_RETRY_CONFLICT") => Object.assign(new Error(message), { statusCode: 409, code });
const sourceUnavailable = () => conflict("The original upload is not completely available for this retry. Open the saved draft and check its photos before trying again. Do not create a second report.", "AUCTIONEER_INITIAL_RETRY_SOURCE_UNAVAILABLE");

function canonicalPreview(kind: Kind, report: any) {
  return kind === "asset" ? report.preview_data : getCanonicalLotListingPreview(report);
}

function wasSubmitted(report: any) {
  return Boolean(report.preview_submitted_at || report.approval_requested_at || report.approval_processed_at ||
    report.released_at || ["pending_approval", "approved", "declined"].includes(report.status));
}

function hasArtifacts(report: any) {
  return [report.preview_files, report.files].some((files) => files && Object.values(files).some((value) => typeof value === "string" && value.trim()));
}

function exactValue(report: any, key: string) {
  return report[key] === undefined ? { [key]: { $exists: false } } :
    // Read the field as an expression so Mongoose cannot recast raw BSON lot
    // arrays into subdocuments with defaults that never existed in the snapshot.
    { $expr: { $eq: [{ $getField: { field: key, input: "$$ROOT" } }, { $literal: report[key] }] } };
}

function snapshotFilter(kind: Kind, report: any) {
  return {
    _id: report._id, user: ownerId(report), adminArchivedAt: null, is_draft_preview: { $ne: true },
    $and: [
      ...["updatedAt", "status", "job_status", "job_id", "job_error", "job_execution_token", "auctioneerWorkItem",
        "preview_data", "lots", "imageUrls", "videoUrls", "preview_submitted_at", "approval_requested_at", "approval_processed_at",
        "release_status", "released_at", "files_generating", "files_regenerating", "files_regeneration_pending", "excel_regenerating",
        "report_recovery", "preview_files", "files", "client_submission_id", "details"].map((key) => exactValue(report, key)),
      { $or: [{ report_job_outbox: { $exists: false } }, { report_job_outbox: null }] },
      kind === "asset" ? proposalValuationWritableRevisionCondition(Number(report.proposal_valuation_revision || 0)) : lotListingArtifactPublicationAvailableCondition(),
    ],
  };
}

/** Source metadata is immutable queue data, never supplied by the retry request. */
function originalSources(payload: any): any[] {
  if (!payload || !Array.isArray(payload.images) || payload.images.length === 0 || payload.images.length > 5000 ||
    (payload.videos !== undefined && (!Array.isArray(payload.videos) || payload.videos.length > 10000))) throw sourceUnavailable();
  const files = [...payload.images, ...(payload.videos || [])];
  // Terminal queue cleanup removes multipart inputs. Reconstructing images from
  // root previews could lose order/roles or stamp them twice, so fail closed.
  if (files.some((file) => !file || typeof file.r2Key !== "string" || !file.r2Key.trim() ||
    !Number.isSafeInteger(file.size) || file.size <= 0)) throw sourceUnavailable();
  return files;
}

function response(kind: Kind, report: any) {
  const ready = report.job_status === "done" && canonicalPreview(kind, report) != null;
  return {
    message: ready ? "The preview is ready. Open it and review the details before submitting." : "The same report is queued for preview processing. Review the preview before submitting.",
    data: { reportId: String(report._id), reportType: kind, status: report.status, job_id: report.job_id,
      job_status: report.job_status, retry_stage: "initial_preview", preview_available: ready,
      auctioneer_work_item_id: String(report.auctioneerWorkItem), downloadable: false,
      files_generating: false, files_regenerating: false },
  };
}

async function dispatch(kind: Kind, report: any) {
  if (!report.report_job_outbox) return;
  try { await ensureReportJobOutbox(kind, String(report._id), String(report.report_job_outbox.token)); }
  catch {
    // Durable parent/outbox already accepted. An ambiguous acknowledgement must
    // not erase the source or cause the next click to create a second attempt.
    console.warn("[AuctioneerInitialRetry] Accepted preview handoff remains pending", { kind, reportId: String(report._id) });
  }
}

/** Existing empty-body Reports Retry, only for an unreviewed missing-event failure. */
export async function retryInitialAuctioneerPreview(input: { reportType: Kind; reportId: unknown; userId: unknown; hasIncomingEdits: boolean }) {
  const kind = input.reportType;
  const Model = modelFor(kind);
  const report = await Model.findOne({ _id: input.reportId, user: input.userId })
    .select("+report_job_outbox +report_recovery +job_execution_token").lean();
  if (!report || !report.auctioneerWorkItem) return null;
  const receipt = report.report_recovery;
  if (!input.hasIncomingEdits && receipt?.mode === mode && receipt.jobId === report.job_id &&
    receipt.actorId === ownerId(report) && !wasSubmitted(report) && !report.adminArchivedAt && !report.is_draft_preview &&
    (activeStatuses.includes(report.job_status) || report.job_status === "done")) {
    await dispatch(kind, report);
    return response(kind, report);
  }
  if (receipt?.mode === mode && receipt.jobId === report.job_id && !wasSubmitted(report) &&
    canonicalPreview(kind, report) == null && report.job_status === "error" &&
    report.job_error !== AUCTIONEER_EVENT_REQUIRED_MESSAGE) {
    // Root Lot rows may still be the original photo/intake shell. A different
    // failure during this retry must never turn that shell into file submission.
    throw conflict("Initial preview processing has not finished. Open the saved draft and check its photos and details before trying again. Keep this report; do not create a duplicate.", "AUCTIONEER_INITIAL_RETRY_INCOMPLETE");
  }
  if (report.job_error !== AUCTIONEER_EVENT_REQUIRED_MESSAGE || report.status !== "error" || report.job_status !== "error") return null;
  // A deliberately saved review is authoritative and stays on the ordinary
  // file-generation path, not this source-based paid initial-analysis retry.
  if (canonicalPreview(kind, report) != null || wasSubmitted(report) || hasArtifacts(report)) return null;
  if (input.hasIncomingEdits) throw conflict("Finish initial preview processing before submitting edits. Use Retry without replacing the saved source data.");
  if (report.adminArchivedAt || report.is_draft_preview || report.report_job_outbox || report.files_generating || report.files_regenerating ||
    report.files_regeneration_pending || report.excel_regenerating || report.report_recovery?.manualReviewRequired || !shouldUseMongoReportQueue()) {
    throw conflict("This initial preview cannot be retried in its current state. Refresh the report and review its processing status.");
  }
  const oldJob = await ReportJob.findOne({ reportId: String(report._id), progressId: report.job_id,
    type: kind === "asset" ? "asset-preview" : "lot-listing-preview", status: "failed", targetStatus: "preview",
    lastError: AUCTIONEER_EVENT_REQUIRED_MESSAGE }).lean();
  if (!oldJob || oldJob.executionToken || oldJob.lockedBy || oldJob.leaseUntil) throw sourceUnavailable();
  const payload: any = oldJob.payload;
  if (String(payload?.user?.id || "") !== ownerId(report) ||
    String(kind === "asset" ? payload?.reportId : payload?.listingId) !== String(report._id) ||
    String(payload?.progressId || "") !== String(report.job_id || "") ||
    !payload?.details || payload.details.draft_preview || !report.job_id) throw sourceUnavailable();
  originalSources(payload);
  const filter = snapshotFilter(kind, report);
  const assertOwned = async () => {
    if (!await Model.exists(filter) || await ReportJob.exists({ reportId: String(report._id), status: { $in: activeStatuses } })) {
      throw conflict("The report changed or another attempt is already processing. Refresh before retrying.");
    }
  };
  await assertOwned();
  await recoverInitialAuctioneerEventIdentity({ reportId: report._id, reportType: kind, assertOwned });
  await assertOwned();
  const token = `event-retry-${createHash("sha256").update(`${kind}:${report._id}:${oldJob._id}`).digest("hex").slice(0, 40)}`;
  const outbox = buildReportJobOutbox({ type: oldJob.type, reportId: String(report._id), progressId: token, token,
    targetStatus: "preview", maxAttempts: 1, idempotencyKey: `auctioneer-event-retry:${kind}:${report._id}:${oldJob._id}`,
    payload: { ...payload, progressId: token, eventIdentityRetry: { version: 1, originalJobId: String(oldJob._id) } } });
  const audit = { mode, actorId: ownerId(report), previousJobId: report.job_id, sourceJobId: String(oldJob._id), jobId: token, requestedAt: new Date() };
  const accepted = await Model.findOneAndUpdate(filter, {
    $set: { status: "processing", job_id: token, job_status: "queued", queued_at: new Date(),
      files_generating: false, files_regenerating: false, generation_target_status: "preview", report_job_outbox: outbox,
      report_recovery: audit, generation_progress: { stage: "queued", phase: "processing", progressPercent: 0,
        message: "Queued to prepare the initial preview", updatedAt: new Date() } },
    $unset: { job_error: 1, error_message: 1, job_execution_token: 1 },
    $push: { report_recovery_history: audit },
  }, { returnDocument: "after" }).select("+report_job_outbox +report_recovery").lean();
  if (!accepted) {
    const current = await Model.findOne({ _id: report._id, user: input.userId }).select("+report_job_outbox +report_recovery").lean();
    if (current?.report_recovery?.mode === mode && current.report_recovery.previousJobId === report.job_id &&
      current.report_recovery.jobId === current.job_id && activeStatuses.includes(current.job_status)) {
      await dispatch(kind, current);
      return response(kind, current);
    }
    throw conflict("The report changed while retrying. Refresh before trying again.");
  }
  await dispatch(kind, accepted);
  return response(kind, accepted);
}

/** Worker-only validation: all retained objects are checked before any paid analysis. */
export async function verifyInitialAuctioneerRetrySources(job: IReportJob, context: ReportJobExecutionContext) {
  if (!job.payload?.eventIdentityRetry) return;
  const files = originalSources(job.payload);
  let next = 0;
  let stopped = false;
  let failure: unknown;
  const assertParent = async () => {
    await context.assertOwned();
    const Model = modelFor(job.type === "asset-preview" ? "asset" : "lotListing");
    if (!await Model.exists({ _id: job.reportId, job_id: job.progressId, user: job.payload.user?.id,
      adminArchivedAt: null, is_draft_preview: { $ne: true }, job_status: { $in: activeStatuses } })) {
      throw conflict("The initial preview attempt is no longer current.");
    }
  };
  const checkEvent = () => recoverInitialAuctioneerEventIdentity({ reportId: job.reportId,
    reportType: job.type === "asset-preview" ? "asset" : "lotListing", assertOwned: assertParent });
  // Queueing can precede execution by minutes. Recheck the exact owner/work-item
  // relationship before storage checks and again before the paid analysis starts.
  await checkEvent();
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (!stopped) {
      const index = next++;
      if (index >= files.length) return;
      try {
        await assertParent();
        const file = files[index];
        const target = resolvePersistedR2StorageTarget({ r2Bucket: file.r2Bucket });
        const head = await headR2Object(target.bucketName, file.r2Key);
        if (Number(head.size) !== file.size) throw sourceUnavailable();
      } catch (error) { stopped = true; failure ||= error; }
    }
  }));
  if (failure) {
    await assertParent();
    throw sourceUnavailable();
  }
  await assertParent();
  await checkEvent();
}
