/** Unversioned source retries must not bypass the protected capability flow. */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn() }));
const mocks = vi.hoisted(() => ({ head: vi.fn(), event: vi.fn() }));
vi.mock("../src/service/auctioneerEventResolutionService.js", () => ({ AUCTIONEER_EVENT_REQUIRED_MESSAGE: "Event required", recoverInitialAuctioneerEventIdentity: mocks.event }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ headR2Object: mocks.head, resolvePersistedR2StorageTarget: ({ r2Bucket }: any) => ({ bucketName: r2Bucket }) }));
import Asset from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import { retryInitialAuctioneerPreview, verifyInitialAuctioneerRetrySources } from "../src/service/auctioneerInitialPreviewRetryService.js";
import { createMongoReportJob } from "../src/utils/reportJobMongoQueue.js";
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo=await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { vi.clearAllMocks(); await mongoose.connection.db!.dropDatabase(); });
describe("superseded unversioned preview retry", () => {
  it.each(["asset", "lotListing"] as const)("%s cannot queue ordinary failures through the Auctioneer retry", async kind => {
    const userId = new mongoose.Types.ObjectId(); const reportId = new mongoose.Types.ObjectId();
    const Model = kind === "asset" ? Asset : LotListing;
    await Model.collection.insertOne({ _id: reportId, user: userId, status: "error", job_status: "error", job_error: "Duplicate lot number 1", job_id: "failed" });
    expect(await retryInitialAuctioneerPreview({ reportType: kind, reportId, userId, hasIncomingEdits: false })).toBeNull();
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(mocks.head).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("refuses a legacy failedPreviewRetry before HEAD or analysis without accepted-session proof", async () => {
    await expect(verifyInitialAuctioneerRetrySources({ payload: { failedPreviewRetry: { version: 1 } } } as any,
      { assertOwned: vi.fn() } as any)).rejects.toMatchObject({ code: "AUCTIONEER_INITIAL_RETRY_SOURCE_UNAVAILABLE" });
    expect(mocks.head).not.toHaveBeenCalled();
  });
  it("never revives a terminal legacy source-retry outbox", async () => {
    const input = { type: "asset-preview" as const, reportId: String(new mongoose.Types.ObjectId()), progressId: "source-retry-old",
      idempotencyKey: "old-source-retry", targetStatus: "preview", maxAttempts: 1,
      payload: { failedPreviewRetry: { version: 1, originalJobId: String(new mongoose.Types.ObjectId()) } } };
    const created = await createMongoReportJob(input);
    await ReportJob.updateOne({ _id: created!._id }, { $set: { status: "failed", attempts: 1 }, $unset: { dedupeKey: 1 } });
    expect(await createMongoReportJob(input)).toMatchObject({ status: "failed", attempts: 1 });
  });
});
