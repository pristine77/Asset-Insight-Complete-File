import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import YoutubeConnection, { YoutubeOAuthState, type IYoutubeConnection } from "../models/youtubeConnection.model.js";
import User from "../models/user.model.js";

const SINGLETON = "shared";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNEL_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=2&fields=items(id,snippet(title)),nextPageToken";
const STATE_TTL_MS = 10 * 60_000;
const NETWORK_TIMEOUT_MS = 15_000;
const CONSENT_VERSION = "youtube-automatic-public-v3";
const SECRET_SELECTION = "+encryptedAccessToken +encryptedRefreshToken +accessTokenExpiresAt +clientFingerprint +tokenVersion +refreshLeaseToken +refreshLeaseUntil";

export class YoutubeConnectionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) {
    super(message);
    this.name = "YoutubeConnectionError";
  }
}

type YoutubeConfig = { clientId: string; clientSecret: string; redirectUri: string; key: Buffer; clientFingerprint: string; stateFingerprint: string };

function readConfiguration(): { config?: YoutubeConfig; issue: string | null } {
  const names = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REDIRECT_URI", "YOUTUBE_TOKEN_ENCRYPTION_KEY"] as const;
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) return { issue: `YouTube is not configured. Set ${missing.join(", ")} on the API and report workers.` };
  const clientId = process.env.YOUTUBE_CLIENT_ID!.trim();
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET!.trim();
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI!.trim();
  const rawKey = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY!.trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256 || clientSecret.length > 4096 || /[\r\n]/.test(clientSecret)) {
    return { issue: "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must contain valid Google web application credentials." };
  }
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { return { issue: "YOUTUBE_REDIRECT_URI must be the absolute admin /youtube/callback URL." }; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if ((redirect.protocol !== "https:" && !(redirect.protocol === "http:" && local)) || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/youtube/callback" || redirectUri.length > 2048) {
    return { issue: "YOUTUBE_REDIRECT_URI must use HTTPS and the admin /youtube/callback path (HTTP is allowed only on loopback)." };
  }
  const key = Buffer.from(rawKey, "base64");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(rawKey) || key.length !== 32 || key.toString("base64") !== rawKey) {
    return { issue: "YOUTUBE_TOKEN_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key." };
  }
  // A changed encryption key makes the stored tokens unusable just as a changed
  // OAuth client does. Detect that before a worker accepts new publication work.
  const clientFingerprint = digest(`${clientId}\0${rawKey}`);
  return { config: { clientId, clientSecret, redirectUri, key, clientFingerprint, stateFingerprint: digest(`${clientId}\0${redirectUri}\0${rawKey}`) }, issue: null };
}

function requireConfiguration(): YoutubeConfig {
  const result = readConfiguration();
  if (!result.config) throw new YoutubeConnectionError("YOUTUBE_NOT_CONFIGURED", result.issue!, 503);
  return result.config;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function revisionConflict(): YoutubeConnectionError {
  return new YoutubeConnectionError("YOUTUBE_CONNECTION_CHANGED", "The YouTube connection changed. Refresh its status before continuing.");
}
function validActor(value: string): void {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new YoutubeConnectionError("YOUTUBE_ADMIN_REQUIRED", "An authenticated administrator is required.", 403);
}

/** Context binds encrypted tokens/session URLs to their intended record and purpose. */
export function encryptYoutubeSecret(plaintext: string, context: string): string {
  const { key } = requireConfiguration();
  if (!plaintext || plaintext.length > 32_768 || !context || context.length > 1024) throw new YoutubeConnectionError("YOUTUBE_SECRET_INVALID", "The YouTube credential could not be stored.", 500);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`youtube-v1\0${context}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptYoutubeSecret(encrypted: string, context: string): string {
  const { key } = requireConfiguration();
  try {
    if (!context || context.length > 1024 || encrypted.length > 50_000) throw new Error();
    const [version, rawIv, rawTag, rawCiphertext, extra] = encrypted.split(".");
    if (version !== "v1" || extra !== undefined || ![rawIv, rawTag, rawCiphertext].every((part) => /^[A-Za-z0-9_-]+$/.test(part || ""))) throw new Error();
    const iv = Buffer.from(rawIv!, "base64url"), tag = Buffer.from(rawTag!, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`youtube-v1\0${context}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(rawCiphertext!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new YoutubeConnectionError("YOUTUBE_CREDENTIAL_UNAVAILABLE", "The stored YouTube credential is unavailable. Reconnect the channel.", 503);
  }
}

export type SafeYoutubeConnection = { channelId: string; channelTitle: string; revision: number; connectedAt: string };
export type YoutubeConnectionStatus = {
  configured: boolean;
  publicationMode: "automatic_public";
  configurationIssue: string | null;
  connected: boolean;
  revision: number;
  channel: { id: string; title: string; url: string } | null;
  connectedAt: string | null;
  needsReconnect: boolean;
  privacyStatus: "public";
  canConnect: boolean;
  canAcknowledgeRevocation: boolean;
  dataCleanup: { status: "not_requested" | "pending" | "completed"; requestedAt: string | null; completedAt: string | null; reason: string | null };
  revocation: { status: "not_requested" | "pending" | "completed" | "unavailable" | "needs_attention" | "manually_confirmed"; requestedAt: string | null; completedAt: string | null; manuallyConfirmedAt: string | null };
};

function safeConnection(record: IYoutubeConnection | null): SafeYoutubeConnection | null {
  if (!record?.connected || !record.channelId || !record.connectedAt || record.dataCleanupStatus === "pending" || record.revocationStatus === "pending" || record.revocationStatus === "needs_attention") return null;
  if (Date.now() - (record.channelDataCheckedAt || record.connectedAt).getTime() >= 30 * 86_400_000) return null;
  return { channelId: record.channelId, channelTitle: record.channelTitle || "YouTube channel", revision: record.revision, connectedAt: record.connectedAt.toISOString() };
}

export async function getYoutubeConnectionStatus(): Promise<YoutubeConnectionStatus> {
  const configuration = readConfiguration();
  const record = await YoutubeConnection.findById(SINGLETON).select("+clientFingerprint +oauthExchangeUntil +encryptedRevocationToken").lean();
  const connection = safeConnection(record);
  return {
    configured: Boolean(configuration.config), configurationIssue: configuration.issue, publicationMode: "automatic_public",
    connected: Boolean(connection), revision: record?.revision || 0,
    channel: connection ? { id: connection.channelId, title: connection.channelTitle, url: `https://www.youtube.com/channel/${connection.channelId}` } : null,
    connectedAt: connection?.connectedAt || null, privacyStatus: "public",
    needsReconnect: Boolean(record?.needsReconnect || (record?.connected && configuration.config && record.clientFingerprint !== configuration.config.clientFingerprint)),
    canConnect: record?.dataCleanupStatus !== "pending" && !["pending", "needs_attention"].includes(record?.revocationStatus || "") && !(record?.dataCleanupRequestedAt && record.oauthExchangeUntil && record.oauthExchangeUntil.getTime() > Date.now()),
    canAcknowledgeRevocation: record?.revocationStatus === "needs_attention" && !record.encryptedRevocationToken,
    dataCleanup: { status: record?.dataCleanupStatus || "not_requested", requestedAt: record?.dataCleanupRequestedAt?.toISOString() || null, completedAt: record?.dataCleanupCompletedAt?.toISOString() || null, reason: record?.dataCleanupReason || null },
    revocation: { status: record?.revocationStatus || "not_requested", requestedAt: record?.revocationRequestedAt?.toISOString() || null, completedAt: record?.revocationCompletedAt?.toISOString() || null, manuallyConfirmedAt: record?.revocationManuallyConfirmedAt?.toISOString() || null },
  };
}

export async function getYoutubeConnection(): Promise<SafeYoutubeConnection | null> {
  const { config } = readConfiguration();
  if (!config) return null;
  const record = await YoutubeConnection.findById(SINGLETON).select("+clientFingerprint").lean();
  if (record?.needsReconnect || record?.clientFingerprint !== config.clientFingerprint) return null;
  return safeConnection(record);
}

export async function assertYoutubeConnection(expectedChannelId: string, expectedRevision?: number): Promise<SafeYoutubeConnection> {
  requireConfiguration();
  const connection = await getYoutubeConnection();
  if (!connection) throw new YoutubeConnectionError("YOUTUBE_NOT_CONNECTED", "Connect the YouTube channel before publishing videos.", 409);
  if (connection.channelId !== expectedChannelId || (expectedRevision !== undefined && connection.revision !== expectedRevision)) throw revisionConflict();
  return connection;
}

export async function beginYoutubeConnection(adminId: string, policyConsent: boolean): Promise<{ authorizationUrl: string; expiresAt: string }> {
  validActor(adminId);
  const config = requireConfiguration();
  if (policyConsent !== true) throw new YoutubeConnectionError("YOUTUBE_CONSENT_REQUIRED", "Accept the privacy policy, YouTube terms and automatic public publication of eligible report videos before connecting.", 400);
  let connection: IYoutubeConnection | null;
  try {
    connection = await YoutubeConnection.findOneAndUpdate({ _id: SINGLETON }, { $setOnInsert: { revision: 0, connected: false, tokenVersion: 0 } }, { upsert: true, returnDocument: "after" }).select("+oauthExchangeUntil").lean();
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    connection = await YoutubeConnection.findById(SINGLETON).select("+oauthExchangeUntil").lean();
  }
  if (!connection) throw revisionConflict();
  if (connection.dataCleanupStatus === "pending" || ["pending", "needs_attention"].includes(connection.revocationStatus || "") || (connection.dataCleanupRequestedAt && connection.oauthExchangeUntil && connection.oauthExchangeUntil.getTime() > Date.now())) throw new YoutubeConnectionError("YOUTUBE_DATA_REMOVAL_IN_PROGRESS", "Finish YouTube data removal and access revocation before connecting again.");
  const state = randomBytes(32).toString("base64url"), stateId = digest(state);
  const verifier = randomBytes(64).toString("base64url");
  const now = new Date(), expiresAt = new Date(now.getTime() + STATE_TTL_MS);
  await YoutubeOAuthState.create({
    _id: stateId, adminId, expectedRevision: connection.revision,
    expectedChannelId: connection.connected ? connection.channelId : undefined,
    configFingerprint: config.stateFingerprint,
    encryptedVerifier: encryptYoutubeSecret(verifier, `state:${stateId}`),
    expiresAt, consentVersion: CONSENT_VERSION, consentedAt: now,
  });
  const authorizationUrl = new URL(AUTHORIZATION_URL);
  authorizationUrl.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: OAUTH_SCOPE, access_type: "offline", prompt: "consent select_account", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return { authorizationUrl: authorizationUrl.toString(), expiresAt: expiresAt.toISOString() };
}

async function providerJson(url: string, options: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65_536) throw new Error();
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return { status: response.status, body };
  } catch {
    // Provider errors can contain tokens, codes, and customer metadata.
    throw new YoutubeConnectionError("YOUTUBE_PROVIDER_UNAVAILABLE", "YouTube could not complete the connection request. Try again.", 502);
  }
}

function parseTokens(result: { status: number; body: any }, requireRefresh: boolean) {
  const { status, body } = result;
  if (status !== 200) {
    if (["invalid_grant", "invalid_client"].includes(body.error)) throw new YoutubeConnectionError("YOUTUBE_REAUTHORIZATION_REQUIRED", "YouTube authorization is no longer valid. Reconnect the channel.", 409);
    throw new YoutubeConnectionError("YOUTUBE_AUTHORIZATION_FAILED", "Google could not authorize the YouTube connection. Start Connect again.", 502);
  }
  const expires = Number(body.expires_in);
  if (typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 16_384 || /[\r\n]/.test(body.access_token) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" || !Number.isFinite(expires) || expires < 120 || expires > 86_400 || (requireRefresh && (typeof body.refresh_token !== "string" || !body.refresh_token))) {
    throw new YoutubeConnectionError("YOUTUBE_AUTHORIZATION_INCOMPLETE", "Google did not return usable offline authorization. Start Connect again and grant the requested access.", 409);
  }
  if (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token || body.refresh_token.length > 16_384 || /[\r\n]/.test(body.refresh_token))) throw new YoutubeConnectionError("YOUTUBE_AUTHORIZATION_INCOMPLETE", "Google did not return usable offline authorization. Start Connect again.", 409);
  if ((requireRefresh || body.scope !== undefined) && (typeof body.scope !== "string" || !body.scope.split(/\s+/).includes(OAUTH_SCOPE))) throw new YoutubeConnectionError("YOUTUBE_SCOPE_REQUIRED", "Grant the requested YouTube access before connecting the channel.", 409);
  return { accessToken: body.access_token as string, refreshToken: body.refresh_token as string | undefined, expiresAt: new Date(Date.now() + expires * 1000) };
}

export async function completeYoutubeConnection(adminId: string, code: string, state: string): Promise<YoutubeConnectionStatus> {
  validActor(adminId);
  const config = requireConfiguration();
  if (typeof code !== "string" || !code.trim() || code.length > 4096 || /[\r\n]/.test(code) || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new YoutubeConnectionError("YOUTUBE_CALLBACK_INVALID", "The YouTube connection response is invalid. Start Connect again.", 400);
  const now = new Date();
  const pending = await YoutubeOAuthState.findOneAndUpdate({ _id: digest(state), adminId, consumedAt: { $exists: false }, expiresAt: { $gt: now }, configFingerprint: config.stateFingerprint }, { $set: { consumedAt: now } }, { returnDocument: "after" }).select("+encryptedVerifier +configFingerprint").lean();
  if (!pending) throw new YoutubeConnectionError("YOUTUBE_STATE_INVALID", "This connection request expired or was already used. Start Connect again.", 409);
  const current = await YoutubeConnection.findById(SINGLETON).lean();
  if (!current || current.revision !== pending.expectedRevision || current.dataCleanupStatus === "pending" || ["pending", "needs_attention"].includes(current.revocationStatus || "") || pending.consentVersion !== CONSENT_VERSION) throw revisionConflict();
  // Register provider work before exchanging a code. Removal uses this deadline
  // to wait out pre-fence exchanges before revoking their shared Google grant.
  const exchangeToken = randomUUID();
  const exchange = await YoutubeConnection.updateOne({ _id: SINGLETON, revision: pending.expectedRevision, dataCleanupStatus: { $ne: "pending" }, revocationStatus: { $nin: ["pending", "needs_attention"] }, $or: [{ oauthExchangeUntil: { $exists: false } }, { oauthExchangeUntil: { $lte: new Date() } }] }, { $set: { oauthExchangeUntil: new Date(Date.now() + 60_000), oauthExchangeToken: exchangeToken } });
  if (!exchange.matchedCount) throw revisionConflict();
  let tokens: ReturnType<typeof parseTokens> | undefined;
  try {
    tokens = parseTokens(await providerJson(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code", code, code_verifier: decryptYoutubeSecret(pending.encryptedVerifier, `state:${pending._id}`) }).toString() }), true);
    const channels = await providerJson(CHANNEL_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (channels.status !== 200 || !Array.isArray(channels.body.items) || channels.body.items.length !== 1 || channels.body.nextPageToken) throw new YoutubeConnectionError("YOUTUBE_CHANNEL_REQUIRED", "Choose one YouTube channel with upload access when connecting.", 409);
    const channel = channels.body.items[0];
    if (typeof channel?.id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(channel.id) || typeof channel?.snippet?.title !== "string" || !channel.snippet.title.trim()) throw new YoutubeConnectionError("YOUTUBE_CHANNEL_REQUIRED", "Google did not return a usable YouTube channel. Start Connect again.", 409);
    if (pending.expectedChannelId && channel.id !== pending.expectedChannelId) throw new YoutubeConnectionError("YOUTUBE_CHANNEL_CHANGE_REQUIRES_DISCONNECT", "Disconnect the current channel before connecting a different channel.", 409);
    // Provider exchange can outlive the original middleware read. Do not commit
    // a shared connection for an actor blocked or demoted during authorization.
    if (!await User.exists({ _id: adminId, role: { $in: ["admin", "superadmin"] }, isBlocked: { $ne: true } })) throw new YoutubeConnectionError("YOUTUBE_ADMIN_REQUIRED", "Current administrator access is required to finish connecting YouTube.", 403);
    const revision = pending.expectedRevision + 1;
    const accepted = await YoutubeConnection.findOneAndUpdate({ _id: SINGLETON, revision: pending.expectedRevision, oauthExchangeToken: exchangeToken, oauthExchangeUntil: { $gt: new Date() } }, {
      $set: { connected: true, revision, channelId: channel.id, channelTitle: channel.snippet.title.trim().slice(0, 300), connectedAt: now, connectedBy: adminId, consentVersion: pending.consentVersion, consentedAt: pending.consentedAt, consentedBy: adminId, needsReconnect: false, clientFingerprint: config.clientFingerprint, tokenVersion: 0, encryptedAccessToken: encryptYoutubeSecret(tokens.accessToken, `connection:${revision}:${channel.id}:access`), encryptedRefreshToken: encryptYoutubeSecret(tokens.refreshToken!, `connection:${revision}:${channel.id}:refresh`), accessTokenExpiresAt: tokens.expiresAt, authorizationCheckedAt: now, channelDataCheckedAt: now, authorizationCheckNextAt: new Date(now.getTime() + 86_400_000) },
      $unset: { refreshLeaseToken: 1, refreshLeaseUntil: 1, disconnectedAt: 1, disconnectedBy: 1, revocationStatus: 1, revocationRequestedAt: 1, revocationCompletedAt: 1, oauthExchangeUntil: 1, oauthExchangeToken: 1 },
    }, { returnDocument: "after" }).lean();
    if (!accepted) throw revisionConflict();
    return await getYoutubeConnectionStatus();
  } catch (error) {
    // Token exchange may succeed even when channel validation/current admin/CAS
    // fails. If removal raced that exchange, preserve the issued grant for the
    // already-authorized revoke rather than silently abandoning its credential.
    if (tokens) {
      const { retainRevocationForAbandonedAuthorization } = await import("./youtubeDataLifecycleService.js");
      await retainRevocationForAbandonedAuthorization(pending.expectedRevision, tokens.refreshToken || tokens.accessToken);
    }
    throw error;
  } finally {
    // A normal failure has finished its provider work and can release the lease.
    // A removal changes revision and deliberately retains its exchange barrier.
    await YoutubeConnection.updateOne({ _id: SINGLETON, revision: pending.expectedRevision, oauthExchangeToken: exchangeToken }, { $unset: { oauthExchangeUntil: 1, oauthExchangeToken: 1 } });
  }
}

export async function disconnectYoutubeConnection(adminId: string, revision: number): Promise<YoutubeConnectionStatus> {
  validActor(adminId);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new YoutubeConnectionError("YOUTUBE_REVISION_REQUIRED", "Refresh the connection status before disconnecting.", 400);
  const result = await YoutubeConnection.findOneAndUpdate({ _id: SINGLETON, revision, dataCleanupStatus: { $ne: "pending" }, revocationStatus: { $nin: ["pending", "needs_attention"] } }, {
    $set: { connected: false, needsReconnect: false, disconnectedAt: new Date(), disconnectedBy: adminId },
    $inc: { revision: 1, tokenVersion: 1 },
    $unset: { encryptedAccessToken: 1, encryptedRefreshToken: 1, accessTokenExpiresAt: 1, clientFingerprint: 1, refreshLeaseToken: 1, refreshLeaseUntil: 1, channelId: 1, channelTitle: 1, connectedAt: 1, connectedBy: 1 },
  }, { returnDocument: "after" }).lean();
  if (!result) throw revisionConflict();
  // This disconnect removes local authority immediately. Do not revoke the Google
  // project grant here: revocation can also invalidate unrelated Google features.
  return getYoutubeConnectionStatus();
}

export async function getYoutubeAccessToken(expectedChannelId: string, expectedRevision?: number, options: { forceRefresh?: boolean } = {}): Promise<string> {
  const config = requireConfiguration();
  const connection = await assertYoutubeConnection(expectedChannelId, expectedRevision);
  const filter = { _id: SINGLETON, connected: true, channelId: expectedChannelId, revision: connection.revision, clientFingerprint: config.clientFingerprint, needsReconnect: { $ne: true } };
  const record = await YoutubeConnection.findOne(filter).select(SECRET_SELECTION).lean();
  if (!record) throw revisionConflict();
  if (!options.forceRefresh && record.encryptedAccessToken && record.accessTokenExpiresAt && record.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    const token = decryptYoutubeSecret(record.encryptedAccessToken, `connection:${record.revision}:${expectedChannelId}:access`);
    await assertYoutubeConnection(expectedChannelId, record.revision);
    return token;
  }
  if (!record.encryptedRefreshToken) throw new YoutubeConnectionError("YOUTUBE_REAUTHORIZATION_REQUIRED", "Reconnect YouTube to restore offline access.", 409);
  const leaseToken = randomUUID();
  const lease = await YoutubeConnection.findOneAndUpdate({ ...filter, tokenVersion: record.tokenVersion, $or: [{ refreshLeaseUntil: { $exists: false } }, { refreshLeaseUntil: { $lte: new Date() } }] }, { $set: { refreshLeaseToken: leaseToken, refreshLeaseUntil: new Date(Date.now() + 30_000) } }, { returnDocument: "after" }).select(SECRET_SELECTION).lean();
  if (!lease) {
    await assertYoutubeConnection(expectedChannelId, record.revision);
    throw new YoutubeConnectionError("YOUTUBE_REFRESH_IN_PROGRESS", "YouTube authorization is refreshing. Retry shortly.", 503);
  }
  const owned = { ...filter, tokenVersion: record.tokenVersion, refreshLeaseToken: leaseToken };
  try {
    const refreshToken = decryptYoutubeSecret(lease.encryptedRefreshToken!, `connection:${record.revision}:${expectedChannelId}:refresh`);
    const tokens = parseTokens(await providerJson(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString() }), false);
    const saved = await YoutubeConnection.updateOne(owned, { $set: { encryptedAccessToken: encryptYoutubeSecret(tokens.accessToken, `connection:${record.revision}:${expectedChannelId}:access`), encryptedRefreshToken: encryptYoutubeSecret(tokens.refreshToken || refreshToken, `connection:${record.revision}:${expectedChannelId}:refresh`), accessTokenExpiresAt: tokens.expiresAt, authorizationCheckedAt: new Date() }, $inc: { tokenVersion: 1 }, $unset: { refreshLeaseToken: 1, refreshLeaseUntil: 1 } });
    if (!saved.matchedCount) throw revisionConflict();
    await assertYoutubeConnection(expectedChannelId, record.revision);
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof YoutubeConnectionError && error.code === "YOUTUBE_REAUTHORIZATION_REQUIRED") {
      const { invalidateYoutubeAuthorization } = await import("./youtubeDataLifecycleService.js");
      await invalidateYoutubeAuthorization(record.revision);
    }
    throw error;
  } finally {
    await YoutubeConnection.updateOne({ _id: SINGLETON, revision: record.revision, refreshLeaseToken: leaseToken }, { $unset: { refreshLeaseToken: 1, refreshLeaseUntil: 1 } });
  }
}

/** Daily refresh of the only cached Google channel metadata. */
export async function refreshYoutubeChannelMetadata(channelId: string, revision: number, accessToken: string): Promise<void> {
  await assertYoutubeConnection(channelId, revision);
  const result = await providerJson(CHANNEL_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (result.status === 401) {
    const { invalidateYoutubeAuthorization } = await import("./youtubeDataLifecycleService.js");
    await invalidateYoutubeAuthorization(revision);
    throw new YoutubeConnectionError("YOUTUBE_REAUTHORIZATION_REQUIRED", "YouTube access is no longer valid. Reconnect after stored data is removed.");
  }
  const channel = result.body?.items?.[0];
  if (result.status !== 200 || result.body.items?.length !== 1 || channel?.id !== channelId || typeof channel?.snippet?.title !== "string" || !channel.snippet.title.trim()) throw new YoutubeConnectionError("YOUTUBE_CHANNEL_UNAVAILABLE", "YouTube channel information could not be verified.", 502);
  const saved = await YoutubeConnection.updateOne({ _id: SINGLETON, revision, connected: true, channelId, dataCleanupStatus: { $ne: "pending" } }, { $set: { channelTitle: channel.snippet.title.trim().slice(0, 300), channelDataCheckedAt: new Date() } });
  if (!saved.matchedCount) throw revisionConflict();
}
