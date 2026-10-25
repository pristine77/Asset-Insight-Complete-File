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
import ReportJob from "../src/models/reportJob.model.js";
import AssetReport from "../src/models/asset.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import {
  createMongoReportJob,
  startMongoReportWorker,
  updateMongoReportJobProgress,
  type ReportJobExecutionContext,
} from "../src/utils/reportJobMongoQueue.js";

let mongo: MongoMemoryServer;

const originalWorkerEnvironment = {
  REPORT_QUEUE_BACKEND: process.env.REPORT_QUEUE_BACKEND,
  REPORT_JOB_CONCURRENCY: process.env.REPORT_JOB_CONCURRENCY,
  REPORT_JOB_POLL_MS: process.env.REPORT_JOB_POLL_MS,
  REPORT_JOB_LEASE_MS: process.env.REPORT_JOB_LEASE_MS,
  REPORT_JOB_HEARTBEAT_MS: process.env.REPORT_JOB_HEARTBEAT_MS,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.REPORT_JOB_CONCURRENCY = "2";
  process.env.REPORT_JOB_POLL_MS = "10";
  process.env.REPORT_JOB_LEASE_MS = "600000";
  process.env.REPORT_JOB_HEARTBEAT_MS = "60000";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([
    ReportJob.syncIndexes(),
    AssetReport.syncIndexes(),
    ReportUploadSession.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  for (const [key, value] of Object.entries(originalWorkerEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential("ReportJob execution-attempt ownership", () => {
  it("does not regress a completed initial preview when its queue lease later expires", async () => {
    const progressId = "completed-initial-preview";
    const executionToken = "completed-initial-attempt";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      preview_data: { lots: [] },
      status: "preview",
      files_generating: false,
      files_regenerating: false,
      job_id: progressId,
      job_execution_token: executionToken,
      job_status: "done",
    });
    const job = await ReportJob.create({
      type: "asset-preview",
      reportId: String(report._id),
      progressId,
      payload: { progressId, notifyOwnerOnFailure: false },
      status: "processing",
      attempts: 3,
      maxAttempts: 3,
      lockedBy: "stopped-worker",
      executionToken,
      leaseUntil: new Date(Date.now() - 1_000),
      queuedAt: new Date(Date.now() - 5_000),
    });
    const uploadSession = await ReportUploadSession.create({
      type: "asset",
      status: "queued",
      user: report.user,
      reportId: String(report._id),
      jobId: progressId,
      clientSubmissionId: progressId,
      activeContractClaim: "completed-initial-preview-contract",
      details: { contract_no: "COMPLETED-INITIAL-PREVIEW-CONTRACT" },
      files: [],
      expectedFileCount: 0,
      expectedImageCount: 0,
      expectedVideoCount: 0,
      totalBytes: 0,
    });
    const abortController = new AbortController();
    const handler = vi.fn(async () => undefined);
    const worker = startMongoReportWorker(
      { "asset-preview": handler },
      { signal: abortController.signal }
    );

    try {
      await vi.waitFor(
        async () => {
          expect((await ReportJob.findById(job._id).lean())?.status).toBe(
            "completed"
          );
        },
        { timeout: 5_000, interval: 20 }
      );

      expect(handler).not.toHaveBeenCalled();
      expect(await AssetReport.findById(report._id).lean()).toMatchObject({
        status: "preview",
        files_generating: false,
        files_regenerating: false,
        job_id: progressId,
        job_execution_token: executionToken,
        job_status: "done",
      });
      const reconciledSession: any = await ReportUploadSession.findById(
        uploadSession._id,
      )
        .select("+activeContractClaim")
        .lean();
      expect(reconciledSession).toMatchObject({ status: "processed" });
      expect(reconciledSession.activeContractClaim).toBeUndefined();
    } finally {
      abortController.abort();
      await worker;
    }
  });

  it.each([
    ["complete", false],
    ["fail", true],
  ] as const)(
    "prevents a reclaimed attempt from writing progress or trying to %s the job",
    async (_label, assertOwnershipBeforeExit) => {
      const job = await createMongoReportJob({
        type: "released-appraisal-analysis",
        reportId: new mongoose.Types.ObjectId().toString(),
        progressId: `execution-attempt-${_label}`,
        maxAttempts: 3,
        payload: {},
      });
      const firstStarted = deferred();
      const secondStarted = deferred();
      const releaseFirst = deferred();
      const releaseSecond = deferred();
      const firstSignalAborted = deferred();
      let firstContext: ReportJobExecutionContext | undefined;
      let secondContext: ReportJobExecutionContext | undefined;
      let firstOwnershipError: unknown;

      const abortController = new AbortController();
      const worker = startMongoReportWorker(
        {
          "released-appraisal-analysis": async (claimedJob, context) => {
            if (claimedJob.attempts === 1) {
              firstContext = context;
              context.signal.addEventListener(
                "abort",
                () => firstSignalAborted.resolve(),
                { once: true }
              );
              await updateMongoReportJobProgress(claimedJob.progressId, {
                message: "owned by attempt one",
              });
              firstStarted.resolve();
              await releaseFirst.promise;
              await updateMongoReportJobProgress(claimedJob.progressId, {
                message: "stale attempt one",
              });
              if (assertOwnershipBeforeExit) {
                try {
                  await context.assertOwned();
                } catch (error) {
                  firstOwnershipError = error;
                  throw error;
                }
              }
              return;
            }

            secondContext = context;
            await updateMongoReportJobProgress(claimedJob.progressId, {
              message: "owned by attempt two",
            });
            secondStarted.resolve();
            await releaseSecond.promise;
          },
        },
        { signal: abortController.signal }
      );

      try {
        await firstStarted.promise;
        expect(firstContext?.executionToken).toEqual(expect.any(String));

        await ReportJob.updateOne(
          {
            _id: job._id,
            executionToken: firstContext?.executionToken,
          },
          { $set: { leaseUntil: new Date(Date.now() - 1_000) } }
        );

        await secondStarted.promise;
        expect(secondContext?.executionToken).toEqual(expect.any(String));
        expect(secondContext?.executionToken).not.toBe(
          firstContext?.executionToken
        );

        releaseFirst.resolve();
        await firstSignalAborted.promise;

        const whileSecondAttemptOwnsJob: any = await ReportJob.findById(
          job._id
        ).lean();
        expect(whileSecondAttemptOwnsJob).toMatchObject({
          status: "processing",
          attempts: 2,
          executionToken: secondContext?.executionToken,
          progress: { message: "owned by attempt two" },
        });
        expect(whileSecondAttemptOwnsJob.lastError).toBeUndefined();
        expect(firstContext?.signal.aborted).toBe(true);
        if (assertOwnershipBeforeExit) {
          expect(firstOwnershipError).toMatchObject({
            code: "REPORT_JOB_OWNERSHIP_LOST",
          });
        }

        releaseSecond.resolve();
        await vi.waitFor(
          async () => {
            expect((await ReportJob.findById(job._id).lean())?.status).toBe(
              "completed"
            );
          },
          { timeout: 5_000, interval: 20 }
        );

        const completed: any = await ReportJob.findById(job._id).lean();
        expect(completed).toMatchObject({
          status: "completed",
          attempts: 2,
          progress: { message: "Completed" },
        });
        expect(completed.executionToken).toBeUndefined();
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        abortController.abort();
        await worker;
      }
    }
  );
});
