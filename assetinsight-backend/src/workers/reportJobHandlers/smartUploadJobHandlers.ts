import ReportUploadSession from "../../models/reportUploadSession.model.js";
import type { ReportJobType } from "../../models/reportJob.model.js";
import { classifySmartUploadSession } from "../../service/smartUploadGroupingService.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";

export const smartUploadJobHandlers = {
  "smart-upload-classify": async (job, executionContext) => {
    const sessionId = String(job.payload?.sessionId || "");
    if (!sessionId) throw new Error("smart-upload-classify job missing sessionId");

    const classificationJobId = String(
      job.payload?.classificationJobId || job._id
    );
    const classificationRevision = Number.isFinite(
      Number(job.payload?.classificationRevision)
    )
      ? Number(job.payload?.classificationRevision)
      : 0;

    try {
      await classifySmartUploadSession(
        sessionId,
        String(job.payload?.progressId || job.progressId || ""),
        {
          classificationJobId,
          revision: classificationRevision,
        },
        executionContext,
      );
    } catch (error) {
      await executionContext?.assertOwned();
      // A delayed worker failure must not roll a review-ready/confirmed (or
      // manually corrected) grouping back to classifying/failed. Only the
      // currently assigned classification job may record its own failure.
      await ReportUploadSession.findOneAndUpdate(
        {
          _id: sessionId,
          "smartGrouping.status": "classifying",
          "smartGrouping.classificationJobId": classificationJobId,
          "smartGrouping.revision": classificationRevision,
        },
        {
          $set: {
            "smartGrouping.status":
              job.attempts < job.maxAttempts ? "classifying" : "failed",
            "smartGrouping.error":
              error instanceof Error ? error.message : String(error),
          },
        }
      );
      throw error;
    }
  },
} satisfies Partial<Record<ReportJobType, ReportJobHandler>>;
