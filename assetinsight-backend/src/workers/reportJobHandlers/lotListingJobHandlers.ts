import {
  runLotListingJob,
  runRegenerateLotListingJob,
  type LotListingJobInput,
  type RegenerateLotListingInput,
} from "../../jobs/lotListingJob.js";
import { runExcelCrRegenerationJob } from "../../jobs/excelCrRegenerationJob.js";
import ReportUploadSession from "../../models/reportUploadSession.model.js";
import type { ReportJobType } from "../../models/reportJob.model.js";
import { deserializeMulterFiles } from "../../utils/multerFileSerialization.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";
import { updateDraftPreviewLifecycle } from "../../service/reportDraftPreviewLifecycleService.js";
import { verifyInitialAuctioneerRetrySources } from "../../service/auctioneerInitialPreviewRetryService.js";

export const lotListingJobHandlers = {
  "lot-listing-preview": async (job, context) => {
    const payload = (job.payload || {}) as Partial<LotListingJobInput>;
    const draftId = String((payload.details as any)?.source_draft_id || "");
    const draftRevision = Number((payload.details as any)?.source_draft_revision);
    const progressId = String(job.progressId || payload.progressId || "");
    await context.assertOwned();
    if ((payload.details as any)?.draft_preview && draftId) {
      await updateDraftPreviewLifecycle(draftId, draftRevision, progressId, {
        status: "processing",
        reportId: String(job.reportId || payload.listingId || ""),
      });
    }
    try {
      await verifyInitialAuctioneerRetrySources(job, context);
      await runLotListingJob({
        listingId: payload.listingId || job.reportId,
        user: payload.user as LotListingJobInput["user"],
        images: deserializeMulterFiles((payload as any).images),
        videos: deserializeMulterFiles((payload as any).videos),
        details: payload.details as LotListingJobInput["details"],
        progressId: payload.progressId || job.progressId,
        executionContext: context,
        deferSourceFileCleanup: true,
        willRetryOnError: job.attempts < job.maxAttempts,
      });
      await context.assertOwned();
      if (job.reportId) {
        await ReportUploadSession.updateMany(
          { reportId: String(job.reportId), type: "lotListing" },
          {
            $set: { status: "processed", lastError: undefined },
            $unset: { activeContractClaim: 1 },
          }
        );
      }
      if ((payload.details as any)?.draft_preview && draftId) {
        await updateDraftPreviewLifecycle(draftId, draftRevision, progressId, {
          status: "ready",
          reportId: String(job.reportId || payload.listingId || ""),
          processedRevision: draftRevision,
        });
      }
    } catch (error) {
      // A reclaimed attempt must not overwrite the winner's upload-session or
      // draft-preview lifecycle. Queue failure reconciliation owns the retry.
      await context.assertOwned();
      if (job.reportId) {
        const willRetry = job.attempts < job.maxAttempts;
        await ReportUploadSession.updateMany(
          { reportId: String(job.reportId), type: "lotListing" },
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
          reportId: String(job.reportId || payload.listingId || ""),
          error: willRetry ? undefined : error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  },

  "lot-listing-files": async (job, context) => {
    const payload = (job.payload || {}) as Partial<RegenerateLotListingInput>;
    const listingId = String(payload.listingId || job.reportId || "");
    if (!listingId) throw new Error("lot-listing-files job missing listingId");
    await runRegenerateLotListingJob({
      listingId,
      user: payload.user as RegenerateLotListingInput["user"],
      generationToken: String(
        payload.generationToken || payload.jobId || job.progressId || ""
      ),
      // Keep accepting the legacy field while old queued jobs drain.
      jobId: payload.jobId,
      previewDataSnapshot: payload.previewDataSnapshot,
      executionContext: context,
      willRetryOnError: job.attempts < job.maxAttempts,
    });
  },

  "lot-listing-excel-cr-files": async (job, context) => {
    const reportId = String(job.reportId || job.payload?.reportId || "");
    if (!reportId) {
      throw new Error("lot-listing-excel-cr-files job missing reportId");
    }
    await runExcelCrRegenerationJob({
      kind: "lotListing",
      reportId,
      generationToken: String(
        job.payload?.generationToken || job.progressId || ""
      ),
      executionContext: context,
    });
  },
} satisfies Partial<Record<ReportJobType, ReportJobHandler>>;
