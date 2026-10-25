import mongoose, { Schema } from "mongoose";
import {
  SUPPORT_SENDER_ROLES,
  supportDiagnosticsSchema,
} from "./supportConversation.model.js";

export const SUPPORT_MESSAGE_TYPES = ["message", "internal_note", "system"] as const;

const supportMessageSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    senderRole: { type: String, enum: SUPPORT_SENDER_ROLES, required: true },
    type: { type: String, enum: SUPPORT_MESSAGE_TYPES, default: "message", required: true },
    visibleToUser: { type: Boolean, default: true, required: true, index: true },
    body: { type: String, default: "", maxlength: 12000 },
    diagnostics: { type: supportDiagnosticsSchema, default: undefined },
    attachments: [{ type: Schema.Types.ObjectId, ref: "SupportAttachment" }],
    clientMessageId: { type: String, maxlength: 120 },
  },
  { timestamps: true }
);

supportMessageSchema.index({ conversation: 1, _id: -1 });
supportMessageSchema.index({ conversation: 1, visibleToUser: 1, _id: -1 });
supportMessageSchema.index(
  { conversation: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: "string" } },
  }
);

const SupportMessage = mongoose.model("SupportMessage", supportMessageSchema);

export default SupportMessage;
