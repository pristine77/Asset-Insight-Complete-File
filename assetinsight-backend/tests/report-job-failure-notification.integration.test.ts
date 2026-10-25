import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  notifyFailure: vi.fn(async () => undefined),
}));

vi.mock("../src/service/reportProcessingFailureService.js", () => ({
  notifyReportProcessingFailure: dependencyMocks.notifyFailure,
}));

import AssetReport from "../src/models/asset.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import { startMongoReportWorker } from "../src/utils/reportJobMongoQueue.js";

let mongo: MongoMemoryServer;
const originalEnvironment = {
  REPORT_QUEUE_BACKEND: process.env.REPORT_QUEUE_BACKEND,
  REPORT_JOB_CONCURRENCY: process.env.REPORT_JOB_CONCURRENCY,
  REPORT_JOB_POLL_MS: process.env.REPORT_JOB_POLL_MS,
};

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.REPORT_JOB_CONCURRENCY = "1";
  process.env.REPORT_JOB_POLL_MS = "10";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  dependencyMocks.notifyFailure.mockClear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential("owned report failure notifications", () => {
  it.each([
    ["already completed", "finished-generation", "finished-generation", "done", "completed"],
    ["superseded", "newer-generation", "expired-generation", "queued", "failed"],
  ] as const)(
    "does not notify for an expired job whose report is %s",
    async (_label, reportJobId, expiredJobId, reportJobStatus, expectedJobStatus) => {
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "mixed",
        imageUrls: [],
        lots: [],
        status: "preview",
        job_id: reportJobId,
        job_status: reportJobStatus,
        files_generating: reportJobStatus !== "done",
        ...(reportJobStatus === "done"
          ? {
              preview_files: {
                docx: "https://assetinsight.test/reports/report.docx",
                excel: "https://assetinsight.test/reports/report.xlsx",
                images: "https://assetinsight.test/reports/images.zip",
              },
            }
          : {}),
      });
      const expired = await ReportJob.create({
        type: "asset-preview-files",
        reportId: report._id.toString(),
        progressId: expiredJobId,
        payload: {
          reportId: report._id.toString(),
          generationToken: expiredJobId,
        },
        status: "processing",
        attempts: 3,
        maxAttempts: 3,
        lockedBy: "stopped-worker",
        executionToken: "expired-execution",
        leaseUntil: new Date(Date.now() - 1_000),
        queuedAt: new Date(Date.now() - 5_000),
      });
      const abortController = new AbortController();
      const handler = vi.fn(async () => undefined);
      const worker = startMongoReportWorker(
        { "asset-preview-files": handler },
        { signal: abortController.signal }
      );

      try {
        await vi.waitFor(
          async () => {
            expect((await ReportJob.findById(expired._id).lean())?.status).toBe(
              expectedJobStatus
            );
          },
          { timeout: 5_000, interval: 20 }
        );
        expect(handler).not.toHaveBeenCalled();
        expect(dependencyMocks.notifyFailure).not.toHaveBeenCalled();
        expect(await AssetReport.findById(report._id).lean()).toMatchObject({
          job_id: reportJobId,
          job_status: reportJobStatus,
        });
      } finally {
        abortController.abort();
        await worker;
      }
    }
  );
});
