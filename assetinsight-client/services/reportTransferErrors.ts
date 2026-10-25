type TransferIntent = "save" | "submit";
type ErrorEnvelope = { response?: { status?: number; data?: unknown }; message?: unknown; code?: unknown };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function reportTransferErrorData(error: unknown) {
  const failure = error as ErrorEnvelope | undefined;
  const body = record(failure?.response?.data);
  return { status: failure?.response?.status, code: typeof body.code === "string" ? body.code : "", data: record(body.data) };
}

export function canSaveSeparateReportDraft(error: unknown): boolean {
  const { status, code, data } = reportTransferErrorData(error);
  return status === 409 && code === "UPLOAD_SESSION_REPORT_UNAVAILABLE" &&
    data.accepted === true && data.reportAvailable === false && data.canCreateSeparate === true;
}

export function isPreviousReportReceipt(value: unknown): boolean {
  const response = record(value);
  const receipt = typeof response.reportId === "string" ? response : record(response.data);
  return receipt.reusedAcceptance === true || receipt.alreadyQueued === true || receipt.resumed === true;
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  const bareHttpStatus = /^(?:http(?:\/\d(?:\.\d)?)?\s+)?(?:(?:status(?:\s+code)?|error)\s*[:=]?\s*)?[1-5]\d{2}(?:\s*[-:]?\s*(?:bad request|unauthori[sz]ed|forbidden|not found|request timeout|conflict|gone|unprocessable (?:entity|content)|too many requests|internal server error|bad gateway|service unavailable|gateway timeout|error))?[.!]?$/i;
  if (bareHttpStatus.test(message)) return undefined;
  if (!message || message.length > 1500 || /[<>]|https?:\/\/|\b(?:bearer|authorization|access_token|refresh_token|x-amz|x-goog|stacktrace)\b|(?:^|\n)\s*at\s+.+:\d|request failed with status code|^network error$|timeout of \d+ms/i.test(message)) return undefined;
  return message;
}

export function safeReportOperationError(error: unknown, fallback: string): string {
  const failure = error as ErrorEnvelope | undefined;
  const body = record(failure?.response?.data);
  const status = failure?.response?.status;
  return (status && status < 500 ? safeMessage(body.message) : !status ? safeMessage(failure?.message) : undefined) || fallback;
}

export function reportTransferErrorMessage(error: unknown, intent: TransferIntent): string {
  const failure = error as ErrorEnvelope | undefined;
  const body = record(failure?.response?.data);
  const { status, code } = reportTransferErrorData(error);
  const retained = "Your current form and selected media have not been cleared. Keep this page open.";
  const known: Record<string, string> = {
    STALE_DRAFT_REVISION: "A newer version of this draft is already saved. Check Drafts in another tab before saving again; do not overwrite another device's changes.",
    DRAFT_REVISION_CONFLICT: "This save differs from the version already saved. Check the latest saved draft before saving again.",
    DRAFT_MEDIA_CONFLICT: "The saved photo information no longer matches this draft. Check its latest saved version before retrying.",
    DRAFT_ALREADY_PROMOTED: "This saved draft has already become a report. Check My Reports before starting a separate report.",
    UPLOAD_SESSION_REPORT_UNAVAILABLE: "The report from the previous submission is no longer available. The old submission cannot be reused. Review your current lots and media before explicitly starting a separate report.",
  };
  if (known[code]) return `${known[code]} ${retained}`;
  const responseMessage = status && status < 500 ? safeMessage(body.message) : undefined;
  if (responseMessage) return `${responseMessage} ${retained}`;
  if (!status && /network|failed to fetch|timeout|timed out|ECONN|ERR_NETWORK/i.test(String(failure?.message || failure?.code || ""))) {
    return `The connection was interrupted. ${intent === "save" ? "The latest draft save could not be confirmed. Retry Save draft when your connection is stable." : "Upload acceptance could not be confirmed. Retry this same upload when your connection is stable; do not recreate the report."} ${retained}`;
  }
  if (status === 409) return `This ${intent === "save" ? "draft save" : "submission"} conflicts with saved work. Check Drafts and My Reports in another tab before retrying. ${retained}`;
  if (status === 401 || status === 403) return `Your account or device access could not be confirmed. Restore access in another tab before retrying. ${retained}`;
  const localMessage = !status ? safeMessage(failure?.message) : undefined;
  return `${localMessage || (intent === "save" ? "The draft save could not be confirmed. Retry Save draft when your connection is stable." : "The upload could not be confirmed. Retry this same upload when your connection is stable; do not recreate the report.")} ${retained}`;
}

/** Only a final create/complete receipt can authorize clearing a capture form. */
export function assertReportUploadAccepted(value: unknown): void {
  const response = record(value);
  const receipt = typeof response.reportId === "string" ? response : record(response.data);
  const reportId = receipt.reportId;
  const status = typeof receipt.status === "string" ? receipt.status.toLowerCase() : "";
  const phase = typeof receipt.phase === "string" ? receipt.phase.toLowerCase() : "";
  const finalState = ["processing", "queued", "processed", "preview", "done", "completed", "error", "failed"].includes(status) || ["processing", "done", "error"].includes(phase);
  const hasJob = typeof receipt.jobId === "string" && Boolean(receipt.jobId.trim());
  if (typeof reportId !== "string" || !reportId.trim() || response.accepted === false || response.reportAvailable === false || receipt.accepted === false || receipt.reportAvailable === false || response.code === "UPLOAD_SESSION_REPORT_UNAVAILABLE" || receipt.code === "UPLOAD_SESSION_REPORT_UNAVAILABLE" || ["upload", "uploading", "preparing", "unavailable"].includes(status) || phase === "upload" || receipt.readyToComplete === true || !(receipt.accepted === true || (hasJob && finalState))) {
    throw new Error("The server did not confirm report acceptance. Retry this same upload; do not recreate the report.");
  }
}
