import mongoose, { Document, Schema } from "mongoose";

export type ReportUploadSessionType = "asset" | "lotListing";
export type ReportUploadSessionStatus =
  | "created"
  | "uploading"
  | "completed"
  | "queued"
  | "processed"
  | "failed";

export type SmartUploadGroupingStatus =
  | "uploading"
  | "classifying"
  | "review_ready"
  | "confirmed"
  | "failed";

export type SmartUploadGroup = {
  groupIndex: number;
  imageCount: number;
  fileIds: string[];
  coverFileId?: string;
  overLimit: boolean;
  lotNumber?: string;
};

export type SmartUploadGroupingMethod = "black_divider" | "lot_number";

export interface IReportUploadSession extends Document {
  type: ReportUploadSessionType;
  status: ReportUploadSessionStatus;
  user: mongoose.Types.ObjectId;
  reportId?: string;
  jobId: string;
  clientSubmissionId?: string;
  capture_id?: string;
  /** @deprecated Legacy same-contract admission field; cleared by deployment migration. */
  activeContractClaim?: string;
  supersedesClientSubmissionIds?: string[];
  manifestHash?: string;
  manifestVersion?: number;
  smartUpload?: boolean;
  smartGrouping?: {
    method?: SmartUploadGroupingMethod;
    status: SmartUploadGroupingStatus;
    progressPercent: number;
    revision?: number;
    algorithmVersion?: string;
    classificationJobId?: string;
    classificationExecutionToken?: string;
    orderSource?: "manifest" | "capture" | "manual" | "groups";
    orderReviewRequired?: boolean;
    unresolvedDividerIds?: string[];
    unresolvedLotNumberFileIds?: string[];
    dividerFileIds: string[];
    groups: SmartUploadGroup[];
    warnings: string[];
    metrics: Array<{
      fileId: string;
      meanLuminance?: number;
      darkPixelRatio?: number;
      variance?: number;
      isDivider: boolean;
      error?: string;
      kind?: "lot_start" | "photo" | "uncertain";
      lotNumber?: string | null;
    }>;
    error?: string;
    classifiedAt?: Date;
    confirmedAt?: Date;
  };
  details: Record<string, any>;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
  files: Array<{
    fileId: string;
    key: string;
    fieldname: "images" | "videos";
    originalname: string;
    mimetype: string;
    size?: number;
    lastModified?: number;
    lotIndex?: number;
    imageIndex?: number;
    captureTimestamp?: number;
    captureOrder?: number;
    originalOrder?: number;
    role?: "main" | "extra" | "video";
    uploadedAt?: Date;
    verifiedSize?: number;
  }>;
  expectedFileCount: number;
  expectedImageCount: number;
  expectedVideoCount: number;
  totalBytes: number;
  uploadStartedAt?: Date;
  uploadCompletedAt?: Date;
  /** Short lease fencing placeholder creation from session supersession. */
  finalizationClaimToken?: string;
  finalizationClaimedAt?: Date;
  queuedAt?: Date;
  cleanupStartedAt?: Date;
  continuationFreeze?: { reservationId: string; workItemId: string; snapshotHash: string };
  cleanupNotBefore?: Date;
  /** Background cleanup of excluded divider photos; never gates report acceptance. */
  dividerCleanupClaimToken?: string;
  dividerCleanupClaimedAt?: Date;
  dividerCleanupCompletedAt?: Date;
  dividerCleanupLastError?: string;
  supersededAt?: Date;
  supersededByClientSubmissionId?: string;
  lastError?: string;
}

const ReportUploadSessionSchema = new Schema<IReportUploadSession>(
  {
    type: {
      type: String,
      enum: ["asset", "lotListing"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["created", "uploading", "completed", "queued", "processed", "failed"],
      default: "created",
      index: true,
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reportId: { type: String, index: true },
    jobId: { type: String, required: true, index: true },
    clientSubmissionId: { type: String },
    capture_id: { type: String },
    activeContractClaim: { type: String, select: false },
    supersedesClientSubmissionIds: { type: [String], default: undefined },
    manifestHash: { type: String },
    manifestVersion: { type: Number },
    smartUpload: { type: Boolean, default: false, index: true },
    smartGrouping: {
      method: { type: String, enum: ["black_divider", "lot_number"] },
      status: {
        type: String,
        enum: ["uploading", "classifying", "review_ready", "confirmed", "failed"],
        default: "uploading",
      },
      progressPercent: { type: Number, default: 0 },
      revision: { type: Number, default: 0 },
      algorithmVersion: { type: String },
      classificationJobId: { type: String },
      classificationExecutionToken: { type: String, select: false },
      orderSource: {
        type: String,
        enum: ["manifest", "capture", "manual", "groups"],
      },
      orderReviewRequired: { type: Boolean },
      unresolvedDividerIds: { type: [String], default: undefined },
      unresolvedLotNumberFileIds: { type: [String], default: undefined },
      dividerFileIds: [{ type: String }],
      groups: [
        {
          groupIndex: { type: Number, required: true },
          imageCount: { type: Number, required: true },
          fileIds: [{ type: String }],
          coverFileId: { type: String },
          overLimit: { type: Boolean, default: false },
          lotNumber: { type: String },
        },
      ],
      warnings: [{ type: String }],
      metrics: [
        {
          fileId: { type: String, required: true },
          meanLuminance: { type: Number },
          darkPixelRatio: { type: Number },
          variance: { type: Number },
          isDivider: { type: Boolean, default: false },
          error: { type: String },
          kind: { type: String, enum: ["lot_start", "photo", "uncertain"] },
          lotNumber: { type: String, default: undefined },
        },
      ],
      error: { type: String },
      classifiedAt: { type: Date },
      confirmedAt: { type: Date },
    },
    details: { type: Schema.Types.Mixed, default: {} },
    // Snapshot the storage generation at session creation. Records created
    // before the R2 cutover intentionally have neither field and resolve to
    // the legacy, read-only target.
    r2Bucket: { type: String, trim: true },
    r2PublicBaseUrl: { type: String, trim: true },
    files: [
      {
        fileId: { type: String, required: true },
        key: { type: String, required: true },
        fieldname: { type: String, enum: ["images", "videos"], required: true },
        originalname: { type: String, required: true },
        mimetype: { type: String, required: true },
        size: { type: Number },
        lastModified: { type: Number },
        lotIndex: { type: Number },
        imageIndex: { type: Number },
        captureTimestamp: { type: Number },
        captureOrder: { type: Number },
        originalOrder: { type: Number },
        role: { type: String, enum: ["main", "extra", "video"] },
        uploadedAt: { type: Date },
        verifiedSize: { type: Number },
      },
    ],
    expectedFileCount: { type: Number, default: 0 },
    expectedImageCount: { type: Number, default: 0 },
    expectedVideoCount: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
    uploadStartedAt: { type: Date },
    uploadCompletedAt: { type: Date },
    finalizationClaimToken: { type: String, select: false },
    finalizationClaimedAt: { type: Date },
    queuedAt: { type: Date },
    cleanupStartedAt: { type: Date },
    continuationFreeze: { type: new Schema({ reservationId: String, workItemId: String, snapshotHash: String }, { _id: false }) },
    cleanupNotBefore: { type: Date },
    dividerCleanupClaimToken: { type: String, select: false },
    dividerCleanupClaimedAt: { type: Date, select: false },
    dividerCleanupCompletedAt: { type: Date, select: false },
    dividerCleanupLastError: { type: String, select: false },
    supersededAt: { type: Date },
    supersededByClientSubmissionId: { type: String },
    lastError: { type: String },
  },
  { timestamps: true }
);

ReportUploadSessionSchema.index({ status: 1, createdAt: -1 });
ReportUploadSessionSchema.index({ user: 1, createdAt: -1 });
ReportUploadSessionSchema.index({ reportId: 1, type: 1 });
ReportUploadSessionSchema.index({
  smartUpload: 1,
  status: 1,
  updatedAt: 1,
  cleanupStartedAt: 1,
});
ReportUploadSessionSchema.index(
  { type: 1, user: 1, clientSubmissionId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientSubmissionId: { $type: "string" } },
  }
);
ReportUploadSessionSchema.plugin(reportActivityPlugin, { model: "ReportUploadSession" });
const ReportUploadSession = mongoose.model<IReportUploadSession>(
  "ReportUploadSession",
  ReportUploadSessionSchema
);

export default ReportUploadSession;
import { reportActivityPlugin } from "../utils/reportActivityPlugin.js";
