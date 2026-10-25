/**
 * Projects worker/job state into user-facing generation progress. Report flags remain
 * the compatibility source for older records, while durable job timestamps and errors
 * refine current progress when available; this avoids forcing controllers to understand
 * queue implementation details.
 */
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import type { ReportProgressStage } from "../models/reportJob.model.js";
import { updateMongoReportJobProgress } from "../utils/reportJobMongoQueue.js";

type ProgressUpdate = {
  kind: "asset" | "lotListing";
  reportId: string;
  progressId?: string;
  generationToken?: string;
  /** Per-claim queue ownership token. Omit for non-worker/controller updates. */
  executionToken?: string;
  stage: ReportProgressStage;
  progressPercent: number;
  message: string;
  currentLot?: number;
  totalLots?: number;
};

/** Persist one progress snapshot on both the report and its durable queue job. */
export async function setReportGenerationProgress(update: ProgressUpdate) {
  const progressPercent = Math.max(0, Math.min(100, update.progressPercent));
  const updatedAt = new Date();
  const snapshot = {
    stage: update.stage,
    progressPercent,
    message: update.message,
    ...(Number.isFinite(update.currentLot) ? { currentLot: update.currentLot } : {}),
    ...(Number.isFinite(update.totalLots) ? { totalLots: update.totalLots } : {}),
    updatedAt,
  };
  const reportFilter = {
    _id: update.reportId,
    ...(update.generationToken ? { job_id: update.generationToken } : {}),
    ...(update.executionToken
      ? { job_execution_token: update.executionToken }
      : {}),
  };
  // Progress advances must not erase controller-owned generation metadata such
  // as previousStatus or a preview fingerprint used to coalesce exact retries.
  const reportProgressUpdate = {
    $set: {
      "generation_progress.stage": snapshot.stage,
      "generation_progress.progressPercent": snapshot.progressPercent,
      "generation_progress.message": snapshot.message,
      "generation_progress.updatedAt": snapshot.updatedAt,
      ...(Number.isFinite(update.currentLot)
        ? { "generation_progress.currentLot": update.currentLot }
        : {}),
      ...(Number.isFinite(update.totalLots)
        ? { "generation_progress.totalLots": update.totalLots }
        : {}),
    },
    ...(!Number.isFinite(update.currentLot) || !Number.isFinite(update.totalLots)
      ? {
          $unset: {
            ...(!Number.isFinite(update.currentLot)
              ? { "generation_progress.currentLot": 1 }
              : {}),
            ...(!Number.isFinite(update.totalLots)
              ? { "generation_progress.totalLots": 1 }
              : {}),
          },
        }
      : {}),
  };
  const reportUpdate = update.kind === "lotListing"
    ? LotListing.findOneAndUpdate(reportFilter, reportProgressUpdate)
    : AssetReport.findOneAndUpdate(reportFilter, reportProgressUpdate);
  await Promise.all([
    reportUpdate,
    updateMongoReportJobProgress(update.progressId, {
      phase: update.stage === "ready" ? "done" : update.stage === "error" ? "error" : "processing",
      stage: update.stage,
      progressPercent,
      serverProgress01: progressPercent / 100,
      message: update.message,
      currentLot: update.currentLot,
      totalLots: update.totalLots,
    }),
  ]);
}
