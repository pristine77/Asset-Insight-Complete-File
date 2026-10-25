import type { ReportJobType } from "../../models/reportJob.model.js";
import type { ReportJobHandler } from "../../utils/reportJobMongoQueue.js";
import { assetReportJobHandlers } from "./assetReportJobHandlers.js";
import { crmImportJobHandlers } from "./crmImportJobHandlers.js";
import { lotListingJobHandlers } from "./lotListingJobHandlers.js";
import { platformJobHandlers } from "./platformJobHandlers.js";
import { smartUploadJobHandlers } from "./smartUploadJobHandlers.js";
import { runSalvagePreviewJob, runSalvageFilesJob } from "../../jobs/salvageReportJob.js";

/**
 * The complete durable-job dispatch table. The Record type deliberately makes
 * adding a ReportJobType a compile-time error until its worker is registered;
 * explicit keys prevent one domain map from silently overwriting another.
 */
export const reportJobHandlers = {
  "salvage-preview": runSalvagePreviewJob,
  "salvage-files": runSalvageFilesJob,
  "asset-preview": assetReportJobHandlers["asset-preview"],
  "asset-preview-files": assetReportJobHandlers["asset-preview-files"],
  "asset-excel-cr-files": assetReportJobHandlers["asset-excel-cr-files"],
  "lot-listing-preview": lotListingJobHandlers["lot-listing-preview"],
  "lot-listing-files": lotListingJobHandlers["lot-listing-files"],
  "lot-listing-excel-cr-files":
    lotListingJobHandlers["lot-listing-excel-cr-files"],
  "smart-upload-classify":
    smartUploadJobHandlers["smart-upload-classify"],
  "crm-import": crmImportJobHandlers["crm-import"],
  "report-media-delete": platformJobHandlers["report-media-delete"],
  "auctioneer-delivery": platformJobHandlers["auctioneer-delivery"],
  "released-appraisal-analysis":
    platformJobHandlers["released-appraisal-analysis"],
} satisfies Record<ReportJobType, ReportJobHandler>;
