import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import User from "../src/models/user.model.js";
import { reconcileOne, queuePersistedArtifactRepair } from "../src/scripts/reconcileReportProcessing.js";
import { ORPHANED_REPORT_MESSAGE, recoverOrphanedReport } from "../src/service/reportRestartRecoveryService.js";

const storage = vi.hoisted(() => ({ head: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>()),
  headR2Object: storage.head,
}));

type Kind = "asset" | "lotListing";
const kinds = ["asset", "lotListing"] as const;
const model = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const ownerId = new mongoose.Types.ObjectId();
let mongo: MongoMemoryServer;
const previousQueueBackend = process.env.REPORT_QUEUE_BACKEND;

async function fixture(kind: Kind, overrides: Record<string, unknown> = {}) {
  const lots = [{ lot_id: "saved-lot-157", lot_number: "157", title: "Retained truck", description: "Saved appraiser correction", estimated_value: "CAD 100",
    image_indexes: [0], condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } }];
  return model(kind).create({ user: ownerId, contract_no: "RECONCILE-RACE", grouping_mode: "single_lot",
    sales_date: new Date("2026-09-01"), location: "Regina, SK", currency: "CAD", lots,
    imageUrls: ["https://assetinsight.test/saved.jpg"], preview_data: { lots, contract_no: "RECONCILE-RACE", currency: "CAD" },
    status: "processing", job_status: "queued", job_id: "original-job", files_generating: true, files_regenerating: false,
    ...overrides });
}

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  storage.head.mockReset().mockResolvedValue({ size: 12 });
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), LotListing.syncIndexes(), ReportJob.syncIndexes(), ReportUploadSession.syncIndexes()]);
  await User.collection.insertOne({ _id: ownerId, email: "reconcile-race@example.test", username: "reconcile-race", role: "user", isVerified: true } as any);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (previousQueueBackend === undefined) delete process.env.REPORT_QUEUE_BACKEND;
  else process.env.REPORT_QUEUE_BACKEND = previousQueueBackend;
});

describe.sequential("deployment reconciliation racing restart and owner mutations", () => {
  it.each(kinds)("%s does not overwrite a startup recovery using its stale orphan snapshot", async (kind) => {
    const old = await fixture(kind, { status: "error", job_status: "error", files_generating: false,
      job_error: ORPHANED_REPORT_MESSAGE, preview_submitted_at: new Date() });
    expect(await recoverOrphanedReport(kind, String(old._id))).toBe("requeued");
    const accepted = await model(kind).findById(old._id).lean();
    expect(await reconcileOne(kind, old)).toBe("skipped");
    const after = await model(kind).findById(old._id).lean();
    expect(after).toMatchObject({ job_id: accepted.job_id, job_status: "queued", files_generating: true });
    expect(after.preview_data).toEqual(accepted.preview_data);
    expect(await ReportJob.countDocuments({ reportId: String(old._id) })).toBe(1);
  });

  it.each(kinds)("%s makes its no-source failure conditional on the observed generation", async (kind) => {
    const old = await fixture(kind);
    await model(kind).updateOne({ _id: old._id }, { $set: { job_id: "owner-new-job", job_status: "queued",
      "preview_data.lots.0.description": "New owner data must win" } });
    expect(await reconcileOne(kind, old)).toBe("conflict");
    const after = await model(kind).findById(old._id).lean();
    expect(after.job_id).toBe("owner-new-job");
    expect(after.job_status).toBe("queued");
    expect(after.preview_data.lots[0].description).toBe("New owner data must win");
    expect(after.job_error).toBeUndefined();
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it.each(kinds)("%s does not write an old failure over a newer preview save", async (kind) => {
    const old = await fixture(kind, { status: "error", job_status: "error", files_generating: false, job_error: "Old failed attempt" });
    await model(kind).updateOne({ _id: old._id }, { $set: { job_error: "New diagnostic", "preview_data.lots.0.title": "New title" } });
    expect(await reconcileOne(kind, old)).toBe("conflict");
    const after = await model(kind).findById(old._id).lean();
    expect(after.job_error).toBe("New diagnostic");
    expect(after.preview_data.lots[0].title).toBe("New title");
  });

  it.each(kinds)("%s does not launch upload-source analysis when the parent changes during source checks", async (kind) => {
    const old = await fixture(kind);
    const session = await ReportUploadSession.create({ type: kind, user: ownerId, reportId: String(old._id), jobId: "original-job",
      status: "completed", details: { contract_no: "RECONCILE-RACE", sales_date: "2026-09-01", location: "Regina, SK" },
      r2Bucket: "asset-insight-test", r2PublicBaseUrl: "https://assetinsight.test",
      files: [{ fileId: "file-1", key: "uploads/report-sessions/race.jpg", fieldname: "images", originalname: "race.jpg", mimetype: "image/jpeg", verifiedSize: 12 }],
      expectedFileCount: 1, expectedImageCount: 1, totalBytes: 12 });
    storage.head.mockImplementationOnce(async () => {
      await model(kind).updateOne({ _id: old._id }, { $set: { job_id: "new-owner-generation", job_status: "queued", "preview_data.lots.0.title": "New owner snapshot" } });
      return { size: 12 };
    });
    expect(await reconcileOne(kind, old)).toBe("conflict");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await ReportUploadSession.findById(session._id).lean())?.status).toBe("completed");
    expect((await model(kind).findById(old._id).lean()).job_id).toBe("new-owner-generation");
  });

  it.each(kinds)("%s refuses artifact repair after an appraiser changes the observed completed preview", async (kind) => {
    const old = await fixture(kind, { status: "approved", job_status: "done", files_generating: false, files_regenerating: false,
      preview_submitted_at: new Date() });
    await model(kind).updateOne({ _id: old._id }, { $set: { "preview_data.lots.0.description": "The latest saved report" } });
    expect(await queuePersistedArtifactRepair(kind, old, "approved")).toBe(false);
    expect(await ReportJob.countDocuments()).toBe(0);
    const after = await model(kind).findById(old._id).lean();
    expect(after.job_status).toBe("done");
    expect(after.preview_data.lots[0].description).toBe("The latest saved report");
  });

  it.each(kinds)("%s leaves live publication leases untouched", async (kind) => {
    const old = await fixture(kind, kind === "asset"
      ? { proposal_valuation_artifact_publish_token: "live-pv", proposal_valuation_artifact_publish_expires_at: new Date(Date.now() + 60_000) }
      : { artifact_publish_token: "live-lot", artifact_publish_expires_at: new Date(Date.now() + 60_000) });
    expect(await reconcileOne(kind, old)).toBe("conflict");
    expect((await model(kind).findById(old._id).lean()).job_status).toBe("queued");
  });
});
