import mongoose, { Schema } from "mongoose";
import { SUPPORT_PRIORITIES } from "./supportConversation.model.js";

export const SUPPORT_TODO_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;

const supportTodoSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    description: { type: String, default: "", maxlength: 4000 },
    status: {
      type: String,
      enum: SUPPORT_TODO_STATUSES,
      default: "todo",
      required: true,
      index: true,
    },
    priority: {
      type: String,
      enum: SUPPORT_PRIORITIES,
      default: "normal",
      required: true,
      index: true,
    },
    dueAt: { type: Date, default: null, index: true },
    assignee: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

supportTodoSchema.index({ conversation: 1, status: 1, createdAt: -1 });
supportTodoSchema.index({ assignee: 1, status: 1, dueAt: 1 });
supportTodoSchema.index({ status: 1, priority: -1, dueAt: 1 });

const SupportTodo = mongoose.model("SupportTodo", supportTodoSchema);

export default SupportTodo;
