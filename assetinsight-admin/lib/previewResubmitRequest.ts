const MAX_BODY_BYTES = 2_048;

export class PreviewResubmitRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PreviewResubmitRequestError";
    this.status = status;
  }
}

/** Shared same-origin, streaming byte limit for cookie-authenticated preview actions. */
export async function readPreviewMutationJson(request: Request, maxBodyBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
    || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim()
    || new URL(request.url).protocol.replace(/:$/, "");
  const expectedOrigin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    || (origin ? origin !== expectedOrigin : fetchSite !== "same-origin")) {
    throw new PreviewResubmitRequestError("This action must be requested from the admin application.", 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new PreviewResubmitRequestError("A JSON request is required.", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBodyBytes) {
    throw new PreviewResubmitRequestError("The request is too large.", 413);
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          throw new PreviewResubmitRequestError("The request is too large.", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PreviewResubmitRequestError("The request must contain valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PreviewResubmitRequestError("A JSON object is required.", 400);
  }
  return body as Record<string, unknown>;
}

/** Cookie-authenticated, small, revision-only mutation. Never forward actor/data fields. */
export async function readPreviewResubmitRequest(request: Request): Promise<{ baseRevision: string }> {
  const body = await readPreviewMutationJson(request);
  const revision = body.baseRevision;
  if (typeof revision !== "string" || !revision.trim() || revision.length > 512) {
    throw new PreviewResubmitRequestError("Reload and review the saved preview before resubmitting.", 400);
  }
  return { baseRevision: revision };
}

export type PreviewReminderRequest = {
  subject: string;
  message: string;
  baseRevision: string;
  requestId: string;
};

/** Recipient/report state and actor are authoritative backend data, never caller fields. */
export async function readPreviewReminderRequest(request: Request): Promise<PreviewReminderRequest> {
  const body = await readPreviewMutationJson(request, 65_536);
  const { subject, message, baseRevision, requestId } = body;
  if (typeof subject !== "string" || subject.trim().length < 3 || subject.length > 180 || /[\r\n\x00-\x1f\x7f]/.test(subject)) {
    throw new PreviewResubmitRequestError("Enter a subject of 3–180 characters on one line.", 400);
  }
  if (typeof message !== "string" || message.trim().length < 10 || message.length > 10_000 || /\x00/.test(message)) {
    throw new PreviewResubmitRequestError("Enter a message of 10–10,000 characters.", 400);
  }
  if (typeof baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(baseRevision)) {
    throw new PreviewResubmitRequestError("Reload the current notification draft before sending.", 400);
  }
  if (typeof requestId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)) {
    throw new PreviewResubmitRequestError("A valid notification request ID is required.", 400);
  }
  return { subject, message, baseRevision, requestId };
}
