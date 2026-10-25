import { randomUUID } from "node:crypto";
import AssetReport from "../models/asset.model.js";
import ReportJob from "../models/reportJob.model.js";
import { setReportGenerationProgress } from "./reportGenerationProgressService.js";

export const ASSET_PREVIEW_FILES_JOB_CONFLICT =
  "ASSET_PREVIEW_FILES_JOB_CONFLICT";

export class AssetPreviewFilesGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 409,
    public readonly code = ASSET_PREVIEW_FILES_JOB_CONFLICT
  ) {
    super(message);
    this.name = "AssetPreviewFilesGenerationError";
  }
}

/** One immutable token owns the report flags, durable job and worker writes. */
export function createAssetPreviewFilesGenerationToken(): string {
  return `asset-files-${randomUUID()}`;
}

export async function findAssetPreviewFilesJobByToken(input: {
  reportId: string;
  generationToken: string;
}) {
  return ReportJob.findOne({
    type: "asset-preview-files",
    reportId: input.reportId,
    progressId: input.generationToken,
    status: { $in: ["queued", "processing", "completed"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

export type AssetPreviewFilesQueueReconciliation = {
  queued: boolean;
  reconciled: boolean;
  superseded: boolean;
};

export type AssetPreviewFilesWorkerFailureReconciliation = {
  reconciled: boolean;
  supersededOrCompleted: boolean;
};

/**
 * Resolve an ambiguous enqueue before reopening the report. An exact durable
 * job wins; otherwise only the token that persisted the queue claim may mark
 * that claim retryable. A newer request is never overwritten.
 */
export async function reconcileAssetPreviewFilesQueueFailure(input: {
  reportId: string;
  generationToken: string;
  error: unknown;
  fallbackStatus: string;
}): Promise<AssetPreviewFilesQueueReconciliation> {
  const exactJob = await findAssetPreviewFilesJobByToken(input);
  if (exactJob) {
    return { queued: true, reconciled: true, superseded: false };
  }

  const message =
    input.error instanceof Error
      ? input.error.message
      : "Report files could not be queued.";
  const result = await AssetReport.updateOne(
    {
      _id: input.reportId,
      job_id: input.generationToken,
      job_status: { $in: ["queued", "processing"] },
    },
    {
      $set: {
        status: input.fallbackStatus,
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: message,
        processing_completed_at: new Date(),
        // Keep controller-owned metadata such as previousStatus and the
        // preview fingerprint. Exact-retry and recovery decisions may still
        // need those values after a definite enqueue failure.
        "generation_progress.stage": "error",
        "generation_progress.progressPercent": 100,
        "generation_progress.message": message,
        "generation_progress.updatedAt": new Date(),
      },
      $unset: {
        generation_target_status: 1,
        job_execution_token: 1,
      },
    }
  );

  return {
    queued: false,
    reconciled: result.matchedCount === 1,
    superseded: result.matchedCount !== 1,
  };
}

/**
 * Reconcile one failed worker attempt without allowing a late exception to
 * turn an already-completed (or superseded) generation back into an error.
 * The progress write is intentionally conditional on the same Mongo claim.
 */
export async function reconcileAssetPreviewFilesWorkerFailure(input: {
  reportId: string;
  generationToken?: string;
  executionToken?: string;
  progressId?: string;
  message: string;
  willRetry: boolean;
  fallbackStatus: string;
  generationTarget?: "preview" | "pending_approval" | "approved";
}): Promise<AssetPreviewFilesWorkerFailureReconciliation> {
  const generationToken = String(input.generationToken || "").trim();
  const result = await AssetReport.updateOne(
    {
      _id: input.reportId,
      ...(generationToken
        ? {
            job_id: generationToken,
            ...(input.executionToken
              ? { job_execution_token: input.executionToken }
              : {}),
            job_status: { $ne: "done" },
          }
        : {}),
    },
    {
      $set: {
        ...(!input.willRetry ? { status: input.fallbackStatus } : {}),
        files_generating: input.willRetry,
        files_regenerating: input.willRetry,
        job_status: input.willRetry ? "queued" : "error",
        job_error: input.willRetry
          ? `Retrying after error: ${input.message}`
          : input.message,
        ...(input.willRetry
          ? { queued_at: new Date() }
          : { processing_completed_at: new Date() }),
        ...(input.generationTarget
          ? { generation_target_status: input.generationTarget }
          : {}),
      },
    }
  );

  if (generationToken && result.matchedCount !== 1) {
    return { reconciled: false, supersededOrCompleted: true };
  }

  await setReportGenerationProgress({
    kind: "asset",
    reportId: input.reportId,
    progressId: input.progressId,
    generationToken: generationToken || undefined,
    executionToken: input.executionToken || undefined,
    stage: input.willRetry ? "queued" : "error",
    progressPercent: input.willRetry ? 1 : 100,
    message: input.willRetry
      ? `Retrying after error: ${input.message}`
      : input.message,
  });
  return { reconciled: result.matchedCount === 1, supersededOrCompleted: false };
}
