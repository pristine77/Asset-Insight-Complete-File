import { createHash, randomBytes } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YoutubeConnection, { YoutubeOAuthState } from "../src/models/youtubeConnection.model.js";
import User from "../src/models/user.model.js";
import youtubeRoutes from "../src/routes/youtube.routes.js";
import { assertYoutubeConnection, beginYoutubeConnection, completeYoutubeConnection, decryptYoutubeSecret, disconnectYoutubeConnection, encryptYoutubeSecret, getYoutubeAccessToken, getYoutubeConnection, getYoutubeConnectionStatus } from "../src/service/youtubeConnectionService.js";

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use("/api/admin/youtube", youtubeRoutes);
const adminId = new mongoose.Types.ObjectId().toString();
const superadminId = new mongoose.Types.ObjectId().toString();
const ownerId = new mongoose.Types.ObjectId().toString();
const channelId = `UC${"a".repeat(22)}`;
const anotherChannel = `UC${"b".repeat(22)}`;
const scope = "https://www.googleapis.com/auth/youtube.force-ssl";
const tokenUrl = "https://oauth2.googleapis.com/token";
let mongo: MongoMemoryServer;
let provider = vi.fn<typeof fetch>();
const authorization = (id = adminId) => ({ Authorization: `Bearer ${jwt.sign({ id, role: "superadmin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tokens = (overrides: Record<string, unknown> = {}) => ({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope, ...overrides });
const channels = (id = channelId) => ({ items: [{ id, snippet: { title: "Fixture Shared Channel" } }] });
function successProvider(id = channelId) {
  provider.mockImplementation(async (url) => String(url) === tokenUrl ? json(tokens()) : json(channels(id)));
}
async function pending(actor = adminId) {
  const value = await beginYoutubeConnection(actor, true);
  return { ...value, state: new URL(value.authorizationUrl).searchParams.get("state")! };
}
async function connected(id = channelId) {
  successProvider(id);
  const value = await pending();
  return completeYoutubeConnection(adminId, "fixture-code", value.state);
}
async function expireAccessToken() {
  await YoutubeConnection.updateOne({ _id: "shared" }, { $set: { accessTokenExpiresAt: new Date(0) } });
  provider.mockClear();
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([YoutubeConnection.init(), YoutubeOAuthState.init()]);
});
beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("YOUTUBE_CLIENT_ID", "fixture-web.apps.googleusercontent.com");
  vi.stubEnv("YOUTUBE_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv("YOUTUBE_REDIRECT_URI", "https://admin.example.test/youtube/callback");
  vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  provider = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unmocked network request"));
  vi.stubGlobal("fetch", provider);
  await Promise.all([YoutubeConnection.deleteMany({}), YoutubeOAuthState.deleteMany({}), User.deleteMany({})]);
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(adminId), role: "admin", username: "Fixture Admin", email: "admin@example.test" },
    { _id: new mongoose.Types.ObjectId(superadminId), role: "superadmin", username: "Fixture Superadmin", email: "superadmin@example.test" },
    { _id: new mongoose.Types.ObjectId(ownerId), role: "user", username: "Fixture Owner", email: "owner@example.test" },
  ]);
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await mongoose.disconnect(); await mongo.stop(); });

describe.sequential("shared admin YouTube connection", () => {
  it("keeps optional configuration disabled without creating records or exposing environment values", async () => {
    vi.stubEnv("YOUTUBE_CLIENT_SECRET", "");
    const result = await getYoutubeConnectionStatus();
    expect(result).toMatchObject({ configured: false, connected: false, revision: 0, channel: null, privacyStatus: "public" });
    expect(result.configurationIssue).toContain("YOUTUBE_CLIENT_SECRET");
    expect(JSON.stringify(result)).not.toContain("fixture-web");
    expect(await getYoutubeConnection()).toBeNull();
    expect(await YoutubeConnection.countDocuments()).toBe(0);
    await expect(beginYoutubeConnection(adminId, true)).rejects.toMatchObject({ code: "YOUTUBE_NOT_CONFIGURED" });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ["YOUTUBE_CLIENT_ID", "malformed"],
    ["YOUTUBE_REDIRECT_URI", "http://admin.example.test/youtube/callback"],
    ["YOUTUBE_REDIRECT_URI", "https://admin.example.test/other"],
    ["YOUTUBE_REDIRECT_URI", "https://admin.example.test/youtube/callback?next=evil"],
    ["YOUTUBE_REDIRECT_URI", "https://name:secret@admin.example.test/youtube/callback"],
    ["YOUTUBE_TOKEN_ENCRYPTION_KEY", "not-a-key"],
    ["YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(31, 1).toString("base64")],
  ])("rejects invalid %s configuration", async (name, value) => {
    vi.stubEnv(name, value);
    expect((await getYoutubeConnectionStatus()).configured).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it("permits an exact loopback callback for isolated development", async () => {
    vi.stubEnv("YOUTUBE_REDIRECT_URI", "http://localhost:3001/youtube/callback");
    expect((await getYoutubeConnectionStatus()).configured).toBe(true);
  });

  it("encrypts secrets with random IVs and rejects altered ciphertext, wrong purpose and wrong key", () => {
    const first = encryptYoutubeSecret("secret-session-uri", "video:one"), second = encryptYoutubeSecret("secret-session-uri", "video:one");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-session-uri");
    expect(decryptYoutubeSecret(first, "video:one")).toBe("secret-session-uri");
    expect(() => decryptYoutubeSecret(first, "video:two")).toThrow("stored YouTube credential");
    const parts = first.split("."); parts[3] = randomBytes(20).toString("base64url");
    expect(() => decryptYoutubeSecret(parts.join("."), "video:one")).toThrow("stored YouTube credential");
    vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(() => decryptYoutubeSecret(first, "video:one")).toThrow("stored YouTube credential");
  });

  it("uses current database roles, admitting ordinary admins and superadmins only", async () => {
    for (const actor of [adminId, superadminId]) expect((await request(app).get("/api/admin/youtube/status").set(authorization(actor))).status).toBe(200);
    expect((await request(app).get("/api/admin/youtube/status")).status).toBe(401);
    expect((await request(app).get("/api/admin/youtube/status").set(authorization(ownerId))).status).toBe(403);
    await User.updateOne({ _id: adminId }, { $set: { isBlocked: true } });
    expect((await request(app).post("/api/admin/youtube/connect").set(authorization()).send({ publicationConsent: true })).status).toBe(403);
    expect(provider).not.toHaveBeenCalled();
  });

  it("requires explicit public consent, strict request fields, and no-store responses", async () => {
    for (const body of [{}, { policyConsent: false }, { policyConsent: "true" }, { policyConsent: true, redirectUri: "https://evil.test" }, { publicationConsent: true }]) {
      expect((await request(app).post("/api/admin/youtube/connect").set(authorization()).send(body)).status).toBe(400);
    }
    expect((await request(app).get("/api/admin/youtube/status?code=unsafe").set(authorization())).status).toBe(400);
    const response = await request(app).post("/api/admin/youtube/connect").set(authorization()).send({ policyConsent: true });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(response.body).sort()).toEqual(["authorizationUrl", "expiresAt"]);
  });

  it("uses one-time hashed admin-bound state, offline authorization and S256 PKCE", async () => {
    const value = await pending();
    const url = new URL(value.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    const stored = await YoutubeOAuthState.findOne().select("+encryptedVerifier").lean();
    expect(stored!._id).not.toBe(value.state);
    expect(stored).toMatchObject({ adminId, expectedRevision: 0, consentVersion: "youtube-automatic-public-v3" });
    const verifier = decryptYoutubeSecret(stored!.encryptedVerifier, `state:${stored!._id}`);
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(stored!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    const indexes = await YoutubeOAuthState.collection.indexes();
    expect(indexes.some((index) => index.expireAfterSeconds === 0 && index.key.expiresAt === 1)).toBe(true);
  });

  it("rejects another admin without consuming the legitimate administrator's state", async () => {
    const value = await pending(); successProvider();
    await expect(completeYoutubeConnection(superadminId, "fixture-code", value.state)).rejects.toMatchObject({ code: "YOUTUBE_STATE_INVALID" });
    expect(provider).not.toHaveBeenCalled();
    expect((await completeYoutubeConnection(adminId, "fixture-code", value.state)).connected).toBe(true);
    await expect(completeYoutubeConnection(adminId, "fixture-code", value.state)).rejects.toMatchObject({ code: "YOUTUBE_STATE_INVALID" });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("rejects expired states and states from changed configuration before exchanging a code", async () => {
    const expired = await pending();
    await YoutubeOAuthState.updateOne({}, { $set: { expiresAt: new Date(0) } });
    await expect(completeYoutubeConnection(adminId, "fixture-code", expired.state)).rejects.toMatchObject({ code: "YOUTUBE_STATE_INVALID" });
    const changed = await pending();
    vi.stubEnv("YOUTUBE_REDIRECT_URI", "https://other-admin.example.test/youtube/callback");
    await expect(completeYoutubeConnection(adminId, "fixture-code", changed.state)).rejects.toMatchObject({ code: "YOUTUBE_STATE_INVALID" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("stores encrypted tokens, a safe channel DTO and consent provenance", async () => {
    const status = await connected();
    expect(status).toMatchObject({ configured: true, connected: true, revision: 1, channel: { id: channelId, title: "Fixture Shared Channel", url: `https://www.youtube.com/channel/${channelId}` }, needsReconnect: false });
    expect(await getYoutubeConnection()).toMatchObject({ channelId, revision: 1 });
    const stored = await YoutubeConnection.collection.findOne({ _id: "shared" });
    expect(stored).toMatchObject({ connectedBy: adminId, consentedBy: adminId, consentVersion: "youtube-automatic-public-v3" });
    expect(JSON.stringify(stored)).not.toContain("fixture-access");
    expect(JSON.stringify(stored)).not.toContain("fixture-refresh");
    expect((await YoutubeConnection.findById("shared").lean())).not.toHaveProperty("encryptedAccessToken");
    const explicit = await YoutubeConnection.findById("shared").select("+encryptedAccessToken +encryptedRefreshToken");
    expect(explicit!.toJSON()).not.toHaveProperty("encryptedAccessToken");
    const [url, init] = provider.mock.calls[0]!;
    expect(url).toBe(tokenUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    const params = new URLSearchParams(String(init!.body));
    expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(params.get("client_secret")).toBe("fixture-client-secret");
    expect(JSON.stringify(status)).not.toMatch(/fixture-(access|refresh|client-secret)/);
  });

  it.each([
    { refresh_token: undefined }, { scope: "https://www.googleapis.com/auth/youtube.readonly" }, { access_token: "" }, { token_type: 7 },
  ])("rejects incomplete or insufficient provider authorization %j", async (changes) => {
    const value = await pending(); provider.mockResolvedValue(json(tokens(changes)));
    await expect(completeYoutubeConnection(adminId, "fixture-code", value.state)).rejects.toBeInstanceOf(Error);
    expect((await getYoutubeConnectionStatus()).connected).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous/missing channel ownership instead of guessing", async () => {
    const value = await pending();
    provider.mockResolvedValueOnce(json(tokens())).mockResolvedValueOnce(json({ items: [channels().items[0], channels(anotherChannel).items[0]] }));
    await expect(completeYoutubeConnection(adminId, "fixture-code", value.state)).rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_REQUIRED" });
  });

  it("does not replace a connected channel without a revision-checked disconnect", async () => {
    await connected();
    const next = await pending(); successProvider(anotherChannel);
    await expect(completeYoutubeConnection(adminId, "fixture-code", next.state)).rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_CHANGE_REQUIRES_DISCONNECT" });
    expect((await getYoutubeConnection())!.channelId).toBe(channelId);
    await expect(disconnectYoutubeConnection(adminId, 0)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    expect((await disconnectYoutubeConnection(superadminId, 1)).revision).toBe(2);
    expect((await connected(anotherChannel)).revision).toBe(3);
  });

  it("rejects administrators demoted while Google authorization is in flight", async () => {
    const value = await pending();
    provider.mockImplementation(async (url) => {
      if (String(url) === tokenUrl) return json(tokens());
      await User.updateOne({ _id: adminId }, { $set: { role: "user" } });
      return json(channels());
    });
    await expect(completeYoutubeConnection(adminId, "fixture-code", value.state)).rejects.toMatchObject({ code: "YOUTUBE_ADMIN_REQUIRED" });
    expect(await getYoutubeConnection()).toBeNull();
  });

  it("marks changed OAuth client or encryption keys for reconnect without provider access", async () => {
    await connected(); provider.mockClear();
    vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect((await getYoutubeConnectionStatus()).needsReconnect).toBe(true);
    expect(await getYoutubeConnection()).toBeNull();
    vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("YOUTUBE_CLIENT_ID", "changed.apps.googleusercontent.com");
    expect((await getYoutubeConnectionStatus()).needsReconnect).toBe(true);
    expect(await getYoutubeConnection()).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent completion snapshots to commit", async () => {
    const first = await pending(), second = await pending(superadminId); successProvider();
    const values = await Promise.allSettled([completeYoutubeConnection(adminId, "one", first.state), completeYoutubeConnection(superadminId, "two", second.state)]);
    expect(values.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(values.find((value) => value.status === "rejected")).toMatchObject({ reason: { code: "YOUTUBE_CONNECTION_CHANGED" } });
    expect((await getYoutubeConnection())!.revision).toBe(1);
  });

  it("disconnect invalidates pending completion and deletes local credentials without a provider request", async () => {
    const value = await pending();
    const result = await disconnectYoutubeConnection(adminId, 0);
    expect(result).toMatchObject({ connected: false, revision: 1, channel: null });
    await expect(completeYoutubeConnection(adminId, "one", value.state)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    expect(provider).not.toHaveBeenCalled();
    expect(await YoutubeConnection.collection.findOne({ _id: "shared" })).not.toHaveProperty("encryptedRefreshToken");
  });

  it("reuses an unexpired access token and fences a disconnected/reconnected same channel revision", async () => {
    await connected(); provider.mockClear();
    expect(await getYoutubeAccessToken(channelId, 1)).toBe("fixture-access");
    expect(provider).not.toHaveBeenCalled();
    await expect(getYoutubeAccessToken(anotherChannel, 1)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    await disconnectYoutubeConnection(adminId, 1); await connected(); provider.mockClear();
    await expect(getYoutubeAccessToken(channelId, 1)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    await expect(assertYoutubeConnection(channelId, 1)).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("refreshes expired access with encrypted CAS persistence and accepts omitted refresh response scope", async () => {
    await connected(); await expireAccessToken();
    provider.mockResolvedValue(json(tokens({ access_token: "new-access", refresh_token: undefined, scope: undefined })));
    expect(await getYoutubeAccessToken(channelId, 1)).toBe("new-access");
    const params = new URLSearchParams(String(provider.mock.calls[0]![1]!.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("fixture-refresh");
    const stored = await YoutubeConnection.collection.findOne({ _id: "shared" });
    expect(stored!.tokenVersion).toBe(1);
    expect(stored).not.toHaveProperty("refreshLeaseToken");
    expect(JSON.stringify(stored)).not.toContain("new-access");
    expect(await getYoutubeAccessToken(channelId, 1)).toBe("new-access");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps a late refresh from resurrecting a disconnected connection", async () => {
    await connected(); await expireAccessToken();
    let release!: (value: Response) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const refresh = getYoutubeAccessToken(channelId, 1);
    const assertion = expect(refresh).rejects.toMatchObject({ code: "YOUTUBE_CONNECTION_CHANGED" });
    await didStart;
    await disconnectYoutubeConnection(adminId, 1);
    release(json(tokens({ access_token: "late-access" })));
    await assertion;
    expect((await getYoutubeConnectionStatus()).connected).toBe(false);
    expect(await YoutubeConnection.collection.findOne({ _id: "shared" })).not.toHaveProperty("encryptedAccessToken");
  });

  it("serializes concurrent refreshes with a persisted lease", async () => {
    await connected(); await expireAccessToken();
    let release!: (value: Response) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    provider.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const first = getYoutubeAccessToken(channelId, 1);
    await didStart;
    await expect(getYoutubeAccessToken(channelId, 1)).rejects.toMatchObject({ code: "YOUTUBE_REFRESH_IN_PROGRESS" });
    expect(provider).toHaveBeenCalledTimes(1);
    release(json(tokens({ access_token: "new-access" })));
    expect(await first).toBe("new-access");
  });

  it("flags rejected offline authorization for reconnect without exposing Google diagnostics", async () => {
    await connected(); await expireAccessToken();
    provider.mockResolvedValue(json({ error: "invalid_grant", error_description: "fixture-refresh should never escape" }, 400));
    await expect(getYoutubeAccessToken(channelId, 1)).rejects.toMatchObject({ code: "YOUTUBE_REAUTHORIZATION_REQUIRED" });
    expect((await getYoutubeConnectionStatus()).needsReconnect).toBe(true);
    expect(await getYoutubeConnection()).toBeNull();
  });

  it("redacts transport and provider diagnostics from callback responses", async () => {
    const value = await pending();
    provider.mockRejectedValue(new Error("client_secret=fixture-client-secret token=fixture-access"));
    const response = await request(app).post("/api/admin/youtube/complete").set(authorization()).send({ code: "fixture-code", state: value.state });
    expect(response.status).toBe(502);
    expect(response.body.code).toBe("YOUTUBE_PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toMatch(/fixture-|client_secret|token=/);
    await expect(completeYoutubeConnection(adminId, "fixture-code", value.state)).rejects.toMatchObject({ code: "YOUTUBE_STATE_INVALID" });
  });
});
