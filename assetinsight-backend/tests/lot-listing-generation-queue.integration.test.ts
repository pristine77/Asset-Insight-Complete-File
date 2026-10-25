import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import {
  buildLotListingArtifactPrefix,
  buildLotListingInitialMediaKey,
  regenerateLotListingFiles,
  runLotListingJob,
} from "../src/jobs/lotListingJob.js";
import {
  createMongoReportJob,
  startMongoReportWorker,
} from "../src/utils/reportJobMongoQueue.js";
import { setReportGenerationProgress } from "../src/service/reportGenerationProgressService.js";

let mongo: MongoMemoryServer;
const originalQueueBackend = process.env.REPORT_QUEUE_BACKEND;
const originalWorkerPollMs = process.env.REPORT_JOB_POLL_MS;
const originalWorkerConcurrency = process.env.REPORT_JOB_CONCURRENCY;

beforeAll(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.REPORT_JOB_POLL_MS = "25";
  process.env.REPORT_JOB_CONCURRENCY = "1";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalQueueBackend === undefined) delete process.env.REPORT_QUEUE_BACKEND;
  else process.env.REPORT_QUEUE_BACKEND = originalQueueBackend;
  if (originalWorkerPollMs === undefined) delete process.env.REPORT_JOB_POLL_MS;
  else process.env.REPORT_JOB_POLL_MS = originalWorkerPollMs;
  if (originalWorkerConcurrency === undefined) delete process.env.REPORT_JOB_CONCURRENCY;
  else process.env.REPORT_JOB_CONCURRENCY = originalWorkerConcurrency;
});

async function createListing(contractNo: string) {
  return LotListing.create({
    user: new mongoose.Types.ObjectId(),
    contract_no: contractNo,
    sales_date: new Date("2026-09-01T00:00:00.000Z"),
    location: "Regina, SK",
    imageUrls: [],
    videoUrls: [],
    lots: [],
    status: "processing",
    job_status: "queued",
    files_generating: true,
    valuation_methods: ["FML"],
    preview_data: { contract_no: contractNo, lots: [] },
  });
}

describe("Lot Listing durable generation identity", () => {
  it("gives reclaimed executions separate immutable artifact destinations", () => {
    const reportId = new mongoose.Types.ObjectId().toString();
    const generationToken = "one-logical-files-job";
    const stalePrefix = buildLotListingArtifactPrefix(
      reportId,
      generationToken,
      "execution-one"
    );
    const winnerPrefix = buildLotListingArtifactPrefix(
      reportId,
      generationToken,
      "execution-two"
    );

    expect(stalePrefix).not.toBe(winnerPrefix);
    expect(stalePrefix).toMatch(
      new RegExp(`^lot-listings/generated/${reportId}/[a-f0-9]{24}$`)
    );
    expect(
      buildLotListingArtifactPrefix(reportId, generationToken, "execution-one")
    ).toBe(stalePrefix);
  });

  it("keeps transformed media keys stable across reclaimed execution attempts", () => {
    const input = {
      reportId: new mongoose.Types.ObjectId().toString(),
      generationToken: "one-logical-preview-job",
      kind: "images" as const,
      index: 8,
      buffer: Buffer.from("same accepted transformed image"),
      extension: ".jpg",
    };

    const firstAttemptKey = buildLotListingInitialMediaKey(input);
    const reclaimedAttemptKey = buildLotListingInitialMediaKey(input);

    expect(reclaimedAttemptKey).toBe(firstAttemptKey);
    expect(firstAttemptKey).toMatch(
      /^uploads\/lot-listing\/initial\/[a-f0-9]{24}\/images\/000008-[a-f0-9]{64}\.jpg$/
    );
  });

  it("keeps an initial preview retryable while its durable job has attempts left", async () => {
    const listing = await createListing("LOT-PREVIEW-TRANSIENT-FAILURE");
    const generationToken = "lot-preview-transient-token";
    const executionToken = "lot-preview-transient-execution";
    listing.job_id = generationToken;
    listing.job_status = "queued";
    await listing.save();
    const controller = new AbortController();

    await expect(
      runLotListingJob({
        listingId: String(listing._id),
        user: {
          id: String(listing.user),
          email: "retryable-preview@example.test",
        },
        images: [
          {
            fieldname: "images",
            originalname: "missing.jpg",
            encoding: "7bit",
            mimetype: "image/jpeg",
            size: 42,
            destination: "/tmp",
            filename: "missing.jpg",
            path: `/tmp/asset-insight-never-created-${new mongoose.Types.ObjectId()}.jpg`,
            buffer: Buffer.alloc(0),
          },
        ],
        details: {
          contract_no: listing.contract_no,
          sales_date: "2026-09-01T00:00:00.000Z",
          location: "Regina, SK",
          valuation_methods: ["FML"],
        },
        progressId: generationToken,
        executionContext: {
          executionToken,
          signal: controller.signal,
          assertOwned: vi.fn().mockResolvedValue(undefined),
        },
        deferSourceFileCleanup: true,
        willRetryOnError: true,
      })
    ).rejects.toThrow(/Missing upload file/);

    expect(
      await LotListing.findById(listing._id)
        .select("+job_execution_token")
        .lean()
    ).toMatchObject({
      status: "processing",
      job_id: generationToken,
      job_status: "queued",
      job_execution_token: executionToken,
      generation_progress: {
        stage: "queued",
        progressPercent: 1,
      },
    });
  });

  it("updates worker progress without erasing controller-owned generation metadata", async () => {
    const listing = await createListing("QUEUE-PROGRESS-METADATA");
    const generationToken = "lot-files-progress-token";
    listing.job_id = generationToken;
    (listing as any).generation_progress = {
      stage: "generating_files",
      progressPercent: 1,
      message: "Queued",
      currentLot: 3,
      totalLots: 10,
      previousStatus: "approved",
      previewFingerprint: "preview-sha-256",
      updatedAt: new Date(),
    };
    await listing.save();

    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: String(listing._id),
      progressId: generationToken,
      generationToken,
      stage: "generating_files",
      progressPercent: 25,
      message: "Preparing the latest lot data",
    });

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.generation_progress).toMatchObject({
      stage: "generating_files",
      progressPercent: 25,
      message: "Preparing the latest lot data",
      previousStatus: "approved",
      previewFingerprint: "preview-sha-256",
    });
    expect(persisted.generation_progress.currentLot).toBeUndefined();
    expect(persisted.generation_progress.totalLots).toBeUndefined();
  });

  it("persists one canonical generationToken and coalesces an exact queue retry", async () => {
    const listing = await createListing("QUEUE-TOKEN-CANONICAL");
    const generationToken = "lot-files-generation-token";
    listing.job_id = generationToken;
    await listing.save();

    const input = {
      listingId: String(listing._id),
      user: { id: String(listing.user), email: "queue@example.test" },
      generationToken,
      previewDataSnapshot: { contract_no: listing.contract_no, lots: [] },
    };
    const first = await regenerateLotListingFiles(input);
    const duplicate = await regenerateLotListingFiles(input);

    expect(String(duplicate?._id)).toBe(String(first?._id));
    expect(await ReportJob.countDocuments({
      type: "lot-listing-files",
      reportId: String(listing._id),
    })).toBe(1);
    const job: any = await ReportJob.findById(first?._id).lean();
    expect(job).toMatchObject({
      progressId: generationToken,
      idempotencyKey: `lot-listing-files:${String(listing._id)}:${generationToken}`,
      payload: {
        generationToken,
        jobId: generationToken,
      },
    });
  });

  it("upgrades the legacy jobId input into the canonical queue payload", async () => {
    const listing = await createListing("QUEUE-TOKEN-LEGACY");
    const legacyToken = "legacy-lot-files-job-id";
    listing.job_id = legacyToken;
    await listing.save();

    const job: any = await regenerateLotListingFiles({
      listingId: String(listing._id),
      user: { id: String(listing.user), email: "legacy@example.test" },
      jobId: legacyToken,
      previewDataSnapshot: { contract_no: listing.contract_no, lots: [] },
    });

    expect(job.progressId).toBe(legacyToken);
    expect(job.payload).toMatchObject({
      generationToken: legacyToken,
      jobId: legacyToken,
    });
  });

  it("rejects a reused idempotency key whose durable payload belongs to another token", async () => {
    const listing = await createListing("QUEUE-TOKEN-MISMATCH");
    const expectedToken = "expected-generation-token";
    listing.job_id = expectedToken;
    await listing.save();
    await ReportJob.create({
      type: "lot-listing-files",
      reportId: String(listing._id),
      progressId: "corrupt-generation-token",
      idempotencyKey: `lot-listing-files:${String(listing._id)}:${expectedToken}`,
      payload: {
        listingId: String(listing._id),
        generationToken: "corrupt-generation-token",
        jobId: "corrupt-generation-token",
      },
      status: "queued",
      queuedAt: new Date(),
      maxAttempts: 3,
    });

    await expect(
      regenerateLotListingFiles({
        listingId: String(listing._id),
        user: { id: String(listing.user), email: "mismatch@example.test" },
        generationToken: expectedToken,
        previewDataSnapshot: { contract_no: listing.contract_no, lots: [] },
      })
    ).rejects.toMatchObject({
      code: "LOT_LISTING_JOB_IDENTITY_CONFLICT",
      statusCode: 409,
    });
  });

  it("uses a legacy queued jobId to fence terminal worker failure from a newer generation", async () => {
    const listing = await createListing("QUEUE-TOKEN-FAILURE-FENCE");
    listing.job_id = "newer-generation-token";
    await listing.save();
    const staleJob: any = await createMongoReportJob({
      type: "lot-listing-files",
      reportId: String(listing._id),
      progressId: "legacy-stale-token",
      maxAttempts: 1,
      payload: {
        listingId: String(listing._id),
        jobId: "legacy-stale-token",
        notifyOwnerOnFailure: false,
      },
    });

    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      {
        "lot-listing-files": async () => {
          throw new Error("simulated terminal generation failure");
        },
      },
      { signal: abortController.signal }
    );
    try {
      await vi.waitFor(
        async () => {
          expect((await ReportJob.findById(staleJob._id).lean())?.status).toBe(
            "failed"
          );
        },
        { timeout: 5_000, interval: 25 }
      );
    } finally {
      abortController.abort();
      await worker;
    }

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      job_id: "newer-generation-token",
      job_status: "queued",
      files_generating: true,
    });
    expect(persisted.job_error).toBeUndefined();
  });

  it("restores processing state before retrying a failed file-generation attempt", async () => {
    const listing = await createListing("QUEUE-FILE-RETRY-STATE");
    const generationToken = "retry-generation-token";
    listing.job_id = generationToken;
    await listing.save();
    const job: any = await createMongoReportJob({
      type: "lot-listing-files",
      reportId: String(listing._id),
      progressId: generationToken,
      maxAttempts: 2,
      payload: {
        listingId: String(listing._id),
        generationToken,
        jobId: generationToken,
        notifyOwnerOnFailure: false,
      },
    });

    let attempt = 0;
    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      {
        "lot-listing-files": async () => {
          attempt += 1;
          if (attempt === 1) {
            await LotListing.updateOne(
              { _id: listing._id, job_id: generationToken },
              {
                $set: {
                  status: "approved",
                  job_status: "error",
                  artifact_repair_required: true,
                },
              }
            );
            throw new Error("simulated retryable generation error");
          }
          const retryState: any = await LotListing.findById(listing._id).lean();
          expect(retryState).toMatchObject({
            status: "processing",
            job_status: "queued",
            files_generating: true,
            artifact_repair_required: true,
          });
          await LotListing.updateOne(
            { _id: listing._id, job_id: generationToken },
            {
              $set: {
                status: "approved",
                job_status: "done",
                files_generating: false,
                files_regenerating: false,
              },
            }
          );
        },
      },
      { signal: abortController.signal }
    );
    try {
      await vi.waitFor(
        async () => {
          expect((await ReportJob.findById(job._id).lean())?.status).toBe(
            "completed"
          );
        },
        { timeout: 5_000, interval: 25 }
      );
    } finally {
      abortController.abort();
      await worker;
    }
    expect(attempt).toBe(2);
  });

  it("clears the artifact repair barrier after the final durable retry fails", async () => {
    const listing = await createListing("QUEUE-TERMINAL-REPAIR-BARRIER");
    const generationToken = "terminal-repair-generation-token";
    listing.job_id = generationToken;
    (listing as any).artifact_repair_required = true;
    await listing.save();
    const job: any = await createMongoReportJob({
      type: "lot-listing-files",
      reportId: String(listing._id),
      progressId: generationToken,
      maxAttempts: 1,
      payload: {
        listingId: String(listing._id),
        generationToken,
        jobId: generationToken,
        notifyOwnerOnFailure: false,
      },
    });

    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      {
        "lot-listing-files": async () => {
          throw new Error("simulated terminal artifact publication failure");
        },
      },
      { signal: abortController.signal }
    );
    try {
      await vi.waitFor(
        async () => {
          expect((await ReportJob.findById(job._id).lean())?.status).toBe(
            "failed"
          );
        },
        { timeout: 5_000, interval: 25 }
      );
    } finally {
      abortController.abort();
      await worker;
    }

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.job_status).toBe("error");
    expect(persisted.artifact_repair_required).toBeUndefined();
    expect(persisted.artifact_publish_token).toBeUndefined();
    expect(persisted.artifact_publish_expires_at).toBeUndefined();
  });
});
