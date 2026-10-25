import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), asset: vi.fn(), lot: vi.fn(), sessions: vi.fn() }));
vi.mock("../src/service/auctioneerInitialPreviewRetryService.js", () => ({ verifyInitialAuctioneerRetrySources: mocks.verify }));
vi.mock("../src/jobs/assetReportJob/previewJob.js", () => ({ runAssetPreviewJob: mocks.asset }));
vi.mock("../src/jobs/assetReportJob/previewFilesJob.js", () => ({ runPreviewFilesJob: vi.fn() }));
vi.mock("../src/jobs/lotListingJob.js", () => ({ runLotListingJob: mocks.lot, runRegenerateLotListingJob: vi.fn() }));
vi.mock("../src/jobs/excelCrRegenerationJob.js", () => ({ runExcelCrRegenerationJob: vi.fn() }));
vi.mock("../src/models/reportUploadSession.model.js", () => ({ default: { updateMany: mocks.sessions } }));
vi.mock("../src/service/reportDraftPreviewLifecycleService.js", () => ({ updateDraftPreviewLifecycle: vi.fn() }));

import { assetReportJobHandlers } from "../src/workers/reportJobHandlers/assetReportJobHandlers.js";
import { lotListingJobHandlers } from "../src/workers/reportJobHandlers/lotListingJobHandlers.js";

beforeEach(() => {
  vi.clearAllMocks(); mocks.verify.mockResolvedValue(undefined); mocks.asset.mockResolvedValue(undefined);
  mocks.lot.mockResolvedValue(undefined); mocks.sessions.mockResolvedValue({});
});
describe.each([
  { kind: "asset", handler: assetReportJobHandlers["asset-preview"], analyze: mocks.asset },
  { kind: "lotListing", handler: lotListingJobHandlers["lot-listing-preview"], analyze: mocks.lot },
])("$kind initial retry worker boundary", ({ handler, analyze }) => {
  const seed = () => ({ job: { reportId: "same-report", progressId: "new-attempt", attempts: 1, maxAttempts: 1,
    payload: { user: { id: "same-owner" }, images: [{ r2Key: "one.jpg", size: 100 }], details: {}, eventIdentityRetry: { version: 1 } } } as any,
    context: { assertOwned: vi.fn().mockResolvedValue(undefined), signal: new AbortController().signal } as any });
  it("waits for all source verification before starting analysis and retains exact image metadata", async () => {
    const { job, context } = seed();
    let release!: () => void;
    mocks.verify.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = handler(job, context);
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(analyze).not.toHaveBeenCalled();
    release(); await pending;
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0].images).toEqual(job.payload.images);
    expect(analyze.mock.calls[0][0].progressId).toBe(job.progressId);
  });
  it("does not analyze when retained originals are missing", async () => {
    const { job, context } = seed();
    mocks.verify.mockRejectedValueOnce(new Error("Source unavailable"));
    await expect(handler(job, context)).rejects.toThrow("Source unavailable");
    expect(analyze).not.toHaveBeenCalled();
    expect(mocks.sessions).toHaveBeenCalledWith(expect.objectContaining({ reportId: "same-report" }),
      expect.objectContaining({ $set: { status: "failed", lastError: "Source unavailable" } }));
  });
  it("stale worker never projects another owner's upload-session failure", async () => {
    const { job, context } = seed();
    mocks.verify.mockRejectedValueOnce(Object.assign(new Error("Ownership lost"), { code: "REPORT_JOB_OWNERSHIP_LOST" }));
    context.assertOwned.mockRejectedValue(Object.assign(new Error("Ownership lost"), { code: "REPORT_JOB_OWNERSHIP_LOST" }));
    await expect(handler(job, context)).rejects.toThrow("Ownership lost");
    expect(analyze).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
});
