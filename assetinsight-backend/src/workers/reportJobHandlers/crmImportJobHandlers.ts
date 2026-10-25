import { runDurableCrmImportJob } from "../../controller/crm.controller.js";
import CrmImportJob from "../../models/crmImportJob.model.js";
import type { ReportJobType } from "../../models/reportJob.model.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";

export const crmImportJobHandlers = {
  "crm-import": async (job) => {
    try {
      await runDurableCrmImportJob(job);
    } catch (error) {
      const willRetry = job.attempts < job.maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      await CrmImportJob.updateOne(
        { jobId: job.progressId },
        {
          $set: {
            status: willRetry ? "queued" : "failed",
            message: willRetry
              ? "Import interrupted; the worker will resume it automatically"
              : "CRM import failed",
            error: message,
            ...(willRetry ? {} : { completedAt: new Date() }),
          },
        }
      );
      throw error;
    }
  },
} satisfies Partial<Record<ReportJobType, ReportJobHandler>>;
