import type { ReportJobType } from "../../models/reportJob.model.js";
import { runAuctioneerDeliveryJob } from "../../service/auctioneer2DeliveryService.js";
import { runReleasedAppraisalAnalysisJob } from "../../service/releasedAppraisalAnalysisService.js";
import { runReportImageDeletionJob } from "../../utils/reportImageDeletion.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";

export const platformJobHandlers = {
  "report-media-delete": runReportImageDeletionJob,
  "auctioneer-delivery": async (job) => {
    const workItemId = String(job.payload?.workItemId || "");
    if (!workItemId) {
      throw new Error("Auctioneer delivery job is missing its work item ID.");
    }
    await runAuctioneerDeliveryJob(workItemId);
  },
  "released-appraisal-analysis": runReleasedAppraisalAnalysisJob,
} satisfies Partial<Record<ReportJobType, ReportJobHandler>>;
