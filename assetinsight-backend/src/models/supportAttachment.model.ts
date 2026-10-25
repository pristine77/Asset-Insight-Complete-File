import mongoose, { Schema } from "mongoose";
import { SUPPORT_SENDER_ROLES } from "./supportConversation.model.js";

export const SUPPORT_ATTACHMENT_TYPES = ["image", "video"] as const;
export const SUPPORT_ATTACHMENT_STATUSES = [
  "pending",
  "ready",
  "rejected",
  "deleting",
] as const;

const supportAttachmentSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    uploader: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    uploaderRole: { type: String, enum: SUPPORT_SENDER_ROLES, required: true },
    message: {
      type: Schema.Types.ObjectId,
      ref: "SupportMessage",
      default: null,
      index: true,
    },
    type: { type: String, enum: SUPPORT_ATTACHMENT_TYPES, required: true },
    status: {
      type: String,
      enum: SUPPORT_ATTACHMENT_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    key: { type: String, required: true, unique: true },
    url: { type: String, default: null },
    r2Bucket: { type: String, trim: true },
    r2PublicBaseUrl: { type: String, trim: true },
    originalName: { type: String, required: true, maxlength: 240 },
    contentType: { type: String, required: true, maxlength: 120 },
    declaredSizeBytes: { type: Number, required: true, min: 1 },
    verifiedSizeBytes: { type: Number, default: null, min: 1 },
    uploadExpiresAt: { type: Date, required: true, index: true },
    completedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },
    cleanupStartedAt: { type: Date, default: null, index: true },
    cleanupPreviousStatus: {
      type: String,
      enum: ["pending", "ready", "rejected"],
      default: null,
    },
    cleanupAttempts: { type: Number, default: 0, min: 0 },
    cleanupError: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true }
);

supportAttachmentSchema.index({ conversation: 1, status: 1, createdAt: -1 });
supportAttachmentSchema.index({ conversation: 1, uploader: 1, status: 1, uploadExpiresAt: 1 });
supportAttachmentSchema.index({ uploader: 1, status: 1, uploadExpiresAt: 1 });
supportAttachmentSchema.index({ status: 1, message: 1, completedAt: 1, uploadExpiresAt: 1 });

const SupportAttachment = mongoose.model("SupportAttachment", supportAttachmentSchema);

export default SupportAttachment;
