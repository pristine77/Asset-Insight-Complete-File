import mongoose, { Document, Schema } from "mongoose";

export type ReleasedAppraisalAnalysisStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface IReleasedAppraisalAnalysis extends Document {
  reportId: mongoose.Types.ObjectId;
  fingerprint: string;
  status: ReleasedAppraisalAnalysisStatus;
  result?: Record<string, unknown>;
  jobId?: mongoose.Types.ObjectId | null;
  requestedBy?: mongoose.Types.ObjectId | null;
  modelName?: string;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ReleasedAppraisalAnalysisSchema =
  new Schema<IReleasedAppraisalAnalysis>(
    {
      reportId: {
        type: Schema.Types.ObjectId,
        ref: "AssetReport",
        required: true,
        index: true,
      },
      fingerprint: { type: String, required: true },
      status: {
        type: String,
        enum: ["queued", "processing", "completed", "failed"],
        required: true,
        default: "queued",
        index: true,
      },
      result: { type: Schema.Types.Mixed },
      jobId: { type: Schema.Types.ObjectId, ref: "ReportJob", default: null },
      requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      modelName: { type: String },
      error: { type: String, default: null },
      startedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
    },
    { timestamps: true }
  );

// A completed analysis remains immutable for a specific report snapshot. A
// changed report produces a new fingerprint and therefore a new cache row.
ReleasedAppraisalAnalysisSchema.index(
  { reportId: 1, fingerprint: 1 },
  { unique: true }
);
ReleasedAppraisalAnalysisSchema.index({ reportId: 1, createdAt: -1 });

const ReleasedAppraisalAnalysis = mongoose.model<IReleasedAppraisalAnalysis>(
  "ReleasedAppraisalAnalysis",
  ReleasedAppraisalAnalysisSchema
);

export default ReleasedAppraisalAnalysis;
