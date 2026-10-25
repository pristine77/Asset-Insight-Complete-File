import mongoose, { Schema } from "mongoose";

// A capability authorizes only the saved upload session, not the user's other APIs.
const grantSchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, required: true },
  device: { type: Schema.Types.ObjectId, required: true },
  sessionVersion: { type: Number, required: true },
  sessionId: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ["asset", "lotListing"], required: true },
  snapshotHash: { type: String, required: true, select: false },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  activity_outbox: { type: [Schema.Types.Mixed], default: [], select: false },
}, { timestamps: true, versionKey: false });
grantSchema.index({ tokenHash: 1 }, { unique: true });
grantSchema.index({ "activity_outbox.0": 1 });

// This intent is saved before returning a grant. Recovery confirms the exact
// report/job acceptance before creating the owner notification. Channels have
// independent receipts; an uncertain email never prevents the durable inbox.
const deliverySchema = new Schema({
  _id: String,
  user: { type: Schema.Types.ObjectId, required: true },
  sessionId: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ["asset", "lotListing"], required: true },
  state: { type: String, enum: ["waiting", "accepted", "unavailable", "complete"], default: "waiting" },
  nextCheckAt: { type: Date, default: Date.now },
  readyAt: Date,
  waitingChecks: { type: Number, default: 0 },
  acceptedAt: Date,
  reportId: String,
  recipient: { type: String, select: false },
  contract: String,
  inboxSentAt: Date,
  emailState: { type: String, enum: ["pending", "sending", "sent", "uncertain"], default: "pending" },
  emailAttemptedAt: Date,
  emailSentAt: Date,
  providerMessageId: { type: String, select: false },
}, { timestamps: true, versionKey: false });
deliverySchema.index({ state: 1, nextCheckAt: 1 });
deliverySchema.index({ state: 1, readyAt: -1, nextCheckAt: 1 });

export const ReportTransferGrant = mongoose.models.ReportTransferGrant || mongoose.model("ReportTransferGrant", grantSchema);
export const ReportTransferDelivery = mongoose.models.ReportTransferDelivery || mongoose.model("ReportTransferDelivery", deliverySchema);
