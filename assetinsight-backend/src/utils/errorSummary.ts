const MAX_ERROR_MESSAGE_LENGTH = 500;

type ErrorLike = {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: {
    status?: unknown;
    data?: {
      message?: unknown;
      code?: unknown;
      error?: unknown;
    };
  };
};

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Produces a compact, non-sensitive error object for logs and persisted job
 * messages. In particular, this avoids logging Axios request headers, payloads,
 * credentials, and push tokens.
 */
export function summarizeError(error: unknown): {
  message: string;
  code?: string;
  status?: string;
} {
  if (typeof error === "string") {
    return { message: cleanValue(error) || "Unknown error" };
  }

  if (!error || typeof error !== "object") {
    return { message: cleanValue(error) || "Unknown error" };
  }

  const value = error as ErrorLike;
  const responseData = value.response?.data;
  const message =
    cleanValue(responseData?.message) ||
    cleanValue(responseData?.error) ||
    cleanValue(value.message) ||
    "Unknown error";
  const code = cleanValue(responseData?.code) || cleanValue(value.code);
  const status =
    cleanValue(value.response?.status) ||
    cleanValue(value.statusCode) ||
    cleanValue(value.status);

  return {
    message,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
  };
}

export function formatErrorSummary(error: unknown): string {
  const summary = summarizeError(error);
  return [
    summary.message,
    summary.code ? `code=${summary.code}` : undefined,
    summary.status ? `status=${summary.status}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function createErrorWithCause(prefix: string, cause: unknown): Error {
  const wrapped = new Error(`${prefix}: ${formatErrorSummary(cause)}`) as Error & {
    cause?: unknown;
  };
  // Never attach the original Axios/provider object: Node may print request
  // headers, bodies, tokens, and credentials when it renders Error.cause.
  wrapped.cause = summarizeError(cause);
  return wrapped;
}
