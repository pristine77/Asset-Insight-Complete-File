import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YoutubeConnection, { YoutubeOAuthState } from "../src/models/youtubeConnection.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import User from "../src/models/user.model.js";
import youtubeRoutes from "../src/routes/youtube.routes.js";
import { beginYoutubeConnection, completeYoutubeConnection, disconnectYoutubeConnection, getYoutubeAccessToken, getYoutubeConnection, getYoutubeConnectionStatus } from "../src/service/youtubeConnectionService.js";
import { acknowledgeYoutubeManualRevocation, eraseYoutubeData, invalidateYoutubeAuthorization, maintainYoutubeDataLifecycle, revokeYoutubeAccessAndEraseData, startYoutubeDataLifecycleMaintenance } from "../src/service/youtubeDataLifecycleService.js";

const app = express();
app.use(express.json()); app.use("/api/admin/youtube", youtubeRoutes);
const adminId = new mongoose.Types.ObjectId().toString();
const ownerId = new mongoose.Types.ObjectId().toString();
const channelId = `UC${"x".repeat(22)}`;
const DAY = 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let provider = vi.fn<typeof fetch>();
let mongo: MongoMemoryServer;
const auth = (id = adminId) => ({ Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: "1h" })}` });

async function seedConnection() {
  // Use production's fingerprint via a complete isolated OAuth connection.
  provider.mockImplementation(async (url) => String(url).includes("/token")
    ? json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" })
    : json({ items: [{ id: channelId, snippet: { title: "Personal channel title" } }] }));
  const pending = await beginYoutubeConnection(adminId, true);
  await completeYoutubeConnection(adminId, "fixture-code", new URL(pending.authorizationUrl).searchParams.get("state")!);
  provider.mockReset();
  provider.mockResolvedValue(new Response("", { status: 200 }));
}

async function seedVideos(count = 1, changes: Record<string, unknown> = {}) {
  const now = new Date();
  await YoutubeVideo.collection.insertMany(Array.from({ length: count }, (_, i) => ({
    _id: `fixture-opaque-${String(i).padStart(3, "0")}`, reportType: "asset", reportId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(ownerId),
    channelId, connectionRevision: 1, generationToken: "private-generation", sourceUrl: "https://private.test/original.mp4", sourceSize: 8000,
    title: "Private title", description: "Private description", lotId: "private-lot", lotNumber: "5", status: "public", videoId: "video-id", url: "https://youtube.com/watch?v=video-id",
    sessionCipher: "private-session", leaseToken: "old-worker", leaseUntil: new Date(Date.now() + DAY), createdAt: now, updatedAt: now,
    providerDataCheckedAt: now, legacyUnknownProviderPayload: { secret: "legacy-data" }, ...changes,
  })));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Promise.all([YoutubeConnection.init(), YoutubeOAuthState.init(), YoutubeVideo.init()]);
});
beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("YOUTUBE_CLIENT_ID", "fixture.apps.googleusercontent.com");
  vi.stubEnv("YOUTUBE_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv("YOUTUBE_REDIRECT_URI", "https://admin.example.test/youtube/callback");
  vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  provider = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected provider request")); vi.stubGlobal("fetch", provider);
  await Promise.all([YoutubeConnection.deleteMany({}), YoutubeOAuthState.deleteMany({}), YoutubeVideo.deleteMany({}), User.deleteMany({})]);
  await User.collection.insertMany([{ _id: new mongoose.Types.ObjectId(adminId), role: "admin", email: "admin@example.test" }, { _id: new mongoose.Types.ObjectId(ownerId), role: "user", email: "owner@example.test" }]);
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await mongoose.disconnect(); await mongo.stop(); });

describe.sequential("YouTube access revocation and local data erasure", () => {
  it("uses strict admin-only, confirmed, revision checked, no-store endpoints", async () => {
    await seedConnection();
    expect((await request(app).post("/api/admin/youtube/revoke").send({ revision: 1, confirm: true })).status).toBe(401);
    expect((await request(app).post("/api/admin/youtube/revoke").set(auth(ownerId)).send({ revision: 1, confirm: true })).status).toBe(403);
    for (const body of [{ revision: 1 }, { revision: 1, confirm: false }, { revision: 1, confirm: "true" }, { revision: 1, confirm: true, token: "caller-token" }]) {
      expect((await request(app).post("/api/admin/youtube/revoke").set(auth()).send(body)).status).toBe(400);
    }
    expect((await request(app).post("/api/admin/youtube/revoke").set(auth()).send({ revision: 0, confirm: true })).status).toBe(409);
    const result = await request(app).post("/api/admin/youtube/revoke").set(auth()).send({ revision: 1, confirm: true });
    expect(result.status).toBe(200); expect(result.headers["cache-control"]).toContain("no-store");
    expect(result.body).toMatchObject({ connected: false, revision: 2, canConnect: true, dataCleanup: { status: "completed" }, revocation: { status: "completed" } });
  });

  it("revokes only at the fixed endpoint, removes all cached details, and retains opaque permanent video tombstones", async () => {
    await seedConnection(); await seedVideos();
    const original = { reportId: "untouched", sourceUrl: "untouched-original", zip: "untouched-zip" };
    await mongoose.connection.collection("lifecycle_original_fixtures").insertOne(original);
    const status = await revokeYoutubeAccessAndEraseData(adminId, 1, true);
    const [url, options] = provider.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(new URLSearchParams(String(options!.body)).get("token")).toBe("fixture-refresh-token");
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    const row = await YoutubeVideo.collection.findOne();
    expect(Object.keys(row!).sort()).toEqual(["_id", "dataRemovedAt", "status"]);
    expect(row!.status).toBe("data_removed");
    expect(JSON.stringify(await YoutubeConnection.collection.findOne())).not.toMatch(/encrypted|Personal|channelId|consentedBy|connectedBy/);
    expect(JSON.stringify(await YoutubeOAuthState.collection.findOne())).not.toMatch(/encrypted|adminId|configFingerprint|expectedChannelId/);
    expect(JSON.stringify(status)).not.toMatch(/fixture-|token|Personal/);
    expect(await mongoose.connection.collection("lifecycle_original_fixtures").findOne({ reportId: "untouched" })).toMatchObject(original);
    // A late worker that had already read its lease cannot resurrect a receipt.
    expect((await YoutubeVideo.updateOne({ _id: row!._id, leaseToken: "old-worker" }, { $set: { status: "public", videoId: "late-id" } })).matchedCount).toBe(0);
    expect(await YoutubeVideo.countDocuments()).toBe(1);
  });

  it("fences connection immediately while provider revocation is in flight and reuses accepted removal after lost responses", async () => {
    await seedConnection(); await seedVideos();
    let release!: (response: Response) => void; let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const operation = revokeYoutubeAccessAndEraseData(adminId, 1, true); await didStart;
    expect(await getYoutubeConnection()).toBeNull();
    await expect(beginYoutubeConnection(adminId, true)).rejects.toMatchObject({ code: "YOUTUBE_DATA_REMOVAL_IN_PROGRESS" });
    const replay = await revokeYoutubeAccessAndEraseData(adminId, 1, true);
    expect(replay).toMatchObject({ revision: 2, canConnect: false, revocation: { status: "pending" } });
    expect(provider).toHaveBeenCalledTimes(1);
    release(new Response("", { status: 200 })); await operation;
    await revokeYoutubeAccessAndEraseData(adminId, 1, true);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("recovers unknown provider outcomes durably and blocks reconnect until the original revoke completes", async () => {
    await seedConnection(); await seedVideos(); provider.mockRejectedValue(new Error("token=must-not-log"));
    const status = await revokeYoutubeAccessAndEraseData(adminId, 1, true);
    expect(status).toMatchObject({ connected: false, canConnect: false, revocation: { status: "pending" }, dataCleanup: { status: "completed" } });
    expect(await YoutubeConnection.collection.findOne()).toHaveProperty("encryptedRevocationToken");
    expect(await YoutubeConnection.collection.findOne()).not.toHaveProperty("encryptedRefreshToken");
    await maintainYoutubeDataLifecycle(); expect(provider).toHaveBeenCalledTimes(1);
    await YoutubeConnection.updateOne({}, { $set: { revocationNextAttemptAt: new Date(0) } });
    provider.mockResolvedValue(json({ error: "invalid_token" }, 400));
    await maintainYoutubeDataLifecycle();
    expect((await getYoutubeConnectionStatus()).revocation.status).toBe("completed");
    expect(await YoutubeConnection.collection.findOne()).not.toHaveProperty("encryptedRevocationToken");
  });

  it("waits out an already-started OAuth exchange and revokes its late credential without reviving the connection", async () => {
    await seedConnection(); await seedVideos();
    const pending = await beginYoutubeConnection(adminId, true);
    let release!: (response: Response) => void; let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(async (url) => {
      if (String(url).endsWith("/token")) { started(); return new Promise((resolve) => { release = resolve; }); }
      if (String(url).endsWith("/revoke")) return new Response("", { status: 200 });
      return json({ items: [{ id: channelId, snippet: { title: "Late channel response" } }] });
    });
    const completion = completeYoutubeConnection(adminId, "late-code", new URL(pending.authorizationUrl).searchParams.get("state")!);
    const failedCompletion = expect(completion).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    await didStart;
    expect(await revokeYoutubeAccessAndEraseData(adminId, 1, true)).toMatchObject({ connected: false, canConnect: false, revocation: { status: "pending" } });
    expect(provider.mock.calls.some(([url]) => String(url).endsWith("/revoke"))).toBe(false);
    release(json({ access_token: "late-access", refresh_token: "late-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" }));
    await failedCompletion;
    await YoutubeConnection.updateOne({}, { $set: { oauthExchangeUntil: new Date(0), revocationNextAttemptAt: new Date(0) } });
    await maintainYoutubeDataLifecycle();
    const revoke = provider.mock.calls.find(([url]) => String(url).endsWith("/revoke"));
    expect(new URLSearchParams(String(revoke![1]!.body)).get("token")).toBe("late-refresh");
    expect(await getYoutubeConnectionStatus()).toMatchObject({ connected: false, revocation: { status: "completed" } });
  });

  it.each(["network", "malformed", "demoted"])("retains the initial issued grant when removal races a %s channel completion failure", async (failure) => {
    const pending = await beginYoutubeConnection(adminId, true);
    let release!: (response: Response) => void; let reject!: (error: Error) => void; let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(async (url) => {
      if (String(url).endsWith("/token")) return json({ access_token: "initial-access", refresh_token: "initial-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" });
      if (String(url).endsWith("/revoke")) return new Response("", { status: 200 });
      started(); return new Promise((resolve, fail) => { release = resolve; reject = fail; });
    });
    const completion = completeYoutubeConnection(adminId, "initial-code", new URL(pending.authorizationUrl).searchParams.get("state")!);
    const failedCompletion = expect(completion).rejects.toBeInstanceOf(Error);
    await didStart;
    const removed = await revokeYoutubeAccessAndEraseData(adminId, 0, true);
    expect(removed).toMatchObject({ connected: false, canConnect: false, revocation: { status: "unavailable" } });
    if (failure === "network") reject(new Error("synthetic provider failure"));
    else {
      if (failure === "demoted") await User.updateOne({ _id: adminId }, { $set: { role: "user" } });
      release(failure === "malformed" ? json({ items: [] }) : json({ items: [{ id: channelId, snippet: { title: "Initial channel" } }] }));
    }
    await failedCompletion;
    expect((await getYoutubeConnectionStatus()).revocation.status).toBe("pending");
    await YoutubeConnection.updateOne({}, { $set: { oauthExchangeUntil: new Date(0), revocationNextAttemptAt: new Date(0) } });
    await maintainYoutubeDataLifecycle();
    const revoke = provider.mock.calls.find(([url]) => String(url).endsWith("/revoke"));
    expect(new URLSearchParams(String(revoke![1]!.body)).get("token")).toBe("initial-refresh");
    expect(await getYoutubeConnectionStatus()).toMatchObject({ connected: false, revocation: { status: "completed" } });
  });

  it("permits only one provider exchange per revision so a second account cannot overwrite the grant awaiting revocation", async () => {
    const first = await beginYoutubeConnection(adminId, true);
    const second = await beginYoutubeConnection(adminId, true);
    let release!: (response: Response) => void; let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(async (url, options) => {
      if (String(url).endsWith("/token")) {
        const code = new URLSearchParams(String(options?.body)).get("code");
        if (code === "account-one") { started(); return new Promise((resolve) => { release = resolve; }); }
        return json({ access_token: "account-two-access", refresh_token: "account-two-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" });
      }
      if (String(url).endsWith("/revoke")) return new Response("", { status: 200 });
      return json({ items: [{ id: channelId, snippet: { title: "First account channel" } }] });
    });
    const completion = completeYoutubeConnection(adminId, "account-one", new URL(first.authorizationUrl).searchParams.get("state")!);
    const rejected = expect(completion).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    await didStart;
    await expect(completeYoutubeConnection(adminId, "account-two", new URL(second.authorizationUrl).searchParams.get("state")!)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    expect(provider.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    await revokeYoutubeAccessAndEraseData(adminId, 0, true);
    release(json({ access_token: "account-one-access", refresh_token: "account-one-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" }));
    await rejected;
    await YoutubeConnection.updateOne({}, { $set: { oauthExchangeUntil: new Date(0), revocationNextAttemptAt: new Date(0) } });
    await maintainYoutubeDataLifecycle();
    const revoke = provider.mock.calls.find(([url]) => String(url).endsWith("/revoke"));
    expect(new URLSearchParams(String(revoke![1]!.body)).get("token")).toBe("account-one-refresh");
    expect(provider.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    expect((await getYoutubeConnectionStatus()).revocation.status).toBe("completed");
  });

  it("bounds revocation credential retention at seven days without pretending Google confirmed revocation", async () => {
    await seedConnection(); provider.mockRejectedValue(new Error("offline"));
    await revokeYoutubeAccessAndEraseData(adminId, 1, true);
    await YoutubeConnection.updateOne({}, { $set: { revocationRequestedAt: new Date(Date.now() - 7 * DAY), revocationNextAttemptAt: new Date(0) } });
    provider.mockClear(); await maintainYoutubeDataLifecycle();
    expect(provider).not.toHaveBeenCalled();
    expect(await YoutubeConnection.collection.findOne()).not.toHaveProperty("encryptedRevocationToken");
    expect(await getYoutubeConnectionStatus()).toMatchObject({ canConnect: false, revocation: { status: "needs_attention" } });
    await expect(eraseYoutubeData(adminId, 2, true)).rejects.toMatchObject({ code: "YOUTUBE_MANUAL_REVOCATION_REQUIRED" });
    await expect(revokeYoutubeAccessAndEraseData(adminId, 2, true)).rejects.toMatchObject({ code: "YOUTUBE_MANUAL_REVOCATION_REQUIRED" });
    await expect(acknowledgeYoutubeManualRevocation(adminId, 2, false)).rejects.toMatchObject({ code: "YOUTUBE_REMOVAL_CONFIRMATION_REQUIRED" });
    expect(await acknowledgeYoutubeManualRevocation(adminId, 2, true)).toMatchObject({ canConnect: true, revision: 3, revocation: { status: "manually_confirmed", completedAt: null } });
    expect(await YoutubeConnection.collection.findOne()).toHaveProperty("revocationManuallyConfirmedBy", adminId);
    expect(await acknowledgeYoutubeManualRevocation(adminId, 2, true)).toMatchObject({ revision: 3 });
  });

  it("redacts at most one hundred receipts per pass and resumes after a restart without creating uploads", async () => {
    await seedConnection(); await seedVideos(205);
    expect((await revokeYoutubeAccessAndEraseData(adminId, 1, true)).dataCleanup.status).toBe("pending");
    expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(100);
    await maintainYoutubeDataLifecycle(); expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(200);
    await maintainYoutubeDataLifecycle(); expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(205);
    expect((await getYoutubeConnectionStatus()).dataCleanup.status).toBe("completed"); expect(provider).toHaveBeenCalledTimes(1);
  });

  it("serializes maintenance workers with a persisted lease", async () => {
    await seedConnection(); await seedVideos(2); await disconnectYoutubeConnection(adminId, 1);
    await YoutubeConnection.updateOne({}, { $set: { lifecycleLeaseToken: "another-worker", lifecycleLeaseUntil: new Date(Date.now() + DAY) } });
    await maintainYoutubeDataLifecycle();
    expect(provider).not.toHaveBeenCalled(); expect(await YoutubeVideo.countDocuments({ status: "public" })).toBe(2);
  });

  it("erases old disconnected receipts without configuration and accurately reports that no revocable token remains", async () => {
    await seedConnection(); await seedVideos(); await disconnectYoutubeConnection(adminId, 1);
    vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", "");
    const result = await eraseYoutubeData(adminId, 2, true);
    expect(result).toMatchObject({ configured: false, connected: false, revocation: { status: "unavailable" }, dataCleanup: { status: "completed" } });
    expect(provider).not.toHaveBeenCalled(); expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(1);
  });

  it("does not let erase-data silently skip revocation of a connected grant", async () => {
    await seedConnection();
    await expect(eraseYoutubeData(adminId, 1, true)).rejects.toMatchObject({ code: "YOUTUBE_REVOKE_REQUIRED" });
    expect(await getYoutubeConnection()).not.toBeNull(); expect(provider).not.toHaveBeenCalled();
  });

  it("definite invalid_grant immediately persists cleanup intent and deletes usable credentials", async () => {
    await seedConnection(); await seedVideos();
    provider.mockResolvedValue(json({ error: "invalid_grant" }, 400));
    await expect(getYoutubeAccessToken(channelId, 1, { forceRefresh: true })).rejects.toMatchObject({ code: "YOUTUBE_REAUTHORIZATION_REQUIRED" });
    expect(await getYoutubeConnectionStatus()).toMatchObject({ connected: false, needsReconnect: true, dataCleanup: { status: "pending", reason: "authorization_invalid" }, revocation: { status: "unavailable" } });
    expect(await YoutubeConnection.collection.findOne()).not.toHaveProperty("encryptedRefreshToken");
    await maintainYoutubeDataLifecycle();
    expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(1);
  });

  it("old invalidation callbacks cannot remove a newer connection", async () => {
    await seedConnection(); await invalidateYoutubeAuthorization(0);
    expect(await getYoutubeConnection()).toMatchObject({ revision: 1 });
  });

  it("checks grant and refreshes channel details at most daily and keeps temporary failures distinct from revocation", async () => {
    await seedConnection();
    await maintainYoutubeDataLifecycle(); expect(provider).not.toHaveBeenCalled();
    await YoutubeConnection.updateOne({}, { $set: { authorizationCheckNextAt: new Date(0) } });
    provider.mockImplementation(async (url) => String(url).includes("/token")
      ? json({ access_token: "refreshed-token", token_type: "Bearer", expires_in: 3600 })
      : json({ items: [{ id: channelId, snippet: { title: "Refreshed channel" } }] }));
    await maintainYoutubeDataLifecycle(); await maintainYoutubeDataLifecycle();
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await getYoutubeConnectionStatus()).channel?.title).toBe("Refreshed channel");
    await YoutubeConnection.updateOne({}, { $set: { authorizationCheckNextAt: new Date(0) } });
    provider.mockRejectedValue(new Error("temporary network failure"));
    await maintainYoutubeDataLifecycle();
    expect((await getYoutubeConnectionStatus()).connected).toBe(true);
  });

  it.each(["deleted", "blocked", "demoted"])("queues erasure when the authorizing administrator is %s", async (kind) => {
    await seedConnection(); await seedVideos();
    if (kind === "deleted") await User.deleteOne({ _id: adminId });
    else await User.updateOne({ _id: adminId }, { $set: kind === "blocked" ? { isBlocked: true } : { role: "user" } });
    await YoutubeConnection.updateOne({}, { $set: { authorizationCheckNextAt: new Date(0) } });
    await maintainYoutubeDataLifecycle();
    expect(await getYoutubeConnectionStatus()).toMatchObject({ connected: false, dataCleanup: { reason: "authorizing_admin_unavailable", status: "pending" } });
    await maintainYoutubeDataLifecycle();
    expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(1);
  });

  it("still detects deletion of the authorizing admin after a legacy local disconnect", async () => {
    await seedConnection(); await seedVideos(); await disconnectYoutubeConnection(adminId, 1);
    await User.deleteOne({ _id: adminId });
    await YoutubeConnection.updateOne({}, { $set: { authorizationCheckNextAt: new Date(0) } });
    await maintainYoutubeDataLifecycle();
    expect((await getYoutubeConnectionStatus()).dataCleanup.reason).toBe("authorizing_admin_unavailable");
    await maintainYoutubeDataLifecycle();
    expect(await YoutubeVideo.countDocuments({ status: "data_removed" })).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it("redacts expired provider cache independently of recent local edits and keeps refreshed rows", async () => {
    await seedConnection(); const old = new Date(Date.now() - 31 * DAY);
    await seedVideos(1, { providerDataCheckedAt: old, uploadedAt: old, updatedAt: new Date() });
    await YoutubeVideo.collection.insertOne({ _id: "fresh-cache", connectionRevision: 1, status: "private", providerDataCheckedAt: new Date(), createdAt: old });
    await maintainYoutubeDataLifecycle();
    expect(await YoutubeVideo.collection.findOne({ _id: "fixture-opaque-000" })).toMatchObject({ status: "data_removed" });
    expect(await YoutubeVideo.collection.findOne({ _id: "fresh-cache" })).toMatchObject({ status: "private" });
  });

  it("hides stale channel metadata immediately and persists a fail-closed stale authorization purge", async () => {
    await seedConnection(); await seedVideos();
    await YoutubeConnection.updateOne({}, { $set: { channelDataCheckedAt: new Date(Date.now() - 31 * DAY), authorizationCheckNextAt: new Date(0) } });
    expect(await getYoutubeConnection()).toBeNull();
    expect((await getYoutubeConnectionStatus()).channel).toBeNull();
    await maintainYoutubeDataLifecycle();
    expect((await getYoutubeConnectionStatus()).dataCleanup.reason).toBe("authorization_stale");
  });

  it("an already aborted worker starts no maintenance requests", async () => {
    await seedConnection(); const controller = new AbortController(); controller.abort();
    await startYoutubeDataLifecycleMaintenance(controller.signal)(); expect(provider).not.toHaveBeenCalled();
  });
});
