import { runAssetPreviewJob } from "../../jobs/assetReportJob/previewJob.js";
import { runPreviewFilesJob } from "../../jobs/assetReportJob/previewFilesJob.js";
import type { AssetJobInput } from "../../jobs/assetReportJob/types.js";
import { runExcelCrRegenerationJob } from "../../jobs/excelCrRegenerationJob.js";
import ReportUploadSession from "../../models/reportUploadSession.model.js";
import type { ReportJobType } from "../../models/reportJob.model.js";
import { deserializeMulterFiles } from "../../utils/multerFileSerialization.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";
import { updateDraftPreviewLifecycle } from "../../service/reportDraftPreviewLifecycleService.js";
import { verifyInitialAuctioneerRetrySources } from "../../service/auctioneerInitialPreviewRetryService.js";

export const assetReportJobHandlers = {
  "asset-preview": async (job, context) => {
    const payload = (job.payload || {}) as Partial<AssetJobInput>;
    const draftId = String((payload.details as any)?.source_draft_id || "");
    const draftRevision = Number((payload.details as any)?.source_draft_revision);
    const progressId = String(job.progressId || payload.progressId || "");
    if ((payload.details as any)?.draft_preview && draftId) {
      await context.assertOwned();
      await updateDraftPreviewLifecycle(draftId, draftRevision, progressId, {
        status: "processing",
        reportId: String(job.reportId || payload.reportId || ""),
      });
    }
    try {
      await verifyInitialAuctioneerRetrySources(job, context);
      await runAssetPreviewJob(
        {
          reportId: payload.reportId || job.reportId,
          user: payload.user as AssetJobInput["user"],
          images: deserializeMulterFiles((payload as any).images),
          videos: deserializeMulterFiles((payload as any).videos),
          details: payload.details || {},
          progressId: payload.progressId || job.progressId,
        },
        {
          executionContext: context,
          deferSourceFileCleanup: true,
          willRetryOnError: job.attempts < job.maxAttempts,
        }
      );
      await context.assertOwned();
      if (job.reportId) {
        await ReportUploadSession.updateMany(
          { reportId: String(job.reportId), type: "asset" },
          {
            $set: { status: "processed", lastError: undefined },
            $unset: { activeContractClaim: 1 },
          }
        );
      }
      if ((payload.details as any)?.draft_preview && draftId) {
        await updateDraftPreviewLifecycle(draftId, draftRevision, progressId, {
          status: "ready",
          reportId: String(job.reportId || payload.reportId || ""),
          processedRevision: draftRevision,
        });
      }
    } catch (error) {
      if (
        context.signal.aborted ||
        [
          "REPORT_JOB_OWNERSHIP_LOST",
          "ASSET_PREVIEW_EXECUTION_OWNERSHIP_LOST",
        ].includes(String((error as any)?.code || ""))
      ) {
        throw error;
      }
      // Do not let a lease loss between the worker error and reconciliation
      // project stale session/draft state onto the reclaimed attempt.
      await context.assertOwned();
      if (job.reportId) {
        const willRetry = job.attempts < job.maxAttempts;
        await ReportUploadSession.updateMany(
          { reportId: String(job.reportId), type: "asset" },
          {
            $set: {
              status: willRetry ? "queued" : "failed",
              lastError:
                error instanceof Error ? error.message : String(error),
            },
            ...(willRetry
              ? {}
              : { $unset: { activeContractClaim: 1 } }),
          }
        );
      }
      if ((payload.details as any)?.draft_preview && draftId) {
        const willRetry = job.attempts < job.maxAttempts;
        await updateDraftPreviewLifecycle(draftId, draftRevision, progressId, {
          status: willRetry ? "queued" : "error",
          reportId: String(job.reportId || payload.reportId || ""),
          error: willRetry ? undefined : error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  },

  "asset-preview-files": async (job, context) => {
    const reportId = String(job.reportId || job.payload?.reportId || "");
    if (!reportId) throw new Error("asset-preview-files job missing reportId");
    await runPreviewFilesJob(reportId, {
      previewDataSnapshot: job.payload?.previewDataSnapshot,
      approveAfterGeneration: job.payload?.approveAfterGeneration === true,
      targetStatus: job.targetStatus || job.payload?.targetStatus,
      generationToken: String(
        job.payload?.generationToken || job.progressId || ""
      ),
      executionContext: context,
      willRetryOnError: job.attempts < job.maxAttempts,
    });
  },

  "asset-excel-cr-files": async (job, context) => {
    const reportId = String(job.reportId || job.payload?.reportId || "");
    if (!reportId) throw new Error("asset-excel-cr-files job missing reportId");
    await runExcelCrRegenerationJob({
      kind: "asset",
      reportId,
      generationToken: String(
        job.payload?.generationToken || job.progressId || ""
      ),
      executionContext: context,
    });
  },
} satisfies Partial<Record<ReportJobType, ReportJobHandler>>;
