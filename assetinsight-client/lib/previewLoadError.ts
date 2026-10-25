/** A queue read failure never means the owner's saved reports were deleted. */
export function previewLoadError(error: any): string {
  const status = Number(error?.response?.status);
  if (status === 401) return "Your session has expired. Sign in again to load your previews.";
  if (status === 403) return "Access to previews was refused. Check your account or device approval with an administrator.";
  if (status === 429) return "The server is receiving too many requests. Wait a moment, then retry.";
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) return "The preview request timed out. Your saved reports are unchanged; retry to refresh the list.";
  if (status >= 500) return "The server could not load this preview list. Your saved reports are unchanged; retry shortly.";
  const message = error?.response?.data?.message;
  if (typeof message === "string" && message.trim() && !/status code|stack|<html/i.test(message)) return message.slice(0, 400);
  if (!error?.response && (error?.code === 'ERR_NETWORK' || error?.message === 'Network Error')) return "The app could not reach the server. This can happen even with an internet connection. Retry shortly; your saved reports are unchanged.";
  return "The preview list could not be read. Retry to refresh it; your saved reports are unchanged.";
}
