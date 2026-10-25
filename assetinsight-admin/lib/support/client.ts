"use client";

import type {
  SupportApiErrorPayload,
  SupportAttachment,
  SupportAttachmentResponse,
  SupportConversation,
  SupportConversationCreate,
  SupportConversationCreatedResponse,
  SupportConversationResponse,
  SupportConversationsResponse,
  SupportConstraintsResponse,
  SupportMessageCreate,
  SupportMessage,
  SupportMessageResponse,
  SupportMessagesResponse,
  SupportReadResponse,
  SupportUploadConstraints,
} from "./types";

const SUPPORT_API_ROOT = "/api/admin/support";
const DEFAULT_REQUEST_TIMEOUT_MS = 45 * 1000;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

export class SupportApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly payload?: SupportApiErrorPayload,
  ) {
    super(message);
    this.name = "SupportApiError";
  }
}

function notifyExpiredSession(): void {
  window.dispatchEvent(new Event("admin-session-expired"));
}

function supportUrl(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.split("?", 1)[0].split("/").some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    throw new SupportApiError("Invalid support request path", 400, "INVALID_SUPPORT_ROUTE");
  }
  return `${SUPPORT_API_ROOT}/${normalized}`;
}

function parsePayload(text: string): SupportApiErrorPayload {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SupportApiErrorPayload : {};
  } catch {
    throw new SupportApiError(
      "The support service returned an invalid response",
      502,
      "INVALID_SUPPORT_RESPONSE",
    );
  }
}

/** Typed same-origin JSON transport; bearer tokens never enter browser storage. */
export async function supportRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // A request supplied by a polling hook can be cancelled when its resource
  // changes, while this controller still guarantees a finite upper bound for
  // every ordinary JSON request.
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) forwardAbort();
  else init?.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(supportUrl(path), {
      ...init,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status === 401) notifyExpiredSession();
    const payload = parsePayload(text);
    if (!response.ok) {
      throw new SupportApiError(
        typeof payload.message === "string" ? payload.message : "The support request failed",
        response.status,
        typeof payload.code === "string" ? payload.code : undefined,
        payload,
      );
    }
    return payload as T;
  } catch (error) {
    if (timedOut) {
      throw new SupportApiError(
        "The support request timed out. Please try again.",
        504,
        "SUPPORT_REQUEST_TIMEOUT",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", forwardAbort);
  }
}

export const supportFetcher = <T,>(path: string): Promise<T> => supportRequest<T>(path);

/**
 * Create once when a composer begins a logical send, then retain the returned
 * value until that send succeeds. Reusing it makes network retries idempotent.
 */
export function createSupportClientMessageId(): string {
  return globalThis.crypto.randomUUID();
}

export function createSupportMessage(input: Omit<SupportMessageCreate, "clientMessageId">): SupportMessageCreate {
  return { ...input, clientMessageId: createSupportClientMessageId() };
}

function supportPathWithQuery(
  path: string,
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  };
}

/** Load the server-owned media limits before accepting files in the composer. */
export async function getSupportConstraints(signal?: AbortSignal): Promise<SupportUploadConstraints> {
  const response = await supportRequest<SupportConstraintsResponse>("constraints", { signal });
  return response.constraints;
}

/** List only requests owned by the currently authenticated admin account. */
export function listSupportConversations(
  cursor?: string,
  signal?: AbortSignal,
): Promise<SupportConversationsResponse> {
  return supportRequest<SupportConversationsResponse>(
    supportPathWithQuery("conversations", { limit: 50, cursor }),
    { signal },
  );
}

export function createSupportConversation(
  input: SupportConversationCreate,
  signal?: AbortSignal,
): Promise<SupportConversationCreatedResponse> {
  return supportRequest<SupportConversationCreatedResponse>("conversations", {
    method: "POST",
    ...jsonBody(input),
    signal,
  });
}

export async function getSupportConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<SupportConversation> {
  const response = await supportRequest<SupportConversationResponse>(
    `conversations/${encodeURIComponent(conversationId)}`,
    { signal },
  );
  return response.conversation;
}

export function listSupportMessages(
  conversationId: string,
  before?: string,
  signal?: AbortSignal,
): Promise<SupportMessagesResponse> {
  return supportRequest<SupportMessagesResponse>(
    supportPathWithQuery(
      `conversations/${encodeURIComponent(conversationId)}/messages`,
      { limit: 50, before },
    ),
    { signal },
  );
}

export async function sendSupportMessage(
  conversationId: string,
  input: SupportMessageCreate,
  signal?: AbortSignal,
): Promise<SupportMessage> {
  const response = await supportRequest<SupportMessageResponse>(
    `conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", ...jsonBody(input), signal },
  );
  return response.message;
}

export function markSupportConversationRead(
  conversationId: string,
  signal?: AbortSignal,
): Promise<SupportReadResponse> {
  return supportRequest<SupportReadResponse>(
    `conversations/${encodeURIComponent(conversationId)}/read`,
    { method: "POST", ...jsonBody({}), signal },
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Runtime boundary: only verified, durable media DTOs may reach the chat UI. */
export function isReadySupportAttachment(value: unknown): value is SupportAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<SupportAttachment>;
  return isNonEmptyString(attachment.id)
    && (attachment.type === "image" || attachment.type === "video")
    && isNonEmptyString(attachment.originalName)
    && isNonEmptyString(attachment.contentType)
    && Number.isFinite(attachment.sizeBytes)
    && Number.isFinite(attachment.verifiedSizeBytes)
    && attachment.status === "ready"
    && isNonEmptyString(attachment.url)
    && isNonEmptyString(attachment.completedAt)
    && isNonEmptyString(attachment.createdAt);
}

function uploadErrorPayload(responseText: string): SupportApiErrorPayload {
  if (!responseText) return {};
  try {
    const parsed = JSON.parse(responseText) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SupportApiErrorPayload : {};
  } catch {
    return {};
  }
}

/**
 * Uploads raw bytes through the authenticated Next.js gateway. XHR is used so
 * the UI can report real byte progress; the gateway streams to R2 via the API.
 */
export function supportUploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (percentage: number) => void,
): Promise<SupportAttachmentResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const path = `conversations/${encodeURIComponent(conversationId)}/attachments/upload?fileName=${encodeURIComponent(file.name)}`;
    request.open("POST", supportUrl(path));
    request.withCredentials = true;
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    // Browsers control Content-Length. This explicit header lets the backend
    // validate the declared size while keeping the request body streamed.
    request.setRequestHeader("X-File-Size", String(file.size));

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.addEventListener("load", () => {
      const payload = uploadErrorPayload(request.responseText) as SupportApiErrorPayload & {
        attachment?: unknown;
      };
      if (request.status === 401) notifyExpiredSession();
      if (request.status < 200 || request.status >= 300) {
        reject(new SupportApiError(
          typeof payload.message === "string" ? payload.message : `Upload failed for ${file.name}`,
          request.status || 502,
          typeof payload.code === "string" ? payload.code : undefined,
          payload,
        ));
        return;
      }
      if (!isReadySupportAttachment(payload.attachment)) {
        reject(new SupportApiError(
          "The support service returned an invalid upload response",
          502,
          "INVALID_SUPPORT_ATTACHMENT",
          payload,
        ));
        return;
      }
      onProgress(100);
      resolve({ attachment: payload.attachment });
    });
    request.addEventListener("error", () => reject(
      new SupportApiError(`Upload failed for ${file.name}`, 502, "UPLOAD_NETWORK_ERROR"),
    ));
    request.addEventListener("timeout", () => reject(
      new SupportApiError(`Upload timed out for ${file.name}`, 504, "UPLOAD_TIMEOUT"),
    ));
    request.addEventListener("abort", () => reject(
      new SupportApiError(`Upload cancelled for ${file.name}`, 499, "UPLOAD_CANCELLED"),
    ));
    request.send(file);
  });
}
