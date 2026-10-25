import mongoose, { Schema } from "mongoose";

// This collection is an observation ledger, not a draft, media backup or job.
// A deterministic primary key also makes creation/removal retry-safe before
// optional secondary indexes have been installed on an existing deployment.
const lotSchema = new Schema({
  id: { type: String, required: true },
  lotNumber: { type: String, default: "" },
  title: { type: String, default: "" },
  mainPhotoCount: { type: Number, required: true },
  extraPhotoCount: { type: Number, required: true },
  availablePhotoCount: { type: Number, required: true },
  missingPhotoCount: { type: Number, required: true },
}, { _id: false });

const schema = new Schema({
  _id: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  captureId: { type: String, required: true },
  schemaVersion: { type: Number, default: 1 },
  revision: { type: Number, required: true },
  contentHash: { type: String, select: false },
  installationHash: { type: String, select: false },
  deviceRegistration: { type: Schema.Types.ObjectId, ref: "DeviceRegistration", default: null },
  platform: { type: String, enum: ["android", "ios"] },
  appVersion: { type: String },
  reportType: { type: String, enum: ["asset", "lotListing"] },
  clientSubmissionId: { type: String, default: "" },
  contractNo: { type: String, default: "" },
  localStatus: { type: String, enum: ["saved", "paused", "discarded"] },
  deviceCreatedAt: { type: Date, default: null },
  deviceSavedAt: { type: Date, default: null },
  firstCapturedAt: { type: Date, default: null },
  lastCapturedAt: { type: Date, default: null },
  firstReceivedAt: { type: Date, required: true },
  lastReceivedAt: { type: Date, required: true },
  counts: {
    lotCount: Number,
    photoCount: Number,
    mainPhotoCount: Number,
    extraPhotoCount: Number,
    availablePhotoCount: Number,
    missingPhotoCount: Number,
  },
  lots: { type: [lotSchema], default: [] },
  // Removal redacts the observation but retains this minimal receipt so an old
  // offline client cannot resurrect discarded history after reconnecting.
  removedAt: { type: Date, default: null },
  removedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, select: false },
}, { versionKey: false });

schema.index({ user: 1, removedAt: 1, lastReceivedAt: -1, _id: -1 });
schema.index({ removedAt: 1, lastReceivedAt: -1, _id: -1 });
schema.index({ user: 1, reportType: 1, clientSubmissionId: 1 });

export default mongoose.models.CaptureInventory || mongoose.model("CaptureInventory", schema);
