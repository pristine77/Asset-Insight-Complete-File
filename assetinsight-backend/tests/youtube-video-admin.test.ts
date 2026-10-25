import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), fetch: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/service/youtubeConnectionService.js", () => ({ getYoutubeConnection: mocks.connection }));
vi.mock("../src/controller/youtubeConnection.controller.js", () => ({ completeAdminYoutube: vi.fn(), connectAdminYoutube: vi.fn(), disconnectAdminYoutube: vi.fn(), getAdminYoutubeStatus: vi.fn(), revokeAdminYoutube: vi.fn(), eraseAdminYoutubeData: vi.fn(), acknowledgeAdminYoutubeRevocation: vi.fn() }));
vi.mock("../src/utils/reportImageDeletionPlugin.js", () => ({ attachReportImageDeletionHooks: vi.fn() }));

import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import User from "../src/models/user.model.js";
import YoutubeVideo from "../src/models/youtubeVideo.model.js";
import youtubeRoutes from "../src/routes/youtube.routes.js";
import { youtubeVideoIdentity } from "../src/service/youtubeVideoPolicy.js";

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use("/api/admin/youtube", youtubeRoutes);
const connection = { channelId: "channel-1", revision: 2 };
const ownerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const superadminId = new mongoose.Types.ObjectId();
const source = "https://assetinsight.test/private-source-original.mp4";
const videoId = "AbCdEfGhI_1";
const url = `https://www.youtube.com/watch?v=${videoId}`;
const auth = (id = adminId) => ({ Authorization: `Bearer ${jwt.sign({ id: String(id), role: "superadmin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
const listPath = "/api/admin/youtube/videos";
const retryPath = (id: string) => `${listPath}/${id}/retry-publication`;
const reviewPath = (id: string) => `${listPath}/${id}/review`;
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { checkMD5: false } });
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mocks.connection.mockReset().mockResolvedValue(connection);
  mocks.fetch.mockReset().mockRejectedValue(new Error("Unexpected provider request"));
  vi.stubGlobal("fetch", mocks.fetch);
  await User.collection.insertMany([
    { _id: adminId, role: "admin", email: "admin@example.test" },
    { _id: superadminId, role: "superadmin", email: "superadmin@example.test" },
    { _id: ownerId, role: "user", email: "private-owner-contact@example.test" },
  ]);
});
afterAll(async () => { vi.unstubAllGlobals(); await mongoose.disconnect(); await mongo.stop(); });

async function fixture(type: "asset" | "lotListing" = "asset", reportChanges: Record<string, unknown> = {}, receiptChanges: Record<string, unknown> = {}) {
  const model = type === "asset" ? AssetReport : LotListing;
  const reportId = new mongoose.Types.ObjectId();
  const id = youtubeVideoIdentity(type, String(reportId), source, connection.channelId);
  const report = { _id: reportId, user: ownerId, status: "approved", release_status: "released", job_id: "files-1", job_status: "done", youtube_videos_enabled: true,
    videoUrls: [source], preview_data: { lots: [{ lot_id: "lot-1", video_urls: [source] }] },
    youtube_submission: { generationToken: "files-1", channelId: connection.channelId, connectionRevision: connection.revision, ownerId: String(ownerId) }, ...reportChanges };
  await model.collection.insertOne(report);
  await YoutubeVideo.create({ _id: id, reportType: type, reportId, ownerId, channelId: connection.channelId, connectionRevision: connection.revision,
    generationToken: "files-1", sourceUrl: source, videoId, url, title: "private-title", description: "private-description", sessionCipher: "private-session-capability", leaseToken: "private-lease-token",
    reviewToken: "reviewed-fixture", reviewedAt: new Date(), reviewedBy: adminId, reviewGenerationToken: "files-1", reviewPolicyVersion: "youtube-video-review-v1", privacyStatus: "public", visibilityPending: true,
    publicationToken: "automatic-fixture", publicationAuthorizedAt: new Date(), publicationGenerationToken: "files-1", publicationPolicyVersion: "youtube-automatic-public-v1",
    lotNumber: "010", status: "needs_attention", publicationAttempts: 5, lastError: "Safe publication guidance", nextAttemptAt: new Date(0), ...receiptChanges });
  // Make the initial revision deterministic and distinct from any retry write.
  await YoutubeVideo.collection.updateOne({ _id: id }, { $set: { updatedAt: new Date("2020-01-01T00:00:00.000Z") } });
  const receipt = await YoutubeVideo.findById(id).lean();
  return { id, model, reportId, updatedAt: receipt!.updatedAt.toISOString() };
}

describe.sequential("admin automatic public YouTube status and same-receipt retries", () => {
  it.each(["asset", "lotListing"] as const)("explains stale %s queued versions without mutating or authorizing their old receipt", async (type) => {
    const f = await fixture(type, { job_id: "files-new", youtube_submission: {
      generationToken: "files-new", uploadGenerationToken: "files-1", channelId: connection.channelId,
      connectionRevision: connection.revision, ownerId: String(ownerId),
    } }, { status: type === "asset" ? "pending_review" : "queued", videoId: undefined, url: undefined, publicationToken: undefined });
    const before = await YoutubeVideo.findById(f.id).select("+sourceUrl +description +publicationToken +sessionCipher +reviewToken").lean();
    const result = await request(app).get(listPath).set(auth());
    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({ status: "needs_attention", retryEligible: false,
      reviewRequired: false, reviewEligible: false, lastError: expect.stringContaining("older saved report version") });
    expect(await YoutubeVideo.findById(f.id).select("+sourceUrl +description +publicationToken +sessionCipher +reviewToken").lean()).toEqual(before);
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("retires the %s manual review endpoint without changing stored metadata or authority", async (type) => {
    const f = await fixture(type, {}, { status: "pending_review", videoId: undefined, url: undefined, reviewToken: undefined });
    const before = await YoutubeVideo.findById(f.id).select("+description +publicationToken +reviewToken").lean();
    const body = { updatedAt: f.updatedAt, title: "Lot 001 — Exact review", description: "Line 1\nLine 2", privacyStatus: "unlisted", policyConsent: true };
    const response = await request(app).post(reviewPath(f.id)).set(auth()).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(410);
    expect(response.body).toMatchObject({ code: "YOUTUBE_REVIEW_REMOVED", message: expect.stringContaining("automatically") });
    expect(await YoutubeVideo.findById(f.id).select("+description +publicationToken +reviewToken").lean()).toEqual(before);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await request(app).post(reviewPath(f.id)).set(auth()).send(body)).status).toBe(410);
  });

  it("keeps administrator authentication on the retired review endpoint", async () => {
    const f = await fixture(); const valid = { updatedAt: f.updatedAt, title: "Exact title", description: "Description", privacyStatus: "private", policyConsent: true };
    expect((await request(app).post(reviewPath(f.id)).send(valid)).status).toBe(401);
    expect((await request(app).post(reviewPath(f.id)).set(auth(ownerId)).send(valid)).status).toBe(403);
    expect((await request(app).post(reviewPath(f.id)).set(auth()).send({})).status).toBe(410);
    expect((await request(app).post(`${reviewPath(f.id)}?force=1`).set(auth()).send(valid)).status).toBe(410);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["lease", "removed", "stale-data", "report-generation", "connection", "unfinished"])("retired review cannot override %s state or change source/report data", async (reason) => {
    const f = await fixture(); const body = { updatedAt: f.updatedAt, title: "Exact title", description: "Description", privacyStatus: "public", policyConsent: true };
    if (reason === "lease") await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { leaseUntil: new Date(Date.now() + 60_000) } });
    if (reason === "removed") await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { status: "data_removed" }, $unset: { reportId: 1, sourceUrl: 1, channelId: 1 } });
    if (reason === "stale-data") await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { providerDataCheckedAt: new Date(Date.now() - 31 * 86400_000) } });
    if (reason === "report-generation") await f.model.collection.updateOne({ _id: f.reportId }, { $set: { job_id: "new" } });
    if (reason === "unfinished") await f.model.collection.updateOne({ _id: f.reportId }, { $set: { job_status: "processing" } });
    if (reason === "connection") mocks.connection.mockResolvedValue(null);
    expect((await request(app).post(reviewPath(f.id)).set(auth()).send(body)).status).toBe(410);
    expect((await request(app).get(listPath).set(auth())).body.items[0].reviewEligible).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect((await f.model.findById(f.reportId).lean())!.videoUrls).toEqual([source]);
  });

  it("minimal tombstones have no provider metadata and do not require a timestamp", async () => {
    await YoutubeVideo.collection.insertOne({ _id: "f".repeat(64), status: "data_removed" } as any);
    const result = await request(app).get(listPath).set(auth()); expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({ title: "", description: "", reportId: null, reportType: null, privacyStatus: null, updatedAt: null, reviewEligible: false, reviewRequired: false });
  });
  it("omits oversized suggestions explicitly instead of breaking the list or silently truncating", async () => {
    const f = await fixture("asset", {}, { title: "x".repeat(1001), description: "d".repeat(10001), reviewToken: undefined });
    const response = await request(app).get(listPath).set(auth()); expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ id: f.id, title: "", description: "", metadataOmitted: true, reviewRequired: false, reviewEligible: false, publicationMode: "automatic_public", targetPrivacyStatus: "public" });
    expect((await YoutubeVideo.findById(f.id).select("+description").lean())!.description).toHaveLength(10001);
  });
  it("hides links with confirmed unavailable provider evidence without erasing the receipt", async () => {
    const f = await fixture("asset", {}, { status: "public", providerAvailable: false });
    expect((await request(app).get(listPath).set(auth())).body.items[0].url).toBeNull();
    expect((await YoutubeVideo.findById(f.id).lean())!.url).toBe(url);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { providerAvailable: true } });
    expect((await request(app).get(listPath).set(auth())).body.items[0].url).toBe(url);
  });

  it("concurrent obsolete review requests cannot create any human authorization", async () => {
    const f = await fixture(); const body = { updatedAt: f.updatedAt, title: "Exact title", description: "Description", privacyStatus: "public", policyConsent: true };
    const before = await YoutubeVideo.findById(f.id).select("+publicationToken +reviewToken").lean();
    const responses = await Promise.all([1, 2].map(() => request(app).post(reviewPath(f.id)).set(auth()).send(body)));
    expect(responses.map((r) => r.status)).toEqual([410, 410]);
    expect(await YoutubeVideo.findById(f.id).select("+publicationToken +reviewToken").lean()).toEqual(before); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("requires a current unblocked admin database role on both endpoints, ignoring JWT role claims", async () => {
    const f = await fixture();
    for (const actor of [adminId, superadminId]) {
      expect((await request(app).get(listPath).set(auth(actor))).status).toBe(200);
    }
    for (const method of ["get", "post"] as const) {
      const path = method === "get" ? listPath : retryPath(f.id);
      expect((await request(app)[method](path).send({ updatedAt: f.updatedAt })).status).toBe(401);
      expect((await request(app)[method](path).set(auth(ownerId)).send({ updatedAt: f.updatedAt })).status).toBe(403);
    }
    await User.updateOne({ _id: adminId }, { $set: { isBlocked: true } });
    expect((await request(app).get(listPath).set(auth())).status).toBe(403);
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(403);
    await User.deleteOne({ _id: superadminId });
    expect((await request(app).get(listPath).set(auth(superadminId))).status).toBe(401);
    expect((await YoutubeVideo.findById(f.id).lean())!.publicationAttempts).toBe(5);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns automatic publication metadata to administrators but never source or secret capabilities", async () => {
    const first = await fixture();
    await fixture("lotListing", {}, { status: "public" });
    await fixture("asset", {}, { status: "uploading", videoId: undefined, url: undefined });
    const response = await request(app).get(listPath).set(auth());
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.body).toMatchObject({ page: 1, total: 3, totalPages: 1 });
    for (const item of response.body.items) {
      expect(Object.keys(item).sort()).toEqual(["description", "id", "lastError", "lotNumber", "metadataOmitted", "nextAttemptAt", "privacyStatus", "publicationMode", "reportId", "reportType", "retryEligible", "retryKind", "reviewEligible", "reviewRequired", "status", "targetPrivacyStatus", "title", "updatedAt", "url"]);
      expect(item.url).toBe(item.status === "public" ? url : null);
      expect(item).toMatchObject({ reviewRequired: false, reviewEligible: false, publicationMode: "automatic_public", targetPrivacyStatus: "public" });
    }
    expect(response.body.items.find((item: any) => item.id === first.id)).toMatchObject({ status: "needs_attention", retryEligible: true, retryKind: "publication", nextAttemptAt: null });
    expect(JSON.stringify(response.body)).not.toMatch(/private-(source|session|lease|owner-contact)/);
    expect(response.body.items[0]).toMatchObject({ title: "private-title", description: "private-description" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("bounds pages to 20 ordered receipts and reports complete pagination totals", async () => {
    const f = await fixture();
    const base = await YoutubeVideo.findById(f.id).select("+sourceUrl").lean();
    await YoutubeVideo.collection.insertMany(Array.from({ length: 24 }, (_, index) => ({ ...base, _id: String(index + 1).padStart(64, "0"), createdAt: new Date(2020, 0, index + 1) })));
    const first = await request(app).get(listPath).set(auth());
    const second = await request(app).get(`${listPath}?page=2`).set(auth());
    const empty = await request(app).get(`${listPath}?page=3`).set(auth());
    expect(first.body).toMatchObject({ page: 1, total: 25, totalPages: 2 });
    expect(first.body.items).toHaveLength(20);
    expect(second.body.items).toHaveLength(5);
    expect(empty.body.items).toEqual([]);
    expect(new Set([...first.body.items, ...second.body.items].map((item: any) => item.id)).size).toBe(25);
    expect(first.body.items[0].id).toBe(f.id);
    for (const query of ["page=0", "page=-1", "page=1.5", "page=10001", "page=NaN", "page=1&page=2", "page=1&limit=1000", "ownerId=forged"]) {
      expect((await request(app).get(`${listPath}?${query}`).set(auth())).status).toBe(400);
    }
  });

  it.each(["asset", "lotListing"] as const)("queues only the existing %s video using the exact receipt revision", async (type) => {
    const f = await fixture(type);
    const response = await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt });
    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.message).toContain("No new upload was started");
    const saved = await YoutubeVideo.findById(f.id).select("+sourceUrl +sessionCipher").lean();
    expect(saved).toMatchObject({ status: "private", publicationAttempts: 0, lastError: "", videoId, url, sourceUrl: source, sessionCipher: "private-session-capability" });
    expect(saved!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(await YoutubeVideo.countDocuments()).toBe(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(409);
  });

  it("allows at most one of two concurrent exact-revision retry requests", async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2].map(() => request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })));
    expect(results.map((value) => value.status).sort()).toEqual([202, 409]);
    expect(await YoutubeVideo.countDocuments()).toBe(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects a changed automatic authorization token even if the visible timestamp is identical", async () => {
    const f = await fixture();
    mocks.connection.mockImplementationOnce(async () => {
      await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { publicationToken: "new-system-authority" } });
      return connection;
    });
    const response = await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt });
    expect(response.status).toBe(409); expect(response.body.code).toBe("YOUTUBE_RETRY_CHANGED");
    expect(await YoutubeVideo.findById(f.id).select("+publicationToken").lean()).toMatchObject({ publicationToken: "new-system-authority", publicationAttempts: 5 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed requests, stale revisions and live receipt leases without changing state", async () => {
    const f = await fixture();
    for (const body of [{}, { updatedAt: "bad" }, { updatedAt: 1 }, { updatedAt: f.updatedAt, sourceUrl: source }, [f.updatedAt]]) {
      expect((await request(app).post(retryPath(f.id)).set(auth()).send(body)).status).toBe(400);
    }
    expect((await request(app).post(`${retryPath(f.id)}?force=true`).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(400);
    expect((await request(app).post(retryPath("not-a-receipt")).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(400);
    expect((await request(app).post(retryPath("a".repeat(64))).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(404);
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: "2019-01-01T00:00:00.000Z" })).status).toBe(409);
    await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: { leaseUntil: new Date(Date.now() + 60_000) } });
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(409);
    expect((await request(app).get(listPath).set(auth())).body.items[0].retryEligible).toBe(false);
    expect((await YoutubeVideo.findById(f.id).lean())!.publicationAttempts).toBe(5);
  });

  it.each(["archived", "deleted", "draft", "preview", "unreleased", "disabled", "owner", "generation", "unassigned"])("does not retry or offer retry for a %s parent", async (change) => {
    const f = await fixture();
    const changes: Record<string, unknown> = { archived: { adminArchivedAt: new Date() }, draft: { is_draft_preview: true }, preview: { status: "preview" }, unreleased: { release_status: "pending_release" }, disabled: { youtube_videos_enabled: false }, owner: { user: new mongoose.Types.ObjectId() }, generation: { job_id: "new-generation" }, unassigned: { preview_data: { lots: [] } } };
    if (change === "deleted") await f.model.collection.deleteOne({ _id: f.reportId });
    else await f.model.collection.updateOne({ _id: f.reportId }, { $set: changes[change] });
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(409);
    expect((await request(app).get(listPath).set(auth())).body.items[0].retryEligible).toBe(false);
    expect((await YoutubeVideo.findById(f.id).lean())!.publicationAttempts).toBe(5);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "revision", "channel", "public"])("rejects %s receipts without creating replacement uploads", async (change) => {
    const f = await fixture();
    if (change === "disconnected") mocks.connection.mockResolvedValue(null);
    if (change === "revision") mocks.connection.mockResolvedValue({ ...connection, revision: 3 });
    if (change === "channel") mocks.connection.mockResolvedValue({ ...connection, channelId: "other-channel" });
    if (change === "public") await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "public", visibilityPending: false } });
    expect((await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt })).status).toBe(409);
    expect((await request(app).get(listPath).set(auth())).body.items[0].retryEligible).toBe(false);
    expect(await YoutubeVideo.countDocuments()).toBe(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("resumes only the exact automatically authorized %s upload, retaining uncertain outcome evidence", async (type) => {
    const f = await fixture(type, { status: "pending_approval", release_status: "pending_release" }, {
      videoId: undefined, url: undefined, visibilityPending: false, uploadAttempts: 5, offset: 8388608,
      sourceSize: 18758929, sourceEtag: "unchanged-original", finalChunkAttempted: true, lastErrorCode: "YOUTUBE_TRANSPORT_UNCERTAIN",
    });
    const before = await YoutubeVideo.findById(f.id).select("+sourceUrl +sessionCipher +description +publicationToken +reviewToken").lean();
    expect((await request(app).get(listPath).set(auth())).body.items[0]).toMatchObject({ retryKind: "upload", retryEligible: true, nextAttemptAt: null });
    const response = await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt });
    expect(response.status).toBe(202); expect(response.body.message).toContain("saved session will be checked");
    const after = await YoutubeVideo.findById(f.id).select("+sourceUrl +sessionCipher +description +publicationToken +reviewToken").lean();
    expect(after).toMatchObject({ status: "uploading", uploadAttempts: 0, lastError: "", lastErrorCode: "", publicationAttempts: 5,
      sourceSize: 18758929, offset: 8388608, finalChunkAttempted: true, sourceEtag: "unchanged-original" });
    for (const field of ["sourceUrl", "sessionCipher", "title", "description", "privacyStatus", "publicationToken", "publicationGenerationToken", "publicationPolicyVersion", "reviewToken", "reviewGenerationToken", "reviewPolicyVersion", "channelId", "connectionRevision", "generationToken"] as const) {
      expect(after![field]).toEqual(before![field]);
    }
    expect(after!.reviewedAt).toEqual(before!.reviewedAt);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(await YoutubeVideo.countDocuments()).toBe(1);
    const stale = await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: f.updatedAt });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe("YOUTUBE_RETRY_CHANGED");
  });

  it("reports scheduled retries separately from exhausted attempts and retains future backoff", async () => {
    const when = new Date(Date.now() + 600_000);
    const f = await fixture("lotListing", {}, { videoId: undefined, url: undefined, status: "uploading", uploadAttempts: 2, nextAttemptAt: when });
    expect((await request(app).get(listPath).set(auth())).body.items[0]).toMatchObject({ status: "uploading", retryKind: "upload", nextAttemptAt: when.toISOString() });
    expect((await YoutubeVideo.findById(f.id).lean())!.nextAttemptAt).toEqual(when);
    await YoutubeVideo.updateOne({ _id: f.id }, { $set: { status: "needs_attention", uploadAttempts: 5 } });
    expect((await request(app).get(listPath).set(auth())).body.items[0]).toMatchObject({ retryKind: "upload", nextAttemptAt: null });
  });

  it.each(["unauthorized", "pending-review", "stale-authority", "stale-data", "removed", "unfinished", "regenerating", "lease", "owner", "generation", "connection"])("never resumes a %s upload", async (reason) => {
    const f = await fixture("asset", {}, { videoId: undefined, url: undefined, uploadAttempts: 5 });
    const receiptChanges: Record<string, unknown> = {
      unauthorized: { publicationToken: "" }, "pending-review": { status: "pending_review" }, "stale-authority": { publicationGenerationToken: "old" },
      "stale-data": { createdAt: new Date(Date.now() - 31 * 86400_000) }, removed: { status: "data_removed" }, lease: { leaseUntil: new Date(Date.now() + 60_000) },
    };
    const reportChanges: Record<string, unknown> = { unfinished: { job_status: "processing" }, regenerating: { files_regenerating: true }, owner: { user: new mongoose.Types.ObjectId() }, generation: { job_id: "new-files" } };
    if (receiptChanges[reason]) await YoutubeVideo.collection.updateOne({ _id: f.id }, { $set: receiptChanges[reason] });
    if (reportChanges[reason]) await f.model.collection.updateOne({ _id: f.reportId }, { $set: reportChanges[reason] });
    if (reason === "connection") mocks.connection.mockResolvedValue({ ...connection, revision: 3 });
    const receipt = await YoutubeVideo.findById(f.id).lean();
    const response = await request(app).post(retryPath(f.id)).set(auth()).send({ updatedAt: receipt!.updatedAt.toISOString() });
    expect(response.status).toBe(409); expect(response.body.code).toBe("YOUTUBE_RETRY_UNAVAILABLE");
    expect((await request(app).get(listPath).set(auth())).body.items[0]).toMatchObject({ retryEligible: false, retryKind: null, nextAttemptAt: null });
    expect((await YoutubeVideo.findById(f.id).lean())!.uploadAttempts).toBe(5); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
