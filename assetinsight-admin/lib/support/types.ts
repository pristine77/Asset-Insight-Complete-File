export type SupportStatus = "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed";
export type SupportCategory = "error" | "feature" | "question" | "other";
export type SupportSource = "web" | "mobile";
export type SupportSenderRole = "user" | "agent" | "system";
export type SupportMessageType = "message" | "system";

/** Only verified, durable R2 objects are renderable in customer messages. */
export type SupportAttachment = {
  id: string;
  type: "image" | "video";
  originalName: string;
  contentType: string;
  sizeBytes: number;
  verifiedSizeBytes: number;
  status: "ready";
  url: string;
  completedAt: string;
  createdAt: string;
};

export type SupportUploadConstraints = {
  imageContentTypes: string[];
  videoContentTypes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  maxAttachmentsPerMessage: number;
  maxPendingUploads: number;
};

export type SupportDiagnostics = Record<string, unknown>;

export type SupportMessage = {
  id: string;
  conversationId: string;
  senderRole: SupportSenderRole;
  type: SupportMessageType;
  body: string;
  attachments: SupportAttachment[];
  createdAt: string;
};

/**
 * Ownership-scoped requester view. Queue management and staff identity are
 * intentionally omitted by the backend requester DTO.
 */
export type SupportConversation = {
  id: string;
  subject: string;
  category: SupportCategory;
  source: SupportSource;
  status: SupportStatus;
  lastMessage: {
    preview: string;
    at: string;
    senderRole: SupportSenderRole;
  } | null;
  unread: { user: number };
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportCursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type SupportConstraintsResponse = { constraints: SupportUploadConstraints };
export type SupportConversationResponse = { conversation: SupportConversation };
export type SupportConversationCreatedResponse = {
  conversation: SupportConversation;
  initialMessage: SupportMessage;
};
export type SupportConversationsResponse = SupportCursorPage<SupportConversation>;
export type SupportMessagesResponse = SupportCursorPage<SupportMessage>;
export type SupportMessageResponse = { message: SupportMessage };
export type SupportAttachmentResponse = { attachment: SupportAttachment };
export type SupportReadResponse = { unreadCount: number };

export type SupportConversationCreate = {
  subject: string;
  category: SupportCategory;
  source: "web";
  message: string;
  diagnostics?: SupportDiagnostics;
};

export type SupportMessageCreate = {
  body?: string;
  attachmentIds?: string[];
  /** Reuse this UUID for every retry of one logical send. */
  clientMessageId: string;
  diagnostics?: SupportDiagnostics;
};

export type SupportApiErrorPayload = {
  code?: string;
  message?: string;
  [key: string]: unknown;
};
