import dotenv from "dotenv";
import mongoose from "mongoose";
import { runReportWorkerProcess } from "./bootstrap/reportWorkerProcess.js";
import connectDB from "./config/database.js";
import { startMongoReportWorker } from "./utils/reportJobMongoQueue.js";
import { startSmartUploadSessionMaintenance } from "./utils/smartUploadSessionMaintenance.js";
import { reportJobHandlers } from "./workers/reportJobHandlers/index.js";
import { assertValidR2StorageConfiguration } from "./utils/r2Storage/r2Upload.js";
import { startYoutubePublicationMaintenance } from "./service/youtubeVideoService.js";
import { startYoutubeDataLifecycleMaintenance } from "./service/youtubeDataLifecycleService.js";

dotenv.config();

process.env.REPORT_PROCESS_ROLE = process.env.REPORT_PROCESS_ROLE || "worker";
process.env.REPORT_QUEUE_BACKEND = process.env.REPORT_QUEUE_BACKEND || "mongo";

// Workers read legacy sources but may publish only to the current generation.
// Fail before claiming jobs if a partial cutover makes those namespaces unsafe.
assertValidR2StorageConfiguration();

void runReportWorkerProcess({
  connectDB,
  disconnectDB: () => mongoose.disconnect(),
  startMaintenance: startSmartUploadSessionMaintenance,
  runWorker: async (signal) => {
    const drainYoutube = startYoutubePublicationMaintenance(signal);
    const drainYoutubeData = startYoutubeDataLifecycleMaintenance(signal);
    try { await startMongoReportWorker(reportJobHandlers, { signal }); }
    finally { await Promise.all([drainYoutube(), drainYoutubeData()]); }
  },
});
