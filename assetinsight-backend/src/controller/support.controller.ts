import type { Request, RequestHandler, Response } from "express";
import {
  SUPPORT_UPLOAD_CONSTRAINTS,
  SupportApiError,
  confirmSupportAttachment,
  createSupportAttachmentUpload,
  createSupportConversation,
  createSupportTodo,
  getSupportConversation,
  getSupportDashboard,
  listSupportAgents,
  listSupportActivity,
  listSupportConversations,
  listSupportMessages,
  listGlobalSupportTodos,
  listSupportTodos,
  markSupportConversationRead,
  sendSupportMessage,
  streamSupportAttachmentUpload,
  updateSupportConversation,
  updateSupportTodo,
} from "../service/supportService.js";

type SupportRequest = Request & { userId?: string };

function requireActorId(req: SupportRequest): string {
  if (!req.userId) throw new SupportApiError(401, "UNAUTHORIZED", "Authentication is required");
  return req.userId;
}

function supportEndpoint(
  handler: (req: SupportRequest, res: Response) => Promise<unknown>
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req as SupportRequest, res);
    } catch (error: any) {
      // A raw upload can fail because the browser closed the connection. Never
      // attempt a JSON write to a response whose socket is already gone.
      if (res.headersSent || res.destroyed) return;
      if (error instanceof SupportApiError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      console.error("Support API error", error);
      res.status(500).json({
        code: "SUPPORT_INTERNAL_ERROR",
        message: "The support request could not be completed",
      });
    }
  };
}

const userAccess = (req: SupportRequest) => ({
  actorId: requireActorId(req),
  actorRole: "user" as const,
});

const agentAccess = (req: SupportRequest) => ({
  actorId: requireActorId(req),
  actorRole: "agent" as const,
});

function declaredUploadSize(req: SupportRequest): string {
  // Browsers cannot assign Content-Length themselves, so first-party clients
  // send the File.size value in X-File-Size. Server-to-server callers can rely
  // on the transport Content-Length fallback.
  const value = req.get("x-file-size") ?? req.get("content-length");
  if (value === undefined) {
    throw new SupportApiError(
      411,
      "UPLOAD_SIZE_REQUIRED",
      "X-File-Size or Content-Length is required"
    );
  }
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) {
    throw new SupportApiError(
      400,
      "VALIDATION_ERROR",
      "X-File-Size or Content-Length must be an exact integer byte count"
    );
  }
  return value.trim();
}

async function relaySupportAttachment(
  req: SupportRequest,
  res: Response,
  access: ReturnType<typeof userAccess> | ReturnType<typeof agentAccess>
) {
  const abortController = new AbortController();
  const onRequestAborted = () => abortController.abort();
  const onResponseClosed = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClosed);

  try {
    const attachment = await streamSupportAttachmentUpload({
      ...access,
      conversationId: req.params.conversationId,
      fileName: req.query.fileName,
      contentType: req.get("content-type"),
      sizeBytes: declaredUploadSize(req),
      body: req,
      signal: abortController.signal,
    });
    res.status(201).json({ attachment });
  } finally {
    req.removeListener("aborted", onRequestAborted);
    res.removeListener("close", onResponseClosed);
  }
}

export const getSupportUploadConstraints = supportEndpoint(async (_req, res) => {
  res.status(200).json({
    constraints: {
      imageContentTypes: SUPPORT_UPLOAD_CONSTRAINTS.imageContentTypes,
      videoContentTypes: SUPPORT_UPLOAD_CONSTRAINTS.videoContentTypes,
      maxImageBytes: SUPPORT_UPLOAD_CONSTRAINTS.maxImageBytes(),
      maxVideoBytes: SUPPORT_UPLOAD_CONSTRAINTS.maxVideoBytes(),
      maxAttachmentsPerMessage: SUPPORT_UPLOAD_CONSTRAINTS.maxAttachmentsPerMessage,
      maxPendingUploads: SUPPORT_UPLOAD_CONSTRAINTS.maxPendingUploads,
    },
  });
});

export const postSupportConversation = supportEndpoint(async (req, res) => {
  const result = await createSupportConversation({
    actorId: requireActorId(req),
    subject: req.body?.subject,
    category: req.body?.category,
    source: req.body?.source,
    message: req.body?.message,
    diagnostics: req.body?.diagnostics,
  });
  res.status(201).json(result);
});

export const getSupportConversations = supportEndpoint(async (req, res) => {
  const result = await listSupportConversations({
    ...userAccess(req),
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});

export const getSupportConversationById = supportEndpoint(async (req, res) => {
  const conversation = await getSupportConversation({
    ...userAccess(req),
    conversationId: req.params.conversationId,
  });
  res.status(200).json({ conversation });
});

export const getSupportMessages = supportEndpoint(async (req, res) => {
  const result = await listSupportMessages({
    ...userAccess(req),
    conversationId: req.params.conversationId,
    before: req.query.before,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});

export const postSupportMessage = supportEndpoint(async (req, res) => {
  const result = await sendSupportMessage({
    ...userAccess(req),
    conversationId: req.params.conversationId,
    body: req.body?.body,
    attachmentIds: req.body?.attachmentIds,
    clientMessageId: req.body?.clientMessageId,
    diagnostics: req.body?.diagnostics,
  });
  res.status(result.idempotent ? 200 : 201).json({ message: result.message });
});

export const postSupportAttachmentPresign = supportEndpoint(async (req, res) => {
  const result = await createSupportAttachmentUpload({
    ...userAccess(req),
    conversationId: req.params.conversationId,
    fileName: req.body?.fileName,
    contentType: req.body?.contentType,
    sizeBytes: req.body?.sizeBytes,
  });
  res.status(201).json(result);
});

export const postSupportAttachmentUpload = supportEndpoint(async (req, res) => {
  await relaySupportAttachment(req, res, userAccess(req));
});

export const postSupportAttachmentConfirm = supportEndpoint(async (req, res) => {
  const attachment = await confirmSupportAttachment({
    ...userAccess(req),
    conversationId: req.params.conversationId,
    attachmentId: req.params.attachmentId,
  });
  res.status(200).json({ attachment });
});

export const postSupportRead = supportEndpoint(async (req, res) => {
  const result = await markSupportConversationRead({
    ...userAccess(req),
    conversationId: req.params.conversationId,
  });
  res.status(200).json(result);
});

export const getAdminSupportDashboard = supportEndpoint(async (_req, res) => {
  res.status(200).json({ dashboard: await getSupportDashboard() });
});

export const getAdminSupportAgents = supportEndpoint(async (_req, res) => {
  res.status(200).json({ items: await listSupportAgents() });
});

export const getAdminSupportTodoQueue = supportEndpoint(async (req, res) => {
  const result = await listGlobalSupportTodos({
    actorId: requireActorId(req),
    status: req.query.status,
    assigneeId: req.query.assigneeId,
    due: req.query.due,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  res.status(200).json(result);
});

export const getAdminSupportConversations = supportEndpoint(async (req, res) => {
  const result = await listSupportConversations({
    ...agentAccess(req),
    cursor: req.query.cursor,
    limit: req.query.limit,
    status: req.query.status,
    priority: req.query.priority,
    category: req.query.category,
    assigneeId: req.query.assigneeId,
    userId: req.query.userId,
    query: req.query.query,
  });
  res.status(200).json(result);
});

export const getAdminSupportConversationById = supportEndpoint(async (req, res) => {
  const conversation = await getSupportConversation({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
  });
  res.status(200).json({ conversation });
});

export const getAdminSupportMessages = supportEndpoint(async (req, res) => {
  const result = await listSupportMessages({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
    before: req.query.before,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});

export const postAdminSupportMessage = supportEndpoint(async (req, res) => {
  const result = await sendSupportMessage({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
    body: req.body?.body,
    attachmentIds: req.body?.attachmentIds,
    clientMessageId: req.body?.clientMessageId,
    diagnostics: req.body?.diagnostics,
  });
  res.status(result.idempotent ? 200 : 201).json({ message: result.message });
});

export const postAdminSupportNote = supportEndpoint(async (req, res) => {
  const result = await sendSupportMessage({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
    body: req.body?.body,
    internalNote: true,
  });
  res.status(result.idempotent ? 200 : 201).json({ message: result.message });
});

export const patchAdminSupportConversation = supportEndpoint(async (req, res) => {
  const conversation = await updateSupportConversation({
    actorId: requireActorId(req),
    conversationId: req.params.conversationId,
    status: req.body?.status,
    priority: req.body?.priority,
    assigneeId: req.body?.assigneeId,
  });
  res.status(200).json({ conversation });
});

export const postAdminSupportRead = supportEndpoint(async (req, res) => {
  const result = await markSupportConversationRead({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
  });
  res.status(200).json(result);
});

export const postAdminSupportAttachmentPresign = supportEndpoint(async (req, res) => {
  const result = await createSupportAttachmentUpload({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
    fileName: req.body?.fileName,
    contentType: req.body?.contentType,
    sizeBytes: req.body?.sizeBytes,
  });
  res.status(201).json(result);
});

export const postAdminSupportAttachmentUpload = supportEndpoint(async (req, res) => {
  await relaySupportAttachment(req, res, agentAccess(req));
});

export const postAdminSupportAttachmentConfirm = supportEndpoint(async (req, res) => {
  const attachment = await confirmSupportAttachment({
    ...agentAccess(req),
    conversationId: req.params.conversationId,
    attachmentId: req.params.attachmentId,
  });
  res.status(200).json({ attachment });
});

export const getAdminSupportTodos = supportEndpoint(async (req, res) => {
  const items = await listSupportTodos(req.params.conversationId, requireActorId(req));
  res.status(200).json({ items });
});

export const postAdminSupportTodo = supportEndpoint(async (req, res) => {
  const todo = await createSupportTodo({
    actorId: requireActorId(req),
    conversationId: req.params.conversationId,
    title: req.body?.title,
    description: req.body?.description,
    priority: req.body?.priority,
    dueAt: req.body?.dueAt,
    assigneeId: req.body?.assigneeId,
  });
  res.status(201).json({ todo });
});

export const patchAdminSupportTodo = supportEndpoint(async (req, res) => {
  const todo = await updateSupportTodo({
    actorId: requireActorId(req),
    conversationId: req.params.conversationId,
    todoId: req.params.todoId,
    title: req.body?.title,
    description: req.body?.description,
    status: req.body?.status,
    priority: req.body?.priority,
    dueAt: req.body?.dueAt,
    assigneeId: req.body?.assigneeId,
  });
  res.status(200).json({ todo });
});

export const getAdminSupportActivity = supportEndpoint(async (req, res) => {
  const result = await listSupportActivity({
    actorId: requireActorId(req),
    conversationId: req.params.conversationId,
    before: req.query.before,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});
