import mongoose from "mongoose";

export const CRM_IMPORT_JOB_STATUSES = ["queued", "processing", "completed", "failed"] as const;

const crmImportJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    sourceBatchId: { type: String, required: true, index: true },
    sourceFileName: { type: String },
    sourceFileUrl: { type: String },
    sourceFileKey: { type: String },
    sourceFileBucket: { type: String, trim: true },
    sourceFilePublicBaseUrl: { type: String, trim: true },
    sourceSheetName: { type: String },
    fileType: { type: String, enum: ["xlsx", "xls", "csv"] },
    durableJobId: { type: mongoose.Schema.Types.ObjectId, ref: "ReportJob", index: true },
    status: { type: String, enum: CRM_IMPORT_JOB_STATUSES, default: "queued", index: true },
    totalRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    importedCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    message: { type: String },
    error: { type: String },
    selectedAssigneeIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    duplicateMode: { type: String, enum: ["skip", "error"], default: "skip" },
    defaultDueDate: { type: Date },
    dueDateOverrides: { type: mongoose.Schema.Types.Mixed, default: [] },
    duplicateRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

crmImportJobSchema.index({ createdAt: -1 });

const CrmImportJob = mongoose.model("CrmImportJob", crmImportJobSchema);

export default CrmImportJob;
