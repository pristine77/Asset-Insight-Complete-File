import AssetReport from "../models/asset.model.js";
import {
  buildAssetPreviewFilesJobOutbox,
  queuePreviewFilesJob,
} from "../jobs/assetReportJob.js";
import {
  ensureReportJobOutbox,
  shouldUseMongoReportQueue,
} from "../utils/reportJobMongoQueue.js";
import { assetPreviewFingerprint } from "../utils/assetGenerationIdentity.js";
import { findCurrentReportFileGenerationJob } from "./reportDraftPromotionService.js";

type AssetPreviewFilesOptions = NonNullable<
  Parameters<typeof queuePreviewFilesJob>[1]
>;

function clonePlain<T>(value: T): T {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function handoffError(
  message: string,
  code: string,
  statusCode: number,
  cause?: unknown
) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    ...(cause === undefined ? {} : { cause }),
  });
}

type AssetGenerationTarget = "preview" | "pending_approval" | "approved";

function requireGenerationTarget(report: any): AssetGenerationTarget {
  const target = String(report?.generation_target_status || "");
  if (["preview", "pending_approval", "approved"].includes(target)) {
    return target as AssetGenerationTarget;
  }
  throw handoffError(
    "The Asset report's saved worker target is missing or invalid. Processing must be reconciled before retrying.",
    "ASSET_QUEUE_HANDOFF_IDENTITY_INVALID",
    409
  );
}

function expectedApproveAfterGeneration(
  report: any,
  targetStatus: AssetGenerationTarget
): boolean {
  // Assigned-approver edits stay pending while their replacement files are
  // built, then complete the already-authorized approval. Owner submissions
  // either target pending approval or preserve preview/approved state.
  return report?.status === "pending_approval" && targetStatus === "approved";
}

function assertBaseGenerationRequestIdentity(input: {
  report: any;
  request: any;
  reportId: string;
  generationToken: string;
}) {
  const { request, reportId, generationToken } = input;
  const payload = request?.payload;
  const expectedIdempotencyKey =
    `asset-preview-files:${reportId}:${generationToken}`;
  const valid =
    request?.type === "asset-preview-files" &&
    String(request?.reportId || "") === reportId &&
    String(request?.progressId || "") === generationToken &&
    String(request?.idempotencyKey || "") === expectedIdempotencyKey &&
    payload &&
    String(payload?.reportId || "") === reportId &&
    String(payload?.generationToken || "") === generationToken;
  if (!valid) {
    throw handoffError(
      "The saved Asset worker request no longer matches this report generation. Refresh and reconcile processing before retrying.",
      "ASSET_QUEUE_HANDOFF_IDENTITY_MISMATCH",
      409
    );
  }
}

/**
 * Submission/preview mutations persist a fingerprint and full snapshot. Other
 * valid producers (merge, Schedule A/PV repair) intentionally queue a smaller
 * immutable payload and are limited to the base token checks above.
 */
function assertPersistedSnapshotIdentityIfPresent(input: {
  report: any;
  request: any;
}) {
  const expectedFingerprint = String(
    input.report?.generation_progress?.previewFingerprint || ""
  ).trim();
  if (!expectedFingerprint) return;

  const targetStatus = requireGenerationTarget(input.report);
  const snapshot = input.request?.payload?.previewDataSnapshot;
  const currentFingerprint = assetPreviewFingerprint(
    input.report?.preview_data || {}
  );
  const snapshotFingerprint = assetPreviewFingerprint(snapshot || {});
  const valid =
    typeof snapshot === "object" &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    String(input.request?.targetStatus || "") === targetStatus &&
    String(input.request?.payload?.targetStatus || "") === targetStatus &&
    Boolean(input.request?.payload?.approveAfterGeneration) ===
      expectedApproveAfterGeneration(input.report, targetStatus) &&
    snapshotFingerprint === expectedFingerprint &&
    currentFingerprint === expectedFingerprint;
  if (!valid) {
    throw handoffError(
      "The saved Asset worker snapshot no longer matches this report generation. Refresh and reconcile processing before retrying.",
      "ASSET_QUEUE_HANDOFF_IDENTITY_MISMATCH",
      409
    );
  }
}

function assertGenerationRequestIdentity(input: {
  report: any;
  request: any;
  reportId: string;
  generationToken: string;
}) {
  assertBaseGenerationRequestIdentity(input);
  assertPersistedSnapshotIdentityIfPresent(input);
}

function requireRecoverableCurrentSnapshot(report: any) {
  const expectedFingerprint = String(
    report?.generation_progress?.previewFingerprint || ""
  ).trim();
  if (
    !expectedFingerprint ||
    expectedFingerprint !== assetPreviewFingerprint(report?.preview_data || {})
  ) {
    throw handoffError(
      "The immutable Asset generation snapshot is unavailable or no longer matches the accepted request. Processing must be reconciled before retrying.",
      "ASSET_QUEUE_HANDOFF_SNAPSHOT_MISMATCH",
      409
    );
  }
}

/**
 * Confirm or reconstruct the exact durable file-generation request already
 * claimed by an Asset report. This never creates a new logical generation:
 * report.job_id remains the job progress/idempotency/ownership token.
 */
export async function ensureActiveAssetPreviewFilesHandoff(report: any) {
  if (!shouldUseMongoReportQueue()) return;

  const reportId = String(report?._id || "").trim();
  const generationToken = String(report?.job_id || "").trim();
  if (!reportId || !generationToken) {
    throw handoffError(
      "The Asset report is marked as generating, but its worker request identity is missing. Retry after report processing is reconciled.",
      "ASSET_QUEUE_HANDOFF_IDENTITY_MISSING",
      503
    );
  }

  let current: any = await AssetReport.findById(reportId)
    .select("+report_job_outbox +job_execution_token")
    .lean();
  if (!current || String(current.job_id || "") !== generationToken) {
    throw handoffError(
      "The Asset report generation changed while its worker handoff was being recovered. Refresh and retry.",
      "ASSET_QUEUE_HANDOFF_CHANGED",
      409
    );
  }
  let outboxToken = String(current.report_job_outbox?.token || "").trim();
  if (outboxToken) {
    assertGenerationRequestIdentity({
      report: current,
      request: current.report_job_outbox,
      reportId,
      generationToken,
    });
    const ensured = await ensureReportJobOutbox(
      "asset",
      reportId,
      outboxToken
    );
    const accepted =
      ensured ||
      (await findCurrentReportFileGenerationJob({
        report: current,
        type: "asset",
      }));
    if (!accepted) {
      throw handoffError(
        "The Asset report worker handoff could not be confirmed. Retry this request.",
        "ASSET_QUEUE_HANDOFF_PENDING",
        503
      );
    }
    assertGenerationRequestIdentity({
      report: current,
      request: accepted,
      reportId,
      generationToken,
    });
    return;
  }
  const existingJob = await findCurrentReportFileGenerationJob({
    report: current,
    type: "asset",
  });
  if (existingJob) {
    assertGenerationRequestIdentity({
      report: current,
      request: existingJob,
      reportId,
      generationToken,
    });
    return;
  }

  const targetStatus = requireGenerationTarget(current);
  requireRecoverableCurrentSnapshot(current);
  const queueOptions: AssetPreviewFilesOptions = {
    previewDataSnapshot: clonePlain(
      current.preview_data || report?.preview_data || {}
    ),
    approveAfterGeneration: expectedApproveAfterGeneration(
      current,
      targetStatus
    ),
    targetStatus,
    generationToken,
  };
  const outbox = buildAssetPreviewFilesJobOutbox(reportId, queueOptions);
  const claimed = await AssetReport.updateOne(
    {
      _id: reportId,
      job_id: generationToken,
      job_status: { $in: ["queued", "processing"] },
      $or: [
        { report_job_outbox: { $exists: false } },
        { report_job_outbox: null },
      ],
      $and: [
        {
          $or: [
            { job_execution_token: { $exists: false } },
            { job_execution_token: null },
          ],
        },
      ],
    },
    { $set: { report_job_outbox: outbox } }
  );
  if (claimed.matchedCount === 1) {
    outboxToken = outbox.token;
  } else {
    current = await AssetReport.findById(reportId)
      .select("+report_job_outbox +job_execution_token")
      .lean();
    if (!current || String(current.job_id || "") !== generationToken) {
      throw handoffError(
        "The Asset report generation changed while its worker handoff was being recovered. Refresh and retry.",
        "ASSET_QUEUE_HANDOFF_CHANGED",
        409
      );
    }
    outboxToken = String(current?.report_job_outbox?.token || "").trim();
    if (!outboxToken) {
      const concurrentlyAccepted = await findCurrentReportFileGenerationJob({
        report: current,
        type: "asset",
      });
      if (concurrentlyAccepted) {
        assertGenerationRequestIdentity({
          report: current,
          request: concurrentlyAccepted,
          reportId,
          generationToken,
        });
        return;
      }
      throw handoffError(
        "The Asset report worker handoff changed while it was being recovered. Refresh and retry.",
        "ASSET_QUEUE_HANDOFF_CHANGED",
        409
      );
    }
    assertGenerationRequestIdentity({
      report: current,
      request: current.report_job_outbox,
      reportId,
      generationToken,
    });
  }

  try {
    const queued = await queuePreviewFilesJob(reportId, {
      ...queueOptions,
      reportJobOutboxToken: outboxToken,
    });
    assertGenerationRequestIdentity({
      report: current,
      request: queued,
      reportId,
      generationToken,
    });
  } catch (error) {
    let accepted: any = null;
    try {
      accepted = await findCurrentReportFileGenerationJob({
        report: current || report,
        type: "asset",
      });
    } catch {
      // Preserve the embedded outbox when the queue lookup itself is
      // uncertain. The same retry can safely ensure this exact request again.
    }
    if (accepted) {
      assertGenerationRequestIdentity({
        report: current,
        request: accepted,
        reportId,
        generationToken,
      });
      return;
    }
    throw handoffError(
      "The Asset report and its exact processing request are saved, but the worker handoff could not be confirmed. Retry this request.",
      "ASSET_QUEUE_HANDOFF_PENDING",
      503,
      error
    );
  }
}
