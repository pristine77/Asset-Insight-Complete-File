import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import User from "../src/models/user.model.js";
import { reconcileOne } from "../src/scripts/reconcileReportProcessing.js";

const mocks = vi.hoisted(() => ({ headR2Object: vi.fn() }));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>()),
  headR2Object: mocks.headR2Object,
}));

let mongo: MongoMemoryServer;
const previousQueueBackend = process.env.REPORT_QUEUE_BACKEND;

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  mocks.headR2Object.mockReset();
  mocks.headR2Object.mockResolvedValue({ size: 12 });
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([
    AssetReport.syncIndexes(),
    LotListing.syncIndexes(),
    ReportJob.syncIndexes(),
    ReportUploadSession.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (previousQueueBackend === undefined) {
    delete process.env.REPORT_QUEUE_BACKEND;
  } else {
    process.env.REPORT_QUEUE_BACKEND = previousQueueBackend;
  }
});

async function createOwner() {
  const suffix = new mongoose.Types.ObjectId();
  return User.create({
    email: `reconciliation-${suffix}@example.test`,
    username: `reconciliation-${suffix}`,
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "admin",
  });
}

describe.sequential("deployment report-processing reconciliation", () => {
  it.each([
    { label: "missing preference", value: undefined, expected: false },
    { label: "explicit opt-in", value: true, expected: true },
    { label: "explicit opt-out", value: false, expected: false },
    { label: "string opt-in", value: "true", expected: true },
    { label: "string opt-out", value: "false", expected: false },
  ])("recovers a Lot upload with $label without changing its watermark choice", async ({ value, expected }) => {
    const owner = await createOwner();
    const jobId = "lot-recovered-upload";
    const details = {
      contract_no: "LOT-RECOVER-WATERMARK",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      ...(value === undefined ? {} : { watermark_images: value }),
    };
    const report = await LotListing.create({
      user: owner._id,
      contract_no: details.contract_no,
      sales_date: new Date(details.sales_date),
      location: details.location,
      imageUrls: [],
      videoUrls: [],
      lots: [],
      status: "processing",
      job_id: jobId,
      job_status: "queued",
      files_generating: true,
    });
    const photoKey = "uploads/report-sessions/lotListing/test/photo-1.jpg";
    const session = await ReportUploadSession.create({
      type: "lotListing",
      status: "completed",
      user: owner._id,
      reportId: String(report._id),
      jobId,
      details,
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      files: [{
        fileId: "photo-1",
        key: photoKey,
        fieldname: "images",
        originalname: "photo-1.jpg",
        mimetype: "image/jpeg",
        verifiedSize: 12,
        originalOrder: 0,
        role: "main",
      }],
      expectedFileCount: 1,
      expectedImageCount: 1,
      totalBytes: 12,
    });

    expect(await reconcileOne("lotListing", report)).toBe("requeued");
    expect(mocks.headR2Object).toHaveBeenCalledExactlyOnceWith("asset-insight-test", photoKey);
    const jobs = await ReportJob.find({
      reportId: String(report._id),
      type: "lot-listing-preview",
    }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "queued",
      progressId: jobId,
      payload: {
        details: {
          contract_no: details.contract_no,
          watermark_images: expected,
          upload_session_id: String(session._id),
        },
        images: [{
          r2Key: photoKey,
          r2Bucket: "asset-insight-test",
          originalname: "photo-1.jpg",
        }],
      },
    });
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe("queued");
    // A deployment sweep must not overwrite a newer row with its pre-recovery
    // snapshot; a fresh read still recognizes the same active durable job.
    expect(await reconcileOne("lotListing", report)).toBe("conflict");
    expect(await reconcileOne("lotListing", await LotListing.findById(report._id))).toBe("active");
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(1);
  });

  it("leaves a completed, unsubmitted Asset preview without download files alone", async () => {
    const owner = await createOwner();
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      preview_data: { lots: [] },
      status: "preview",
      job_id: "asset-preview-complete",
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
    });

    expect(await reconcileOne("asset", report)).toBe("preview-ready");
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(0);
    expect(await AssetReport.findById(report._id).lean()).toMatchObject({
      status: "preview",
      job_id: "asset-preview-complete",
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
    });
  });

  it("leaves a done submitted Asset report unchanged even when its files are missing", async () => {
    const owner = await createOwner();
    const previewData = {
      contract_no: "ASSET-RECONCILE-100",
      grouping_mode: "single_lot",
      lots: [],
    };
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      contract_no: previewData.contract_no,
      imageUrls: [],
      lots: [],
      preview_data: previewData,
      preview_submitted_at: new Date(),
      status: "approved",
      job_id: "asset-files-completed-without-files",
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
    });

    const before = await AssetReport.collection.findOne({ _id: report._id });
    expect(await reconcileOne("asset", report)).toBe("done");
    expect(await AssetReport.collection.findOne({ _id: report._id })).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
  });

  it("leaves a done submitted Lot and its repair warning for explicit user action", async () => {
    const owner = await createOwner();
    const previewData = {
      contract_no: "LOT-RECONCILE-100",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      currency: "CAD",
      valuation_methods: ["FML"],
      lots: [],
    };
    const report = await LotListing.create({
      user: owner._id,
      contract_no: previewData.contract_no,
      sales_date: new Date(previewData.sales_date),
      location: previewData.location,
      imageUrls: [],
      videoUrls: [],
      lots: [],
      preview_data: previewData,
      preview_submitted_at: new Date(),
      status: "approved",
      job_id: "lot-files-completed-without-files",
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
      valuation_methods: ["FML"],
      artifact_repair_required: true,
    });

    const before = await LotListing.collection.findOne({ _id: report._id });
    expect(await reconcileOne("lotListing", report)).toBe("done");
    expect(await LotListing.collection.findOne({ _id: report._id })).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
  });

  it.each((["asset", "lotListing"] as const).flatMap((kind) =>
    ["pending_approval", "approved"].map((target) => ({ kind, target })),
  ))("$kind never treats a done preview's stale $target target as an owner submission", async ({ kind, target }) => {
    const owner = await createOwner();
    const model: any = kind === "asset" ? AssetReport : LotListing;
    const savedLot = { lot_id: "saved-unsubmitted-lot", lot_number: "157", title: "Appraiser saved vehicle", description: "Retained narrative", image_indexes: [0] };
    const report = await model.create({
      user: owner._id,
      grouping_mode: "single_lot",
      contract_no: "UNSUBMITTED-RECONCILE",
      sales_date: new Date("2026-09-01"),
      location: "Regina, SK",
      imageUrls: ["https://assetinsight.test/retained.jpg"],
      lots: [savedLot],
      preview_data: { contract_no: "UNSUBMITTED-RECONCILE", lots: [savedLot] },
      status: "preview",
      job_id: "saved-preview-complete",
      job_status: "done",
      generation_target_status: target,
      files_generating: false,
      files_regenerating: false,
    });
    const before = await model.collection.findOne({ _id: report._id });
    expect(before.preview_submitted_at).toBeUndefined();
    expect(before.approval_requested_at).toBeUndefined();
    expect(await reconcileOne(kind, report)).toBe("preview-ready");
    expect(await reconcileOne(kind, await model.findById(report._id))).toBe("preview-ready");
    expect(await model.collection.findOne({ _id: report._id })).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.headR2Object).not.toHaveBeenCalled();
  });
});
