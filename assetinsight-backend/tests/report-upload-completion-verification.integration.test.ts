/**
 * Upload completion does not repeat finished verification work.
 *
 * Reported 2026-10-01: on large reports the mobile app's progress bar sat at
 * "Finalizing Report". Completion HEADed every photo on every attempt; once an
 * attempt ran past the app's and the proxy's 120 s window, the app retried and
 * each retry began the whole pass again while the abandoned attempt kept going.
 * A storage hiccup on any one photo also failed the whole session as "missing".
 *
 * These tests pin the three rules in reportUploadSession.controller.ts
 * ("Completion verification of an ordinary session"): recent verifications are
 * reused, completion records its own progress as it goes, and only a real
 * "not found" counts as missing -- anything else is a retryable 503.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueLotListingJob: vi.fn(),
  queueAssetPreviewJob: vi.fn(),
  headR2Object: vi.fn(),
  deleteFromR2: vi.fn(),
}));

vi.mock("../src/jobs/assetReportJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/assetReportJob.js")>()),
  queueAssetPreviewJob: mocks.queueAssetPreviewJob,
}));

vi.mock("../src/jobs/lotListingJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/lotListingJob.js")>()),
  queueLotListingJob: mocks.queueLotListingJob,
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>()),
  headR2Object: mocks.headR2Object,
  deleteFromR2: mocks.deleteFromR2,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let ReportUploadSession: typeof import("../src/models/reportUploadSession.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let ensureReportJobOutbox: typeof import("../src/utils/reportJobMongoQueue.js")["ensureReportJobOutbox"];
let isRecentUploadVerification: typeof import("../src/controller/reportUploadSession.controller.js")["isRecentUploadVerification"];

const originalEnvironment = new Map<string, string | undefined>();
const setEnvironment = (name: string, value: string) => {
  if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
  process.env[name] = value;
};

beforeAll(async () => {
  setEnvironment("REPORT_QUEUE_BACKEND", "mongo");
  setEnvironment("DEVICE_APPROVAL_ENFORCEMENT", "off");
  setEnvironment("JWT_SECRET", process.env.JWT_SECRET || "completion-verification-test-secret");
  setEnvironment("R2_BUCKET_NAME", "asset-insight-test");
  setEnvironment("R2_BUCKET", "asset-insight-test");
  setEnvironment("R2_PUBLIC_URL", "https://assetinsight.test");
  setEnvironment("R2_CUSTOM_DOMAIN", "https://assetinsight.test");
  setEnvironment("R2_LEGACY_BUCKET_NAME", "sellsnap");
  setEnvironment("R2_LEGACY_PUBLIC_URL", "https://images.sellsnap.store");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: ReportUploadSession } = await import("../src/models/reportUploadSession.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ ensureReportJobOutbox } = await import("../src/utils/reportJobMongoQueue.js"));
  ({ isRecentUploadVerification } = await import("../src/controller/reportUploadSession.controller.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mocks.headR2Object.mockReset();
  mocks.headR2Object.mockResolvedValue({ size: 12 });
  mocks.deleteFromR2.mockReset();
  mocks.queueAssetPreviewJob.mockReset();
  mocks.queueAssetPreviewJob.mockImplementation((input: any) =>
    ensureReportJobOutbox("asset", String(input.reportId), String(input.reportJobOutboxToken)));
  mocks.queueLotListingJob.mockReset();
  mocks.queueLotListingJob.mockImplementation((input: any) =>
    ensureReportJobOutbox("lotListing", String(input.listingId), String(input.reportJobOutboxToken)));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Marker = "none" | "fresh" | "stale" | "wrongSize";

/** An ordinary (non-Smart Upload) lot-listing session of `count` photos, ready to complete. */
async function makeSession(count: number, markerFor: (index: number) => Marker = () => "none", type: "asset" | "lotListing" = "lotListing") {
  const user = await User.create({ email: `verify-${count}@example.test`, username: `verify-${count}`,
    password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
  const auth = { Authorization: `Bearer ${jwt.sign({ id: String(user._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` };
  const sessionId = new mongoose.Types.ObjectId();
  const now = Date.now();
  const files = Array.from({ length: count }, (_, index) => {
    const marker = markerFor(index);
    return {
      fileId: `photo-${index}`,
      key: `uploads/report-sessions/lotListing/${sessionId}/photo-${index}.jpg`,
      fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg", size: 12,
      lotIndex: Math.floor(index / 200), imageIndex: index % 200, originalOrder: index, role: "main",
      ...(marker === "fresh" ? { uploadedAt: new Date(now - 60_000), verifiedSize: 12 } : {}),
      ...(marker === "stale" ? { uploadedAt: new Date(now - 2 * 60 * 60_000), verifiedSize: 12 } : {}),
      ...(marker === "wrongSize" ? { uploadedAt: new Date(now - 60_000), verifiedSize: 11 } : {}),
    };
  });
  const details = {
    client_submission_id: `verify-submission-${count}`, contract_no: `VERIFY-${count}`,
    grouping_mode: "mixed", mixed_lots: Array.from({ length: Math.ceil(count / 200) }, (_, index) => ({
      count: Math.min(200, count - index * 200), extra_count: 0, mode: "single_lot",
    })),
    location: "Regina, SK", sales_date: "2026-10-01", valuation_methods: ["FML"],
  };
  const session = await ReportUploadSession.create({
    _id: sessionId, type, user: user._id, jobId: `verify-job-${count}`,
    clientSubmissionId: details.client_submission_id, status: "uploading", manifestHash: `verify-${count}`,
    manifestVersion: 2, smartUpload: false, details, files, expectedFileCount: count,
    expectedImageCount: count, expectedVideoCount: 0, totalBytes: 12 * count,
    r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test",
  });
  return { session, auth, url: `/api/${type === "asset" ? "asset" : "lot-listing"}/upload-session/${session._id}/complete` };
}

const checkedKeys = () => mocks.headR2Object.mock.calls.map((call) => String(call[1]).split("/").pop());

describe("isRecentUploadVerification", () => {
  const now = Date.parse("2026-10-01T18:00:00.000Z");
  const window = 30 * 60_000;

  it("trusts a matching verification inside the window", () => {
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 12, uploadedAt: new Date(now - 5 * 60_000) }, now, window)).toBe(true);
  });

  it("does not trust an old one, a different size, or one never recorded", () => {
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 12, uploadedAt: new Date(now - window - 1) }, now, window)).toBe(false);
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 11, uploadedAt: new Date(now) }, now, window)).toBe(false);
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 12 }, now, window)).toBe(false);
    expect(isRecentUploadVerification({ size: 0, verifiedSize: 0, uploadedAt: new Date(now) }, now, window)).toBe(false);
  });

  it("tolerates a minute of clock difference between API processes, no more", () => {
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 12, uploadedAt: new Date(now + 30_000) }, now, window)).toBe(true);
    expect(isRecentUploadVerification({ size: 12, verifiedSize: 12, uploadedAt: new Date(now + 5 * 60_000) }, now, window)).toBe(false);
  });
});

describe.sequential("upload completion verification", () => {
  it("keeps Asset verification failures resumable and preserves its exact upload identity", async () => {
    const { session, url, auth } = await makeSession(3, () => "none", "asset");
    mocks.headR2Object.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("photo-2.jpg")) throw Object.assign(new Error("Storage busy"), { $metadata: { httpStatusCode: 503 } });
      return { size: 12 };
    });
    const failed = await request(app).post(url).set(auth);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("UPLOAD_VERIFICATION_UNAVAILABLE");
    const saved = await ReportUploadSession.findById(session._id).lean();
    expect(saved?.clientSubmissionId).toBe(session.clientSubmissionId);
    expect(saved?.status).toBe("uploading");
    expect(saved?.files.filter((file) => file.verifiedSize === 12)).toHaveLength(2);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
    mocks.headR2Object.mockReset().mockResolvedValue({ size: 12 });
    const retry = await request(app).post(url).set(auth);
    expect(retry.status).toBe(202);
    expect(mocks.headR2Object).toHaveBeenCalledTimes(1);
    expect(await ReportUploadSession.countDocuments()).toBe(1);
  });
  it("accepts photos verified moments ago without checking storage again", async () => {
    const { url, auth } = await makeSession(3, () => "fresh");
    const response = await request(app).post(url).set(auth);
    expect(response.status).toBe(202);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("checks storage again for an old verification or one that does not match the manifest", async () => {
    const { url, auth } = await makeSession(3, (index) => (["stale", "wrongSize", "fresh"] as Marker[])[index]);
    const response = await request(app).post(url).set(auth);
    expect(response.status).toBe(202);
    expect(checkedKeys().sort()).toEqual(["photo-0.jpg", "photo-1.jpg"]);
    // Every check carries a deadline, so one stalled socket cannot hold the request.
    for (const call of mocks.headR2Object.mock.calls) {
      expect(call[2]).toEqual({ timeoutMs: 15_000 });
    }
  });

  it("completes in one request after recording its progress part way through", async () => {
    // 60 photos cross the 50-photo batch, so progress is written mid-request.
    // The submission compare-and-set matches updatedAt; it still succeeds only
    // because those writes leave updatedAt alone.
    const { session, url, auth } = await makeSession(60);
    const response = await request(app).post(url).set(auth);
    expect(response.status).toBe(202);
    expect(mocks.headR2Object).toHaveBeenCalledTimes(60);
    const saved: any = await ReportUploadSession.findById(session._id).lean();
    expect(saved.status).not.toBe("uploading");
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("treats a storage hiccup as retryable, keeps the session open, and lets the retry check only what is left", async () => {
    const { session, url, auth } = await makeSession(60);
    const before: any = await ReportUploadSession.findById(session._id).lean();
    let calls = 0;
    mocks.headR2Object.mockImplementation(async () => {
      calls += 1;
      if (calls > 55) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return { size: 12 };
    });

    const first = await request(app).post(url).set(auth);
    expect(first.status).toBe(503);
    expect(first.headers["retry-after"]).toBe("5");
    expect(first.body).toMatchObject({ code: "UPLOAD_VERIFICATION_UNAVAILABLE", retryable: true, data: { unconfirmedCount: 5 } });

    const afterFirst: any = await ReportUploadSession.findById(session._id).lean();
    expect(afterFirst.status).toBe("uploading");
    expect(afterFirst.lastError).toBeFalsy();
    // Progress was recorded without touching updatedAt.
    expect(new Date(afterFirst.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    const recorded = afterFirst.files.filter((file: any) => file.verifiedSize === 12 && file.uploadedAt);
    expect(recorded).toHaveLength(55);

    mocks.headR2Object.mockReset();
    mocks.headR2Object.mockResolvedValue({ size: 12 });
    const retry = await request(app).post(url).set(auth);
    expect(retry.status).toBe(202);
    expect(mocks.headR2Object).toHaveBeenCalledTimes(5);
    const recordedKeys = new Set(recorded.map((file: any) => String(file.key).split("/").pop()));
    for (const key of checkedKeys()) expect(recordedKeys.has(key)).toBe(false);
    expect(await ReportJob.countDocuments()).toBe(1);
  });

  it("still fails the session when storage says a photo is not there", async () => {
    const { session, url, auth } = await makeSession(3);
    mocks.headR2Object.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("photo-1.jpg")) {
        throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      return { size: 12 };
    });
    const response = await request(app).post(url).set(auth);
    expect(response.status).toBe(400);
    expect(response.body.missingFiles).toEqual(["photo-1.jpg"]);
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe("failed");
    expect(await ReportJob.countDocuments()).toBe(0);
  });
});

/*
 * The per-photo check (POST .../files/:fileId/verify) reads only the session's
 * state, storage target and the one photo (2026-10-02). These pin that it still
 * answers exactly as before and writes to that photo alone.
 */
describe.sequential("photo check", () => {
  const verifyUrl = (sessionId: unknown, fileId: string) =>
    `/api/lot-listing/upload-session/${sessionId}/files/${fileId}/verify`;

  it("keeps both database responses bounded for a 5,000-photo manifest", async () => {
    const { session, auth } = await makeSession(5_000);
    const find = vi.spyOn(ReportUploadSession, "findOne");
    const update = vi.spyOn(ReportUploadSession, "findOneAndUpdate");
    try {
      const response = await request(app).post(verifyUrl(session._id, "photo-4999")).set(auth).send({});
      expect(response.status).toBe(200);
      expect(find).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ files: { $elemMatch: { fileId: "photo-4999" } } }));
      expect(update).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ projection: { _id: 1 } }));
      expect(mocks.headR2Object).toHaveBeenCalledTimes(1);
      const saved = await ReportUploadSession.findById(session._id).lean();
      expect(saved?.files).toHaveLength(5_000);
      expect(saved?.files[4999].verifiedSize).toBe(12);
      expect(saved?.files[0].verifiedSize).toBeUndefined();
    } finally {
      find.mockRestore();
      update.mockRestore();
    }
  });

  it("verifies the one photo asked about and records it on that photo only", async () => {
    const { session, auth } = await makeSession(3);
    const response = await request(app).post(verifyUrl(session._id, "photo-1")).set(auth).send({});
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ fileId: "photo-1", verified: true, size: 12 });
    expect(mocks.headR2Object).toHaveBeenCalledTimes(1);
    expect(String(mocks.headR2Object.mock.calls[0][1])).toMatch(/photo-1.jpg$/);
    const saved: any = await ReportUploadSession.findById(session._id).lean();
    const byId = Object.fromEntries(saved.files.map((file: any) => [file.fileId, file]));
    expect(byId["photo-1"].verifiedSize).toBe(12);
    expect(byId["photo-1"].uploadedAt).toBeTruthy();
    expect(byId["photo-0"].verifiedSize).toBeUndefined();
    expect(byId["photo-2"].verifiedSize).toBeUndefined();
    expect(saved.files).toHaveLength(3);
  });

  it("says a photo is not uploaded yet when storage has no object", async () => {
    const { session, auth } = await makeSession(2);
    mocks.headR2Object.mockRejectedValue(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    const response = await request(app).post(verifyUrl(session._id, "photo-0")).set(auth).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("UPLOAD_NOT_VERIFIED");
  });

  it("refuses a photo whose stored size does not match", async () => {
    const { session, auth } = await makeSession(2);
    mocks.headR2Object.mockResolvedValue({ size: 11 });
    const response = await request(app).post(verifyUrl(session._id, "photo-0")).set(auth).send({});
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "UPLOAD_FILE_SIZE_MISMATCH", data: { expectedSize: 12, verifiedSize: 11 } });
  });

  it("answers 404 for a photo that is not in the session", async () => {
    const { session, auth } = await makeSession(2);
    const response = await request(app).post(verifyUrl(session._id, "photo-99")).set(auth).send({});
    expect(response.status).toBe(404);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
  });

  it("refuses to check a session that was already submitted", async () => {
    const { session, auth } = await makeSession(2);
    await ReportUploadSession.updateOne({ _id: session._id }, { $set: { status: "completed" } });
    const response = await request(app).post(verifyUrl(session._id, "photo-0")).set(auth).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("UPLOAD_SESSION_LOCKED");
  });
});
