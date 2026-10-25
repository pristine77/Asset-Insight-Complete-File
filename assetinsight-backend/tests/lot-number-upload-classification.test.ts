import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), detect: vi.fn(), read: vi.fn(), sync: vi.fn(), progress: vi.fn() }));
vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) }, config: () => ({ parsed: {} }) }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
vi.mock("../src/service/lotNumberUploadDetector.js", () => ({ prepareLotNumberUploadPhoto: mocks.prepare, detectLotNumberUploadBatch: mocks.detect }));
vi.mock("../src/service/reportDraftService.js", () => ({ syncSmartUploadReportDraft: mocks.sync }));
vi.mock("../src/utils/reportJobMongoQueue.js", () => ({ updateMongoReportJobProgress: mocks.progress }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ readR2ObjectBuffer: mocks.read,
  resolvePersistedR2StorageTarget: () => ({ bucketName: "isolated-test" }) }));
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import { classifySmartUploadSession } from "../src/service/smartUploadGroupingService.js";
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.clearAllMocks(); await mongoose.connection.db!.dropDatabase();
  mocks.read.mockImplementation(async (_bucket: string, key: string) => Buffer.from(key));
  mocks.prepare.mockImplementation(async (fileId: string) => ({ fileId, imageUrl: `data:image/jpeg;base64,${fileId}` }));
  mocks.detect.mockImplementation(async (photos: Array<{ fileId: string }>) => photos.map(({ fileId }) => ({
    fileId, kind: Number(fileId.slice(2)) % 10 === 0 ? "lot_start" : "photo", lotNumber: Number(fileId.slice(2)) % 10 === 0 ? String(2500 + Number(fileId.slice(2))) : null,
  })));
});
async function fixture(count: number) {
  return ReportUploadSession.create({ type: "asset", user: new mongoose.Types.ObjectId(), status: "uploading", jobId: "submission", smartUpload: true,
    clientSubmissionId: "isolated-number-upload", details: {},
    smartGrouping: { method: "lot_number", status: "classifying", revision: 0, classificationJobId: "classifier", metrics: [], groups: [], dividerFileIds: [] },
    files: Array.from({ length: count }, (_, index) => ({ fileId: `p-${index}`, key: `p-${index}.jpg`, fieldname: "images", originalname: `${index}.jpg`,
      mimetype: "image/jpeg", size: 100, verifiedSize: 100, uploadedAt: new Date(), originalOrder: index })),
  });
}
const ownership = { classificationJobId: "classifier", revision: 0 };
const context = () => ({ executionToken: "attempt-1", signal: new AbortController().signal, assertOwned: vi.fn(async () => {}) });

describe("durable lot-number classification", () => {
  it.each([undefined, "earlier-attempt"])("cannot replace a newer execution token after a stale initial read (%s)", async (observedToken) => {
    const session = await fixture(2);
    if (observedToken) await ReportUploadSession.updateOne({ _id: session._id }, { $set: {
      "smartGrouping.classificationExecutionToken": observedToken,
    } });
    const execution = context();
    let ownershipChecks = 0;
    execution.assertOwned.mockImplementation(async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 2) {
        // A reclaimed worker wins between the old read and its claim write.
        await ReportUploadSession.updateOne({ _id: session._id }, { $set: {
          "smartGrouping.classificationExecutionToken": "newer-worker",
          "smartGrouping.progressPercent": 50,
          "smartGrouping.metrics": [{ fileId: "p-0", isDivider: false, kind: "lot_start", lotNumber: "2500" }],
        } });
      }
    });
    await classifySmartUploadSession(String(session._id), "progress", ownership, execution);
    const saved = await ReportUploadSession.findById(session._id).select("+smartGrouping.classificationExecutionToken");
    expect(saved!.smartGrouping).toMatchObject({ classificationExecutionToken: "newer-worker", progressPercent: 50 });
    expect(saved!.smartGrouping!.metrics).toHaveLength(1);
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(execution.assertOwned).toHaveBeenCalledTimes(2);
  });
  it("checkpoints batches and resumes only unfinished photos after provider failure", async () => {
    const session = await fixture(23);
    const normal = mocks.detect.getMockImplementation()!;
    mocks.detect.mockImplementationOnce(normal).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(classifySmartUploadSession(String(session._id), "progress", ownership, context())).rejects.toThrow("provider unavailable");
    expect((await ReportUploadSession.findById(session._id))!.smartGrouping!.metrics).toHaveLength(10);
    mocks.detect.mockImplementation(normal);
    const result: any = await classifySmartUploadSession(String(session._id), "progress", ownership, { ...context(), executionToken: "attempt-2" });
    expect(mocks.detect.mock.calls.map(([photos]) => photos.length)).toEqual([10, 10, 10, 3]);
    expect(result.smartGrouping).toMatchObject({ method: "lot_number", status: "review_ready", dividerFileIds: [] });
    expect(result.smartGrouping.groups.map((group: any) => group.imageCount)).toEqual([10, 10, 3]);
    expect(result.smartGrouping.groups.flatMap((group: any) => group.fileIds)).toEqual(session.files.map((file) => file.fileId));
    await classifySmartUploadSession(String(session._id), "progress", ownership, context());
    expect(mocks.detect).toHaveBeenCalledTimes(4);
  });
  it("caps simultaneous conversions at four and provider batches at ten", async () => {
    const session = await fixture(31);
    let active = 0, peak = 0;
    mocks.prepare.mockImplementation(async (fileId: string) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { fileId, imageUrl: "data:image/jpeg;base64,test" };
    });
    await classifySmartUploadSession(String(session._id), "progress", ownership, context());
    expect(peak).toBe(4);
    expect(mocks.detect.mock.calls.map(([photos]) => photos.length)).toEqual([10, 10, 10, 1]);
  });
  it("keeps unreadable and uncertain photos for review without fabricating boundaries", async () => {
    const session = await fixture(3);
    mocks.prepare.mockImplementation(async (fileId: string) => {
      if (fileId === "p-1") throw new Error("invalid image");
      return { fileId, imageUrl: "data:image/jpeg;base64,test" };
    });
    mocks.detect.mockResolvedValue([{ fileId: "p-0", kind: "lot_start", lotNumber: "2500" }, { fileId: "p-2", kind: "uncertain", lotNumber: null }]);
    const result: any = await classifySmartUploadSession(String(session._id), "progress", ownership, context());
    expect(result.smartGrouping.unresolvedLotNumberFileIds).toEqual(["p-1", "p-2"]);
    expect(result.smartGrouping.groups[0].fileIds).toEqual(["p-0", "p-1", "p-2"]);
    expect(result.smartGrouping.metrics[1].error).toMatch(/could not be read/);
  });
  it("does not publish a provider response after classification ownership changes", async () => {
    const session = await fixture(2);
    mocks.detect.mockImplementation(async (photos: any[]) => {
      await ReportUploadSession.updateOne({ _id: session._id }, { $set: { "smartGrouping.classificationJobId": "new-owner" } });
      return photos.map(({ fileId }) => ({ fileId, kind: "photo", lotNumber: null }));
    });
    await expect(classifySmartUploadSession(String(session._id), "progress", ownership, context())).rejects.toThrow(/no longer owns/);
    const saved = await ReportUploadSession.findById(session._id);
    expect(saved!.smartGrouping!.classificationJobId).toBe("new-owner");
    expect(saved!.smartGrouping!.metrics).toHaveLength(0);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
