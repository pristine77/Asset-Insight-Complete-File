import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueAssetPreviewJob: vi.fn(),
  queueLotListingJob: vi.fn(),
  headR2Object: vi.fn(),
  createR2PresignedPutUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  deleteFromR2Strict: vi.fn(),
}));
vi.mock("../src/jobs/assetReportJob.js", async (original) => ({
  ...(await original<typeof import("../src/jobs/assetReportJob.js")>()),
  queueAssetPreviewJob: mocks.queueAssetPreviewJob,
}));
vi.mock("../src/jobs/lotListingJob.js", async (original) => ({
  ...(await original<typeof import("../src/jobs/lotListingJob.js")>()),
  queueLotListingJob: mocks.queueLotListingJob,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...(await original<typeof import("../src/utils/r2Storage/r2Upload.js")>()),
  headR2Object: mocks.headR2Object,
  createR2PresignedPutUrl: mocks.createR2PresignedPutUrl,
  deleteFromR2: mocks.deleteFromR2,
  deleteFromR2Strict: mocks.deleteFromR2Strict,
}));

type ReportType = "asset" | "lotListing";
let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportUploadSession: typeof import("../src/models/reportUploadSession.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let ensureReportJobOutbox: typeof import("../src/utils/reportJobMongoQueue.js")["ensureReportJobOutbox"];
let cleanupCompletedSmartUploadDividers: typeof import("../src/utils/smartUploadSessionMaintenance.js")["cleanupCompletedSmartUploadDividers"];
const previousEnvironment = new Map<string, string | undefined>();
const environment = (key: string, value: string) => {
  if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key]);
  process.env[key] = value;
};

beforeAll(async () => {
  environment("REPORT_QUEUE_BACKEND", "mongo");
  environment("DEVICE_APPROVAL_ENFORCEMENT", "off");
  environment("RESEND_API_KEY", "re_isolated_lot_number_test_only");
  environment("OPENAI_API_KEY", "sk-isolated-lot-number-test-only");
  environment("R2_BUCKET", "asset-insight-test");
  environment("R2_BUCKET_NAME", "asset-insight-test");
  environment("R2_PUBLIC_URL", "https://assetinsight.test");
  environment("R2_CUSTOM_DOMAIN", "https://assetinsight.test");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportUploadSession } = await import("../src/models/reportUploadSession.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ ensureReportJobOutbox } = await import("../src/utils/reportJobMongoQueue.js"));
  ({ cleanupCompletedSmartUploadDividers } = await import("../src/utils/smartUploadSessionMaintenance.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.headR2Object.mockResolvedValue({ size: 12 });
  mocks.createR2PresignedPutUrl.mockResolvedValue("https://assetinsight.test/isolated-put-target");
  mocks.queueAssetPreviewJob.mockImplementation((input: any) => ensureReportJobOutbox(
    "asset", String(input.reportId), String(input.reportJobOutboxToken),
  ));
  mocks.queueLotListingJob.mockImplementation((input: any) => ensureReportJobOutbox(
    "lotListing", String(input.listingId), String(input.reportJobOutboxToken),
  ));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const endpoint = (type: ReportType) => `/api/${type === "asset" ? "asset" : "lot-listing"}/upload-session`;
const details = (id: string) => ({
  client_submission_id: id, smart_upload: true, smart_upload_grouping_method: "lot_number",
  contract_no: "QA-LOT-NUMBER-2500", client_name: "Isolated number upload", sales_date: "2026-09-27",
  location: "Regina, SK", currency: "CAD", language: "en", valuation_methods: ["FML"],
});
const manifest = (count: number) => Array.from({ length: count }, (_, index) => ({
  fileId: `photo-${index}`, fieldname: "images", originalname: `photo-${index}.jpg`,
  mimetype: "image/jpeg", size: 12, originalOrder: index, role: "main",
}));
async function owner(name = "owner") {
  const user = await User.create({ email: `${name}@example.test`, username: name,
    password: "Password123!", authProvider: "email", isVerified: true, role: "admin" });
  const token = jwt.sign({ id: String(user._id), role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
  return { user, auth: { Authorization: `Bearer ${token}` } };
}
async function fixture(type: ReportType, count = 6, groupSize = 3) {
  const { user, auth } = await owner();
  const sessionId = new mongoose.Types.ObjectId();
  const files = manifest(count).map((file) => ({ ...file,
    key: `uploads/report-sessions/${type}/${sessionId}/${file.fileId}.jpg`,
    uploadedAt: new Date(), verifiedSize: 12,
  }));
  const groups = Array.from({ length: Math.ceil(count / groupSize) }, (_, index) => {
    const groupFiles = files.slice(index * groupSize, (index + 1) * groupSize);
    return { groupIndex: index, fileIds: groupFiles.map((file) => file.fileId),
      imageCount: groupFiles.length, lotNumber: String(2500 + index),
      coverFileId: groupFiles[0].fileId, overLimit: false };
  });
  const session = await ReportUploadSession.create({
    _id: sessionId, type, user: user._id, jobId: `number-job-${sessionId}`, status: "uploading",
    clientSubmissionId: `number-submission-${sessionId}`, smartUpload: true,
    details: details(`number-submission-${sessionId}`),
    smartGrouping: { method: "lot_number", status: "review_ready", revision: 2,
      orderSource: "manifest", orderReviewRequired: false, groups,
      dividerFileIds: [], unresolvedDividerIds: [], unresolvedLotNumberFileIds: [], metrics: [] },
    files, expectedFileCount: count, expectedImageCount: count, expectedVideoCount: 0, totalBytes: count * 12,
    r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test",
  });
  return { session, files, groups, auth, user, url: `${endpoint(type)}/${sessionId}` };
}

describe.sequential("Lot Number Upload API acceptance", () => {
  it.each(["asset", "lotListing"] as const)("keeps all 5,000 %s photos, reviewed numbers and group order through durable acceptance", async (type) => {
    const { session, files, groups, auth, url } = await fixture(type, 5000, 200);
    // Review may reorder complete lots and change a custom display number. The
    // first numbered card remains a real report image, not an excluded divider.
    const reviewed = [...groups.slice(1), { ...groups[0], lotNumber: "2500A" }];
    const read = await request(app).get(`${url}/smart-grouping`).set(auth);
    expect(read.status).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.body.data).toMatchObject({ groupingMethod: "lot_number", revision: 2, dividerFileIds: [] });
    expect(read.body.data.groups.map((group: any) => group.lotNumber)).toEqual(groups.map((group) => group.lotNumber));
    const confirm = await request(app).patch(`${url}/smart-grouping`).set(auth).send({
      revision: 2, groupingMethod: "lot_number", groups: reviewed, confirm: true,
      acknowledgeLotNumberReview: true, orderReviewRequired: false,
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.groupingStatus).toBe("confirmed");
    expect(confirm.body.data.groups.map((group: any) => group.lotNumber)).toEqual(reviewed.map((group) => group.lotNumber));
    expect(confirm.body.data.files.map((file: any) => file.fileId)).toEqual(reviewed.flatMap((group) => group.fileIds));

    const response = await request(app).post(`${url}/complete`).set(auth).timeout(20_000);
    expect(response.status).toBe(202);
    const job: any = await ReportJob.findOne({ progressId: session.jobId }).lean();
    expect(job).toBeTruthy();
    const keyById = new Map(files.map((file) => [file.fileId, file.key]));
    expect(job.payload.images.map((file: any) => file.r2Key)).toEqual(
      reviewed.flatMap((group) => group.fileIds.map((id) => keyById.get(id))),
    );
    expect(job.payload.images).toHaveLength(5000);
    expect(new Set(job.payload.images.map((file: any) => file.r2Key)).size).toBe(5000);
    expect(job.payload.details.smart_upload_grouping_method).toBe("lot_number");
    expect(job.payload.details.mixed_lots).toEqual(reviewed.map((group) => ({
      count: 200, extra_count: 0, cover_index: 0, mode: "single_lot",
      reviewed_lot_number: group.lotNumber, lot_number: group.lotNumber,
    })));
    const accepted = await ReportUploadSession.findById(session._id).lean();
    expect(accepted?.files).toHaveLength(5000);
    expect(accepted?.smartGrouping?.dividerFileIds).toEqual([]);
    expect(await cleanupCompletedSmartUploadDividers()).toEqual({ sessions: 0, objects: 0, failedObjects: 0 });
    expect(mocks.headR2Object).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2Strict).not.toHaveBeenCalled();
    const retry = await request(app).post(`${url}/complete`).set(auth);
    expect(retry.body.reportId).toBe(response.body.reportId);
    expect(await ReportJob.countDocuments()).toBe(1);
    const receipt = await request(app).get(`${url}/status`).set(auth);
    expect(receipt.body.data).toMatchObject({ accepted: true, reportId: response.body.reportId });
    expect(JSON.stringify(receipt.body).length).toBeLessThan(1000);
    expect(await (type === "asset" ? AssetReport.countDocuments() : LotListing.countDocuments())).toBe(1);
  }, 60_000);

  it.each(["asset", "lotListing"] as const)("bounds %s target pages and rejects switching an existing submission's method", async (type) => {
    const { auth } = await owner();
    const body = { details: details("same-number-submission"), groupingMethod: "lot_number", files: manifest(5000) };
    const created = await request(app).post(endpoint(type)).set(auth).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ groupingMethod: "lot_number", nextCursor: "100" });
    expect(created.body.data.files).toHaveLength(100);
    expect(mocks.createR2PresignedPutUrl).toHaveBeenCalledTimes(100);
    const saved = await ReportUploadSession.findById(created.body.data.sessionId).lean();
    expect(saved?.files).toHaveLength(5000);
    const changed = await request(app).post(endpoint(type)).set(auth).send({ ...body, groupingMethod: "black_divider" });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("UPLOAD_SESSION_MODE_CHANGED");
    expect(await ReportUploadSession.countDocuments()).toBe(1);
    expect(mocks.createR2PresignedPutUrl).toHaveBeenCalledTimes(100);
    expect(await ReportJob.countDocuments()).toBe(0);
  }, 30_000);

  it.each(["asset", "lotListing"] as const)("requires review before %s submission and does not clear an uncertain card implicitly", async (type) => {
    const { session, groups, auth, url } = await fixture(type);
    await ReportUploadSession.updateOne({ _id: session._id }, { $set: { "smartGrouping.unresolvedLotNumberFileIds": ["photo-3"] } });
    const incomplete = await request(app).post(`${url}/complete`).set(auth);
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe("SMART_UPLOAD_GROUPING_REQUIRED");
    const rejected = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 2, groups, confirm: true });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("LOT_NUMBER_UPLOAD_REVIEW_REQUIRED");
    const saved = await ReportUploadSession.findById(session._id).lean();
    expect(saved?.smartGrouping?.unresolvedLotNumberFileIds).toEqual(["photo-3"]);
    expect(saved?.smartGrouping?.revision).toBe(2);
    expect(await ReportJob.countDocuments()).toBe(0);
    const confirmed = await request(app).patch(`${url}/smart-grouping`).set(auth).send({
      revision: 2, groups, confirm: true, acknowledgeLotNumberReview: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({ groupingStatus: "confirmed", unresolvedLotNumberFileIds: [] });
    expect(await ReportJob.countDocuments()).toBe(0); // Review is never a submission.
  });

  it.each([
    ["missing photo", [{ fileIds: ["photo-0", "photo-1"], lotNumber: "2500" }, { fileIds: ["photo-3", "photo-4", "photo-5"], lotNumber: "2501" }]],
    ["duplicate photo", [{ fileIds: ["photo-0", "photo-1", "photo-2"], lotNumber: "2500" }, { fileIds: ["photo-2", "photo-3", "photo-4", "photo-5"], lotNumber: "2501" }]],
    ["foreign photo", [{ fileIds: ["photo-0", "photo-1", "photo-2"], lotNumber: "2500" }, { fileIds: ["photo-3", "photo-4", "foreign-photo"], lotNumber: "2501" }]],
    ["missing number", [{ fileIds: ["photo-0", "photo-1", "photo-2"], lotNumber: "" }, { fileIds: ["photo-3", "photo-4", "photo-5"], lotNumber: "2501" }]],
  ])("rejects %s without altering the saved grouping or creating a job", async (_label, groups) => {
    const { session, auth, url } = await fixture("asset");
    const before = await ReportUploadSession.findById(session._id).lean();
    const response = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 2, groups, confirm: true, acknowledgeLotNumberReview: true });
    expect(response.status).toBe(400);
    expect(await ReportUploadSession.findById(session._id).lean()).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(["asset", "lotListing"] as const)("still requires explicit %s grouping review when every detected number is readable", async (type) => {
    const { session, groups, auth, url } = await fixture(type);
    const response = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 2, groups, confirm: true });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LOT_NUMBER_UPLOAD_REVIEW_REQUIRED");
    expect((await ReportUploadSession.findById(session._id).lean())?.smartGrouping?.status).toBe("review_ready");
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("cannot exclude the lot-number photograph or change the selected method during review", async () => {
    const { session, groups, auth, url } = await fixture("lotListing");
    const before = await ReportUploadSession.findById(session._id).lean();
    for (const extra of [{ dividerFileIds: ["photo-0"] }, { groupingMethod: "black_divider" }]) {
      const response = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 2, groups, confirm: true, acknowledgeLotNumberReview: true, ...extra });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_LOT_NUMBER_GROUPING");
    }
    expect(await ReportUploadSession.findById(session._id).lean()).toEqual(before);
  });

  it.each(["asset", "lotListing"] as const)("keeps the 200-photo %s per-lot limit despite the 5,000-photo report limit", async (type) => {
    const { groups, auth, url } = await fixture(type, 201, 201);
    // An oversized detected group can be saved while the user splits it, but
    // cannot be confirmed or silently clipped at report creation.
    const rejected = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 2, groups, confirm: true, acknowledgeLotNumberReview: true });
    expect(rejected.status).toBe(400);
    expect(await ReportJob.countDocuments()).toBe(0);
    const allIds = groups[0].fileIds;
    const split = await request(app).patch(`${url}/smart-grouping`).set(auth).send({
      revision: 2, confirm: true, acknowledgeLotNumberReview: true,
      groups: [{ fileIds: allIds.slice(0, 200), lotNumber: "2500" }, { fileIds: allIds.slice(200), lotNumber: "2501" }],
    });
    expect(split.status).toBe(200);
    expect(split.body.data.groups.map((group: any) => group.fileIds.length)).toEqual([200, 1]);
    expect(split.body.data.files).toHaveLength(201);
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(["missing photo", "missing number", "unreviewed card", "excluded sign"] as const)("revalidates confirmed groups at completion: %s", async (failure) => {
    const { session, groups, auth, url } = await fixture("asset");
    const persisted: Record<string, unknown> = { "smartGrouping.status": "confirmed" };
    if (failure === "missing photo") persisted["smartGrouping.groups"] = [groups[0]];
    if (failure === "missing number") persisted["smartGrouping.groups"] = [{ ...groups[0], lotNumber: "" }, groups[1]];
    if (failure === "unreviewed card") persisted["smartGrouping.unresolvedLotNumberFileIds"] = ["photo-3"];
    if (failure === "excluded sign") persisted["smartGrouping.dividerFileIds"] = ["photo-0"];
    await ReportUploadSession.updateOne({ _id: session._id }, { $set: persisted });
    const response = await request(app).post(`${url}/complete`).set(auth);
    expect([400, 409]).toContain(response.status);
    expect((await ReportUploadSession.findById(session._id).lean())?.files).toHaveLength(6);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(await AssetReport.countDocuments()).toBe(0);
    expect(mocks.deleteFromR2).not.toHaveBeenCalled();
    expect(mocks.deleteFromR2Strict).not.toHaveBeenCalled();
  });

  it("enforces owner and revision fences and keeps reads side-effect free", async () => {
    const { session, groups, auth, url } = await fixture("lotListing");
    const { auth: foreignAuth } = await owner("other-owner");
    const before = await ReportUploadSession.findById(session._id).lean();
    const read = await request(app).get(`${url}/smart-grouping`).set(auth);
    expect(read.status).toBe(200);
    expect((await request(app).get(`${url}/smart-grouping`).set(foreignAuth)).status).toBe(404);
    expect((await request(app).patch(`${url}/smart-grouping`).set(foreignAuth).send({ revision: 2, groups, confirm: true })).status).toBe(404);
    expect((await request(app).post(`${url}/complete`).set(foreignAuth)).status).toBe(404);
    const stale = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ revision: 1, groups, confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("SMART_UPLOAD_GROUPING_STALE");
    const noRevision = await request(app).patch(`${url}/smart-grouping`).set(auth).send({ groups, confirm: true });
    expect(noRevision.status).toBe(400);
    expect(noRevision.body.code).toBe("SMART_UPLOAD_GROUPING_REVISION_REQUIRED");
    expect(await ReportUploadSession.findById(session._id).lean()).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.queueAssetPreviewJob).not.toHaveBeenCalled();
    expect(mocks.queueLotListingJob).not.toHaveBeenCalled();
  });
});
