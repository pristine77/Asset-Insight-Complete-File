import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueLotListingJob: vi.fn(),
  headR2Object: vi.fn(),
  queueAssetPreviewJob: vi.fn(),
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
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportUploadSession: typeof import("../src/models/reportUploadSession.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let ensureReportJobOutbox: typeof import("../src/utils/reportJobMongoQueue.js")["ensureReportJobOutbox"];

const originalEnvironment = new Map<string, string | undefined>();
const setEnvironment = (name: string, value: string) => {
  if (!originalEnvironment.has(name)) {
    originalEnvironment.set(name, process.env[name]);
  }
  process.env[name] = value;
};

beforeAll(async () => {
  setEnvironment("REPORT_QUEUE_BACKEND", "mongo");
  setEnvironment("DEVICE_APPROVAL_ENFORCEMENT", "off");
  setEnvironment("JWT_SECRET", process.env.JWT_SECRET || "upload-outbox-test-secret");
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
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportUploadSession } = await import(
    "../src/models/reportUploadSession.model.js"
  ));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ ensureReportJobOutbox } = await import(
    "../src/utils/reportJobMongoQueue.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mocks.queueLotListingJob.mockReset();
  mocks.headR2Object.mockReset();
  mocks.headR2Object.mockResolvedValue({ size: 12 });
  mocks.deleteFromR2.mockReset();
  mocks.queueAssetPreviewJob.mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function makeReceiptFixture(type: "asset" | "lotListing" = "lotListing") {
  const user = await User.create({ email: "receipt-owner@example.test", username: "receipt-owner",
    password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
  const token = jwt.sign({ id: String(user._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
  const jobId = "receipt-preview-job";
  const Model = type === "asset" ? (await import("../src/models/asset.model.js")).default : LotListing;
  const listing = await (Model as any).create({ user: user._id, client_submission_id: "receipt-submission",
    contract_no: "QA-RECEIPT", grouping_mode: "single_lot", sales_date: new Date("2026-09-10"), location: "Regina, SK",
    imageUrls: [], videoUrls: [], lots: [], status: "processing", job_id: jobId,
    job_status: "queued", valuation_methods: ["FML"] });
  const session = await ReportUploadSession.create({ type, user: user._id,
    clientSubmissionId: "receipt-submission", status: "completed", smartUpload: true,
    reportId: String(listing._id), jobId, files: [], details: {} });
  return { user, listing, session, jobId, Model: Model as any, auth: { Authorization: `Bearer ${token}` },
    url: `/api/${type === "asset" ? "asset" : "lot-listing"}/upload-session/${session._id}/status` };
}

describe.sequential("upload completion status receipts", () => {
  it("does not erase newer same-identity or superseded-alias drafts on an accepted retry", async () => {
    const { user, listing, session, jobId, auth, url } = await makeReceiptFixture();
    const ReportDraft = (await import("../src/models/reportDraft.model.js")).default;
    const cutoff = new Date(Date.now() - 60_000);
    await ReportUploadSession.updateOne({ _id: session._id }, { $set: { status: "processed",
      uploadCompletedAt: cutoff, supersedesClientSubmissionIds: ["newer-alias", "old-alias"] } });
    await ReportJob.create({ type: "lot-listing-preview", reportId: String(listing._id), progressId: jobId,
      status: "completed", payload: {} });
    await ReportDraft.create([
      { user: user._id, type: "lotListing", clientDraftId: "receipt-submission", revision: 7, formData: { clientName: "Changed after acceptance" } },
      { user: user._id, type: "lotListing", clientDraftId: "newer-alias", revision: 8, formData: { clientName: "Alias changes retained" } },
      { user: user._id, type: "lotListing", clientDraftId: "old-alias", revision: 1, updatedAt: new Date(cutoff.getTime() - 1000) },
    ]);
    await ReportDraft.collection.updateOne({ clientDraftId: "old-alias" }, { $set: { updatedAt: new Date(cutoff.getTime() - 1000) } });
    const newerBefore = await ReportDraft.find({ clientDraftId: { $ne: "old-alias" } }).sort({ clientDraftId: 1 }).lean();
    const complete = await request(app).post(url.replace("/status", "/complete")).set(auth);
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ accepted: true, reportAvailable: true });
    await vi.waitFor(async () => expect(await ReportDraft.exists({ clientDraftId: "old-alias" })).toBeNull());
    expect(await ReportDraft.find().sort({ clientDraftId: 1 }).lean()).toEqual(newerBefore);
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
  });

  it.each([
    ["asset", "queued"], ["asset", "processed"], ["lotListing", "queued"], ["lotListing", "processed"],
  ] as const)("preserves a saved draft when retrying a %s %s upload whose report was removed", async (type, status) => {
    const { user, listing, session, jobId, Model, auth, url } = await makeReceiptFixture(type);
    const ReportDraft = (await import("../src/models/reportDraft.model.js")).default;
    const file = { fileId: "photo-1", fieldname: "images", originalname: "photo.jpg", mimetype: "image/jpeg", size: 12,
      key: "uploads/report-sessions/receipt/photo.jpg", imageIndex: 0, originalOrder: 0, role: "main" };
    await ReportUploadSession.updateOne({ _id: session._id }, { $set: { status, files: [file] } });
    await ReportJob.create({ type: type === "asset" ? "asset-preview" : "lot-listing-preview", reportId: String(listing._id), progressId: jobId,
      status: "completed", payload: {} });
    await Model.deleteOne({ _id: listing._id });
    const draft = await ReportDraft.create({ user: user._id, type, clientDraftId: "receipt-submission",
      revision: 7, formData: { clientName: "Unsaved changes retained" }, lots: [{ id: "lot-1" }], media: [] });
    const savedDraft = await ReportDraft.findById(draft._id).lean();
    const savedSession = await ReportUploadSession.findById(session._id).lean();

    const complete = await request(app).post(url.replace("/status", "/complete")).set(auth);
    expect(complete.status).toBe(409);
    expect(complete.body).toMatchObject({ code: "UPLOAD_SESSION_REPORT_UNAVAILABLE",
      data: { sessionId: String(session._id), accepted: true, reportAvailable: false, canCreateSeparate: true } });
    const receipt = await request(app).get(url).set(auth);
    expect(receipt.body.data).toMatchObject({ accepted: true, reportAvailable: false, status: "unavailable",
      code: "UPLOAD_SESSION_REPORT_UNAVAILABLE", canSupersede: false, canCreateSeparate: true });
    const resume = await request(app).post(url.replace(`/${session._id}/status`, "")).set(auth).send({
      details: { client_submission_id: "receipt-submission", smart_upload: true, valuation_methods: ["FML"] }, files: [file],
    });
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe("UPLOAD_SESSION_REPORT_UNAVAILABLE");
    expect(await ReportDraft.findById(draft._id).lean()).toEqual(savedDraft);
    expect(await ReportUploadSession.findById(session._id).lean()).toEqual(savedSession);
    expect(await ReportJob.countDocuments()).toBe(1);
    expect(await Model.countDocuments()).toBe(0);
    expect(mocks.queueAssetPreviewJob).not.toHaveBeenCalled();
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
  });

  it.each(["pending", "incoming"])("never authorizes a separate report for an unavailable %s handoff", async (kind) => {
    const { listing, session, auth, url } = await makeReceiptFixture();
    if (kind === "incoming") await ReportUploadSession.updateOne({ _id: session._id }, { $set: {
      status: "processed", "details.auctioneer_work_item_id": String(new mongoose.Types.ObjectId()),
    } });
    await LotListing.deleteOne({ _id: listing._id });
    const receipt = await request(app).get(url).set(auth);
    expect(receipt.body.data).toMatchObject({ accepted: kind === "incoming", reportAvailable: false,
      canCreateSeparate: false, canSupersede: false, status: "unavailable" });
    const complete = await request(app).post(url.replace("/status", "/complete")).set(auth);
    expect(complete.status).toBe(409);
    expect(complete.body).toMatchObject({ code: "UPLOAD_SESSION_REPORT_UNAVAILABLE", data: { canCreateSeparate: false } });
    expect(await LotListing.countDocuments()).toBe(0);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it("keeps an unlinked finalization claim distinct from a replaceable uploading session", async () => {
    const { listing, session, auth, url } = await makeReceiptFixture();
    await LotListing.deleteOne({ _id: listing._id });
    await ReportUploadSession.updateOne({ _id: session._id }, { $unset: { reportId: 1 },
      $set: { finalizationClaimToken: "pending-claim" } });
    const claimed = await request(app).get(url).set(auth);
    expect(claimed.body.data).toMatchObject({ accepted: false, reportAvailable: null,
      canCreateSeparate: false, canSupersede: false, status: "preparing" });
    expect(JSON.stringify(claimed.body)).not.toContain("pending-claim");
    await ReportUploadSession.updateOne({ _id: session._id }, { $unset: { finalizationClaimToken: 1 }, $set: { status: "uploading" } });
    const uploading = await request(app).get(url).set(auth);
    expect(uploading.body.data).toMatchObject({ accepted: false, reportAvailable: null,
      canCreateSeparate: false, canSupersede: true, status: "ready" });
  });

  it.each(["queued", "processed"])("does not claim a %s session without a report identity is available or remove its draft", async (status) => {
    const { user, session, auth, url } = await makeReceiptFixture();
    const ReportDraft = (await import("../src/models/reportDraft.model.js")).default;
    await ReportDraft.create({ user: user._id, type: "lotListing", clientDraftId: "receipt-submission", revision: 1 });
    await ReportUploadSession.updateOne({ _id: session._id }, { $unset: { reportId: 1 },
      $set: { status, uploadCompletedAt: new Date(Date.now() + 1000) } });
    const before = await ReportDraft.findOne().lean();
    const complete = await request(app).post(url.replace("/status", "/complete")).set(auth);
    expect(complete.status).toBe(409);
    expect(complete.body).toMatchObject({ code: "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED",
      data: { accepted: false, reportAvailable: null, canSupersede: false, canCreateSeparate: false } });
    const receipt = await request(app).get(url).set(auth);
    expect(receipt.body.data).toMatchObject({ accepted: false, reportAvailable: null,
      code: "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED", canSupersede: false, canCreateSeparate: false });
    expect(await ReportDraft.findOne().lean()).toEqual(before);
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it.each((["asset", "lotListing"] as const).flatMap((type) =>
    ["created", "uploading", "completed", "failed"].map((status) => ({ type, status }))))(
    "blocks $type $status recovery when its report link is lost but an exact preview job remains", async ({ type, status }) => {
      const { user, Model, listing, session, jobId, auth, url } = await makeReceiptFixture(type);
      const ReportDraft = (await import("../src/models/reportDraft.model.js")).default;
      const file = { fileId: "photo-1", fieldname: "images", originalname: "photo.jpg", mimetype: "image/jpeg", size: 12,
        key: "uploads/report-sessions/receipt/photo.jpg", imageIndex: 0, originalOrder: 0, role: "main" };
      await ReportUploadSession.updateOne({ _id: session._id }, { $unset: { reportId: 1 }, $set: { status, files: [file] } });
      await ReportJob.create({ type: type === "asset" ? "asset-preview" : "lot-listing-preview", reportId: String(listing._id),
        progressId: jobId, status: "failed", payload: {} });
      await Model.deleteOne({ _id: listing._id });
      await ReportDraft.create({ user: user._id, type, clientDraftId: "receipt-submission", revision: 9 });
      const before = await ReportUploadSession.findById(session._id).lean();
      const savedDraft = await ReportDraft.findOne().lean();
      const receipt = await request(app).get(url).set(auth);
      expect(receipt.body.data).toMatchObject({ code: "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED", accepted: false,
        canSupersede: false, canCreateSeparate: false, reportAvailable: null });
      const create = await request(app).post(url.replace(`/${session._id}/status`, "")).set(auth).send({
        details: { client_submission_id: "receipt-submission", smart_upload: true, valuation_methods: ["FML"] }, files: [file],
      });
      expect(create.status).toBe(409);
      expect(create.body.code).toBe("UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED");
      const complete = await request(app).post(url.replace("/status", "/complete")).set(auth);
      expect(complete.status).toBe(409);
      expect(complete.body.code).toBe("UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED");
      expect(await ReportUploadSession.findById(session._id).lean()).toEqual(before);
      expect(await ReportDraft.findOne().lean()).toEqual(savedDraft);
      expect(await Model.countDocuments()).toBe(0);
      expect(await ReportJob.countDocuments()).toBe(1);
      expect(mocks.queueAssetPreviewJob).not.toHaveBeenCalled();
      expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
    });

  it.each(["asset", "lotListing"] as const)("does not infer lost %s acceptance from classifier, other-type, or other-progress jobs", async (type) => {
    const { Model, listing, session, jobId, auth, url } = await makeReceiptFixture(type);
    await Model.deleteOne({ _id: listing._id });
    await ReportUploadSession.updateOne({ _id: session._id }, { $unset: { reportId: 1 }, $set: { status: "uploading" } });
    await ReportJob.create([
      { type: "smart-upload-classify", reportId: String(listing._id), progressId: jobId, status: "completed", payload: {} },
      { type: type === "asset" ? "lot-listing-preview" : "asset-preview", reportId: String(listing._id), progressId: jobId, status: "completed", payload: {} },
      { type: type === "asset" ? "asset-preview" : "lot-listing-preview", reportId: String(listing._id), progressId: "other-progress", status: "completed", payload: {} },
    ]);
    const receipt = await request(app).get(url).set(auth);
    expect(receipt.body.data).toMatchObject({ status: "ready", accepted: false, reportAvailable: null, canSupersede: true });
    expect(receipt.body.data).not.toHaveProperty("code");
  });

  it("keeps a completed-session placeholder preparing until an exact durable receipt exists", async () => {
    const { session, listing, auth, url } = await makeReceiptFixture();
    const before = await ReportUploadSession.findById(session._id).lean();
    const response = await request(app).get(url).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "preparing", accepted: false, phase: "processing" });
    expect(response.body.data).not.toHaveProperty("reportId");
    expect(response.body.data).not.toHaveProperty("jobId");
    expect(await ReportUploadSession.findById(session._id).lean()).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await LotListing.findById(listing._id).lean())?.job_status).toBe("queued");
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it("does not accept classifier or unrelated preview jobs as the report receipt", async () => {
    const { listing, jobId, auth, url } = await makeReceiptFixture();
    await ReportJob.create([
      { type: "smart-upload-classify", reportId: String(listing._id), progressId: jobId, status: "completed", payload: {} },
      { type: "lot-listing-preview", reportId: String(listing._id), progressId: "other-generation", status: "completed", payload: {} },
      { type: "lot-listing-preview", reportId: String(new mongoose.Types.ObjectId()), progressId: jobId, status: "completed", payload: {} },
    ]);
    const response = await request(app).get(url).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ accepted: false, status: "preparing" });
    expect(response.body.data).not.toHaveProperty("reportId");
    expect(await ReportJob.countDocuments()).toBe(3);
  });

  it.each(["failed", "cancelled"])("retains the accepted report destination after an exact preview job is %s", async (status) => {
    const { listing, jobId, auth, url } = await makeReceiptFixture();
    await ReportJob.create({ type: "lot-listing-preview", reportId: String(listing._id), progressId: jobId,
      status, payload: { privateFixture: "must not be returned" }, lastError: "private provider diagnostics" });
    const response = await request(app).get(url).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ accepted: true, status: "failed", phase: "error",
      reportId: String(listing._id), jobId });
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it.each(["type", "reportId", "progressId", "token"])("does not accept a mismatched outbox %s", async (field) => {
    const { listing, jobId, auth, url } = await makeReceiptFixture();
    const outbox = { type: "lot-listing-preview", reportId: String(listing._id), progressId: jobId,
      token: "saved-intent", [field]: field === "token" ? "" : "wrong-identity" };
    await LotListing.updateOne({ _id: listing._id }, { $set: { report_job_outbox: outbox } });
    const response = await request(app).get(url).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ accepted: false, status: "preparing" });
    expect(response.body.data).not.toHaveProperty("reportId");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("returns 404 to another existing authenticated user without disclosing the upload", async () => {
    const { url } = await makeReceiptFixture();
    const outsider = await User.create({ email: "receipt-outsider@example.test", username: "receipt-outsider",
      password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
    const token = jwt.sign({ id: String(outsider._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
    const response = await request(app).get(url).set({ Authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Upload session not found" });
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });
});

describe.sequential("report upload-session durable outbox", () => {
  it.each(["asset", "lotListing"] as const)("rejects inconsistent %s mappings at both admission and completion without deleting drafts or queuing jobs", async (type) => {
    const ReportDraft = (await import("../src/models/reportDraft.model.js")).default;
    const AssetReport = (await import("../src/models/asset.model.js")).default;
    const user = await User.create({ email: "mapping@example.test", username: "mapping", password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
    const auth = { Authorization: `Bearer ${jwt.sign({ id: String(user._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` };
    const route = `/api/${type === "asset" ? "asset" : "lot-listing"}`;
    const details = { client_submission_id: "mapping-draft", contract_no: "MAPPING-94205", grouping_mode: "mixed", mixed_lots: [{ count: 1, mode: "single_lot" }], location: "Regina", sales_date: "2026-09-29" };
    const draft = await ReportDraft.create({ user: user._id, clientDraftId: details.client_submission_id, type, revision: 100, formData: details, lots: [{ id: "lot-1" }], media: [] });
    const saved = await ReportDraft.findById(draft._id).lean();
    const files = [0, 1].map((index) => ({ fileId: `photo-${index}`, fieldname: "images", originalname: `${index}.jpg`, mimetype: "image/jpeg", size: 12, key: `uploads/report-sessions/fixture/${index}.jpg`, imageIndex: index, originalOrder: index, role: "main", uploadedAt: new Date(), verifiedSize: 12 }));
    const rejected = await request(app).post(`${route}/upload-session`).set(auth).send({ details, files });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_LOT_PHOTO_MAPPING");
    expect(rejected.body.message).toContain("describe 1 photos, but the upload contains 2");
    expect(await ReportUploadSession.countDocuments()).toBe(0);
    const session = await ReportUploadSession.create({ user: user._id, type, jobId: "mapping-job", clientSubmissionId: details.client_submission_id, status: "uploading", manifestHash: "mapping-fixture", manifestVersion: 2, smartUpload: false, details, files, expectedFileCount: 2, expectedImageCount: 2, totalBytes: 24, r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test" });
    const completed = await request(app).post(`${route}/upload-session/${session._id}/complete`).set(auth);
    expect(completed.status).toBe(400);
    expect(completed.body.code).toBe("INVALID_LOT_PHOTO_MAPPING");
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe("uploading");
    const multipart = await request(app).post(route).set(auth).field("details", JSON.stringify(details)).attach("images", Buffer.alloc(12), "0.jpg").attach("images", Buffer.alloc(12), "1.jpg");
    expect(multipart.status).toBe(400);
    expect(multipart.body.code).toBe("INVALID_LOT_PHOTO_MAPPING");
    expect(await ReportDraft.findById(draft._id).lean()).toEqual(saved);
    expect(await AssetReport.countDocuments()).toBe(0);
    expect(await LotListing.countDocuments()).toBe(0);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.queueAssetPreviewJob).not.toHaveBeenCalled();
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("accepts 5,000 verified %s photos without waiting for storage cleanup and exposes a compact receipt", async (type) => {
    const user = await User.create({ email: "smart-large@example.test", username: "smart-large",
      password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
    const token = jwt.sign({ id: String(user._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
    const sessionId = new mongoose.Types.ObjectId();
    const files = Array.from({ length: 5000 }, (_, index) => ({
      fileId: `photo-${index}`, key: `uploads/report-sessions/${type}/${sessionId}/photo-${index}.jpg`,
      fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg",
      size: 12, verifiedSize: 12, uploadedAt: new Date(), originalOrder: index, role: "main",
    }));
    const dividerFileIds = files.filter((_, index) => index % 50 === 49).map((file) => file.fileId);
    const groups = Array.from({ length: 100 }, (_, groupIndex) => ({
      groupIndex, imageCount: 49, fileIds: files.slice(groupIndex * 50, groupIndex * 50 + 49).map((f) => f.fileId),
      coverFileId: `photo-${groupIndex * 50}`, overLimit: false,
    }));
    const session = await ReportUploadSession.create({
      _id: sessionId, type, user: user._id, jobId: `large-${type}`, status: "uploading",
      clientSubmissionId: `large-${type}`, manifestHash: "large-manifest", smartUpload: true,
      details: { contract_no: "LARGE-5000", sales_date: "2026-09-10", location: "Regina, SK", valuation_methods: ["FML"] },
      smartGrouping: { status: "confirmed", revision: 2, orderSource: "groups", groups, dividerFileIds },
      files, expectedFileCount: 5000, expectedImageCount: 5000, expectedVideoCount: 0, totalBytes: 60000,
      r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test",
    });
    mocks.deleteFromR2.mockImplementation(() => new Promise(() => {}));
    const queueMock = type === "asset" ? mocks.queueAssetPreviewJob : mocks.queueLotListingJob;
    queueMock.mockImplementation((input: any) => ensureReportJobOutbox(type,
      String(input.reportId || input.listingId), String(input.reportJobOutboxToken)));
    const endpoint = type === "asset" ? "asset" : "lot-listing";
    const url = `/api/${endpoint}/upload-session/${session._id}`;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).get(`${url}/status`).set(auth)).body.data).toMatchObject({ accepted: false, status: "ready" });
    const response = await request(app).post(`${url}/complete`).set(auth).timeout(20_000);
    expect(response.status).toBe(202);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
    const job: any = await ReportJob.findOne({ progressId: `large-${type}` }).lean();
    expect(job.payload.images.map((file: any) => file.r2Key)).toEqual(
      files.filter((_, index) => index % 50 !== 49).map((file) => file.key));
    expect(job.payload.images).toHaveLength(4900);
    expect((await ReportUploadSession.findById(session._id).lean())?.files).toHaveLength(5000);
    const receipt = await request(app).get(`${url}/status`).set(auth);
    expect(receipt.status).toBe(200);
    expect(receipt.headers["cache-control"]).toBe("no-store");
    expect(receipt.body.data).toMatchObject({ accepted: true, status: "queued", reportId: response.body.reportId, jobId: `large-${type}` });
    expect(JSON.stringify(receipt.body).length).toBeLessThan(1000);
    expect(await ReportJob.countDocuments()).toBe(1);
    const retry = await request(app).post(`${url}/complete`).set(auth);
    expect(retry.body.reportId).toBe(response.body.reportId);
    expect(await ReportJob.countDocuments()).toBe(1);
    const outsider = jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "admin" }, process.env.JWT_SECRET!);
    expect((await request(app).get(`${url}/status`).set({ Authorization: `Bearer ${outsider}` })).status).not.toBe(200);
  }, 30_000);

  it("retains the exact Lot handoff on ambiguity and ensures it on completion retry", async () => {
    const user = await User.create({
      email: "upload-outbox@example.test",
      username: "upload-outbox",
      password: "Password123!",
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const token = jwt.sign(
      { id: String(user._id), role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );
    const jobId = "lot-upload-session-job";
    const contractClaim = "upload outbox 500";
    const listing = await LotListing.create({
      user: user._id,
      client_submission_id: "lot-upload-session-submission",
      submission_contract_claim: contractClaim,
      contract_no: "UPLOAD-OUTBOX-500",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      mixed_lots: [],
      status: "processing",
      job_id: jobId,
      job_status: "queued",
      valuation_methods: ["FML"],
    });
    const session = await ReportUploadSession.create({
      type: "lotListing",
      status: "completed",
      user: user._id,
      reportId: String(listing._id),
      jobId,
      clientSubmissionId: "lot-upload-session-submission",
      manifestHash: "manifest-hash",
      manifestVersion: 2,
      smartUpload: false,
      details: {
        client_submission_id: "lot-upload-session-submission",
        contract_no: "UPLOAD-OUTBOX-500",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        valuation_methods: ["FML"],
        mixed_lots: [{ count: 1, extra_count: 0, mode: "single_lot" }],
      },
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      files: [
        {
          fileId: "photo-1",
          key: "uploads/report-sessions/lotListing/session/photo-1.jpg",
          fieldname: "images",
          originalname: "photo-1.jpg",
          mimetype: "image/jpeg",
          size: 12,
          verifiedSize: 12,
          uploadedAt: new Date(),
          lotIndex: 0,
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
      expectedFileCount: 1,
      expectedImageCount: 1,
      expectedVideoCount: 0,
      totalBytes: 12,
      uploadCompletedAt: new Date(),
    });

    mocks.queueLotListingJob.mockRejectedValueOnce(
      new Error("ambiguous queue acknowledgement")
    );
    const first = await request(app)
      .post(`/api/lot-listing/upload-session/${session._id}/complete`)
      .set({ Authorization: `Bearer ${token}` });

    expect(first.status).toBe(503);
    expect(first.body.code).toBe("UPLOAD_SESSION_QUEUE_HANDOFF_PENDING");
    const retainedReport: any = await LotListing.findById(listing._id)
      .select("+report_job_outbox +submission_contract_claim")
      .lean();
    expect(retainedReport).toMatchObject({
      job_id: jobId,
      job_status: "queued",
      submission_contract_claim: contractClaim,
      report_job_outbox: {
        type: "lot-listing-preview",
        reportId: String(listing._id),
        progressId: jobId,
      },
    });
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe(
      "completed"
    );
    expect(await ReportJob.countDocuments()).toBe(0);

    const savedReceipt = await request(app)
      .get(`/api/lot-listing/upload-session/${session._id}/status`)
      .set({ Authorization: `Bearer ${token}` });
    expect(savedReceipt.body.data).toMatchObject({ accepted: true, status: "queued", reportId: String(listing._id), jobId });
    // A read must not create the job, dispatch research, or alter the session.
    expect(await ReportJob.countDocuments()).toBe(0);

    mocks.queueLotListingJob.mockImplementationOnce((input: any) =>
      ensureReportJobOutbox(
        "lotListing",
        String(input.listingId),
        String(input.reportJobOutboxToken)
      )
    );
    const retry = await request(app)
      .post(`/api/lot-listing/upload-session/${session._id}/complete`)
      .set({ Authorization: `Bearer ${token}` });

    expect(retry.status).toBe(202);
    expect(
      await ReportJob.countDocuments({
        type: "lot-listing-preview",
        reportId: String(listing._id),
        progressId: jobId,
      })
    ).toBe(1);
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe(
      "queued"
    );
    const recoveredReport: any = await LotListing.findById(listing._id)
      .select("+report_job_outbox +submission_contract_claim")
      .lean();
    expect(recoveredReport.report_job_outbox).toBeUndefined();
    expect(recoveredReport.submission_contract_claim).toBe(contractClaim);
  });

  it("heals a queued upload session after its exact durable job already completed", async () => {
    const user = await User.create({
      email: "upload-completed-recovery@example.test",
      username: "upload-completed-recovery",
      password: "Password123!",
      authProvider: "email",
      isVerified: true,
      role: "admin",
    });
    const token = jwt.sign(
      { id: String(user._id), role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );
    const jobId = "lot-upload-completed-recovery";
    const listing = await LotListing.create({
      user: user._id,
      client_submission_id: "lot-upload-completed-recovery",
      contract_no: "UPLOAD-COMPLETED-RECOVERY",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      status: "preview",
      job_id: jobId,
      job_status: "done",
      valuation_methods: ["FML"],
    });
    const session = await ReportUploadSession.create({
      type: "lotListing",
      status: "queued",
      user: user._id,
      reportId: String(listing._id),
      jobId,
      clientSubmissionId: "lot-upload-completed-recovery",
      activeContractClaim: "upload-completed-recovery",
      details: {},
      files: [],
      expectedFileCount: 0,
      expectedImageCount: 0,
      expectedVideoCount: 0,
      totalBytes: 0,
      queuedAt: new Date(),
    });
    await ReportJob.create({
      type: "lot-listing-preview",
      status: "completed",
      reportId: String(listing._id),
      progressId: jobId,
      payload: { listingId: String(listing._id), progressId: jobId },
      completedAt: new Date(),
    });

    const response = await request(app)
      .post(`/api/lot-listing/upload-session/${session._id}/complete`)
      .set({ Authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: "Upload session already processed",
      reportId: String(listing._id),
      jobId,
      status: "completed",
      phase: "done",
    });
    const healed: any = await ReportUploadSession.findById(session._id)
      .select("+activeContractClaim")
      .lean();
    expect(healed.status).toBe("processed");
    expect(healed.activeContractClaim).toBeUndefined();
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });
});
