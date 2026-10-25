import mongoose, { Document, Schema } from "mongoose";

export interface IApkRelease extends Document {
  platform: "android";
  versionName: string;
  versionCode: number;
  releaseNotes?: string;
  mandatory: boolean;
  apkUrl: string;
  apkKey: string;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
  sha256: string;
  sizeBytes: number;
  originalName?: string;
  uploadedBy?: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const apkReleaseSchema = new Schema<IApkRelease>(
  {
    platform: {
      type: String,
      enum: ["android"],
      default: "android",
      required: true,
      index: true,
    },
    versionName: { type: String, required: true, trim: true },
    versionCode: { type: Number, required: true, min: 1, index: true },
    releaseNotes: { type: String, default: "", trim: true },
    mandatory: { type: Boolean, default: false },
    apkUrl: { type: String, required: true },
    apkKey: { type: String, required: true },
    r2Bucket: { type: String, trim: true },
    r2PublicBaseUrl: { type: String, trim: true },
    sha256: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    originalName: { type: String, default: "" },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

apkReleaseSchema.index({ platform: 1, versionCode: 1 }, { unique: true });
apkReleaseSchema.index({ platform: 1, isActive: 1, versionCode: -1 });

export default mongoose.models.ApkRelease ||
  mongoose.model<IApkRelease>("ApkRelease", apkReleaseSchema);
