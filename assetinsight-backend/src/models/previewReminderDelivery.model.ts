import mongoose, { Schema } from "mongoose";

// The deterministic primary key is the idempotency constraint. This collection
// needs no secondary unique-index migration before accepting reviewed sends.
const schema = new Schema({
  _id: { type: String, required: true },
  requestId: { type: String, required: true },
  reportId: { type: String, required: true },
  reportType: { type: String, enum: ["Asset", "LotListing"], required: true },
  actorId: { type: String, required: true },
  baseRevision: { type: String, required: true },
  contentHash: { type: String, required: true },
  contractNo: { type: String, default: "" },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  recipient: { type: Schema.Types.Mixed, required: true },
  reportError: { type: String, default: "" },
  correctionSteps: { type: [String], default: [] },
  affectedLots: { type: [String], default: [] },
  waitingSince: { type: Date, required: true },
  state: { type: String, enum: ["reserved", "processing", "sent", "uncertain", "rejected"], required: true },
  notificationId: { type: Schema.Types.ObjectId, required: true },
  notificationStatus: { type: String, enum: ["pending", "sent", "uncertain"], default: "pending" },
  providerMessageId: { type: String },
  sentAt: { type: Date },
  attemptedAt: { type: Date },
  errorCode: { type: String },
}, { timestamps: true });

export default mongoose.model("PreviewReminderDelivery", schema);
