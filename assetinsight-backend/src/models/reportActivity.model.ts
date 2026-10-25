import mongoose, { Schema } from "mongoose";

const activitySchema = new Schema({
  _id: { type: String, required: true },
  activityId: { type: String, required: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  reportType: { type: String, enum: ["asset", "lotListing"], required: true },
  contract: { type: String, default: "" },
  contracts: { type: [String], default: [] },
  reportId: { type: String, default: null },
  draftId: { type: String, default: null },
  captureId: { type: String, default: null },
  submissionId: { type: String, default: null },
  uploadSessionId: { type: String, default: null },
  source: { type: String, default: "unknown" },
  latestAction: String,
  latestOutcome: String,
  latestCounts: Schema.Types.Mixed,
  deviceSequences: { type: Schema.Types.Mixed, select: false, default: {} },
  lastReceivedAt: { type: Date, required: true },
  lastConfirmedAt: Date,
  revision: { type: Number, default: 0 },
  deleted: { type: Boolean, default: false },
  removedAt: { type: Date, default: null },
  removedBy: { type: Schema.Types.ObjectId, ref: "User", select: false },
}, { versionKey: false, timestamps: { createdAt: true, updatedAt: false } });
activitySchema.index({ removedAt: 1, lastReceivedAt: -1, _id: -1 });
activitySchema.index({ owner: 1, removedAt: 1, lastReceivedAt: -1 });
activitySchema.index({ contracts: 1, removedAt: 1, lastReceivedAt: -1 });
activitySchema.index({ reportId: 1 });

const eventSchema = new Schema({
  _id: { type: String, required: true },
  activity: { type: String, required: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
  actorRole: { type: String, default: "system" },
  eventId: { type: String, required: true },
  contentHash: { type: String, required: true, select: false },
  projected: { type: Boolean, default: false, select: false },
  authority: { type: String, enum: ["device", "server"], required: true },
  source: { type: String, required: true },
  action: { type: String, required: true },
  outcome: { type: String, required: true },
  observedAt: { type: Date, default: null },
  receivedAt: { type: Date, required: true },
  sequence: { type: Number, default: null },
  sequenceScope: { type: String, default: null },
  device: { type: String, default: null },
  appVersion: { type: String, default: null },
  data: { type: Schema.Types.Mixed, default: {} },
}, { versionKey: false });
eventSchema.index({ activity: 1, receivedAt: -1, _id: -1 });
eventSchema.index({ action: 1, outcome: 1, receivedAt: -1 });

// A deletion receipt survives the parent. Pending never means successfully deleted.
const deletionSchema = new Schema({
  _id: String, model: String, target: Schema.Types.ObjectId,
  stream: Schema.Types.Mixed, event: Schema.Types.Mixed,
  state: { type: String, enum: ["prepared", "claimed", "completed", "aborted"], default: "prepared" },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
deletionSchema.index({ state: 1, createdAt: 1 });

export const ReportActivity = mongoose.models.ReportActivity || mongoose.model("ReportActivity", activitySchema);
export const ReportActivityEvent = mongoose.models.ReportActivityEvent || mongoose.model("ReportActivityEvent", eventSchema);
export const ReportActivityDeletion = mongoose.models.ReportActivityDeletion || mongoose.model("ReportActivityDeletion", deletionSchema);
