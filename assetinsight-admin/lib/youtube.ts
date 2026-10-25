export type YouTubeStatus = {
  configured: boolean;
  configurationIssue: string | null;
  connected: boolean;
  needsReconnect: boolean;
  revision: number;
  channel: { id: string; title: string; url: string } | null;
  connectedAt: string | null;
  privacyStatus: "public" | "private";
  publicationMode: "automatic_public" | null;
  canConnect: boolean;
  canAcknowledgeRevocation: boolean;
  dataCleanup: { status: "not_requested" | "pending" | "completed"; requestedAt: string | null; completedAt: string | null; reason: string | null };
  revocation: { status: "not_requested" | "pending" | "completed" | "unavailable" | "needs_attention" | "manually_confirmed"; requestedAt: string | null; completedAt: string | null; manuallyConfirmedAt: string | null };
};
export type YouTubeCallback = { code: string; state: string };
const invalid = () => new Error("YouTube connection details could not be verified. Refresh and try again.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}
export function parseYouTubeStatus(value: unknown): YouTubeStatus {
  const data = object(value);
  if (typeof data.configured !== "boolean" || typeof data.connected !== "boolean" || typeof data.needsReconnect !== "boolean" || !["public", "private"].includes(String(data.privacyStatus)) || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0) throw invalid();
  if (data.publicationMode != null && data.publicationMode !== "automatic_public") throw invalid();
  let channel: YouTubeStatus["channel"] = null;
  if (data.channel !== null) {
    const item = object(data.channel);
    const id = text(item.id, 100);
    if (!/^UC[\w-]{22}$/.test(id)) throw invalid();
    channel = { id, title: text(item.title, 300), url: `https://www.youtube.com/channel/${id}` };
  }
  if (data.connected !== Boolean(channel)) throw invalid();
  const connectedAt = data.connectedAt == null ? null : text(data.connectedAt, 50);
  if (connectedAt && !Number.isFinite(Date.parse(connectedAt))) throw invalid();
  function lifecycleDate(value: unknown): string | null {
    if (value == null) return null;
    const result = text(value, 50);
    if (!Number.isFinite(Date.parse(result))) throw invalid();
    return result;
  }
  const cleanup = data.dataCleanup === undefined ? { status: "not_requested" } : object(data.dataCleanup);
  const revocation = data.revocation === undefined ? { status: "not_requested" } : object(data.revocation);
  if (!["not_requested", "pending", "completed"].includes(String(cleanup.status)) || !["not_requested", "pending", "completed", "unavailable", "needs_attention", "manually_confirmed"].includes(String(revocation.status)) || (data.canConnect !== undefined && typeof data.canConnect !== "boolean") || (data.canAcknowledgeRevocation !== undefined && typeof data.canAcknowledgeRevocation !== "boolean")) throw invalid();
  return {
    configured: data.configured,
    configurationIssue: data.configurationIssue == null ? null : text(data.configurationIssue, 1000),
    connected: data.connected,
    needsReconnect: data.needsReconnect,
    revision: data.revision as number,
    channel,
    connectedAt,
    privacyStatus: data.privacyStatus as YouTubeStatus["privacyStatus"],
    publicationMode: data.publicationMode === "automatic_public" ? "automatic_public" : null,
    canConnect: data.canConnect === true,
    canAcknowledgeRevocation: data.canAcknowledgeRevocation === true,
    dataCleanup: { status: cleanup.status as YouTubeStatus["dataCleanup"]["status"], requestedAt: lifecycleDate(cleanup.requestedAt), completedAt: lifecycleDate(cleanup.completedAt), reason: cleanup.reason == null ? null : text(cleanup.reason, 500) },
    revocation: { status: revocation.status as YouTubeStatus["revocation"]["status"], requestedAt: lifecycleDate(revocation.requestedAt), completedAt: lifecycleDate(revocation.completedAt), manuallyConfirmedAt: lifecycleDate(revocation.manuallyConfirmedAt) },
  };
}
export function youtubeConnectBody(value: Record<string, unknown>): { policyConsent: true } {
  if (Object.keys(value).length !== 1 || value.policyConsent !== true) throw new Error("Review and accept the YouTube terms and privacy policy before connecting.");
  return { policyConsent: true };
}
export function youtubeCompleteBody(value: Record<string, unknown>): YouTubeCallback {
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "code") || !Object.hasOwn(value, "state")) throw invalid();
  const code = text(value.code, 4096);
  const state = text(value.state, 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(state)) throw invalid();
  return { code, state };
}
export function youtubeDisconnectBody(value: Record<string, unknown>): { revision: number } {
  if (Object.keys(value).length !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("Refresh the channel connection before disconnecting.");
  return { revision: value.revision as number };
}
export function youtubeEraseBody(value: Record<string, unknown>): { revision: number; confirm: true } {
  if (Object.keys(value).length !== 2 || value.confirm !== true || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Refresh the connection and confirm removal before continuing.");
  return { revision: value.revision as number, confirm: true };
}
export function parseYouTubeCallback(search: string): YouTubeCallback {
  const params = new URLSearchParams(search);
  if (params.has("error")) throw new Error("Google authorization was not completed. Return to YouTube settings to start again.");
  if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1) throw new Error("This connection link is incomplete or expired. Start again from YouTube settings.");
  return youtubeCompleteBody({ code: params.get("code"), state: params.get("state") });
}
export function parseYouTubeAuthorization(value: unknown, adminOrigin?: string): { authorizationUrl: string; expiresAt: string } {
  const data = object(value);
  const authorizationUrl = text(data.authorizationUrl, 8192);
  const url = new URL(authorizationUrl);
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash) throw invalid();
  if (["state", "response_type", "redirect_uri"].some(key => url.searchParams.getAll(key).length !== 1) || !/^[A-Za-z0-9_-]{32,256}$/.test(url.searchParams.get("state") || "") || url.searchParams.get("response_type") !== "code") throw invalid();
  const redirect = new URL(url.searchParams.get("redirect_uri") || "");
  if (redirect.pathname !== "/youtube/callback" || redirect.search || redirect.hash || redirect.username || redirect.password || (adminOrigin && redirect.origin !== adminOrigin)) throw invalid();
  const expiresAt = text(data.expiresAt, 50);
  if (!Number.isFinite(Date.parse(expiresAt))) throw invalid();
  return { authorizationUrl, expiresAt };
}

const connectionIssues: Record<string, string> = {
  YOUTUBE_STATE_INVALID: "This connection request expired, was already used, or belongs to another administrator. Return to YouTube settings and start Connect with Google again.",
  YOUTUBE_CALLBACK_INVALID: "The Google connection link is invalid. Start Connect with Google again from YouTube settings.",
  YOUTUBE_REAUTHORIZATION_REQUIRED: "Google rejected the authorization. Start Connect with Google again and finish promptly using the same admin account.",
  YOUTUBE_AUTHORIZATION_FAILED: "Google could not authorize this connection. Check the Google OAuth configuration, then start Connect with Google again.",
  YOUTUBE_AUTHORIZATION_INCOMPLETE: "Google did not grant usable offline access. Start Connect with Google again and allow the requested YouTube access.",
  YOUTUBE_SCOPE_REQUIRED: "The required YouTube permission was not granted. Start Connect with Google again and select the requested YouTube permission on Google's consent screen.",
  YOUTUBE_CHANNEL_REQUIRED: "Google did not confirm a single YouTube channel. Check that the selected Google account owns a YouTube channel, then reconnect and choose that channel.",
  YOUTUBE_CHANNEL_CHANGE_REQUIRES_DISCONNECT: "A different YouTube channel is already connected. Review the current channel in settings before disconnecting it and connecting another.",
  YOUTUBE_ADMIN_REQUIRED: "Administrator access is required. Sign in with the same administrator account that started this connection.",
  YOUTUBE_NOT_CONFIGURED: "Google connection setup is incomplete on the backend. Return to YouTube settings to see the configuration issue.",
  YOUTUBE_CONNECTION_CHANGED: "YouTube settings changed during authorization. Refresh the status in settings before starting again.",
  YOUTUBE_PROVIDER_UNAVAILABLE: "Google could not be reached or returned an unusable response. Check the connection status in settings before starting again.",
  YOUTUBE_CONNECTION_UNAVAILABLE: "YouTube connection settings are temporarily unavailable. Check the status in settings before starting again.",
};

/** Project only known public errors; never display provider bodies or credentials. */
export function youtubeConnectionFailure(value: unknown, status: number): { code?: string; message: string } {
  if (status === 401) return { message: "Your admin session expired. Sign in again, then start Connect with Google from YouTube settings." };
  const code = value && typeof value === "object" && "code" in value ? value.code : null;
  if (typeof code === "string" && Object.hasOwn(connectionIssues, code)) return { code, message: `${connectionIssues[code]} (${code})` };
  if (status === 403) return { message: "This connection request was denied. Check your administrator access and open YouTube settings on the configured admin website before starting again." };
  return { message: `The connection could not be confirmed (HTTP ${status}). Check the status in YouTube settings before starting again.` };
}

/** Refresh authentication with a safe read BEFORE the one-time code exchange. */
export async function finishYouTubeConnection(input: YouTubeCallback, request: typeof fetch = fetch, cancelled?: AbortSignal): Promise<YouTubeStatus> {
  const call = async (url: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      cancelled?.throwIfAborted();
      response = await request(url, { ...init, signal: cancelled ? AbortSignal.any([cancelled, init.signal!]) : init.signal });
    }
    catch { throw new Error("The connection response was interrupted or timed out. Check the status in YouTube settings before starting again. Do not reuse this connection link."); }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(youtubeConnectionFailure(payload, response.status).message);
    return payload;
  };
  // The status BFF may refresh HttpOnly cookies on 401. Completion must never
  // replay a consumed code after a timeout, a refresh or a double click.
  parseYouTubeStatus(await call("/api/admin/youtube/status", { cache: "no-store", signal: AbortSignal.timeout(15_000) }));
  const result = parseYouTubeStatus(await call("/api/admin/youtube/complete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(45_000),
  }));
  // Two sequential provider requests can each take 15 seconds. Allow their
  // backend response to arrive instead of aborting at their combined deadline.
  if (!result.connected || !result.channel || result.needsReconnect) throw new Error("The channel was not connected. Check the status in YouTube settings before starting again.");
  return result;
}
