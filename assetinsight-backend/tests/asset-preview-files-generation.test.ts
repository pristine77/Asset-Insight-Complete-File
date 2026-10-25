import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let mongo: MongoMemoryServer;
let previousQueueBackend: string | undefined;
let previousWorkerConcurrency: string | undefined;
let previousWorkerPollMs: string | undefined;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let queueAssetPreviewJob: typeof import("../src/jobs/assetReportJob.js")["queueAssetPreviewJob"];
let runAssetPreviewJob: typeof import("../src/jobs/assetReportJob/previewJob.js")["runAssetPreviewJob"];
let buildAssetInitialPreviewImageObjectKey: typeof import("../src/jobs/assetReportJob/previewJob.js")["buildAssetInitialPreviewImageObjectKey"];
let buildImmutableAssetArtifactKey: typeof import("../src/service/assetArtifactBufferPublicationService.js")["buildImmutableAssetArtifactKey"];
let queuePreviewFilesJob: typeof import("../src/jobs/assetReportJob/previewFilesJob.js")["queuePreviewFilesJob"];
let reconcileAssetPreviewFilesQueueFailure: typeof import("../src/service/assetPreviewFilesGenerationService.js")["reconcileAssetPreviewFilesQueueFailure"];
let reconcileAssetPreviewFilesWorkerFailure: typeof import("../src/service/assetPreviewFilesGenerationService.js")["reconcileAssetPreviewFilesWorkerFailure"];
let persistAssetGeneratedLots: typeof import("../src/service/assetGeneratedLotsPersistenceService.js")["persistAssetGeneratedLots"];
let publishProposalValuationArtifactsForRevision: typeof import("../src/service/proposalValuationArtifactPublicationService.js")["publishProposalValuationArtifactsForRevision"];
let startMongoReportWorker: typeof import("../src/utils/reportJobMongoQueue.js")["startMongoReportWorker"];

beforeAll(async () => {
  previousQueueBackend = process.env.REPORT_QUEUE_BACKEND;
  previousWorkerConcurrency = process.env.REPORT_JOB_CONCURRENCY;
  previousWorkerPollMs = process.env.REPORT_JOB_POLL_MS;
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  process.env.REPORT_JOB_CONCURRENCY = "1";
  process.env.REPORT_JOB_POLL_MS = "25";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ queueAssetPreviewJob } = await import("../src/jobs/assetReportJob.js"));
  ({
    runAssetPreviewJob,
    buildAssetInitialPreviewImageObjectKey,
  } = await import("../src/jobs/assetReportJob/previewJob.js"));
  ({ queuePreviewFilesJob } = await import(
    "../src/jobs/assetReportJob/previewFilesJob.js"
  ));
  ({
    reconcileAssetPreviewFilesQueueFailure,
    reconcileAssetPreviewFilesWorkerFailure,
  } = await import("../src/service/assetPreviewFilesGenerationService.js"));
  ({ persistAssetGeneratedLots } = await import(
    "../src/service/assetGeneratedLotsPersistenceService.js"
  ));
  ({ publishProposalValuationArtifactsForRevision } = await import(
    "../src/service/proposalValuationArtifactPublicationService.js"
  ));
  ({ startMongoReportWorker } = await import(
    "../src/utils/reportJobMongoQueue.js"
  ));
  ({ buildImmutableAssetArtifactKey } = await import(
    "../src/service/assetArtifactBufferPublicationService.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.syncIndexes(), ReportJob.syncIndexes()]);
});

afterAll(async () => {
  if (previousQueueBackend === undefined) {
    delete process.env.REPORT_QUEUE_BACKEND;
  } else {
    process.env.REPORT_QUEUE_BACKEND = previousQueueBackend;
  }
  if (previousWorkerConcurrency === undefined) {
    delete process.env.REPORT_JOB_CONCURRENCY;
  } else {
    process.env.REPORT_JOB_CONCURRENCY = previousWorkerConcurrency;
  }
  if (previousWorkerPollMs === undefined) {
    delete process.env.REPORT_JOB_POLL_MS;
  } else {
    process.env.REPORT_JOB_POLL_MS = previousWorkerPollMs;
  }
  await mongoose.disconnect();
  await mongo.stop();
});

async function createClaimedReport(generationToken: string) {
  return AssetReport.create({
    user: new mongoose.Types.ObjectId(),
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    status: "approved",
    preview_data: { lots: [] },
    files_generating: true,
    files_regenerating: true,
    job_id: generationToken,
    job_status: "queued",
  });
}

describe.sequential("Asset preview-file generation ownership", () => {
  it("builds deterministic, position-bound initial preview image keys", () => {
    const base = {
      reportId: new mongoose.Types.ObjectId().toHexString(),
      generationToken: "asset-initial-logical-job",
      imageIndex: 7,
      buffer: Buffer.from("same transformed image bytes"),
      extension: ".JPG",
    };
    const first = buildAssetInitialPreviewImageObjectKey(base);
    const retry = buildAssetInitialPreviewImageObjectKey({ ...base });

    expect(retry).toBe(first);
    expect(first).toMatch(
      /^uploads\/asset\/initial\/[a-f0-9]{24}\/000007-[a-f0-9]{64}\.jpg$/
    );
    expect(
      buildAssetInitialPreviewImageObjectKey({ ...base, imageIndex: 8 })
    ).not.toBe(first);
    expect(
      buildAssetInitialPreviewImageObjectKey({
        ...base,
        buffer: Buffer.from("different bytes"),
      })
    ).not.toBe(first);
  });

  it("publishes report artifacts to immutable content-addressed keys", async () => {
    const input = {
      reportId: new mongoose.Types.ObjectId().toHexString(),
      revision: 9,
      baseKey: "previews/contract-report.docx",
      buffer: Buffer.from("accepted artifact bytes"),
    };
    const accepted = await buildImmutableAssetArtifactKey(input);

    expect(await buildImmutableAssetArtifactKey({ ...input })).toBe(accepted);
    expect(accepted).toMatch(
      /^previews\/asset-generations\/[a-f0-9]{24}\/revision-9\/[a-f0-9]{64}-contract-report\.docx$/
    );
    expect(
      await buildImmutableAssetArtifactKey({
        ...input,
        buffer: Buffer.from("stale artifact bytes"),
      })
    ).not.toBe(accepted);
  });

  it("lets a reclaimed initial-preview attempt finish without stale state or source cleanup", async () => {
    const logicalToken = "asset-initial-two-attempts";
    const firstExecutionToken = "asset-initial-attempt-one";
    const secondExecutionToken = "asset-initial-attempt-two";
    const ownerId = new mongoose.Types.ObjectId();
    const report = await AssetReport.create({
      user: ownerId,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: logicalToken,
      job_status: "queued",
    });
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "asset-preview-attempt-")
    );
    const sharedSourcePath = path.join(tempDirectory, "shared-video.mp4");
    await writeFile(sharedSourcePath, Buffer.from("shared durable source"));
    const storage = await import("../src/utils/r2Storage/r2Upload.js");
    const uploadVideo = vi.spyOn(storage, "uploadFilePathToR2").mockResolvedValue("https://assetinsight.test/shared-video.mp4");
    const input = {
      reportId: String(report._id),
      user: {
        id: String(ownerId),
        email: "asset-attempt@example.test",
        name: "Asset Attempt",
      },
      images: [],
      videos: [
        {
          path: sharedSourcePath,
          originalname: "shared-video.mp4",
          mimetype: "video/mp4",
        } as Express.Multer.File,
      ],
      details: {
        grouping_mode: "single_lot",
        contract_no: "ASSET-INITIAL-TWO-ATTEMPTS",
        draft_preview: true,
      },
      progressId: logicalToken,
    };
    let firstOwnershipChecks = 0;
    const ownershipLost = Object.assign(new Error("first attempt lease lost"), {
      code: "REPORT_JOB_OWNERSHIP_LOST",
    });

    try {
      await expect(
        runAssetPreviewJob(input, {
          deferSourceFileCleanup: true,
          executionContext: {
            executionToken: firstExecutionToken,
            signal: new AbortController().signal,
            assertOwned: async () => {
              firstOwnershipChecks += 1;
              if (firstOwnershipChecks === 3) {
                await AssetReport.updateOne(
                  {
                    _id: report._id,
                    job_id: logicalToken,
                    job_execution_token: firstExecutionToken,
                  },
                  { $set: { job_execution_token: secondExecutionToken } }
                );
                throw ownershipLost;
              }
            },
          },
        })
      ).rejects.toMatchObject({ code: "REPORT_JOB_OWNERSHIP_LOST" });

      expect(await AssetReport.findById(report._id).lean()).toMatchObject({
        status: "processing",
        job_id: logicalToken,
        job_execution_token: secondExecutionToken,
        job_status: "processing",
      });

      await runAssetPreviewJob(input, {
        deferSourceFileCleanup: true,
        executionContext: {
          executionToken: secondExecutionToken,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
        },
      });

      const completed: any = await AssetReport.findById(report._id).lean();
      expect(completed).toMatchObject({
        status: "preview",
        job_id: logicalToken,
        job_status: "done",
        preview_data: { lots: [] },
      });
      expect(completed.job_execution_token).toBeUndefined();
      expect(await readFile(sharedSourcePath, "utf8")).toBe(
        "shared durable source"
      );
    } finally {
      uploadVideo.mockRestore();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("reuses one durable initial-preview job for a direct submission retry", async () => {
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: "asset-direct-preview-token",
      job_status: "queued",
    });
    const input = {
      reportId: String(report._id),
      user: {
        id: String(report.user),
        email: "direct-preview@example.test",
      },
      images: [],
      videos: [],
      details: { client_submission_id: "asset-direct-preview-submission" },
      progressId: "asset-direct-preview-token",
    };

    const first = await queueAssetPreviewJob(input);
    const retried = await queueAssetPreviewJob(input);

    expect(String(retried._id)).toBe(String(first._id));
    expect(await ReportJob.countDocuments({
      reportId: String(report._id),
      type: "asset-preview",
    })).toBe(1);
    expect(await ReportJob.findById(first._id).lean()).toMatchObject({
      idempotencyKey:
        `asset-preview:${String(report._id)}:asset-direct-preview-submission`,
      progressId: "asset-direct-preview-token",
    });
  });

  it("uses one token for the report job identity and exact retries", async () => {
    const token = "asset-files-exact-retry";
    const report = await createClaimedReport(token);

    const first = await queuePreviewFilesJob(String(report._id), {
      jobId: token,
      targetStatus: "approved",
      previewDataSnapshot: { lots: [] },
    });
    const retried = await queuePreviewFilesJob(String(report._id), {
      jobId: token,
      targetStatus: "approved",
      previewDataSnapshot: { lots: [] },
    });

    expect(String(retried._id)).toBe(String(first._id));
    expect(await ReportJob.countDocuments({ reportId: String(report._id) })).toBe(1);
    expect(await ReportJob.findById(first._id).lean()).toMatchObject({
      progressId: token,
      idempotencyKey: `asset-preview-files:${String(report._id)}:${token}`,
      payload: {
        reportId: String(report._id),
        generationToken: token,
      },
    });
  });

  it("rejects a different active token and restores only the caller's claim", async () => {
    const currentToken = "asset-files-new-request";
    const report = await createClaimedReport(currentToken);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          generation_progress: {
            stage: "queued",
            progressPercent: 1,
            message: "Queued",
            previousStatus: "approved",
            previewFingerprint: "asset-queue-conflict-fingerprint",
            updatedAt: new Date(),
          },
        },
      }
    );
    await ReportJob.create({
      type: "asset-preview-files",
      reportId: String(report._id),
      progressId: "asset-files-old-request",
      dedupeKey: `asset-preview-files:${String(report._id)}`,
      idempotencyKey: `asset-preview-files:${String(report._id)}:asset-files-old-request`,
      status: "processing",
      payload: {
        reportId: String(report._id),
        generationToken: "asset-files-old-request",
      },
    });

    let queueError: unknown;
    try {
      await queuePreviewFilesJob(String(report._id), {
        jobId: currentToken,
        targetStatus: "approved",
      });
    } catch (error) {
      queueError = error;
    }
    expect(queueError).toMatchObject({
      code: "ASSET_PREVIEW_FILES_JOB_CONFLICT",
      statusCode: 409,
    });

    const reconciliation = await reconcileAssetPreviewFilesQueueFailure({
      reportId: String(report._id),
      generationToken: currentToken,
      error: queueError,
      fallbackStatus: "approved",
    });
    expect(reconciliation).toEqual({
      queued: false,
      reconciled: true,
      superseded: false,
    });
    expect(await AssetReport.findById(report._id).lean()).toMatchObject({
      status: "approved",
      files_generating: false,
      files_regenerating: false,
      job_status: "error",
      generation_progress: {
        stage: "error",
        progressPercent: 100,
        previousStatus: "approved",
        previewFingerprint: "asset-queue-conflict-fingerprint",
      },
    });
  });

  it("does not let a stale generator overwrite generated lot fields", async () => {
    const token = "asset-files-lot-owner";
    const report = await createClaimedReport(token);
    await AssetReport.updateOne(
      { _id: report._id },
      { $set: { job_status: "processing" } }
    );
    await persistAssetGeneratedLots({
      reportId: String(report._id),
      lots: [{ lot_id: "owned", title: "Owned value" }],
      claimFilter: { job_id: token, job_status: "processing" },
    });
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          job_id: "asset-files-new-owner",
          job_status: "queued",
        },
      }
    );

    await expect(
      persistAssetGeneratedLots({
        reportId: String(report._id),
        lots: [{ lot_id: "stale", title: "Stale value" }],
        claimFilter: { job_id: token, job_status: "processing" },
      })
    ).rejects.toMatchObject({
      code: "ASSET_PREVIEW_FILES_OWNERSHIP_LOST",
      statusCode: 409,
    });
    expect((await AssetReport.findById(report._id).lean())?.lots).toEqual([
      expect.objectContaining({ lot_id: "owned", title: "Owned value" }),
    ]);
  });

  it("fences stale file-worker writes when the same logical job is reclaimed", async () => {
    const logicalToken = "asset-files-same-logical-job";
    const firstExecutionToken = "asset-files-attempt-one";
    const secondExecutionToken = "asset-files-attempt-two";
    const report = await createClaimedReport(logicalToken);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          job_status: "processing",
          job_execution_token: firstExecutionToken,
          proposal_valuation_revision: 0,
        },
      }
    );

    const reclaimed = await AssetReport.findOneAndUpdate(
      {
        _id: report._id,
        job_id: logicalToken,
        job_status: "processing",
      },
      { $set: { job_execution_token: secondExecutionToken } },
      { new: true }
    );
    expect(reclaimed?.job_execution_token).toBe(secondExecutionToken);

    await expect(
      persistAssetGeneratedLots({
        reportId: String(report._id),
        lots: [{ lot_id: "stale-attempt", title: "Must not persist" }],
        claimFilter: {
          job_id: logicalToken,
          job_execution_token: firstExecutionToken,
          job_status: "processing",
        },
      })
    ).rejects.toMatchObject({
      code: "ASSET_PREVIEW_FILES_OWNERSHIP_LOST",
    });

    await expect(
      reconcileAssetPreviewFilesWorkerFailure({
        reportId: String(report._id),
        generationToken: logicalToken,
        executionToken: firstExecutionToken,
        progressId: logicalToken,
        message: "stale attempt failed after reclaim",
        willRetry: false,
        fallbackStatus: "approved",
        generationTarget: "approved",
      })
    ).resolves.toEqual({
      reconciled: false,
      supersededOrCompleted: true,
    });

    await persistAssetGeneratedLots({
      reportId: String(report._id),
      lots: [{ lot_id: "winning-attempt", title: "Winner" }],
      claimFilter: {
        job_id: logicalToken,
        job_execution_token: secondExecutionToken,
        job_status: "processing",
      },
    });
    const stored: any = await AssetReport.findById(report._id).lean();
    expect(stored).toMatchObject({
      status: "approved",
      job_execution_token: secondExecutionToken,
      job_status: "processing",
      lots: [expect.objectContaining({ lot_id: "winning-attempt" })],
    });
    expect(stored.job_error).toBeUndefined();
  });

  it("fences publication finalization after the report claim changes", async () => {
    const token = "asset-files-publisher";
    const report = await createClaimedReport(token);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          job_status: "processing",
          proposal_valuation_revision: 4,
        },
      }
    );

    await expect(
      publishProposalValuationArtifactsForRevision({
        reportId: String(report._id),
        revision: 4,
        previewFiles: { excel: "https://assetinsight.test/stale.xlsx" },
        claimFilter: { job_id: token, job_status: "processing" },
        publish: async () => {
          await AssetReport.updateOne(
            { _id: report._id },
            {
              $set: {
                job_id: "asset-files-new-publisher",
                job_status: "queued",
              },
            }
          );
        },
      })
    ).rejects.toThrow("publication lease was lost");

    const stored = await AssetReport.findById(report._id).lean();
    expect((stored as any)?.preview_files?.excel).toBeUndefined();
    expect((stored as any)?.job_id).toBe("asset-files-new-publisher");
    expect((stored as any)?.files_regeneration_pending).not.toBe(true);
  });

  it("preserves controller generation metadata when a durable job fails", async () => {
    const token = "asset-files-terminal-failure";
    const report = await createClaimedReport(token);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          generation_progress: {
            stage: "queued",
            progressPercent: 1,
            message: "Queued",
            previousStatus: "approved",
            previewFingerprint: "asset-preview-fingerprint",
            updatedAt: new Date(),
          },
        },
      }
    );
    const job = await ReportJob.create({
      type: "asset-preview-files",
      reportId: String(report._id),
      progressId: token,
      payload: {
        reportId: String(report._id),
        generationToken: token,
        notifyOwnerOnFailure: false,
      },
      maxAttempts: 1,
    });

    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      {
        "asset-preview-files": async () => {
          throw new Error("simulated terminal file-generation failure");
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

    const stored: any = await AssetReport.findById(report._id).lean();
    expect(stored.generation_progress).toMatchObject({
      stage: "error",
      progressPercent: 100,
      previousStatus: "approved",
      previewFingerprint: "asset-preview-fingerprint",
    });
  });

  it("preserves controller generation metadata when an exhausted lease expires", async () => {
    const token = "asset-files-expired-worker";
    const report = await createClaimedReport(token);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          generation_progress: {
            stage: "generating_files",
            progressPercent: 42,
            message: "Generating",
            previousStatus: "approved",
            previewFingerprint: "asset-expired-preview-fingerprint",
            updatedAt: new Date(),
          },
        },
      }
    );
    const job = await ReportJob.create({
      type: "asset-preview-files",
      reportId: String(report._id),
      progressId: token,
      payload: {
        reportId: String(report._id),
        generationToken: token,
        notifyOwnerOnFailure: false,
      },
      status: "processing",
      attempts: 1,
      maxAttempts: 1,
      lockedBy: "dead-worker",
      leaseUntil: new Date(Date.now() - 1_000),
    });

    const abortController = new AbortController();
    const worker = startMongoReportWorker(
      { "asset-preview-files": async () => undefined },
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

    const stored: any = await AssetReport.findById(report._id).lean();
    expect(stored.generation_progress).toMatchObject({
      stage: "error",
      progressPercent: 100,
      previousStatus: "approved",
      previewFingerprint: "asset-expired-preview-fingerprint",
    });
  });

  it("does not overwrite completed progress when a worker throws after final save", async () => {
    const token = "asset-files-completed-before-late-error";
    const report = await createClaimedReport(token);
    await AssetReport.updateOne(
      { _id: report._id },
      {
        $set: {
          status: "approved",
          job_status: "done",
          files_generating: false,
          files_regenerating: false,
          generation_progress: {
            stage: "ready",
            progressPercent: 100,
            message: "Report ready",
            previousStatus: "approved",
            updatedAt: new Date(),
          },
        },
      }
    );

    await expect(
      reconcileAssetPreviewFilesWorkerFailure({
        reportId: String(report._id),
        generationToken: token,
        progressId: token,
        message: "late optional side effect failed",
        willRetry: false,
        fallbackStatus: "approved",
        generationTarget: "approved",
      })
    ).resolves.toEqual({
      reconciled: false,
      supersededOrCompleted: true,
    });

    const stored: any = await AssetReport.findById(report._id).lean();
    expect(stored).toMatchObject({
      status: "approved",
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
      generation_progress: {
        stage: "ready",
        progressPercent: 100,
        message: "Report ready",
        previousStatus: "approved",
      },
    });
  });
});
