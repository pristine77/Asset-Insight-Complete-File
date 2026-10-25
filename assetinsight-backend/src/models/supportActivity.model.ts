import mongoose, { Schema } from "mongoose";

export const SUPPORT_ACTIVITY_TYPES = [
  "conversation_created",
  "message_sent",
  "internal_note_added",
  "attachment_confirmed",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "todo_created",
  "todo_updated",
] as const;

const supportActivitySchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    type: { type: String, enum: SUPPORT_ACTIVITY_TYPES, required: true, index: true },
    visibleToUser: { type: Boolean, default: false, required: true },
    summary: { type: String, required: true, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

supportActivitySchema.index({ conversation: 1, createdAt: -1, _id: -1 });
supportActivitySchema.index({ conversation: 1, _id: -1 });
supportActivitySchema.index({ type: 1, createdAt: -1 });

const SupportActivity = mongoose.model("SupportActivity", supportActivitySchema);

export default SupportActivity;
