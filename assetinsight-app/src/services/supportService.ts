import api from './api';
import { getLocalSupportFileSize, uploadLocalSupportFileToBackend } from './supportUploadTransport';

const SUPPORT_BASE = '/support';

export type SupportCategory = 'error' | 'feature' | 'question' | 'other';
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SupportStatus = 'open' | 'in_progress' | 'waiting_on_user' | 'resolved' | 'closed';

export type SupportAttachmentKind = 'image' | 'video';

export type SupportAttachment = {
  id: string;
  kind: SupportAttachmentKind;
  fileName: string;
  contentType: string;
  size?: number;
  url?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  status?: 'pending' | 'ready' | 'failed';
};

export type SupportMessage = {
  id: string;
  conversationId: string;
  body: string;
  senderType: 'user' | 'developer' | 'system';
  senderName?: string;
  attachments: SupportAttachment[];
  clientMessageId?: string;
  createdAt: string;
};

export type SupportConversation = {
  id: string;
  reference?: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  source: 'mobile' | 'web';
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportDiagnostics = {
  appVersion?: string;
  buildNumber?: string;
  platform: 'android' | 'ios' | 'web';
  osVersion: string;
  deviceModel?: string;
  screen: string;
  route: string;
  errorCode?: string;
  errorMessage?: string;
  stack?: string;
  occurredAt: string;
};

export type LocalSupportAttachment = {
  uri: string;
  fileName: string;
  contentType: string;
  kind: SupportAttachmentKind;
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type SupportConversationPage = {
  conversations: SupportConversation[];
  nextCursor?: string;
};

export type SupportMessagePage = {
  messages: SupportMessage[];
  nextCursor?: string;
};

export type SupportUploadConstraints = {
  imageContentTypes: string[];
  videoContentTypes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  maxAttachmentsPerMessage: number;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function unwrapData(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    const record = asRecord(current);
    if (!Object.prototype.hasOwnProperty.call(record, 'data')) break;
    current = record.data;
  }
  return current;
}

function stringValue(...values: unknown[]): string {
  const match = values.find((value) => typeof value === 'string' && value.trim());
  return typeof match === 'string' ? match.trim() : '';
}

function numberValue(...values: unknown[]): number | undefined {
  const match = values.find(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  );
  return typeof match === 'number' ? match : undefined;
}

function normalizeCategory(value: unknown): SupportCategory {
  return value === 'error' || value === 'feature' || value === 'question' || value === 'other'
    ? value
    : 'other';
}

function normalizePriority(value: unknown): SupportPriority {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent'
    ? value
    : 'normal';
}

function normalizeStatus(value: unknown): SupportStatus {
  if (value === 'waiting_on_customer') return 'waiting_on_user';
  return value === 'open' ||
    value === 'in_progress' ||
    value === 'waiting_on_user' ||
    value === 'resolved' ||
    value === 'closed'
    ? value
    : 'open';
}

function normalizeSenderType(value: unknown): SupportMessage['senderType'] {
  const normalized = String(value || '').toLowerCase();
  if (['developer', 'agent', 'admin', 'support'].includes(normalized)) return 'developer';
  if (normalized === 'system') return 'system';
  return 'user';
}

function normalizeAttachmentKind(value: unknown, contentType: string): SupportAttachmentKind {
  if (value === 'video' || contentType.toLowerCase().startsWith('video/')) return 'video';
  return 'image';
}

export function normalizeSupportAttachment(value: unknown): SupportAttachment {
  const raw = asRecord(value);
  const id = stringValue(raw.id, raw._id, raw.attachmentId, raw.key);
  const contentType =
    stringValue(raw.contentType, raw.mimeType, raw.type) || 'application/octet-stream';
  const state = stringValue(raw.status);
  return {
    id,
    kind: normalizeAttachmentKind(raw.kind || raw.type, contentType),
    fileName: stringValue(raw.fileName, raw.filename, raw.originalName, raw.name) || 'attachment',
    contentType,
    size: numberValue(raw.size, raw.sizeBytes, raw.verifiedSizeBytes, raw.bytes),
    url: stringValue(raw.url, raw.publicUrl, raw.downloadUrl, raw.readUrl) || undefined,
    thumbnailUrl: stringValue(raw.thumbnailUrl, raw.previewUrl, raw.posterUrl) || undefined,
    width: numberValue(raw.width),
    height: numberValue(raw.height),
    durationMs: numberValue(raw.durationMs, raw.duration),
    status: state === 'ready' || state === 'failed' || state === 'pending' ? state : undefined,
  };
}

export function normalizeSupportMessage(value: unknown): SupportMessage {
  const raw = asRecord(value);
  const sender = asRecord(raw.sender || raw.author);
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(normalizeSupportAttachment).filter((item) => item.id)
    : [];
  return {
    id: stringValue(raw.id, raw._id, raw.messageId, raw.clientMessageId),
    conversationId: stringValue(raw.conversationId, raw.conversation),
    body: stringValue(raw.body, raw.message, raw.content, raw.text),
    senderType: normalizeSenderType(
      raw.senderType || raw.senderRole || raw.authorType || raw.role || sender.role
    ),
    senderName:
      stringValue(raw.senderName, raw.authorName, sender.name, sender.username) || undefined,
    attachments,
    clientMessageId: stringValue(raw.clientMessageId) || undefined,
    createdAt: stringValue(raw.createdAt, raw.sentAt, raw.timestamp) || new Date(0).toISOString(),
  };
}

export function normalizeSupportConversation(value: unknown): SupportConversation {
  const raw = asRecord(value);
  const lastMessageRecord = asRecord(raw.lastMessage);
  const lastMessage =
    typeof raw.lastMessage === 'string'
      ? raw.lastMessage
      : stringValue(
          lastMessageRecord.body,
          lastMessageRecord.message,
          lastMessageRecord.content,
          lastMessageRecord.preview,
          raw.lastMessagePreview
        );
  const createdAt = stringValue(raw.createdAt) || new Date(0).toISOString();
  const updatedAt = stringValue(raw.updatedAt, raw.lastMessageAt) || createdAt;
  return {
    id: stringValue(raw.id, raw._id, raw.conversationId),
    reference: stringValue(raw.reference, raw.ticketNumber, raw.caseNumber) || undefined,
    subject: stringValue(raw.subject, raw.title) || 'Support request',
    category: normalizeCategory(raw.category),
    priority: normalizePriority(raw.priority || raw.severity),
    status: normalizeStatus(raw.status),
    source: raw.source === 'web' ? 'web' : 'mobile',
    lastMessage: lastMessage || undefined,
    lastMessageAt:
      stringValue(
        raw.lastMessageAt,
        lastMessageRecord.createdAt,
        lastMessageRecord.at,
        raw.updatedAt
      ) || undefined,
    unreadCount: numberValue(raw.unreadCount, raw.unreadMessages, asRecord(raw.unread).user) || 0,
    createdAt,
    updatedAt,
  };
}

function cursorFromPayload(payload: UnknownRecord): string | undefined {
  const pagination = asRecord(payload.pagination);
  return stringValue(payload.nextCursor, payload.cursor, pagination.nextCursor) || undefined;
}

export function normalizeSupportConversationPage(value: unknown): SupportConversationPage {
  const payloadValue = unwrapData(value);
  const payload = asRecord(payloadValue);
  const items = Array.isArray(payloadValue)
    ? payloadValue
    : Array.isArray(payload.conversations)
      ? payload.conversations
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  return {
    conversations: items.map(normalizeSupportConversation).filter((item) => item.id),
    nextCursor: cursorFromPayload(payload),
  };
}

export function normalizeSupportMessagePage(value: unknown): SupportMessagePage {
  const payloadValue = unwrapData(value);
  const payload = asRecord(payloadValue);
  const items = Array.isArray(payloadValue)
    ? payloadValue
    : Array.isArray(payload.messages)
      ? payload.messages
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  return {
    messages: items.map(normalizeSupportMessage).filter((item) => item.id),
    nextCursor: cursorFromPayload(payload),
  };
}

function normalizeSingleConversation(value: unknown): SupportConversation {
  const payload = asRecord(unwrapData(value));
  return normalizeSupportConversation(payload.conversation || payload);
}

function normalizeSingleMessage(value: unknown): SupportMessage {
  const payload = asRecord(unwrapData(value));
  return normalizeSupportMessage(payload.message || payload);
}

export function getSupportErrorMessage(error: unknown, fallback: string): string {
  const raw = asRecord(error);
  const response = asRecord(raw.response);
  const responseData = asRecord(response.data);
  return stringValue(responseData.message, responseData.error, raw.message) || fallback;
}

export async function listSupportConversations(args?: {
  cursor?: string;
  limit?: number;
}): Promise<SupportConversationPage> {
  const response = await api.get(`${SUPPORT_BASE}/conversations`, {
    params: { cursor: args?.cursor, limit: args?.limit || 30 },
  });
  return normalizeSupportConversationPage(response.data);
}

export async function getSupportUploadConstraints(): Promise<SupportUploadConstraints> {
  const response = await api.get(`${SUPPORT_BASE}/constraints`);
  const payload = asRecord(unwrapData(response.data));
  const constraints = asRecord(payload.constraints || payload);
  return {
    imageContentTypes: Array.isArray(constraints.imageContentTypes)
      ? constraints.imageContentTypes.filter((value): value is string => typeof value === 'string')
      : [],
    videoContentTypes: Array.isArray(constraints.videoContentTypes)
      ? constraints.videoContentTypes.filter((value): value is string => typeof value === 'string')
      : [],
    maxImageBytes: numberValue(constraints.maxImageBytes) || 20 * 1024 * 1024,
    maxVideoBytes: numberValue(constraints.maxVideoBytes) || 250 * 1024 * 1024,
    maxAttachmentsPerMessage: numberValue(constraints.maxAttachmentsPerMessage) || 8,
  };
}

export async function getSupportConversation(id: string): Promise<SupportConversation> {
  const response = await api.get(`${SUPPORT_BASE}/conversations/${encodeURIComponent(id)}`);
  return normalizeSingleConversation(response.data);
}

export async function listSupportMessages(
  conversationId: string,
  args?: { cursor?: string; limit?: number }
): Promise<SupportMessagePage> {
  const response = await api.get(
    `${SUPPORT_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
    { params: { before: args?.cursor, limit: args?.limit || 50 } }
  );
  return normalizeSupportMessagePage(response.data);
}

export async function createSupportConversation(input: {
  subject: string;
  category: SupportCategory;
  message: string;
  diagnostics?: SupportDiagnostics;
}): Promise<SupportConversation> {
  const response = await api.post(`${SUPPORT_BASE}/conversations`, {
    ...input,
    source: 'mobile',
  });
  return normalizeSingleConversation(response.data);
}

export async function sendSupportMessage(
  conversationId: string,
  input: { body: string; attachmentIds?: string[]; clientMessageId: string }
): Promise<SupportMessage> {
  const response = await api.post(
    `${SUPPORT_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
    input
  );
  return normalizeSingleMessage(response.data);
}

export async function markSupportConversationRead(conversationId: string): Promise<void> {
  await api.post(`${SUPPORT_BASE}/conversations/${encodeURIComponent(conversationId)}/read`, {});
}

async function resolveLocalFileSize(file: LocalSupportAttachment): Promise<number | undefined> {
  if (typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0) {
    return file.size;
  }
  return getLocalSupportFileSize(file.uri);
}

export async function uploadSupportAttachment(args: {
  conversationId: string;
  file: LocalSupportAttachment;
  onProgress?: (progress: number) => void;
}): Promise<SupportAttachment> {
  const size = await resolveLocalFileSize(args.file);
  if (!size) {
    throw new Error('The selected media size could not be verified. Choose the file again.');
  }
  const endpointPath = `${SUPPORT_BASE}/conversations/${encodeURIComponent(
    args.conversationId
  )}/attachments/upload`;
  const upload = () =>
    uploadLocalSupportFileToBackend({
      uri: args.file.uri,
      endpointPath,
      fileName: args.file.fileName,
      contentType: args.file.contentType,
      sizeBytes: size,
      onProgress: args.onProgress,
    });

  let response;
  try {
    response = await upload();
  } catch (error) {
    const status = numberValue(asRecord(error).status);
    if (status !== 401 && status !== 403) throw error;
    // Native FileSystem uploads bypass Axios. A protected lightweight request
    // lets the shared interceptor refresh credentials before one safe retry;
    // auth middleware rejects the original request before consuming its body.
    await api.get(`${SUPPORT_BASE}/constraints`);
    response = await upload();
  }

  let decoded: unknown;
  try {
    decoded = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    throw new Error('The server returned an invalid attachment response.');
  }
  const payload = asRecord(unwrapData(decoded));
  const confirmed = normalizeSupportAttachment(payload.attachment || payload);
  if (!confirmed.id || confirmed.status !== 'ready' || !confirmed.url) {
    throw new Error('The server did not return a ready attachment.');
  }
  return {
    ...confirmed,
    kind: confirmed.kind || args.file.kind,
    fileName: confirmed.fileName || args.file.fileName,
    contentType: confirmed.contentType || args.file.contentType,
    size: confirmed.size || size,
    status: 'ready',
  };
}
