import mongoose, { Document, Schema } from "mongoose";

export type ReportSubmissionAdmissionType = "asset" | "lotListing";

export interface IReportSubmissionAdmission extends Document {
  key: string;
  reportType: ReportSubmissionAdmissionType;
  user: mongoose.Types.ObjectId;
  contractClaim: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReportSubmissionAdmissionSchema =
  new Schema<IReportSubmissionAdmission>(
    {
      key: { type: String, required: true, unique: true, select: false },
      reportType: {
        type: String,
        enum: ["asset", "lotListing"],
        required: true,
      },
      user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      contractClaim: { type: String, required: true, select: false },
      token: { type: String, required: true, select: false },
      expiresAt: { type: Date, required: true, select: false },
    },
    { timestamps: true },
  );

// TTL is crash recovery only. Admission code also performs an atomic expired
// takeover because Mongo's TTL monitor intentionally runs asynchronously.
ReportSubmissionAdmissionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "report_submission_admission_expiry" },
);
ReportSubmissionAdmissionSchema.index(
  { reportType: 1, user: 1, updatedAt: -1 },
  { name: "report_submission_admission_diagnostics" },
);

const ReportSubmissionAdmission =
  mongoose.models.ReportSubmissionAdmission ||
  mongoose.model<IReportSubmissionAdmission>(
    "ReportSubmissionAdmission",
    ReportSubmissionAdmissionSchema,
  );

export default ReportSubmissionAdmission as mongoose.Model<IReportSubmissionAdmission>;
