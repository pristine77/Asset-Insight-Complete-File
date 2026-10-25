import mongoose from "mongoose";
import { resolvePhotoWatermark } from "../utils/photoWatermarkPolicy.js";
import { pathToFileURL } from "node:url";
import connectDB from "../config/database.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import User from "../models/user.model.js";
import { buildAssetPreviewJobOutbox } from "../jobs/assetReportJob.js";
import { buildLotListingPreviewJobOutbox } from "../jobs/lotListingJob.js";
import { hasRequiredReportFiles } from "../utils/reportFileState.js";
import {
  headR2Object,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";
import { ensureReportJobOutbox } from "../utils/reportJobMongoQueue.js";
import { requiresAssetApproval } from "../utils/assetApprovalThreshold.js";
import { resolveReportApproverForUser } from "../service/approvalAssignmentService.js";
import {
  assignReleaseManager,
} from "../service/reportReleaseService.js";
import { sendClaimedAssignmentEmail } from "../service/assignmentEmailClaimService.js";
import { ORPHANED_REPORT_MESSAGE, recoverOrphanedReport } from "../service/reportRestartRecoveryService.js";
import { proposalValuationWritableRevisionCondition } from "../service/proposalValuationArtifactPublicationService.js";
import { lotListingArtifactPublicationAvailableCondition } from "../service/lotListingArtifactPublicationService.js";

const ACTIVE_JOB_STATUSES = ["queued", "processing"];

// The deployment CLI can overlap an API restart recovery, an owner save, or a
// worker claim. Never use a stale list snapshot to overwrite newer work.
function reconciliationFilter(kind: "asset" | "lotListing", report: any) {
  return {
    _id: report._id,
    $and: [
      ...["updatedAt", "job_id", "job_status", "job_error", "status", "files_generating", "files_regenerating"].map((key) => ({
        [key]: report[key] === undefined ? { $exists: false } : report[key],
      })),
      { $or: [{ report_job_outbox: { $exists: false } }, { report_job_outbox: null }] },
      kind === "asset"
        ? proposalValuationWritableRevisionCondition(Number(report.proposal_valuation_revision || 0))
        : lotListingArtifactPublicationAvailableCondition(),
    ],
  };
}

function resolveBooleanFlag(value: unknown, fallback: boolean): boolean {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return fallback;
}

function isSubmittedReport(report: any): boolean {
  return Boolean(
    report.preview_submitted_at ||
      report.approval_requested_at ||
      ["pending_approval", "approved"].includes(String(report.status || "")),
  );
}

export async function queuePersistedArtifactRepair(
  kind: "asset" | "lotListing",
  report: any,
  _persistedTarget: unknown,
) {
  // Retain the internal entry point, but never infer submission from a target
  // or regenerate a done report merely because an artifact is missing.
  if (report.job_status !== "error" || !isSubmittedReport(report)) return false;
  return await recoverOrphanedReport(kind, String(report._id)) === "requeued";
}

async function reconcileCompletedAssetApprovalGate(report: any) {
  if (report.status !== "pending_approval") return "unchanged";
  if (
    !hasRequiredReportFiles(
      "asset",
      report.preview_files,
      report.files
    )
  ) {
    return "waiting-for-files";
  }

  const [thresholdExceeded, currentApproverId] = await Promise.all([
    requiresAssetApproval(report),
    resolveReportApproverForUser(report.user),
  ]);
  if (thresholdExceeded && currentApproverId) return "approval-required";

  // Repair legacy reports that were routed to approval by an obsolete
  // Auctioneer/manual override. Approval requires both value and assignment.
  report.status = "approved";
  report.approval_requested_at = undefined;
  report.approval_processed_at = new Date();
  report.approval_assigned_to = undefined;
  report.approval_assigned_at = undefined;
  report.approval_assigned_source = undefined;
  report.approval_assignment_email_sent_at = undefined;

  const releaseManagerId = await assignReleaseManager(report, {
    userId: report.user,
    forceManual: Boolean(report.auctioneerWorkItem),
  });
  report.generation_progress = {
    stage:
      report.release_status === "pending_release" ? "awaiting_release" : "ready",
    progressPercent: 100,
    message:
      report.release_status === "pending_release"
        ? "Files ready; awaiting release"
        : "Report ready",
    updatedAt: new Date(),
  };
  await report.save();
  if (releaseManagerId) {
    await sendClaimedAssignmentEmail({
      model: AssetReport,
      reportId: report._id,
      kind: "release",
      generationToken: `reconcile:${String(report.job_id || report._id)}`,
      ownershipFilter: { job_status: "done" },
      stateFilter: {
        status: "approved",
        release_status: "pending_release",
      },
      reportType: "Asset",
      creatorUserId: report.user,
      title: report.client_name || report.preview_data?.client_name,
      summary: report.contract_no || report.preview_data?.contract_no,
    });
  }
  return thresholdExceeded ? "auto-approved-unassigned" : "auto-approved-below-limit";
}

function sessionFilesAsMulter(session: any): Express.Multer.File[] {
  const storageTarget = resolvePersistedR2StorageTarget(session);
  return [...(session?.files || [])]
    .map((file: any, index: number) => ({ file, index }))
    .sort((a, b) =>
      Number(a.file.originalOrder ?? a.index) - Number(b.file.originalOrder ?? b.index)
    )
    .map(({ file }) => ({
      fieldname: file.fieldname,
      originalname: file.originalname,
      encoding: "7bit",
      mimetype: file.mimetype,
      filename: String(file.key || "").split("/").pop() || file.originalname,
      size: Number(file.verifiedSize || file.size || 0),
      r2Key: file.key,
      r2Bucket: storageTarget.bucketName,
    })) as any;
}

async function sessionSourcesExist(session: any): Promise<boolean> {
  const bucket = resolvePersistedR2StorageTarget(session).bucketName;
  if (!bucket || !Array.isArray(session?.files) || session.files.length === 0) return false;
  try {
    await Promise.all(session.files.map((file: any) => headR2Object(bucket, file.key)));
    return true;
  } catch {
    return false;
  }
}

export async function reconcileOne(
  kind: "asset" | "lotListing",
  report: any,
) {
  // A saved/done preview is not an implicit file submission. Leave its saved
  // state (including old target metadata and absent artifacts) untouched.
  if (!report.files_generating && !report.files_regenerating &&
    (report.job_status === "done" || (report.status === "preview" && !isSubmittedReport(report)))) {
    return isSubmittedReport(report) ? "done" : "preview-ready";
  }
  // Reuse the fresh, revision-fenced recovery decision. The old error branch
  // must not race startup recovery and turn its new queued job back into error.
  if (report.job_status === "error" && report.job_error === ORPHANED_REPORT_MESSAGE) {
    return recoverOrphanedReport(kind, String(report._id));
  }
  // A report-row outbox is the authoritative crash-safe handoff. Materialize
  // it before deciding that a queued report has no durable job; otherwise the
  // deployment repair pass could incorrectly turn recoverable work into error.
  const outboxJob = await ensureReportJobOutbox(
    kind,
    String(report._id)
  );
  const controllingTypes =
    kind === "asset"
      ? ["asset-preview", "asset-preview-files", "asset-excel-cr-files"]
      : [
          "lot-listing-preview",
          "lot-listing-files",
          "lot-listing-excel-cr-files",
        ];
  const reportGenerationToken = String(report.job_id || "").trim();
  const latestJob =
    outboxJob ||
    (await ReportJob.findOne({
      reportId: String(report._id),
      type: { $in: controllingTypes },
      ...(reportGenerationToken
        ? {
            $or: [
              { progressId: reportGenerationToken },
              { "payload.generationToken": reportGenerationToken },
              { "payload.jobId": reportGenerationToken },
              { "payload.progressId": reportGenerationToken },
            ],
          }
        : {}),
    }).sort({ createdAt: -1 }));
  const persistedTarget =
    report.generation_target_status || latestJob?.targetStatus ||
    (kind === "lotListing" ? "approved" : undefined);
  const isFileGeneration =
    Boolean(report.files_regenerating) || Boolean(latestJob?.type?.endsWith("-files"));
  if (latestJob && ACTIVE_JOB_STATUSES.includes(latestJob.status)) {
    const activeExecutionToken =
      latestJob.status === "processing" && typeof latestJob.executionToken === "string"
        ? latestJob.executionToken
        : undefined;
    const changed = await report.constructor.updateOne(reconciliationFilter(kind, report), {
      $set: {
        ...(!isFileGeneration ? { status: "processing" } : {}),
        files_generating: true,
        ...(isFileGeneration ? { files_regenerating: true } : {}),
        job_id: latestJob.progressId || report.job_id,
        job_status: latestJob.status,
        ...(activeExecutionToken
          ? { job_execution_token: activeExecutionToken }
          : {}),
        job_error: undefined,
        ...(persistedTarget ? { generation_target_status: persistedTarget } : {}),
        generation_progress: latestJob.progress || {
          stage: latestJob.status === "queued" ? "queued" : "analyzing",
          progressPercent: 0,
          message: latestJob.status === "queued" ? "Queued" : "Processing",
          updatedAt: new Date(),
        },
      },
      ...(!activeExecutionToken
        ? { $unset: { job_execution_token: 1 } }
        : {}),
    });
    return changed.matchedCount === 1 ? "active" : "conflict";
  }
  if (
    latestJob?.status === "failed" ||
    (!latestJob && String(report.job_status || "").toLowerCase() === "error")
  ) {
    const failureMessage =
      latestJob?.lastError ||
      report.job_error ||
      "Report processing failed. Retry file generation.";
    const changed = await report.constructor.updateOne(reconciliationFilter(kind, report), {
      $set: {
        ...(!isFileGeneration ? { status: "error" } : {}),
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: failureMessage,
        ...(persistedTarget ? { generation_target_status: persistedTarget } : {}),
        generation_progress: {
          stage: "error",
          progressPercent: 100,
          message: failureMessage,
          updatedAt: new Date(),
        },
      },
      $unset: { job_execution_token: 1 },
    });
    return changed.matchedCount === 1 ? "failed" : "conflict";
  }

  const filesReady = report.artifact_repair_required !== true && hasRequiredReportFiles(
    kind === "asset" ? "asset" : "lotListing",
    report.preview_files,
    report.files
  );
  if (filesReady) {
    const nextStatus = report.status === "processing"
      ? persistedTarget || (kind === "lotListing" ? "approved" : "preview")
      : report.status;
    const changed = await report.constructor.updateOne(reconciliationFilter(kind, report), {
      $set: {
        status: nextStatus,
        files_generating: false,
        files_regenerating: false,
        job_status: "done",
        processing_completed_at: report.processing_completed_at || new Date(),
        generation_progress: {
          stage: nextStatus === "approved" ? "ready" : nextStatus === "pending_approval" ? "awaiting_approval" : "building_preview",
          progressPercent: 100,
          message: nextStatus === "approved" ? "Report ready" : nextStatus === "pending_approval" ? "Files ready; awaiting approval" : "Preview ready",
          updatedAt: new Date(),
        },
        ...(kind === "lotListing" && nextStatus === "approved"
          ? {
              release_status: "released",
              release_assigned_source: "auto_released",
              approval_processed_at: report.approval_processed_at || new Date(),
              released_at: report.released_at || new Date(),
            }
          : {}),
      },
      $unset: {
        job_error: 1,
        generation_target_status: 1,
        ...(kind === "lotListing"
          ? {
              approval_assigned_to: 1,
              approval_assigned_at: 1,
              approval_assigned_source: 1,
              approval_assignment_email_sent_at: 1,
              release_assigned_to: 1,
              release_assigned_at: 1,
              release_assignment_email_sent_at: 1,
            }
          : {}),
      },
    });
    return changed.matchedCount === 1 ? "ready" : "conflict";
  }

  const session = await ReportUploadSession.findOne({
    reportId: String(report._id),
    type: kind,
    status: { $in: ["uploading", "completed", "queued"] },
  }).sort({ createdAt: -1 });
  if (session && await sessionSourcesExist(session)) {
    const user = await User.findById(session.user).lean();
    const allFiles = sessionFilesAsMulter(session);
    const userPayload = {
      id: String(session.user),
      email: String((user as any)?.email || ""),
      name: (user as any)?.name || (user as any)?.username || undefined,
    };
    const recoveryOutbox = kind === "asset"
      ? buildAssetPreviewJobOutbox({
        reportId: String(report._id),
        user: userPayload,
        images: allFiles.filter((file: any) => file.fieldname === "images"),
        videos: allFiles.filter((file: any) => file.fieldname === "videos"),
        details: { ...(session.details || {}), upload_session_id: String(session._id) },
        progressId: session.jobId,
      })
      : buildLotListingPreviewJobOutbox({
        listingId: String(report._id),
        user: userPayload,
        images: allFiles.filter((file: any) => file.fieldname === "images"),
        videos: allFiles.filter((file: any) => file.fieldname === "videos"),
        details: {
          contract_no: session.details?.contract_no || "",
          sales_date: session.details?.sales_date || new Date().toISOString(),
          location: session.details?.location || "",
          latitude: session.details?.latitude,
          longitude: session.details?.longitude,
          language: session.details?.language || "en",
          currency: session.details?.currency || "CAD",
          include_damage_analysis: resolveBooleanFlag(
            session.details?.include_damage_analysis,
            true
          ),
          bank_photos_enabled: resolveBooleanFlag(
            session.details?.bank_photos_enabled,
            false
          ),
          watermark_images: resolvePhotoWatermark(session.details?.watermark_images),
          valuation_methods: session.details?.valuation_methods || ["FML"],
          mixed_lots: session.details?.mixed_lots || [],
          focus_boxes: session.details?.focus_boxes || [],
          upload_session_id: String(session._id),
        },
        progressId: session.jobId,
      });
    // Persist acceptance and its exact queue intent before launching anything.
    // A newer owner/admin generation defeats this CAS and receives no stale job.
    const claimed = await report.constructor.updateOne(reconciliationFilter(kind, report), {
      $set: {
        status: "processing",
        files_generating: true,
        job_id: session.jobId,
        job_status: "queued",
        queued_at: new Date(),
        report_job_outbox: recoveryOutbox,
        ...(persistedTarget ? { generation_target_status: persistedTarget } : {}),
        generation_progress: {
          stage: "queued", progressPercent: 0,
          message: "Recovered after server restart", updatedAt: new Date(),
        },
      },
      $unset: { job_error: 1, job_execution_token: 1 },
    });
    if (claimed.matchedCount !== 1) return "conflict";
    // An uncertain dispatch retains the authoritative outbox for a worker or
    // later pass. Never roll back accepted work or remove its saved sources.
    const recoveredJob = await ensureReportJobOutbox(kind, String(report._id), recoveryOutbox.token);
    // A completed idempotency key proves the exact source submission already
    // ran. Never label it queued when no worker can claim it; keep the report
    // on the explicit unrecoverable path below for operator/user retry.
    if (recoveredJob?.status === "completed") {
      console.warn(
        `[ReportReconciliation] Exact ${kind} recovery job is already completed but required files are missing`,
        { reportId: String(report._id), jobId: String(recoveredJob._id) },
      );
      await ReportUploadSession.updateOne(
        {
          _id: session._id,
          reportId: String(report._id),
          status: { $in: ["uploading", "completed", "queued"] },
          cleanupStartedAt: { $exists: false },
        },
        {
          $set: {
            status: "failed",
            lastError:
              "The exact processing job completed without the required report files. Reopen the saved draft and submit again.",
          },
          $unset: { activeContractClaim: 1 },
        },
      );
      const current = await report.constructor.findOne({
        _id: report._id, job_id: session.jobId, job_status: "queued",
      });
      if (!current) return "conflict";
      const changed = await report.constructor.updateOne(reconciliationFilter(kind, current), {
        $set: {
          ...(!isFileGeneration ? { status: "error" } : {}),
          files_generating: false, files_regenerating: false, job_status: "error",
          job_error: ORPHANED_REPORT_MESSAGE,
          generation_progress: { stage: "error", progressPercent: 100, message: ORPHANED_REPORT_MESSAGE, updatedAt: new Date() },
        },
      });
      return changed.matchedCount === 1 ? "unrecoverable" : "conflict";
    } else {
      await ReportUploadSession.updateOne({
        _id: session._id, reportId: String(report._id), jobId: session.jobId,
        status: { $in: ["uploading", "completed", "queued"] },
        cleanupStartedAt: { $exists: false },
      }, {
        $set: { status: "queued", queuedAt: new Date() },
        $unset: { lastError: 1 },
      });
      return "requeued";
    }
  }

  const changed = await report.constructor.updateOne(reconciliationFilter(kind, report), {
    $set: {
      ...(!isFileGeneration ? { status: "error" } : {}),
      files_generating: false,
      files_regenerating: false,
      job_status: "error",
      job_error: "No active processing job or complete source upload was found. Reopen the saved draft and retry.",
      ...(persistedTarget ? { generation_target_status: persistedTarget } : {}),
      generation_progress: {
        stage: "error",
        progressPercent: 100,
        message: "No active processing job or complete source upload was found. Reopen the saved draft and retry.",
        updatedAt: new Date(),
      },
    },
  });
  return changed.matchedCount === 1 ? "unrecoverable" : "conflict";
}

export async function main() {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  await connectDB();
  // Deployment reconciliation also guarantees the idempotency indexes exist
  // before new submissions are accepted by the reloaded API processes.
  await Promise.all([
    AssetReport.createIndexes(),
    LotListing.createIndexes(),
    ReportJob.createIndexes(),
    ReportUploadSession.createIndexes(),
  ]);
  const query = {
    $or: [
      { status: "processing" },
      { files_generating: true },
      { files_regenerating: true },
      { job_status: { $in: ["queued", "processing", "error"] } },
      {
        job_status: "done",
        $or: [
          { preview_submitted_at: { $exists: true } },
          { approval_requested_at: { $exists: true } },
          { status: { $in: ["pending_approval", "approved"] } },
          {
            generation_target_status: {
              $in: ["preview", "pending_approval", "approved"],
            },
          },
          { artifact_repair_required: true },
        ],
      },
      { "report_job_outbox.token": { $type: "string" } },
    ],
  };
  const [assets, listings] = await Promise.all([
    AssetReport.find(query),
    LotListing.find(query),
  ]);
  const summary: Record<string, number> = {};
  for (const report of assets) {
    const result = await reconcileOne("asset", report);
    summary[`asset:${result}`] = (summary[`asset:${result}`] || 0) + 1;
  }
  for (const report of listings) {
    const result = await reconcileOne("lotListing", report);
    summary[`lotListing:${result}`] = (summary[`lotListing:${result}`] || 0) + 1;
  }

  const pendingApprovalAssets = await AssetReport.find({ status: "pending_approval" });
  for (const report of pendingApprovalAssets) {
    const result = await reconcileCompletedAssetApprovalGate(report);
    summary[`asset-approval:${result}`] =
      (summary[`asset-approval:${result}`] || 0) + 1;
  }
  console.log("[ReportReconciliation]", summary);
  await mongoose.disconnect();
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  main().catch(async (error) => {
    console.error("[ReportReconciliation] failed", error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
}
