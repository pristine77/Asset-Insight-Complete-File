import mongoose, { Schema } from "mongoose";

// Backup credentials cannot authenticate to the ordinary report/auth APIs.
// One active credential per approved installation; no raw credential is stored.
const grantSchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, required: true },
  device: { type: Schema.Types.ObjectId, required: true },
  sessionVersion: { type: Number, required: true },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });
grantSchema.index({ tokenHash: 1 }, { unique: true });

// Objects are immutable and shared by revisions of this same owner/device/capture.
// Neither a plan replacement nor completion deletes any stored or local original.
const objectSchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, required: true },
  device: { type: Schema.Types.ObjectId, required: true },
  captureId: { type: String, required: true },
  sha256: { type: String, required: true },
  size: { type: Number, required: true },
  mimeType: { type: String, required: true },
  r2Key: { type: String, required: true },
  r2Bucket: { type: String, required: true },
  verifiedAt: Date,
  verifiedSize: Number,
  verifiedSha256: String,
}, { timestamps: true, versionKey: false });

const planSchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, required: true },
  device: { type: Schema.Types.ObjectId, required: true },
  clientDraftId: { type: String, required: true },
  captureId: { type: String, required: true },
  type: { type: String, enum: ["asset", "lotListing"], required: true },
  revision: { type: Number, required: true },
  contentHash: { type: String, required: true, select: false },
  contractNo: { type: String, default: "" },
  title: { type: String, default: "" },
  formData: { type: Schema.Types.Mixed, required: true },
  lots: { type: [Schema.Types.Mixed], required: true },
  media: { type: [Schema.Types.Mixed], required: true },
  activeLotIdx: { type: Number, default: 0 },
  completedAt: Date,
  // Same durable dispatcher/tombstone semantics as other Report Activity sources.
  activity_outbox: { type: [Schema.Types.Mixed], default: [], select: false },
}, { timestamps: true, versionKey: false });
planSchema.index({ user: 1, createdAt: -1, _id: -1 });
planSchema.index({ user: 1, device: 1, type: 1, clientDraftId: 1, revision: -1 });
planSchema.index({ "activity_outbox.0": 1 });

export const CaptureBackupGrant = mongoose.models.CaptureBackupGrant || mongoose.model("CaptureBackupGrant", grantSchema);
export const CaptureBackupObject = mongoose.models.CaptureBackupObject || mongoose.model("CaptureBackupObject", objectSchema);
export const CaptureBackupPlan = mongoose.models.CaptureBackupPlan || mongoose.model("CaptureBackupPlan", planSchema);
