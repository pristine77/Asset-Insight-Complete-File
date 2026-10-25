import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob from "../models/reportJob.model.js";
import User from "../models/user.model.js";
import { buildAssetPreviewFilesJobOutbox } from "../jobs/assetReportJob.js";
import { buildLotListingFilesJobOutbox } from "../jobs/lotListingJob.js";
import { ensureReportJobOutbox, shouldUseMongoReportQueue } from "../utils/reportJobMongoQueue.js";
import { getCanonicalLotListingPreview, hasSavedReportPreview } from "../utils/reportPreviewAvailability.js";
import { assetPreviewFingerprint } from "../utils/assetGenerationIdentity.js";
import { lotListingPreviewFingerprint } from "../utils/lotListingGenerationIdentity.js";
import { requiresAssetApproval } from "../utils/assetApprovalThreshold.js";
import { resolveReportApproverForUser } from "./approvalAssignmentService.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import { isLotListingArtifactPublicationLive, lotListingArtifactPublicationAvailableCondition } from "./lotListingArtifactPublicationService.js";
import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { normalizePreviewLotNumbers } from "../utils/lotNumbers.js";
import { getPreviewLotPhotoLimitMessage } from "../utils/assetPhotoLimits.js";
import { sanitizeAssetPreviewSignature } from "../utils/assetPreviewSignature.js";

export const ORPHANED_REPORT_MESSAGE = "No active processing job or complete source upload was found. Reopen the saved draft and retry.";
type Kind = "asset" | "lotListing";
type Mode = "startup" | "admin";
const activeStatuses = ["queued", "processing"];
const modelFor = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const plain = (value: any): any => value?.toObject?.() ?? value;
const clone = (value: any): any => JSON.parse(JSON.stringify(value));
const ownerId = (report: any) => String(report?.user?._id || report?.user || "");
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409, code: "REPORT_RESUBMIT_CONFLICT" });

/** Never fill an explicitly cleared canonical preview from stale root data. */
function savedPreview(kind: Kind, report: any): any {
  if (kind === "asset") return plain(report.preview_data);
  const canonical = getCanonicalLotListingPreview(report);
  if (canonical != null) return plain(canonical);
  return {
    contract_no: report.contract_no,
    sales_date: report.sales_date,
    location: report.location,
    latitude: report.latitude,
    longitude: report.longitude,
    currency: report.currency,
    language: report.language,
    total_value: report.total_value,
    include_damage_analysis: report.include_damage_analysis !== false,
    bank_photos_enabled: report.bank_photos_enabled === true,
    watermark_images: resolvePhotoWatermark(report.watermark_images),
    valuation_methods: report.valuation_methods || ["FML"],
    videoUrls: report.videoUrls || [],
    lots: plain(report.lots),
  };
}

function previewProblem(kind: Kind, report: any): string | null {
  if (!hasSavedReportPreview(kind, report)) return "No complete saved preview is available. Reopen the saved draft and finish the upload.";
  const preview = savedPreview(kind, report);
  // Photo-only intake shells are not completed analysis. Do not invent report text.
  if (!preview.lots.every((lot: any) => [lot.title, lot.description].some((value) => typeof value === "string" && value.trim()))) {
    return "Some lots contain photos but no saved report details. Reopen the draft and complete those lots.";
  }
  return null;
}

function isArchivedOrDraft(report: any) {
  return Boolean(report.adminArchivedAt || report.is_draft_preview || ["archived", "draft"].includes(report.status));
}

function hasFileWork(report: any): boolean {
  return Boolean(report.files_generating || report.files_regenerating ||
    report.files_regeneration_pending || report.excel_regenerating);
}

function hasLivePublication(kind: Kind, report: any) {
  return kind === "lotListing" ? isLotListingArtifactPublicationLive(report) : Boolean(
    report.proposal_valuation_artifact_publish_token &&
    (!report.proposal_valuation_artifact_publish_expires_at || new Date(report.proposal_valuation_artifact_publish_expires_at).getTime() > Date.now()),
  );
}

function revision(kind: Kind, report: any): string {
  return createHash("sha256").update(JSON.stringify({
    kind, id: String(report._id), owner: ownerId(report),
    updatedAt: report.updatedAt ? new Date(report.updatedAt).toISOString() : null,
    status: report.status, jobId: report.job_id, jobStatus: report.job_status,
    preview: assetPreviewFingerprint(savedPreview(kind, report) || {}),
    pvRevision: report.proposal_valuation_revision || 0,
  })).digest("hex");
}

export function getReportResubmitState(kind: Kind, report: any) {
  let reason: string | null = null;
  if (isArchivedOrDraft(report)) reason = "Draft previews must be submitted by their owner; archived reports cannot be resubmitted here.";
  else if (hasFileWork(report) || activeStatuses.includes(report.job_status) || report.report_job_outbox || hasLivePublication(kind, report)) reason = "This report is already processing. Wait for the current generation to finish.";
  else if (!["preview", "declined", "pending_approval", "approved", "error"].includes(report.status)) reason = "This report is not ready for resubmission.";
  else reason = previewProblem(kind, report);
  return { resubmitEligible: !reason, resubmitIneligibleReason: reason, resubmitRevision: revision(kind, report) };
}

async function loadReport(kind: Kind, reportId: string) {
  return modelFor(kind).findById(reportId).select("+report_job_outbox +report_recovery +job_execution_token").lean();
}

function exactField(report: any, key: string) {
  return { [key]: report[key] === undefined ? { $exists: false } : report[key] };
}

function exactSavedValue(report: any, key: string) {
  // Timestamps have millisecond resolution; two saves can share updatedAt.
  // $literal avoids interpreting uploaded strings/keys as query operators and
  // compares the raw lean BSON snapshot without Mongoose subdocument defaults.
  return report[key] === undefined ? { [key]: { $exists: false } } :
    { $expr: { $eq: [`$${key}`, { $literal: report[key] }] } };
}

function claimFilter(kind: Kind, report: any) {
  return {
    _id: report._id,
    user: ownerId(report),
    adminArchivedAt: null,
    is_draft_preview: { $ne: true },
    $and: [
      ...["updatedAt", "status", "job_status", "job_id", "job_error", "files_generating", "files_regenerating", "files_regeneration_pending", "excel_regenerating"].map((key) => exactField(report, key)),
      exactSavedValue(report, "preview_data"),
      ...(kind === "lotListing" && getCanonicalLotListingPreview(report) == null ? [exactSavedValue(report, "lots")] : []),
      { $or: [{ report_job_outbox: { $exists: false } }, { report_job_outbox: null }] },
      kind === "asset" ? proposalValuationWritableRevisionCondition(Number(report.proposal_valuation_revision || 0)) : lotListingArtifactPublicationAvailableCondition(),
    ],
  };
}

/** The old reconciler wrote target=approved even on initial Lot failures. */
function wasSubmitted(report: any): boolean {
  return Boolean(report.preview_submitted_at || report.approval_requested_at || ["pending_approval", "approved"].includes(report.status));
}

async function hasLiveJob(reportId: string) {
  return Boolean(await ReportJob.exists({ reportId, status: { $in: activeStatuses } }));
}

async function hasExactStoppedJob(report: any) {
  const jobId = String(report.job_id || "");
  if (!jobId) return false;
  return Boolean(await ReportJob.exists({ reportId: String(report._id), status: { $in: ["failed", "cancelled"] },
    $or: [{ progressId: jobId }, { "payload.generationToken": jobId }, { "payload.jobId": jobId }, { jobId }],
  }));
}

async function dispatch(kind: Kind, reportId: string, outboxToken: string) {
  try { await ensureReportJobOutbox(kind, reportId, outboxToken); }
  catch {
    // The report/outbox is already accepted. Workers and exact HTTP retries can
    // materialize it; never erase the only durable request after an ambiguous write.
    console.warn("[ReportRecovery] Accepted worker handoff remains pending", { kind, reportId });
  }
}

function accepted(kind: Kind, reportId: string, jobId: string) {
  return { message: "Saved preview accepted. Report files are queued for generation.", reportId,
    reportType: kind === "asset" ? "Asset" : "LotListing", jobId };
}

async function queueSavedFiles(kind: Kind, report: any, mode: Mode, actorId?: string) {
  const reportId = String(report._id);
  const sourceRevision = revision(kind, report);
  const user = await User.findOne({ _id: ownerId(report), isBlocked: { $ne: true } }).select("email username name").lean();
  if (!user) throw conflict("The report owner is unavailable or blocked.");
  const preview = clone(savedPreview(kind, report));
  // Validate without renormalizing saved narratives, media or user lot numbers.
  const validationProblem = normalizePreviewLotNumbers(preview, preview).message ||
    getPreviewLotPhotoLimitMessage(preview) ||
    (kind === "asset" ? sanitizeAssetPreviewSignature(preview).message : null);
  if (validationProblem) throw conflict(validationProblem);
  // Match normal Asset submission routing. Recovery never turns an unfinished
  // preview into an approved report; caller checks prior submission first.
  // A processed timestamp can also record a decline or an older revision.
  // Only the current approved state proves that this approval gate has passed.
  const alreadyApproved = report.status === "approved";
  const approvalRequired = kind === "asset" && !alreadyApproved && await requiresAssetApproval({ ...report, preview_data: preview });
  const approver = approvalRequired ? await resolveReportApproverForUser(ownerId(report)) : null;
  const targetStatus = kind === "asset" && approver ? "pending_approval" : "approved";
  const jobId = `${kind === "asset" ? "asset" : "ll"}-recovery-${randomUUID()}`;
  const outbox = kind === "asset" ? buildAssetPreviewFilesJobOutbox(reportId, {
    previewDataSnapshot: preview, generationToken: jobId, targetStatus,
  }) : buildLotListingFilesJobOutbox({ listingId: reportId,
    user: { id: ownerId(report), email: user.email || "", name: user.username || undefined },
    generationToken: jobId, jobId, previewDataSnapshot: preview }, "approved");
  const now = new Date();
  const audit = { mode, sourceRevision, jobId, previousJobId: report.job_id || null,
    actorId: actorId || null, createdAt: now };
  const set: Record<string, any> = {
    preview_data: preview, status: kind === "asset" && alreadyApproved ? "approved" : "processing",
    files_generating: true, files_regenerating: true, job_id: jobId, job_status: "queued", queued_at: now,
    generation_target_status: targetStatus, report_job_outbox: outbox, report_recovery: audit,
    generation_progress: { stage: "queued", progressPercent: 0, previousStatus: report.status,
      previewFingerprint: kind === "asset" ? assetPreviewFingerprint(preview) : lotListingPreviewFingerprint(preview),
      message: mode === "startup" ? "Recovering report files from the saved preview" : "Generating files from the saved preview", updatedAt: now },
  };
  const unset: Record<string, 1> = { job_error: 1, job_execution_token: 1 };
  if (kind === "lotListing") unset.error_message = 1;
  if (mode === "admin") set.preview_submitted_at = now;
  if (kind === "asset" && !alreadyApproved) {
    if (approver) {
      set.approval_assigned_to = approver; set.approval_assigned_at = now;
      set.approval_assigned_source = "user_report_approver";
      set.approval_requested_at = report.approval_requested_at || now;
    } else {
      for (const key of ["approval_assigned_to", "approval_assigned_at", "approval_assigned_source", "approval_requested_at"]) unset[key] = 1;
    }
    for (const key of ["approval_processed_at", "approval_assignment_email_sent_at", "release_status", "release_assigned_to", "release_assigned_at", "release_assigned_source", "release_assignment_email_sent_at", "released_by", "released_at"]) unset[key] = 1;
  }
  // Pre-check alone is not our lock: owner submissions, PV edits and publication
  // all mutate the parent and defeat the following exact snapshot CAS.
  if (await hasLiveJob(reportId)) throw conflict("This report already has active processing work.");
  const result = await modelFor(kind).updateOne(claimFilter(kind, report), {
    $set: set, $unset: unset, $push: { report_recovery_history: audit },
  });
  if (result.matchedCount !== 1) throw conflict("This preview changed. Refresh, review the latest saved data and try again.");
  await dispatch(kind, reportId, outbox.token);
  return accepted(kind, reportId, jobId);
}

/** Explicit admin action; authentication/assignment is enforced by the route. */
export async function resubmitSavedReportPreview(input: { kind: Kind; reportId: string; baseRevision: string; actorId: string }) {
  if (!shouldUseMongoReportQueue()) throw Object.assign(new Error("The durable report worker must be enabled before resubmitting here."), { statusCode: 503 });
  const report = await loadReport(input.kind, input.reportId);
  if (!report) throw Object.assign(new Error("Preview report not found."), { statusCode: 404 });
  if (isArchivedOrDraft(report)) throw conflict("Draft or archived previews cannot be resubmitted here.");
  const receipt = report.report_recovery;
  if (receipt?.mode === "admin" && receipt.sourceRevision === input.baseRevision && receipt.jobId === report.job_id && receipt.actorId === input.actorId) {
    if (report.report_job_outbox) await dispatch(input.kind, input.reportId, report.report_job_outbox.token);
    return accepted(input.kind, input.reportId, receipt.jobId);
  }
  const state = getReportResubmitState(input.kind, report);
  if (!input.baseRevision || input.baseRevision !== state.resubmitRevision) throw conflict("This preview changed. Refresh and review it before resubmitting.");
  if (!state.resubmitEligible) throw conflict(state.resubmitIneligibleReason!);
  try { return await queueSavedFiles(input.kind, report, "admin", input.actorId); }
  catch (error) {
    const current = await loadReport(input.kind, input.reportId);
    const receipt = current?.report_recovery;
    if (receipt?.mode === "admin" && receipt.sourceRevision === input.baseRevision && receipt.jobId === current.job_id && receipt.actorId === input.actorId) {
      if (current.report_job_outbox) await dispatch(input.kind, input.reportId, current.report_job_outbox.token);
      return accepted(input.kind, input.reportId, receipt.jobId);
    }
    throw error;
  }
}

/** Narrow recovery: no provider calls, upload reconstruction or broad status repair. */
export async function recoverOrphanedReport(kind: Kind, reportId: string): Promise<string> {
  if (!shouldUseMongoReportQueue()) return "skipped";
  const report = await loadReport(kind, reportId);
  if (report?.report_recovery?.manualReviewRequired === true &&
    String(report.report_recovery.jobId || "") === String(report.job_id || "")) return "skipped";
  if (!report || report.job_error !== ORPHANED_REPORT_MESSAGE || report.job_status !== "error" ||
    !wasSubmitted(report) ||
    !["error", "processing", "pending_approval", "approved"].includes(report.status) ||
    isArchivedOrDraft(report) || report.report_job_outbox || hasLivePublication(kind, report) ||
    hasFileWork(report) || await hasLiveJob(reportId) || await hasExactStoppedJob(report)) return "skipped";
  // A completed legacy job may have lost its file handoff, so it may seed one
  // new file-only generation. Never recursively repair our own accepted job,
  // even after queue history is pruned or the old reconciler repeats its error.
  if (report.report_recovery?.jobId && report.report_recovery.jobId === report.job_id) return "skipped";
  if (previewProblem(kind, report)) return "incomplete";
  try {
    await queueSavedFiles(kind, report, "startup");
    return "requeued";
  } catch (error: any) {
    if (error?.statusCode === 409) return "conflict";
    throw error;
  }
}

/** Keyset batches bound memory/concurrency without starving older failures. */
export async function recoverOrphanedReportsOnStartup() {
  const summary: Record<string, number> = {};
  if (!shouldUseMongoReportQueue() || mongoose.connection.readyState !== 1) return summary;
  const cutoff = new Date();
  const deadline = Date.now() + 2 * 60_000;
  for (const kind of ["asset", "lotListing"] as const) {
    let cursor: unknown;
    do {
      const reports = await modelFor(kind).find({ job_status: "error", job_error: ORPHANED_REPORT_MESSAGE,
        adminArchivedAt: null, is_draft_preview: { $ne: true }, updatedAt: { $lte: cutoff },
        ...(cursor ? { _id: { $gt: cursor } } : {}),
      }).select("_id").sort({ _id: 1 }).limit(25).lean();
      if (!reports.length) break;
      for (const report of reports) {
        if (Date.now() >= deadline) return { ...summary, timeLimited: 1 };
        const result = await recoverOrphanedReport(kind, String(report._id)).catch(() => "failed");
        summary[`${kind}:${result}`] = (summary[`${kind}:${result}`] || 0) + 1;
        cursor = report._id;
      }
    } while (Date.now() < deadline);
  }
  return summary;
}

export function startReportRestartRecovery() {
  if (process.env.REPORT_RESTART_RECOVERY_ENABLED === "false" || !shouldUseMongoReportQueue()) return;
  // Do not hold readiness or run the operator migration/reconciliation CLI.
  const timer = setTimeout(() => {
    void recoverOrphanedReportsOnStartup().then((summary) => {
      console.info("[ReportRecovery] Startup recovery finished", summary);
    }).catch(() => console.error("[ReportRecovery] Startup recovery could not complete; inspect the saved report and worker state before retrying."));
  }, 1_000);
  timer.unref();
}
