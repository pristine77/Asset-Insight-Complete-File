import crypto from "crypto";
import mongoose from "mongoose";
import { Readable, Transform } from "node:stream";
import SupportActivity from "../models/supportActivity.model.js";
import SupportAttachment from "../models/supportAttachment.model.js";
import SupportConversation, {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_SOURCES,
  SUPPORT_STATUSES,
  type SupportDiagnostics,
  type SupportPriority,
  type SupportSenderRole,
  type SupportStatus,
} from "../models/supportConversation.model.js";
import SupportMessage from "../models/supportMessage.model.js";
import SupportTodo, { SUPPORT_TODO_STATUSES } from "../models/supportTodo.model.js";
import User from "../models/user.model.js";
import {
  createR2PresignedPutUrl,
  createR2StreamingUpload,
  deleteFromR2Strict,
  getCurrentR2StorageTarget,
  getR2PublicUrl,
  headR2Object,
  resolvePersistedR2StorageTarget,
  type R2StreamingUpload,
} from "../utils/r2Storage/r2Upload.js";
import {
  matchesSupportMediaSignature,
  supportMediaSignatureBytes,
} from "../utils/supportMediaSignature.js";

const MiB = 1024 * 1024;
const DEFAULT_IMAGE_LIMIT = 20 * MiB;
const DEFAULT_VIDEO_LIMIT = 250 * MiB;
const UPLOAD_TTL_SECONDS = 15 * 60;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_ACTIVE_PENDING_UPLOADS = 20;

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);

type ActorRole = "user" | "agent";
type ConversationAccess = { actorId: string; actorRole: ActorRole };

export class SupportApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SupportApiError";
  }
}

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const boundedString = (
  value: unknown,
  maxLength: number,
  field: string,
  required = false
): string => {
  const text = asString(value);
  if (required && !text) {
    throw new SupportApiError(400, "VALIDATION_ERROR", `${field} is required`);
  }
  if (text.length > maxLength) {
    throw new SupportApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be ${maxLength} characters or fewer`
    );
  }
  return text;
};

const requireObjectId = (value: unknown, field: string): string => {
  const id = asString(value);
  if (!mongoose.isValidObjectId(id)) {
    throw new SupportApiError(400, "VALIDATION_ERROR", `${field} is invalid`);
  }
  return id;
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T => {
  const normalized = asString(value) as T;
  if (!allowed.includes(normalized)) {
    throw new SupportApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be one of: ${allowed.join(", ")}`
    );
  }
  return normalized;
};

const optionalDate = (value: unknown, field: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new SupportApiError(400, "VALIDATION_ERROR", `${field} must be a valid date`);
  }
  return date;
};

const envPositiveInteger = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const activeSupportDeveloperFilter = (userId?: string): Record<string, unknown> => ({
  ...(userId ? { _id: userId } : {}),
  role: { $in: ["admin", "superadmin"] },
  canManageSupport: true,
  isBlocked: { $ne: true },
});

export function sanitizeSupportDiagnostics(value: unknown): SupportDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: SupportDiagnostics = {};
  const copy = (key: keyof SupportDiagnostics, maxLength: number) => {
    const text = asString(input[key]);
    if (text) (output as any)[key] = text.slice(0, maxLength);
  };

  copy("appVersion", 80);
  copy("buildNumber", 80);
  copy("platform", 40);
  copy("osVersion", 120);
  copy("deviceModel", 160);
  copy("screen", 200);
  copy("route", 300);
  copy("errorCode", 160);
  copy("errorMessage", 4000);
  copy("stack", 12000);

  const occurredAt =
    input.occurredAt instanceof Date ? input.occurredAt : asString(input.occurredAt);
  if (occurredAt) {
    const date = new Date(occurredAt);
    if (!Number.isNaN(date.getTime())) output.occurredAt = date;
  }
  return Object.keys(output).length ? output : undefined;
}

function attachmentLimits(contentType: string): { type: "image" | "video"; maxBytes: number } {
  if (IMAGE_CONTENT_TYPES.has(contentType)) {
    return {
      type: "image",
      maxBytes: envPositiveInteger("SUPPORT_MAX_IMAGE_BYTES", DEFAULT_IMAGE_LIMIT),
    };
  }
  if (VIDEO_CONTENT_TYPES.has(contentType)) {
    return {
      type: "video",
      maxBytes: envPositiveInteger("SUPPORT_MAX_VIDEO_BYTES", DEFAULT_VIDEO_LIMIT),
    };
  }
  throw new SupportApiError(
    415,
    "UNSUPPORTED_MEDIA_TYPE",
    "Only supported image and video files can be attached"
  );
}

function safeFileName(value: unknown): string {
  const originalName = boundedString(value, 240, "fileName", true);
  const normalized = originalName
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(-120);
  return normalized || "attachment";
}

function previewFor(body: string, attachments: number): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact) return compact.slice(0, 280);
  return attachments === 1 ? "Attachment" : `${attachments} attachments`;
}

function publicUser(value: any): { id: string; username: string | null; email: string | null } | null {
  if (!value) return null;
  if (typeof value === "string" || value instanceof mongoose.Types.ObjectId) {
    return { id: String(value), username: null, email: null };
  }
  return {
    id: String(value._id || value.id),
    username: value.username ? String(value.username) : null,
    email: value.email ? String(value.email) : null,
  };
}

export function supportAttachmentDto(value: any) {
  const ready = value?.status === "ready";
  return {
    id: String(value._id),
    type: value.type,
    originalName: value.originalName,
    contentType: value.contentType,
    sizeBytes: Number(value.declaredSizeBytes),
    ...(ready
      ? {
          verifiedSizeBytes: Number(value.verifiedSizeBytes),
          status: "ready" as const,
          url: String(value.url),
          completedAt: value.completedAt,
          createdAt: value.createdAt,
        }
      : {
          status: value.status,
          uploadExpiresAt: value.uploadExpiresAt,
        }),
  };
}

export function supportMessageDto(value: any) {
  return {
    id: String(value._id),
    conversationId: String(value.conversation?._id || value.conversation),
    sender: publicUser(value.sender),
    senderRole: value.senderRole,
    type: value.type === "internal_note" ? "internal_note" : value.type,
    body: String(value.body || ""),
    diagnostics: value.diagnostics || null,
    attachments: (value.attachments || [])
      .filter((item: any) => item && item.status === "ready")
      .map(supportAttachmentDto),
    createdAt: value.createdAt,
  };
}

/**
 * Requesters need message content and verified media, not staff identity or
 * diagnostic internals. The developer DTO remains richer behind the explicit
 * support capability gate.
 */
export function supportRequesterMessageDto(value: any) {
  const { sender: _sender, diagnostics: _diagnostics, ...message } =
    supportMessageDto(value);
  return message;
}

export function supportConversationDto(value: any) {
  return {
    id: String(value._id),
    subject: value.subject,
    category: value.category,
    source: value.source,
    status: value.status,
    priority: value.priority,
    user: publicUser(value.user),
    assignee: publicUser(value.assignee),
    lastMessage: value.lastMessageAt
      ? {
          preview: String(value.lastMessagePreview || ""),
          at: value.lastMessageAt,
          senderRole: value.lastMessageBy,
        }
      : null,
    unread: {
      user: Number(value.userUnreadCount || 0),
      agent: Number(value.agentUnreadCount || 0),
    },
    messageCount: Number(value.messageCount || 0),
    diagnostics: value.diagnostics || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * Keep queue-only metadata out of every ownership-scoped requester response.
 * This prevents admin requesters and ordinary customers from learning agent
 * assignment, agent unread state, workflow priority, or stored diagnostics.
 */
export function supportRequesterConversationDto(value: any) {
  const conversation = supportConversationDto(value);
  return {
    id: conversation.id,
    subject: conversation.subject,
    category: conversation.category,
    source: conversation.source,
    status: conversation.status,
    lastMessage: conversation.lastMessage,
    unread: { user: conversation.unread.user },
    messageCount: conversation.messageCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function supportTodoDto(value: any) {
  const conversation =
    value.conversation && typeof value.conversation === "object" && value.conversation.subject
      ? {
          id: String(value.conversation._id),
          subject: value.conversation.subject,
          category: value.conversation.category,
          status: value.conversation.status,
          priority: value.conversation.priority,
          user: publicUser(value.conversation.user),
        }
      : null;
  return {
    id: String(value._id),
    conversationId: String(value.conversation?._id || value.conversation),
    title: value.title,
    description: value.description || "",
    status: value.status,
    priority: value.priority,
    dueAt: value.dueAt || null,
    assignee: publicUser(value.assignee),
    createdBy: publicUser(value.createdBy),
    completedAt: value.completedAt || null,
    conversation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function supportActivityDto(value: any) {
  const conversation =
    value.conversation && typeof value.conversation === "object" && value.conversation.subject
      ? {
          id: String(value.conversation._id),
          subject: value.conversation.subject,
          category: value.conversation.category,
          status: value.conversation.status,
        }
      : null;
  return {
    id: String(value._id),
    conversationId: String(value.conversation?._id || value.conversation),
    actor: publicUser(value.actor),
    type: value.type,
    visibleToUser: Boolean(value.visibleToUser),
    summary: value.summary,
    metadata: value.metadata || {},
    conversation,
    createdAt: value.createdAt,
  };
}

async function populatedConversation(id: string) {
  return SupportConversation.findById(id)
    .populate("user", "username email")
    .populate("assignee", "username email")
    .lean();
}

async function populatedMessage(id: string) {
  return SupportMessage.findById(id)
    .populate("sender", "username email")
    .populate({ path: "attachments", match: { status: "ready" } })
    .lean();
}

async function requireConversationAccess(conversationId: unknown, access: ConversationAccess) {
  const id = requireObjectId(conversationId, "conversationId");
  const filter = access.actorRole === "user" ? { _id: id, user: access.actorId } : { _id: id };
  const conversation = await SupportConversation.findOne(filter).lean();
  if (!conversation) {
    throw new SupportApiError(404, "CONVERSATION_NOT_FOUND", "Support conversation not found");
  }
  return conversation as any;
}

async function recordActivity(input: {
  conversation: string | mongoose.Types.ObjectId;
  actor?: string | mongoose.Types.ObjectId | null;
  type: string;
  visibleToUser?: boolean;
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  await SupportActivity.create({
    conversation: input.conversation,
    actor: input.actor || null,
    type: input.type,
    visibleToUser: input.visibleToUser === true,
    summary: input.summary.slice(0, 500),
    metadata: input.metadata || {},
  });
}

function encodeConversationCursor(value: any): string {
  return Buffer.from(
    JSON.stringify({ at: new Date(value.lastMessageAt).toISOString(), id: String(value._id) })
  ).toString("base64url");
}

function decodeConversationCursor(value: unknown): { at: Date; id: mongoose.Types.ObjectId } | null {
  const cursor = asString(value);
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(parsed.id)) throw new Error();
    return { at, id: new mongoose.Types.ObjectId(parsed.id) };
  } catch {
    throw new SupportApiError(400, "INVALID_CURSOR", "Conversation cursor is invalid");
  }
}

export function parseSupportLimit(value: unknown, fallback = 30): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

export async function createSupportConversation(input: {
  actorId: string;
  subject: unknown;
  category: unknown;
  source: unknown;
  message: unknown;
  diagnostics?: unknown;
}) {
  const subject = boundedString(input.subject, 160, "subject", true);
  const category = enumValue(input.category, SUPPORT_CATEGORIES, "category");
  const source = enumValue(input.source, SUPPORT_SOURCES, "source");
  const body = boundedString(input.message, 12000, "message", true);
  const diagnostics = sanitizeSupportDiagnostics(input.diagnostics);

  const conversation = await SupportConversation.create({
    user: input.actorId,
    subject,
    category,
    source,
    diagnostics,
    lastMessagePreview: "",
    lastMessageAt: new Date(),
    lastMessageBy: "user",
  });

  try {
    await recordActivity({
      conversation: conversation._id,
      actor: input.actorId,
      type: "conversation_created",
      visibleToUser: true,
      summary: "Support conversation created",
      metadata: { category, source },
    });
    const result = await sendSupportMessage({
      conversationId: String(conversation._id),
      actorId: input.actorId,
      actorRole: "user",
      body,
      diagnostics,
    });
    const populated = await populatedConversation(String(conversation._id));
    return {
      conversation: supportRequesterConversationDto(populated),
      initialMessage: result.message,
    };
  } catch (error) {
    // The initial message is part of the create contract. Compensate if a later
    // write fails so clients never discover an empty half-created conversation.
    await Promise.all([
      SupportActivity.deleteMany({ conversation: conversation._id }),
      SupportMessage.deleteMany({ conversation: conversation._id }),
      SupportConversation.deleteOne({ _id: conversation._id }),
    ]).catch(() => undefined);
    throw error;
  }
}

export async function listSupportConversations(input: {
  actorId?: string;
  actorRole: ActorRole;
  cursor?: unknown;
  limit?: unknown;
  status?: unknown;
  priority?: unknown;
  category?: unknown;
  assigneeId?: unknown;
  userId?: unknown;
  query?: unknown;
}) {
  const limit = parseSupportLimit(input.limit, 30);
  const cursor = decodeConversationCursor(input.cursor);
  const filter: Record<string, any> = {};
  if (input.actorRole === "user") {
    filter.user = input.actorId;
  } else {
    if (asString(input.status)) filter.status = enumValue(input.status, SUPPORT_STATUSES, "status");
    if (asString(input.priority)) {
      filter.priority = enumValue(input.priority, SUPPORT_PRIORITIES, "priority");
    }
    if (asString(input.category)) {
      filter.category = enumValue(input.category, SUPPORT_CATEGORIES, "category");
    }
    if (asString(input.userId)) filter.user = requireObjectId(input.userId, "userId");
    if (asString(input.assigneeId) === "unassigned") filter.assignee = null;
    else if (asString(input.assigneeId)) {
      filter.assignee = requireObjectId(input.assigneeId, "assigneeId");
    }
    const query = boundedString(input.query, 160, "query");
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { subject: { $regex: escaped, $options: "i" } },
        { lastMessagePreview: { $regex: escaped, $options: "i" } },
      ];
    }
  }
  if (cursor) {
    const cursorFilter = {
      $or: [
        { lastMessageAt: { $lt: cursor.at } },
        { lastMessageAt: cursor.at, _id: { $lt: cursor.id } },
      ],
    };
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, cursorFilter];
      delete filter.$or;
    } else {
      Object.assign(filter, cursorFilter);
    }
  }

  const rows = await SupportConversation.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("user", "username email")
    .populate("assignee", "username email")
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(
      input.actorRole === "user"
        ? supportRequesterConversationDto
        : supportConversationDto
    ),
    nextCursor: hasMore && page.length ? encodeConversationCursor(page[page.length - 1]) : null,
  };
}

export async function getSupportConversation(input: ConversationAccess & { conversationId: unknown }) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const populated = await populatedConversation(String(conversation._id));
  return input.actorRole === "user"
    ? supportRequesterConversationDto(populated)
    : supportConversationDto(populated);
}

export async function listSupportMessages(input: ConversationAccess & {
  conversationId: unknown;
  before?: unknown;
  limit?: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const toMessageDto = input.actorRole === "user"
    ? supportRequesterMessageDto
    : supportMessageDto;
  const limit = parseSupportLimit(input.limit, 50);
  const filter: Record<string, any> = { conversation: conversation._id };
  if (input.actorRole === "user") filter.visibleToUser = true;
  const before = asString(input.before);
  if (before) filter._id = { $lt: new mongoose.Types.ObjectId(requireObjectId(before, "before")) };

  const rows = await SupportMessage.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate("sender", "username email")
    .populate({ path: "attachments", match: { status: "ready" } })
    .lean();
  const hasMore = rows.length > limit;
  const pageNewestFirst = hasMore ? rows.slice(0, limit) : rows;
  const oldest = pageNewestFirst[pageNewestFirst.length - 1];
  return {
    items: pageNewestFirst.reverse().map(toMessageDto),
    nextCursor: hasMore && oldest ? String(oldest._id) : null,
  };
}

export async function sendSupportMessage(input: ConversationAccess & {
  conversationId: unknown;
  body?: unknown;
  attachmentIds?: unknown;
  clientMessageId?: unknown;
  diagnostics?: unknown;
  internalNote?: boolean;
}) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const toMessageDto = input.actorRole === "user"
    ? supportRequesterMessageDto
    : supportMessageDto;
  const body = boundedString(input.body, 12000, "body");
  const rawIds = input.attachmentIds === undefined ? [] : input.attachmentIds;
  if (!Array.isArray(rawIds)) {
    throw new SupportApiError(400, "VALIDATION_ERROR", "attachmentIds must be an array");
  }
  if (rawIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new SupportApiError(
      400,
      "VALIDATION_ERROR",
      `A message can contain at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`
    );
  }
  const attachmentIds = [...new Set(rawIds.map((id) => requireObjectId(id, "attachmentId")))];
  if (!body && !attachmentIds.length) {
    throw new SupportApiError(400, "VALIDATION_ERROR", "A message or attachment is required");
  }
  if (input.internalNote && input.actorRole !== "agent") {
    throw new SupportApiError(403, "FORBIDDEN", "Only support agents can add internal notes");
  }

  const clientMessageId = boundedString(input.clientMessageId, 120, "clientMessageId");
  if (clientMessageId) {
    const existing = await SupportMessage.findOne({
      conversation: conversation._id,
      clientMessageId,
    })
      .populate("sender", "username email")
      .populate({ path: "attachments", match: { status: "ready" } })
      .lean();
    if (existing) return { message: toMessageDto(existing), idempotent: true };
  }

  const messageId = new mongoose.Types.ObjectId();
  if (attachmentIds.length) {
    const claim = await SupportAttachment.updateMany(
      {
        _id: { $in: attachmentIds },
        conversation: conversation._id,
        uploader: input.actorId,
        uploaderRole: input.actorRole,
        status: "ready",
        message: null,
      },
      { $set: { message: messageId } }
    );
    if (claim.modifiedCount !== attachmentIds.length) {
      await SupportAttachment.updateMany(
        { message: messageId },
        { $set: { message: null } }
      );
      throw new SupportApiError(
        409,
        "ATTACHMENT_NOT_READY",
        "One or more attachments are unavailable, unconfirmed, or already used"
      );
    }
  }

  const senderRole: SupportSenderRole = input.actorRole === "agent" ? "agent" : "user";
  const internalNote = input.internalNote === true;
  const diagnostics = sanitizeSupportDiagnostics(input.diagnostics);
  try {
    await SupportMessage.create({
      _id: messageId,
      conversation: conversation._id,
      sender: input.actorId,
      senderRole,
      type: internalNote ? "internal_note" : "message",
      visibleToUser: !internalNote,
      body,
      diagnostics,
      attachments: attachmentIds,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  } catch (error: any) {
    await SupportAttachment.updateMany({ message: messageId }, { $set: { message: null } });
    if (error?.code === 11000 && clientMessageId) {
      const existing = await SupportMessage.findOne({
        conversation: conversation._id,
        clientMessageId,
      })
        .populate("sender", "username email")
        .populate({ path: "attachments", match: { status: "ready" } })
        .lean();
      if (existing) return { message: toMessageDto(existing), idempotent: true };
    }
    throw error;
  }

  if (!internalNote) {
    const update: Record<string, any> = {
      $set: {
        lastMessagePreview: previewFor(body, attachmentIds.length),
        lastMessageAt: (await SupportMessage.findById(messageId).select("createdAt").lean())!
          .createdAt,
        lastMessageBy: senderRole,
      },
      $inc: {
        messageCount: 1,
        ...(senderRole === "user" ? { agentUnreadCount: 1 } : { userUnreadCount: 1 }),
      },
    };
    // A customer follow-up reopens completed work so it cannot remain hidden in
    // resolved/closed queues after new evidence arrives.
    if (senderRole === "user" && ["resolved", "closed"].includes(conversation.status)) {
      update.$set.status = "open";
      update.$set.resolvedAt = null;
      update.$set.closedAt = null;
    }
    await SupportConversation.updateOne({ _id: conversation._id }, update);
  }

  await recordActivity({
    conversation: conversation._id,
    actor: input.actorId,
    type: internalNote ? "internal_note_added" : "message_sent",
    visibleToUser: !internalNote,
    summary: internalNote ? "Internal note added" : `${senderRole === "agent" ? "Agent" : "User"} replied`,
    metadata: { messageId: String(messageId), attachmentCount: attachmentIds.length },
  });

  const populated = await populatedMessage(String(messageId));
  return { message: toMessageDto(populated), idempotent: false };
}

type SupportAttachmentUploadInput = ConversationAccess & {
  conversationId: unknown;
  fileName: unknown;
  contentType: unknown;
  sizeBytes: unknown;
};

/**
 * Validate an attachment and reserve its conversation-scoped object key.
 * Both upload transports use this boundary so ownership, MIME, byte ceilings,
 * and pending-upload throttling cannot drift between direct and relayed flows.
 */
async function createPendingSupportAttachment(input: SupportAttachmentUploadInput) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const originalName = boundedString(input.fileName, 240, "fileName", true);
  const nameForKey = safeFileName(originalName);
  const contentType = asString(input.contentType).toLowerCase();
  const { type, maxBytes } = attachmentLimits(contentType);
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) {
    throw new SupportApiError(
      413,
      "ATTACHMENT_TOO_LARGE",
      `${type === "image" ? "Image" : "Video"} must be ${maxBytes} bytes or smaller`
    );
  }
  const pendingCount = await SupportAttachment.countDocuments({
    conversation: conversation._id,
    uploader: input.actorId,
    status: "pending",
    uploadExpiresAt: { $gt: new Date() },
    message: null,
  });
  if (pendingCount >= MAX_ACTIVE_PENDING_UPLOADS) {
    throw new SupportApiError(
      429,
      "TOO_MANY_PENDING_UPLOADS",
      "Confirm or wait for existing attachment uploads before starting more"
    );
  }
  const storage = getCurrentR2StorageTarget();
  if (!storage.bucketName) {
    throw new SupportApiError(503, "STORAGE_UNAVAILABLE", "Support attachment storage is unavailable");
  }

  const attachmentId = new mongoose.Types.ObjectId();
  const uploadExpiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
  const key = `support/${conversation._id}/${attachmentId}/${crypto.randomUUID()}-${nameForKey}`;
  const attachment = await SupportAttachment.create({
    _id: attachmentId,
    conversation: conversation._id,
    uploader: input.actorId,
    uploaderRole: input.actorRole,
    type,
    status: "pending",
    key,
    r2Bucket: storage.bucketName,
    r2PublicBaseUrl: storage.publicBaseUrl,
    originalName,
    contentType,
    declaredSizeBytes: sizeBytes,
    uploadExpiresAt,
  });

  return {
    attachment,
    bucket: storage.bucketName,
    storage,
    conversation,
    contentType,
    sizeBytes,
  };
}

export async function createSupportAttachmentUpload(input: SupportAttachmentUploadInput) {
  const { attachment, bucket, contentType } = await createPendingSupportAttachment(input);
  try {
    const url = await createR2PresignedPutUrl(
      bucket,
      attachment.key,
      contentType,
      UPLOAD_TTL_SECONDS,
      { preventOverwrite: true }
    );
    return {
      attachment: supportAttachmentDto(attachment.toObject()),
      upload: {
        url,
        method: "PUT" as const,
        headers: { "Content-Type": contentType, "If-None-Match": "*" },
        expiresInSeconds: UPLOAD_TTL_SECONDS,
      },
    };
  } catch (error) {
    await SupportAttachment.deleteOne({ _id: attachment._id }).catch(() => undefined);
    throw error;
  }
}

class UploadSizeMismatchError extends Error {
  constructor() {
    super("The request body does not match the declared attachment size");
    this.name = "UploadSizeMismatchError";
  }
}

class UploadSignatureMismatchError extends Error {
  constructor() {
    super("The request body signature does not match its declared content type");
    this.name = "UploadSignatureMismatchError";
  }
}

/**
 * Count the upload and hold only its small identifying prefix until the file
 * signature matches the declared MIME type. Invalid leading bytes never flow
 * into the R2 request; valid uploads are released immediately and the rest of
 * the body continues with normal stream backpressure.
 */
function meteredUploadStream(expectedBytes: number, contentType: string) {
  let receivedBytes = 0;
  let exceeded = false;
  let ended = false;
  let signatureValidated = false;
  let signatureMismatch = false;
  let signaturePrefix = Buffer.alloc(0);
  const requiredSignatureBytes = supportMediaSignatureBytes(contentType);
  if (!requiredSignatureBytes) {
    throw new SupportApiError(
      415,
      "UNSUPPORTED_ATTACHMENT_TYPE",
      "The attachment content type is not supported"
    );
  }
  const stream = new Transform({
    transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      receivedBytes += bytes.length;
      if (receivedBytes > expectedBytes) {
        exceeded = true;
        callback(new UploadSizeMismatchError());
        return;
      }

      if (signatureValidated) {
        callback(null, bytes);
        return;
      }

      const missingBytes = requiredSignatureBytes - signaturePrefix.length;
      const prefixChunk = bytes.subarray(0, Math.min(missingBytes, bytes.length));
      signaturePrefix = Buffer.concat([signaturePrefix, prefixChunk]);
      if (signaturePrefix.length < requiredSignatureBytes) {
        callback();
        return;
      }
      if (!matchesSupportMediaSignature(contentType, signaturePrefix)) {
        signatureMismatch = true;
        callback(new UploadSignatureMismatchError());
        return;
      }

      signatureValidated = true;
      // Push the bounded prefix and the zero-copy remainder separately so a
      // large first network chunk is never duplicated into a second buffer.
      this.push(signaturePrefix);
      const remainder = bytes.subarray(prefixChunk.length);
      if (remainder.length > 0) this.push(remainder);
      signaturePrefix = Buffer.alloc(0);
      callback();
    },
    flush(callback) {
      ended = true;
      if (!signatureValidated) {
        signatureMismatch = true;
        callback(new UploadSignatureMismatchError());
        return;
      }
      callback();
    },
  });
  return {
    stream,
    receivedBytes: () => receivedBytes,
    exceeded: () => exceeded,
    ended: () => ended,
    signatureMismatch: () => signatureMismatch,
  };
}

async function cleanupFailedStreamingAttachment(input: {
  attachmentId: mongoose.Types.ObjectId;
  bucket: string;
  key: string;
  reason: string;
}) {
  try {
    // DeleteObject is safe when a failed single PUT never created an object,
    // and removes a completed object if verification/finalization failed later.
    await deleteFromR2Strict(input.bucket, input.key);
    await SupportAttachment.deleteOne({ _id: input.attachmentId });
  } catch (cleanupError: any) {
    // Retain the key when R2 is temporarily unavailable. The attachment
    // reconciler already retries rejected objects, preventing an untracked leak.
    await SupportAttachment.updateOne(
      { _id: input.attachmentId },
      {
        $set: {
          status: "rejected",
          rejectionReason: input.reason.slice(0, 500),
          uploadExpiresAt: new Date(0),
          cleanupError: String(cleanupError?.message || cleanupError).slice(0, 1000),
        },
      }
    ).catch(() => undefined);
  }
}

/**
 * Relay an authenticated raw request body to R2 without buffering it in memory
 * or on disk. Readiness is granted only after the stream byte count and R2 HEAD
 * metadata both exactly match the validated declaration.
 */
export async function streamSupportAttachmentUpload(
  input: SupportAttachmentUploadInput & {
    body: Readable;
    signal?: AbortSignal;
  }
) {
  const { attachment, bucket, storage, conversation, contentType, sizeBytes } =
    await createPendingSupportAttachment(input);
  const meter = meteredUploadStream(sizeBytes, contentType);
  let upload: R2StreamingUpload | undefined;
  let readyAttachment: any;

  const abortUpload = () => {
    meter.stream.destroy();
    void upload?.abort().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abortUpload, { once: true });

  try {
    if (input.signal?.aborted) {
      throw new SupportApiError(499, "UPLOAD_ABORTED", "Attachment upload was cancelled");
    }

    input.body.pipe(meter.stream);
    upload = createR2StreamingUpload({
      bucketName: bucket,
      key: attachment.key,
      body: meter.stream,
      contentType,
      contentLength: sizeBytes,
    });
    if (input.signal?.aborted) abortUpload();
    await upload.done();

    if (meter.exceeded() || meter.receivedBytes() !== sizeBytes) {
      throw new SupportApiError(
        400,
        "UPLOAD_SIZE_MISMATCH",
        "The uploaded bytes do not match X-File-Size or Content-Length"
      );
    }
    if (input.signal?.aborted) {
      throw new SupportApiError(499, "UPLOAD_ABORTED", "Attachment upload was cancelled");
    }

    let head: Awaited<ReturnType<typeof headR2Object>>;
    try {
      head = await headR2Object(bucket, attachment.key);
    } catch {
      throw new SupportApiError(
        502,
        "UPLOAD_VERIFICATION_FAILED",
        "R2 could not verify the completed attachment upload"
      );
    }
    const actualSize = Number(head.size || 0);
    const actualType = asString(head.contentType).toLowerCase();
    if (actualSize !== sizeBytes || actualType !== contentType) {
      throw new SupportApiError(
        409,
        "UPLOAD_METADATA_MISMATCH",
        "Stored attachment size or content type does not match the request"
      );
    }
    if (input.signal?.aborted) {
      throw new SupportApiError(499, "UPLOAD_ABORTED", "Attachment upload was cancelled");
    }

    attachment.status = "ready";
    attachment.verifiedSizeBytes = actualSize;
    attachment.url = getR2PublicUrl(attachment.key, storage);
    attachment.completedAt = new Date();
    try {
      readyAttachment = await attachment.save();
    } catch {
      throw new SupportApiError(
        500,
        "ATTACHMENT_FINALIZATION_FAILED",
        "The uploaded attachment could not be finalized"
      );
    }
    if (input.signal?.aborted) {
      throw new SupportApiError(499, "UPLOAD_ABORTED", "Attachment upload was cancelled");
    }
  } catch (error) {
    input.body.unpipe(meter.stream);
    if (!input.body.readableEnded && !input.body.destroyed) input.body.resume();
    meter.stream.destroy();
    await upload?.abort().catch(() => undefined);
    await cleanupFailedStreamingAttachment({
      attachmentId: attachment._id,
      bucket,
      key: attachment.key,
      reason:
        error instanceof Error ? error.message : "Attachment streaming upload failed",
    });

    if (
      meter.exceeded() ||
      error instanceof UploadSizeMismatchError ||
      (meter.ended() && meter.receivedBytes() !== sizeBytes)
    ) {
      throw new SupportApiError(
        400,
        "UPLOAD_SIZE_MISMATCH",
        "The uploaded bytes do not match X-File-Size or Content-Length"
      );
    }
    if (meter.signatureMismatch() || error instanceof UploadSignatureMismatchError) {
      throw new SupportApiError(
        415,
        "ATTACHMENT_SIGNATURE_MISMATCH",
        "The uploaded file does not match its declared content type"
      );
    }
    if (error instanceof SupportApiError) throw error;
    throw new SupportApiError(
      502,
      "STORAGE_UPLOAD_FAILED",
      "The attachment could not be uploaded to storage"
    );
  } finally {
    input.signal?.removeEventListener("abort", abortUpload);
  }

  // Activity history is operational metadata; a transient audit write must not
  // roll back bytes that are already durable and verified for chat use.
  await recordActivity({
    conversation: conversation._id,
    actor: input.actorId,
    type: "attachment_confirmed",
    visibleToUser: true,
    summary: `${attachment.type === "image" ? "Image" : "Video"} attachment uploaded`,
    metadata: { attachmentId: String(attachment._id), contentType },
  }).catch((error) => console.error("Support attachment activity write failed", error));

  return supportAttachmentDto(readyAttachment.toObject());
}

export async function confirmSupportAttachment(input: ConversationAccess & {
  conversationId: unknown;
  attachmentId: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const attachmentId = requireObjectId(input.attachmentId, "attachmentId");
  const attachment: any = await SupportAttachment.findOne({
    _id: attachmentId,
    conversation: conversation._id,
    uploader: input.actorId,
    uploaderRole: input.actorRole,
  });
  if (!attachment) {
    throw new SupportApiError(404, "ATTACHMENT_NOT_FOUND", "Support attachment not found");
  }
  if (attachment.status === "ready") return supportAttachmentDto(attachment.toObject());
  if (attachment.status === "rejected") {
    throw new SupportApiError(409, "ATTACHMENT_REJECTED", "This attachment upload was rejected");
  }
  if (attachment.status === "deleting") {
    throw new SupportApiError(410, "ATTACHMENT_EXPIRED", "This attachment upload has expired");
  }
  const storage = resolvePersistedR2StorageTarget({
    r2Bucket: attachment.r2Bucket,
    r2PublicBaseUrl: attachment.r2PublicBaseUrl,
  });
  let head: Awaited<ReturnType<typeof headR2Object>>;
  try {
    head = await headR2Object(storage.bucketName, attachment.key);
  } catch {
    throw new SupportApiError(
      409,
      "UPLOAD_NOT_FOUND",
      "The uploaded attachment was not found; complete the PUT before confirming"
    );
  }
  const actualSize = Number(head.size || 0);
  const actualType = asString(head.contentType).toLowerCase();
  if (actualSize !== Number(attachment.declaredSizeBytes) || actualType !== attachment.contentType) {
    attachment.status = "rejected";
    attachment.rejectionReason = "R2 metadata did not match the declared upload";
    await attachment.save();
    throw new SupportApiError(
      409,
      "UPLOAD_METADATA_MISMATCH",
      "Uploaded attachment size or content type does not match the presigned request"
    );
  }

  // The public render URL becomes durable only after storage proves the exact
  // object described by the authenticated presign request exists.
  attachment.status = "ready";
  attachment.verifiedSizeBytes = actualSize;
  attachment.url = getR2PublicUrl(attachment.key, storage);
  attachment.completedAt = new Date();
  await attachment.save();
  await recordActivity({
    conversation: conversation._id,
    actor: input.actorId,
    type: "attachment_confirmed",
    visibleToUser: true,
    summary: `${attachment.type === "image" ? "Image" : "Video"} attachment confirmed`,
    metadata: { attachmentId: String(attachment._id), contentType: attachment.contentType },
  });
  return supportAttachmentDto(attachment.toObject());
}

export async function markSupportConversationRead(input: ConversationAccess & {
  conversationId: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, input);
  const field = input.actorRole === "user" ? "userUnreadCount" : "agentUnreadCount";
  await SupportConversation.updateOne({ _id: conversation._id }, { $set: { [field]: 0 } });
  return { unreadCount: 0 };
}

export async function updateSupportConversation(input: {
  actorId: string;
  conversationId: unknown;
  status?: unknown;
  priority?: unknown;
  assigneeId?: unknown;
}) {
  const conversation: any = await requireConversationAccess(input.conversationId, {
    actorId: input.actorId,
    actorRole: "agent",
  });
  const updates: Record<string, any> = {};
  const changes: Array<{ type: string; summary: string; metadata: Record<string, unknown> }> = [];

  if (input.status !== undefined) {
    const status = enumValue(input.status, SUPPORT_STATUSES, "status");
    if (status !== conversation.status) {
      updates.status = status;
      updates.resolvedAt = status === "resolved" ? new Date() : null;
      updates.closedAt = status === "closed" ? new Date() : null;
      changes.push({
        type: "status_changed",
        summary: `Status changed from ${conversation.status} to ${status}`,
        metadata: { from: conversation.status, to: status },
      });
    }
  }
  if (input.priority !== undefined) {
    const priority = enumValue(input.priority, SUPPORT_PRIORITIES, "priority");
    if (priority !== conversation.priority) {
      updates.priority = priority;
      changes.push({
        type: "priority_changed",
        summary: `Priority changed from ${conversation.priority} to ${priority}`,
        metadata: { from: conversation.priority, to: priority },
      });
    }
  }
  if (input.assigneeId !== undefined) {
    let assignee: string | null = null;
    if (input.assigneeId !== null && asString(input.assigneeId)) {
      assignee = requireObjectId(input.assigneeId, "assigneeId");
      const agent = await User.exists(activeSupportDeveloperFilter(assignee));
      if (!agent) {
        throw new SupportApiError(
          400,
          "INVALID_ASSIGNEE",
          "Assignee must be an active support developer"
        );
      }
    }
    const previous = conversation.assignee ? String(conversation.assignee) : null;
    if (assignee !== previous) {
      updates.assignee = assignee;
      changes.push({
        type: "assignee_changed",
        summary: assignee ? "Conversation assigned" : "Conversation unassigned",
        metadata: { from: previous, to: assignee },
      });
    }
  }
  if (!Object.keys(updates).length) {
    const unchanged = await populatedConversation(String(conversation._id));
    return supportConversationDto(unchanged);
  }
  await SupportConversation.updateOne({ _id: conversation._id }, { $set: updates });
  for (const change of changes) {
    await recordActivity({
      conversation: conversation._id,
      actor: input.actorId,
      type: change.type,
      visibleToUser: change.type === "status_changed",
      summary: change.summary,
      metadata: change.metadata,
    });
  }
  const updated = await populatedConversation(String(conversation._id));
  return supportConversationDto(updated);
}

export async function listSupportTodos(conversationId: unknown, actorId: string) {
  const conversation = await requireConversationAccess(conversationId, {
    actorId,
    actorRole: "agent",
  });
  const rows = await SupportTodo.find({ conversation: conversation._id })
    .sort({ status: 1, dueAt: 1, createdAt: -1 })
    .populate("assignee", "username email")
    .populate("createdBy", "username email")
    .lean();
  return rows.map(supportTodoDto);
}

function encodeCreatedAtCursor(value: any): string {
  return Buffer.from(
    JSON.stringify({ at: new Date(value.createdAt).toISOString(), id: String(value._id) })
  ).toString("base64url");
}

function decodeCreatedAtCursor(value: unknown): { at: Date; id: mongoose.Types.ObjectId } | null {
  const cursor = asString(value);
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(parsed.id)) throw new Error();
    return { at, id: new mongoose.Types.ObjectId(parsed.id) };
  } catch {
    throw new SupportApiError(400, "INVALID_CURSOR", "Todo cursor is invalid");
  }
}

export async function listGlobalSupportTodos(input: {
  actorId: string;
  status?: unknown;
  assigneeId?: unknown;
  due?: unknown;
  limit?: unknown;
  cursor?: unknown;
}) {
  const limit = parseSupportLimit(input.limit, 40);
  const filter: Record<string, any> = {};
  if (asString(input.status) === "active") {
    filter.status = { $in: ["todo", "in_progress"] };
  } else if (asString(input.status)) {
    filter.status = enumValue(input.status, SUPPORT_TODO_STATUSES, "status");
  }
  const assigneeId = asString(input.assigneeId);
  if (assigneeId === "me") filter.assignee = input.actorId;
  else if (assigneeId === "unassigned") filter.assignee = null;
  else if (assigneeId) filter.assignee = requireObjectId(assigneeId, "assigneeId");

  const due = asString(input.due);
  if (due && due !== "overdue" && due !== "today") {
    throw new SupportApiError(400, "VALIDATION_ERROR", "due must be overdue or today");
  }
  const now = new Date();
  if (due === "overdue") {
    filter.dueAt = { $lt: now };
    filter.status = { $in: ["todo", "in_progress"] };
  } else if (due === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    filter.dueAt = { $gte: start, $lt: end };
  }
  const cursor = decodeCreatedAtCursor(input.cursor);
  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.at } },
      { createdAt: cursor.at, _id: { $lt: cursor.id } },
    ];
  }

  const rows = await SupportTodo.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("assignee", "username email")
    .populate("createdBy", "username email")
    .populate({
      path: "conversation",
      select: "subject category status priority user",
      populate: { path: "user", select: "username email" },
    })
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(supportTodoDto),
    nextCursor: hasMore && page.length ? encodeCreatedAtCursor(page[page.length - 1]) : null,
  };
}

export async function createSupportTodo(input: {
  actorId: string;
  conversationId: unknown;
  title: unknown;
  description?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  assigneeId?: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, {
    actorId: input.actorId,
    actorRole: "agent",
  });
  const title = boundedString(input.title, 240, "title", true);
  const description = boundedString(input.description, 4000, "description");
  const priority = input.priority
    ? enumValue(input.priority, SUPPORT_PRIORITIES, "priority")
    : "normal";
  const dueAt = optionalDate(input.dueAt, "dueAt");
  // Context-created work belongs to the creating agent by default. Passing
  // explicit null is the intentional way to put it in the unassigned queue.
  let assignee: string | null = input.assigneeId === undefined ? input.actorId : null;
  if (input.assigneeId !== null && asString(input.assigneeId)) {
    assignee = requireObjectId(input.assigneeId, "assigneeId");
    const exists = await User.exists(activeSupportDeveloperFilter(assignee));
    if (!exists) {
      throw new SupportApiError(
        400,
        "INVALID_ASSIGNEE",
        "Todo assignee must be an active support developer"
      );
    }
  }
  const todo = await SupportTodo.create({
    conversation: conversation._id,
    title,
    description,
    priority,
    dueAt: dueAt ?? null,
    assignee,
    createdBy: input.actorId,
  });
  await recordActivity({
    conversation: conversation._id,
    actor: input.actorId,
    type: "todo_created",
    summary: `Todo created: ${title}`,
    metadata: { todoId: String(todo._id), priority },
  });
  const populated = await SupportTodo.findById(todo._id)
    .populate("assignee", "username email")
    .populate("createdBy", "username email")
    .lean();
  return supportTodoDto(populated);
}

export async function updateSupportTodo(input: {
  actorId: string;
  conversationId: unknown;
  todoId: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  assigneeId?: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, {
    actorId: input.actorId,
    actorRole: "agent",
  });
  const todoId = requireObjectId(input.todoId, "todoId");
  const todo: any = await SupportTodo.findOne({ _id: todoId, conversation: conversation._id });
  if (!todo) throw new SupportApiError(404, "TODO_NOT_FOUND", "Support todo not found");

  if (input.title !== undefined) todo.title = boundedString(input.title, 240, "title", true);
  if (input.description !== undefined) {
    todo.description = boundedString(input.description, 4000, "description");
  }
  if (input.priority !== undefined) {
    todo.priority = enumValue(input.priority, SUPPORT_PRIORITIES, "priority");
  }
  if (input.status !== undefined) {
    todo.status = enumValue(input.status, SUPPORT_TODO_STATUSES, "status");
    todo.completedAt = todo.status === "done" ? todo.completedAt || new Date() : null;
  }
  if (input.dueAt !== undefined) todo.dueAt = optionalDate(input.dueAt, "dueAt");
  if (input.assigneeId !== undefined) {
    let assignee: string | null = null;
    if (input.assigneeId !== null && asString(input.assigneeId)) {
      assignee = requireObjectId(input.assigneeId, "assigneeId");
      const exists = await User.exists(activeSupportDeveloperFilter(assignee));
      if (!exists) {
        throw new SupportApiError(
          400,
          "INVALID_ASSIGNEE",
          "Todo assignee must be an active support developer"
        );
      }
    }
    todo.assignee = assignee;
  }
  await todo.save();
  await recordActivity({
    conversation: conversation._id,
    actor: input.actorId,
    type: "todo_updated",
    summary: `Todo updated: ${todo.title}`,
    metadata: { todoId: String(todo._id), status: todo.status, priority: todo.priority },
  });
  const populated = await SupportTodo.findById(todo._id)
    .populate("assignee", "username email")
    .populate("createdBy", "username email")
    .lean();
  return supportTodoDto(populated);
}

export async function listSupportActivity(input: {
  actorId: string;
  conversationId: unknown;
  before?: unknown;
  limit?: unknown;
}) {
  const conversation = await requireConversationAccess(input.conversationId, {
    actorId: input.actorId,
    actorRole: "agent",
  });
  const limit = parseSupportLimit(input.limit, 50);
  const filter: Record<string, any> = { conversation: conversation._id };
  const before = asString(input.before);
  if (before) filter._id = { $lt: new mongoose.Types.ObjectId(requireObjectId(before, "before")) };
  const rows = await SupportActivity.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate("actor", "username email")
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(supportActivityDto),
    nextCursor: hasMore && page.length ? String(page[page.length - 1]._id) : null,
  };
}

export async function getSupportDashboard() {
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const [statusRows, priorityRows, total, unassigned, unreadRows, todoOpen, todoOverdue, todoDueToday, recent, recentTodos, recentActivity] =
    await Promise.all([
      SupportConversation.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      SupportConversation.aggregate([{ $group: { _id: "$priority", count: { $sum: 1 } } }]),
      SupportConversation.countDocuments({}),
      SupportConversation.countDocuments({
        assignee: null,
        status: { $in: ["open", "in_progress", "waiting_on_user"] },
      }),
      SupportConversation.aggregate([{ $group: { _id: null, count: { $sum: "$agentUnreadCount" } } }]),
      SupportTodo.countDocuments({ status: { $in: ["todo", "in_progress"] } }),
      SupportTodo.countDocuments({
        status: { $in: ["todo", "in_progress"] },
        dueAt: { $lt: now },
      }),
      SupportTodo.countDocuments({
        status: { $in: ["todo", "in_progress"] },
        dueAt: { $gte: now, $lte: todayEnd },
      }),
      SupportConversation.find({})
        .sort({ lastMessageAt: -1 })
        .limit(8)
        .populate("user", "username email")
        .populate("assignee", "username email")
        .lean(),
      SupportTodo.find({ status: { $in: ["todo", "in_progress"] } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("assignee", "username email")
        .populate("createdBy", "username email")
        .populate({
          path: "conversation",
          select: "subject category status priority user",
          populate: { path: "user", select: "username email" },
        })
        .lean(),
      SupportActivity.find({})
        .sort({ createdAt: -1, _id: -1 })
        .limit(8)
        .populate("actor", "username email")
        .populate("conversation", "subject category status")
        .lean(),
    ]);

  const counts = (values: readonly string[], rows: any[]) =>
    Object.fromEntries(values.map((value) => [value, rows.find((row) => row._id === value)?.count || 0]));
  return {
    conversations: {
      total,
      unassigned,
      agentUnread: Number(unreadRows[0]?.count || 0),
      statuses: counts(SUPPORT_STATUSES, statusRows),
      priorities: counts(SUPPORT_PRIORITIES, priorityRows),
    },
    todos: { open: todoOpen, overdue: todoOverdue, dueToday: todoDueToday },
    recent: recent.map(supportConversationDto),
    recentTodos: recentTodos.map(supportTodoDto),
    recentActivity: recentActivity.map(supportActivityDto),
    generatedAt: now,
  };
}

export async function listSupportAgents() {
  const agents = await User.find(activeSupportDeveloperFilter())
    .select("username email role")
    .sort({ username: 1, email: 1 })
    .lean();
  return agents.map((agent: any) => ({
    ...publicUser(agent),
    role: agent.role,
  }));
}

export const SUPPORT_UPLOAD_CONSTRAINTS = {
  imageContentTypes: [...IMAGE_CONTENT_TYPES],
  videoContentTypes: [...VIDEO_CONTENT_TYPES],
  maxImageBytes: () => envPositiveInteger("SUPPORT_MAX_IMAGE_BYTES", DEFAULT_IMAGE_LIMIT),
  maxVideoBytes: () => envPositiveInteger("SUPPORT_MAX_VIDEO_BYTES", DEFAULT_VIDEO_LIMIT),
  maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
  maxPendingUploads: MAX_ACTIVE_PENDING_UPLOADS,
};
