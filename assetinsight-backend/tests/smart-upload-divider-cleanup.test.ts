import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import { cleanupCompletedSmartUploadDividers } from "../src/utils/smartUploadSessionMaintenance.js";

const storage = vi.hoisted(() => ({ deleteObject: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  deleteFromR2Strict: storage.deleteObject,
  getCurrentR2StorageTarget: () => ({ bucketName: "asset-insight-test" }),
  resolvePersistedR2StorageTarget: (session: { r2Bucket?: string }) => ({
    bucketName: session.r2Bucket || "sellsnap-test",
    generation: session.r2Bucket === "asset-insight-test" ? "current" : "legacy",
  }),
}));

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await ReportUploadSession.init();
});
beforeEach(async () => {
  await ReportUploadSession.deleteMany({});
  storage.deleteObject.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function makeSession(overrides: Record<string, unknown> = {}, dividerCount = 1) {
  const _id = new mongoose.Types.ObjectId();
  const prefix = `uploads/report-sessions/asset/${String(_id)}/`;
  const file = (fileId: string) => ({
    fileId, key: `${prefix}${fileId}.jpg`, fieldname: "images",
    originalname: `${fileId}.jpg`, mimetype: "image/jpeg", size: 100,
  });
  const dividerIds = Array.from({ length: dividerCount }, (_, index) => `divider-${index}`);
  return ReportUploadSession.create({
    _id, type: "asset", user: new mongoose.Types.ObjectId(), jobId: `job-${_id}`,
    clientSubmissionId: `submission-${_id}`, reportId: String(new mongoose.Types.ObjectId()),
    smartUpload: true, status: "queued", r2Bucket: "asset-insight-test",
    r2PublicBaseUrl: "https://assetinsight.test", queuedAt: new Date(),
    files: [file("report-photo"), ...dividerIds.map(file)],
    smartGrouping: { status: "confirmed", dividerFileIds: dividerIds,
      groups: [{ groupIndex: 0, imageCount: 1, fileIds: ["report-photo"], overLimit: false }],
    },
    ...overrides,
  });
}

const load = (id: unknown) => ReportUploadSession.findById(id)
  .select("+dividerCleanupCompletedAt +dividerCleanupClaimedAt +dividerCleanupClaimToken +dividerCleanupLastError");

describe("accepted Smart Upload divider cleanup", () => {
  it.each(["queued", "processed"])("deletes only excluded divider originals for %s and never deletes the session", async (status) => {
    const session = await makeSession({ status });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 1, objects: 1, failedObjects: 0 });
    expect(storage.deleteObject).toHaveBeenCalledExactlyOnceWith("asset-insight-test", session.files[1].key);
    const saved = await load(session._id);
    expect(saved?.files.map((file) => file.fileId)).toEqual(["report-photo", "divider-0"]);
    expect(saved?.status).toBe(status);
    expect(saved?.dividerCleanupCompletedAt).toBeInstanceOf(Date);
    expect(saved?.dividerCleanupClaimToken).toBeUndefined();
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 0, failedObjects: 0 });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("retains failed cleanup for lease-reclaimed retry after a restart", async () => {
    const session = await makeSession();
    storage.deleteObject.mockRejectedValueOnce(new Error("Synthetic R2 outage"));
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 0, failedObjects: 1 });
    expect((await load(session._id))?.dividerCleanupLastError).toContain("retry automatically");
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 0, failedObjects: 0 });
    await ReportUploadSession.updateOne({ _id: session._id }, {
      $set: { dividerCleanupClaimedAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 1, objects: 1, failedObjects: 0 });
    expect((await load(session._id))?.dividerCleanupLastError).toBeUndefined();
  });

  it("reclaims a crash after claim/before completion, keeping duplicate deletes idempotent", async () => {
    const session = await makeSession({ dividerCleanupClaimToken: "crashed-worker",
      dividerCleanupClaimedAt: new Date(Date.now() - 24 * 60 * 60_000) });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 1, objects: 1, failedObjects: 0 });
    expect((await load(session._id))?.dividerCleanupCompletedAt).toBeInstanceOf(Date);
  });

  it.each([undefined, "sellsnap-test"])("never deletes legacy bucket objects (%s)", async (r2Bucket) => {
    const session = await makeSession({ r2Bucket });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 1, objects: 0, failedObjects: 0 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect((await load(session._id))?.dividerCleanupCompletedAt).toBeInstanceOf(Date);
  });

  it("protects grouped IDs, reused report keys, videos and foreign-session keys", async () => {
    const session = await makeSession({}, 5);
    session.smartGrouping!.groups[0].fileIds.push("divider-0");
    session.files[2].key = session.files[0].key; // Divider alias of a report object.
    session.files[3].key = "uploads/report-sessions/asset/other-session/photo.jpg";
    session.files[4].fieldname = "videos";
    await session.save();
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 1, objects: 1, failedObjects: 0 });
    expect(storage.deleteObject).toHaveBeenCalledExactlyOnceWith("asset-insight-test", session.files[5].key);
  });

  it("ignores editable, failed, unconfirmed, empty-group and full-cleanup sessions", async () => {
    for (const status of ["created", "uploading", "completed", "failed"]) await makeSession({ status });
    await makeSession({ smartUpload: false });
    await makeSession({}, 0);
    await makeSession({ reportId: undefined });
    await makeSession({ "smartGrouping": { status: "review_ready", groups: [] } });
    await makeSession({ "smartGrouping": { status: "confirmed", groups: [] } });
    await makeSession({ cleanupStartedAt: new Date() });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 0, failedObjects: 0 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("does not finish or clear a newer worker's cleanup claim", async () => {
    const session = await makeSession();
    storage.deleteObject.mockImplementationOnce(async () => {
      await ReportUploadSession.updateOne({ _id: session._id }, {
        $set: { dividerCleanupClaimToken: "new-owner", dividerCleanupClaimedAt: new Date() },
      });
    });
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 1, failedObjects: 0 });
    const saved = await load(session._id);
    expect(saved?.dividerCleanupClaimToken).toBe("new-owner");
    expect(saved?.dividerCleanupCompletedAt).toBeUndefined();
  });

  it("bounds concurrent deletes and competing sweeps claim each session once", async () => {
    await makeSession({}, 20);
    let active = 0;
    let peak = 0;
    storage.deleteObject.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });
    const results = await Promise.all([cleanupCompletedSmartUploadDividers(), cleanupCompletedSmartUploadDividers()]);
    expect(results.reduce((sum, value) => sum + value.objects, 0)).toBe(20);
    expect(results.reduce((sum, value) => sum + value.sessions, 0)).toBe(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(storage.deleteObject).toHaveBeenCalledTimes(20);
  });

  it("does not expose internal cleanup claims in default model reads", async () => {
    const session = await makeSession({ dividerCleanupClaimToken: "private-token",
      dividerCleanupClaimedAt: new Date(), dividerCleanupLastError: "internal cleanup warning" });
    const safe = await ReportUploadSession.findById(session._id).lean();
    expect(safe).not.toHaveProperty("dividerCleanupClaimToken");
    expect(safe).not.toHaveProperty("dividerCleanupClaimedAt");
    expect(safe).not.toHaveProperty("dividerCleanupLastError");
  });
});
