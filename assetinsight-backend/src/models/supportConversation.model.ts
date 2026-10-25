import mongoose, { Schema } from "mongoose";

export const SUPPORT_CATEGORIES = ["error", "feature", "question", "other"] as const;
export const SUPPORT_SOURCES = ["web", "mobile"] as const;
export const SUPPORT_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
] as const;
export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const SUPPORT_SENDER_ROLES = ["user", "agent", "system"] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportSource = (typeof SUPPORT_SOURCES)[number];
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];
export type SupportSenderRole = (typeof SUPPORT_SENDER_ROLES)[number];

export type SupportDiagnostics = {
  appVersion?: string;
  buildNumber?: string;
  platform?: string;
  osVersion?: string;
  deviceModel?: string;
  screen?: string;
  route?: string;
  errorCode?: string;
  errorMessage?: string;
  stack?: string;
  occurredAt?: Date;
};

const diagnosticsSchema = new Schema<SupportDiagnostics>(
  {
    appVersion: { type: String, maxlength: 80 },
    buildNumber: { type: String, maxlength: 80 },
    platform: { type: String, maxlength: 40 },
    osVersion: { type: String, maxlength: 120 },
    deviceModel: { type: String, maxlength: 160 },
    screen: { type: String, maxlength: 200 },
    route: { type: String, maxlength: 300 },
    errorCode: { type: String, maxlength: 160 },
    errorMessage: { type: String, maxlength: 4000 },
    stack: { type: String, maxlength: 12000 },
    occurredAt: { type: Date },
  },
  { _id: false }
);

const supportConversationSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    category: {
      type: String,
      enum: SUPPORT_CATEGORIES,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: SUPPORT_SOURCES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: SUPPORT_STATUSES,
      default: "open",
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
    assignee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    diagnostics: { type: diagnosticsSchema, default: undefined },
    lastMessagePreview: { type: String, default: "", maxlength: 280 },
    lastMessageAt: { type: Date, default: Date.now, required: true, index: true },
    lastMessageBy: {
      type: String,
      enum: SUPPORT_SENDER_ROLES,
      default: "user",
      required: true,
    },
    userUnreadCount: { type: Number, default: 0, min: 0 },
    agentUnreadCount: { type: Number, default: 0, min: 0 },
    messageCount: { type: Number, default: 0, min: 0 },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// These compound indexes match the customer inbox, unassigned queue and an
// individual agent's work queue without requiring in-memory sorting.
supportConversationSchema.index({ user: 1, lastMessageAt: -1, _id: -1 });
supportConversationSchema.index({ status: 1, lastMessageAt: -1, _id: -1 });
supportConversationSchema.index({ status: 1, priority: -1, lastMessageAt: -1, _id: -1 });
supportConversationSchema.index({ assignee: 1, status: 1, lastMessageAt: -1, _id: -1 });
supportConversationSchema.index({ category: 1, status: 1, createdAt: -1 });

const SupportConversation = mongoose.model("SupportConversation", supportConversationSchema);

export default SupportConversation;
export { diagnosticsSchema as supportDiagnosticsSchema };
