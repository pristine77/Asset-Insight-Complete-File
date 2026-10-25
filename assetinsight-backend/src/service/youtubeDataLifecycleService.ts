import { randomUUID } from "node:crypto";
import YoutubeConnection, { YoutubeOAuthState, type IYoutubeConnection } from "../models/youtubeConnection.model.js";
import YoutubeVideo from "../models/youtubeVideo.model.js";
import User from "../models/user.model.js";
import { decryptYoutubeSecret, encryptYoutubeSecret, getYoutubeAccessToken, getYoutubeConnectionStatus, refreshYoutubeChannelMetadata, YoutubeConnectionError } from "./youtubeConnectionService.js";

const DAY_MS = 86_400_000;
const SINGLETON = "shared";
const SECRET_FIELDS = "+encryptedAccessToken +encryptedRefreshToken +encryptedRevocationToken +revocationTokenContext +revocationAttempts +revocationNextAttemptAt +dataCleanupThroughRevision +lifecycleLeaseToken +lifecycleLeaseUntil +authorizationCheckNextAt +oauthExchangeUntil";
type RemovalReason = NonNullable<IYoutubeConnection["dataCleanupReason"]>;
const date = (value: unknown): number => value instanceof Date ? value.getTime() : 0;
const removalConflict = () => new YoutubeConnectionError("YOUTUBE_CONNECTION_CHANGED", "The YouTube connection changed. Refresh its status before continuing.");

// This is an intent in the same singleton write that fences every publication and
// token refresh. No report, original, artifact or provider video is deleted.
async function stageRemoval(record: IYoutubeConnection, reason: RemovalReason, revoke: boolean, attempt = 0): Promise<boolean> {
  const now = new Date();
  let encryptedRevocationToken: string | undefined;
  let revocationTokenContext: string | undefined;
  if (revoke && record.channelId) {
    try {
      const kind = record.encryptedRefreshToken ? "refresh" : "access";
      const encrypted = record.encryptedRefreshToken || record.encryptedAccessToken;
      if (encrypted) {
        const token = decryptYoutubeSecret(encrypted, `connection:${record.revision}:${record.channelId}:${kind}`);
        revocationTokenContext = `revocation:${record.revision + 1}`;
        encryptedRevocationToken = encryptYoutubeSecret(token, revocationTokenContext);
      }
    } catch { /* Erasure must remain possible after a lost/changed encryption key. */ }
  }
  const revocationStatus = encryptedRevocationToken ? "pending" : "unavailable";
  const result = await YoutubeConnection.updateOne({ _id: SINGLETON, revision: record.revision, oauthExchangeUntil: record.oauthExchangeUntil || { $exists: false }, dataCleanupStatus: { $ne: "pending" }, revocationStatus: { $ne: "pending" } }, {
    $set: {
      connected: false, needsReconnect: reason !== "admin_erase" && reason !== "admin_revoke",
      dataCleanupStatus: "pending", dataCleanupReason: reason,
      dataCleanupRequestedAt: now, dataCleanupThroughRevision: record.revision,
      revocationStatus, revocationRequestedAt: now, revocationAttempts: 0,
      ...(encryptedRevocationToken ? { encryptedRevocationToken, revocationTokenContext, revocationNextAttemptAt: new Date(Math.max(now.getTime(), date(record.oauthExchangeUntil))) } : {}),
    },
    $inc: { revision: 1, tokenVersion: 1 },
    $unset: {
      channelId: 1, channelTitle: 1, connectedAt: 1, connectedBy: 1,
      consentVersion: 1, consentedAt: 1, consentedBy: 1, disconnectedAt: 1, disconnectedBy: 1,
      clientFingerprint: 1, encryptedAccessToken: 1, encryptedRefreshToken: 1,
      accessTokenExpiresAt: 1, refreshLeaseToken: 1, refreshLeaseUntil: 1,
      authorizationCheckedAt: 1, authorizationCheckNextAt: 1, channelDataCheckedAt: 1,
      dataCleanupCompletedAt: 1, lifecycleLeaseToken: 1, lifecycleLeaseUntil: 1,
      oauthExchangeToken: 1,
      revocationCompletedAt: 1,
      ...(!encryptedRevocationToken ? { encryptedRevocationToken: 1, revocationTokenContext: 1, revocationNextAttemptAt: 1 } : {}),
    },
  });
  if (result.matchedCount === 1) return true;
  if (attempt < 3) {
    const latest = await YoutubeConnection.findOne({ _id: SINGLETON, revision: record.revision }).select(SECRET_FIELDS).lean();
    if (latest && date(latest.oauthExchangeUntil) !== date(record.oauthExchangeUntil)) return stageRemoval(latest, reason, revoke, attempt + 1);
  }
  return false;
}

async function requestRemoval(adminId: string, revision: number, confirm: boolean, revoke: boolean) {
  if (!/^[a-f\d]{24}$/i.test(adminId) || !await User.exists({ _id: adminId, role: { $in: ["admin", "superadmin"] }, isBlocked: { $ne: true } })) throw new YoutubeConnectionError("YOUTUBE_ADMIN_REQUIRED", "Current administrator access is required.", 403);
  if (confirm !== true) throw new YoutubeConnectionError("YOUTUBE_REMOVAL_CONFIRMATION_REQUIRED", "Confirm removal of stored YouTube data. Original reports and media, and videos already on YouTube, remain unchanged.", 400);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new YoutubeConnectionError("YOUTUBE_REVISION_REQUIRED", "Refresh the connection status before removing YouTube data.", 400);
  const record = await YoutubeConnection.findById(SINGLETON).select(SECRET_FIELDS).lean();
  if (!record) {
    // A disconnected legacy installation can still have retained upload receipts.
    if (revision !== 0) throw removalConflict();
    try { await YoutubeConnection.create({ _id: SINGLETON, revision: 0, connected: false, tokenVersion: 0 }); }
    catch (error: any) { if (error?.code !== 11000) throw error; }
    return requestRemoval(adminId, revision, confirm, revoke);
  }
  if (record.revision !== revision) {
    // Lost response: the exact prior revision identifies the already accepted
    // removal, but cannot match a subsequently reconnected connection.
    if (record.revision === revision + 1 && record.dataCleanupThroughRevision === revision && !record.connected && record.dataCleanupReason === (revoke ? "admin_revoke" : "admin_erase")) return getYoutubeConnectionStatus();
    throw removalConflict();
  }
  if (!revoke && record.connected) throw new YoutubeConnectionError("YOUTUBE_REVOKE_REQUIRED", "Use Revoke access and erase data while the channel is connected.", 409);
  if (record.revocationStatus === "needs_attention") throw new YoutubeConnectionError("YOUTUBE_MANUAL_REVOCATION_REQUIRED", "Remove Asset Insight access in Google Account settings, then explicitly confirm that manual removal before continuing.", 409);
  if (record.dataCleanupStatus === "pending" || record.revocationStatus === "pending") return getYoutubeConnectionStatus();
  if (!await stageRemoval(record, revoke ? "admin_revoke" : "admin_erase", revoke)) throw removalConflict();
  // One bounded pass gives immediate feedback; the durable worker resumes an
  // interrupted pass and retries unknown provider outcomes on the same token.
  await maintainYoutubeDataLifecycle({ batchSize: 100 });
  return getYoutubeConnectionStatus();
}

export const revokeYoutubeAccessAndEraseData = (adminId: string, revision: number, confirm: boolean) => requestRemoval(adminId, revision, confirm, true);
export const eraseYoutubeData = (adminId: string, revision: number, confirm: boolean) => requestRemoval(adminId, revision, confirm, false);

export async function acknowledgeYoutubeManualRevocation(adminId: string, revision: number, confirm: boolean) {
  if (!/^[a-f\d]{24}$/i.test(adminId) || !await User.exists({ _id: adminId, role: { $in: ["admin", "superadmin"] }, isBlocked: { $ne: true } })) throw new YoutubeConnectionError("YOUTUBE_ADMIN_REQUIRED", "Current administrator access is required.", 403);
  if (confirm !== true || !Number.isSafeInteger(revision) || revision < 0) throw new YoutubeConnectionError("YOUTUBE_REMOVAL_CONFIRMATION_REQUIRED", "Confirm that you removed Asset Insight access in Google Account settings.", 400);
  const record = await YoutubeConnection.findById(SINGLETON).select("+encryptedRevocationToken").lean();
  if (record?.revision === revision + 1 && record.revocationStatus === "manually_confirmed" && !record.connected) return getYoutubeConnectionStatus();
  const accepted = await YoutubeConnection.updateOne({ _id: SINGLETON, revision, connected: false, revocationStatus: "needs_attention", encryptedRevocationToken: { $exists: false } }, {
    $set: { revocationStatus: "manually_confirmed", revocationManuallyConfirmedAt: new Date(), revocationManuallyConfirmedBy: adminId },
    $inc: { revision: 1 }, $unset: { lifecycleLeaseToken: 1, lifecycleLeaseUntil: 1 },
  });
  if (!accepted.matchedCount) throw removalConflict();
  return getYoutubeConnectionStatus();
}

export async function invalidateYoutubeAuthorization(revision: number): Promise<void> {
  const record = await YoutubeConnection.findOne({ _id: SINGLETON, revision, connected: true }).select(SECRET_FIELDS).lean();
  if (record) await stageRemoval(record, "authorization_invalid", false);
}

/** A pre-removal OAuth callback may finish after local authority was fenced. */
export async function retainRevocationForAbandonedAuthorization(expectedRevision: number, token: string): Promise<void> {
  const record = await YoutubeConnection.findOne({ _id: SINGLETON, connected: false, dataCleanupThroughRevision: { $gte: expectedRevision }, dataCleanupReason: { $ne: "admin_erase" } }).select(SECRET_FIELDS).lean();
  if (!record || !record.oauthExchangeUntil || record.oauthExchangeUntil.getTime() <= Date.now()) return;
  const context = `revocation:${record.revision}`;
  await YoutubeConnection.updateOne({ _id: SINGLETON, revision: record.revision, connected: false, dataCleanupThroughRevision: { $gte: expectedRevision } }, {
    $set: { encryptedRevocationToken: encryptYoutubeSecret(token, context), revocationTokenContext: context, revocationStatus: "pending", revocationNextAttemptAt: record.oauthExchangeUntil },
    $unset: { revocationCompletedAt: 1 },
  });
}

async function revokeProviderToken(token: string): Promise<boolean> {
  // Do not follow redirects or put the token in URL/access logs. Google returns
  // an empty 200 on success; invalid_token is already revoked, not retry failure.
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 200) { await response.body?.cancel().catch(() => undefined); return true; }
  if (response.status !== 400 || !response.body) { await response.body?.cancel().catch(() => undefined); return false; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) return false;
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error === "invalid_token";
  } catch { return false; }
  finally { await reader.cancel().catch(() => undefined); }
}

async function redactVideos(filter: Record<string, unknown>, limit: number): Promise<number> {
  const records = await YoutubeVideo.collection.find({ ...filter, status: { $ne: "data_removed" } }, { projection: { _id: 1, updatedAt: 1 } }).sort({ _id: 1 }).limit(limit).toArray();
  for (const record of records) {
    // Replacement allowlist also removes unknown/legacy provider payload fields.
    // The opaque digest is the only retained identity: delayed upsert/retry can
    // see this permanent tombstone, never recreate the source or a duplicate.
    await YoutubeVideo.collection.replaceOne({ _id: record._id, status: { $ne: "data_removed" }, ...filter, ...(record.updatedAt ? { updatedAt: record.updatedAt } : { updatedAt: { $exists: false } }) }, { _id: record._id, status: "data_removed", dataRemovedAt: new Date() });
  }
  return records.length;
}

async function redactStates(throughRevision: number, limit: number): Promise<void> {
  const records = await YoutubeOAuthState.collection.find({ expectedRevision: { $lte: throughRevision } }, { projection: { _id: 1, expiresAt: 1 } }).sort({ _id: 1 }).limit(limit).toArray();
  for (const record of records) {
    await YoutubeOAuthState.collection.replaceOne({ _id: record._id, expectedRevision: { $lte: throughRevision } }, { _id: record._id, consumedAt: new Date(), expiresAt: record.expiresAt });
  }
}

/** Minute worker sweep; at most two bounded requests and 100 receipt/state rows. */
export async function maintainYoutubeDataLifecycle(options: { batchSize?: number } = {}): Promise<void> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.batchSize || 100)));
  const now = new Date();
  const leaseToken = randomUUID();
  const record = await YoutubeConnection.findOneAndUpdate({ _id: SINGLETON, $or: [{ lifecycleLeaseUntil: { $exists: false } }, { lifecycleLeaseUntil: { $lte: now } }] }, { $set: { lifecycleLeaseToken: leaseToken, lifecycleLeaseUntil: new Date(now.getTime() + 120_000) } }, { returnDocument: "after" }).select(SECRET_FIELDS).lean();
  if (!record) return;
  const owned = { _id: SINGLETON, revision: record.revision, lifecycleLeaseToken: leaseToken };
  try {
    if (record.revocationStatus === "pending" && date(record.revocationNextAttemptAt) <= now.getTime()) {
      let revoked = false;
      const expired = now.getTime() - date(record.revocationRequestedAt) >= 7 * DAY_MS;
      if (!expired) {
        try {
          const token = decryptYoutubeSecret(record.encryptedRevocationToken || "", record.revocationTokenContext || "");
          revoked = await revokeProviderToken(token);
        } catch { /* Never log token-bearing provider failures. */ }
      }
      if (revoked || expired) await YoutubeConnection.updateOne(owned, {
        $set: { revocationStatus: revoked ? "completed" : "needs_attention", ...(revoked ? { revocationCompletedAt: new Date() } : {}) },
        $unset: { encryptedRevocationToken: 1, revocationTokenContext: 1, revocationNextAttemptAt: 1 },
      });
      else await YoutubeConnection.updateOne(owned, { $set: { revocationNextAttemptAt: new Date(now.getTime() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(record.revocationAttempts || 0, 9))) }, $inc: { revocationAttempts: 1 } });
    }
    if (record.dataCleanupStatus === "pending") {
      const throughRevision = record.dataCleanupThroughRevision ?? record.revision - 1;
      const affected = { $or: [{ connectionRevision: { $lte: throughRevision } }, { connectionRevision: { $exists: false } }] };
      await redactVideos(affected, limit);
      await redactStates(throughRevision, limit);
      const remaining = await YoutubeVideo.collection.findOne({ ...affected, status: { $ne: "data_removed" } }, { projection: { _id: 1 } });
      const statesRemaining = await YoutubeOAuthState.collection.findOne({ expectedRevision: { $lte: throughRevision } }, { projection: { _id: 1 } });
      if (!remaining && !statesRemaining) await YoutubeConnection.updateOne(owned, { $set: { dataCleanupStatus: "completed", dataCleanupCompletedAt: new Date() } });
      return;
    }
    // Fail closed for expired API metadata even if a video is no longer queued.
    // Local edits/lease writes never extend the provider-data retention clock.
    const cutoff = new Date(now.getTime() - 30 * DAY_MS);
    await redactVideos({ $or: [
      { providerDataCheckedAt: { $lte: cutoff } },
      { providerDataCheckedAt: { $exists: false }, uploadedAt: { $lte: cutoff } },
      { providerDataCheckedAt: { $exists: false }, uploadedAt: { $exists: false }, createdAt: { $lte: cutoff } },
    ] }, limit);
    const authorizingAdmin = record.connectedBy || record.consentedBy;
    if ((!record.connected && !authorizingAdmin) || date(record.authorizationCheckNextAt) > now.getTime()) return;
    // Claim next check before the network request, shared across worker processes.
    await YoutubeConnection.updateOne(owned, { $set: { authorizationCheckNextAt: new Date(now.getTime() + DAY_MS) } });
    if (!authorizingAdmin || !await User.exists({ _id: authorizingAdmin, role: { $in: ["admin", "superadmin"] }, isBlocked: { $ne: true } })) {
      await stageRemoval(record, "authorizing_admin_unavailable", true);
      return;
    }
    if (!record.connected || !record.channelId) return;
    if (now.getTime() - date(record.authorizationCheckedAt || record.connectedAt) >= 30 * DAY_MS || now.getTime() - date(record.channelDataCheckedAt || record.connectedAt) >= 30 * DAY_MS) {
      await stageRemoval(record, "authorization_stale", true);
      return;
    }
    try {
      const accessToken = await getYoutubeAccessToken(record.channelId, record.revision, { forceRefresh: true });
      await refreshYoutubeChannelMetadata(record.channelId, record.revision, accessToken);
    }
    catch { /* A definite invalid grant stages deletion in the token adapter. */ }
  } finally {
    await YoutubeConnection.updateOne({ _id: SINGLETON, lifecycleLeaseToken: leaseToken }, { $unset: { lifecycleLeaseToken: 1, lifecycleLeaseUntil: 1 } });
  }
}

export function startYoutubeDataLifecycleMaintenance(signal: AbortSignal): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let stopped = false;
  const tick = async () => {
    if (pending || stopped || signal.aborted) return;
    pending = maintainYoutubeDataLifecycle().catch(() => undefined);
    try { await pending; } finally { pending = undefined; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  const abort = () => { stopped = true; clearInterval(timer); };
  signal.addEventListener("abort", abort, { once: true });
  void tick();
  return async () => { abort(); signal.removeEventListener("abort", abort); await pending; };
}
