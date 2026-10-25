import mongoose, { Schema } from "mongoose";

export const ANNOUNCEMENT_AUDIENCES = ["all", "crm", "selected"] as const;
export const ANNOUNCEMENT_STATUSES = [
  "queued",
  "sending",
  "completed",
  "partial",
  "failed",
] as const;

const announcementSchema = new Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    heading: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 10_000 },
    audience: {
      type: String,
      enum: ANNOUNCEMENT_AUDIENCES,
      required: true,
      default: "all",
      index: true,
    },
    selectedUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    requestId: { type: String, required: true, trim: true, maxlength: 100 },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ANNOUNCEMENT_STATUSES,
      required: true,
      default: "queued",
      index: true,
    },
    recipientCount: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    failedCount: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true }
);

announcementSchema.index({ createdBy: 1, requestId: 1 }, { unique: true });
announcementSchema.index({ status: 1, createdAt: 1 });

const Announcement = mongoose.model("Announcement", announcementSchema);

export default Announcement;
