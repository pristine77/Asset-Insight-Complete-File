import mongoose, { Document, Schema } from "mongoose";

export type ReportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export const REPORT_JOB_TYPES = [
  "asset-preview",
  "asset-preview-files",
  "asset-excel-cr-files",
  "lot-listing-preview",
  "lot-listing-files",
  "lot-listing-excel-cr-files",
  "salvage-preview",
  "salvage-files",
  "crm-import",
  "smart-upload-classify",
  "report-media-delete",
  "auctioneer-delivery",
  "released-appraisal-analysis",
] as const;

export type ReportJobType = (typeof REPORT_JOB_TYPES)[number];

export type ReportProgressStage =
  | "queued"
  | "uploading"
  | "classifying_upload"
  | "analyzing"
  | "building_preview"
  | "generating_files"
  | "awaiting_approval"
  | "awaiting_release"
  | "ready"
  | "error";

export type ReportJobProgress = {
  phase?: "upload" | "processing" | "done" | "error";
  stage?: ReportProgressStage;
  progressPercent?: number;
  currentLot?: number;
  totalLots?: number;
  updatedAt?: string;
  serverProgress01?: number;
  steps?: Array<{
    key: string;
    label: string;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  message?: string;
  result?: {
    reportId?: string;
    reportType?: string;
    status?: string;
  };
};

export interface IReportJob extends Document {
  type: ReportJobType;
  status: ReportJobStatus;
  priority: number;
  reportId?: string;
  progressId?: string;
  dedupeKey?: string;
  idempotencyKey?: string;
  payload: Record<string, any>;
  progress?: ReportJobProgress;
  attempts: number;
  maxAttempts: number;
  lockedBy?: string;
  executionToken?: string;
  leaseUntil?: Date;
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  targetStatus?: "preview" | "pending_approval" | "approved";
  failureNotificationSentAt?: Date;
  timings?: Record<string, any>;
}

const ReportJobSchema = new Schema<IReportJob>(
  {
    type: {
      type: String,
      // Runtime validation and the TypeScript union intentionally share one
      // source of truth so new durable job types cannot drift between layers.
      enum: REPORT_JOB_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      default: "queued",
      required: true,
      index: true,
    },
    priority: { type: Number, default: 0, index: true },
    reportId: { type: String, index: true },
    progressId: { type: String, index: true },
    dedupeKey: { type: String },
    idempotencyKey: { type: String },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
    progress: { type: Schema.Types.Mixed, default: undefined },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    lockedBy: { type: String },
    executionToken: { type: String },
    leaseUntil: { type: Date, index: true },
    queuedAt: { type: Date, default: Date.now, index: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    lastError: { type: String },
    targetStatus: {
      type: String,
      enum: ["preview", "pending_approval", "approved"],
    },
    failureNotificationSentAt: { type: Date },
    timings: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

ReportJobSchema.index({ status: 1, priority: -1, queuedAt: 1 });
ReportJobSchema.index({ progressId: 1, createdAt: -1 });
ReportJobSchema.index({ reportId: 1, type: 1, createdAt: -1 });
ReportJobSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  }
);
ReportJobSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

const ReportJob = mongoose.model<IReportJob>("ReportJob", ReportJobSchema);

export default ReportJob;
