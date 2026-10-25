import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";

const r2Mocks = vi.hoisted(() => ({
  uploadBufferToR2: vi.fn(),
  copyR2Object: vi.fn(),
  deleteFromR2: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  uploadBufferToR2: r2Mocks.uploadBufferToR2,
  copyR2Object: r2Mocks.copyR2Object,
  deleteFromR2: r2Mocks.deleteFromR2,
}));

import {
  isLotListingArtifactPublicationLive,
  lotListingArtifactPublicationAvailableCondition,
  stageAndPublishLotListingArtifacts,
} from "../src/service/lotListingArtifactPublicationService.js";
import { setReportGenerationProgress } from "../src/service/reportGenerationProgressService.js";
import { resolveReportGenerationStateForProfile } from "../src/utils/reportFileState.js";
import { assertReportFilesReadyForWorkflow } from "../src/service/reportReleaseService.js";

let mongo: MongoMemoryServer;
const originalBucket = process.env.R2_BUCKET_NAME;

beforeAll(async () => {
  process.env.R2_BUCKET_NAME = "lot-publication-test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  r2Mocks.uploadBufferToR2.mockReset();
  r2Mocks.copyR2Object.mockReset();
  r2Mocks.deleteFromR2.mockReset();
  r2Mocks.uploadBufferToR2.mockImplementation(
    async (_buffer: Buffer, _contentType: string, _bucket: string, key: string) =>
      `https://assetinsight.test/${key}`
  );
  r2Mocks.copyR2Object.mockResolvedValue(undefined);
  r2Mocks.deleteFromR2.mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalBucket === undefined) delete process.env.R2_BUCKET_NAME;
  else process.env.R2_BUCKET_NAME = originalBucket;
});

async function createPublishingListing(
  generationToken: string,
  executionToken?: string
) {
  return LotListing.create({
    user: new mongoose.Types.ObjectId(),
    contract_no: "LOT-PUBLISH-100",
    sales_date: new Date("2026-09-01T00:00:00.000Z"),
    location: "Regina, SK",
    imageUrls: [],
    videoUrls: [],
    lots: [],
    status: "processing",
    job_id: generationToken,
    job_execution_token: executionToken,
    job_status: "processing",
    files_generating: true,
    valuation_methods: ["FML"],
    preview_data: { contract_no: "LOT-PUBLISH-100", lots: [] },
  });
}

const artifacts = [
  {
    buffer: Buffer.from("spreadsheet"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    key: "lot-listings/LOT-PUBLISH-100.xlsx",
  },
  {
    buffer: Buffer.from("photos"),
    contentType: "application/zip",
    key: "lot-listings/LOT-PUBLISH-100-images.zip",
  },
];

describe("Lot Listing artifact publication", () => {
  it.each(["preview", "approved"] as const)(
    "shows active %s publication until its complete files are atomically visible",
    async (finalStatus) => {
      const generationToken = `lot-active-publication-${finalStatus}`;
      const listing = await createPublishingListing(generationToken);
      const storedFiles = {
        excel: "https://assetinsight.test/old.xlsx",
        images: "https://assetinsight.test/old.zip",
      };
      await LotListing.updateOne({ _id: listing._id }, { $set: {
        status: finalStatus === "preview" ? "preview" : "processing",
        preview_files: storedFiles,
        ...(finalStatus === "approved" ? { preview_submitted_at: new Date() } : {}),
      } });
      let releaseCopy!: () => void;
      const copyGate = new Promise<void>(resolve => { releaseCopy = resolve; });
      r2Mocks.copyR2Object.mockImplementationOnce(() => copyGate);
      const publishedFiles = {
        excel: "https://assetinsight.test/new.xlsx",
        images: "https://assetinsight.test/new.zip",
      };
      const publishing = stageAndPublishLotListingArtifacts({
        reportId: String(listing._id),
        generationToken,
        artifacts,
        ...(finalStatus === "preview" ? { claimFilter: { status: "preview", job_status: "processing" } } : {}),
        finalizeSet: {
          status: finalStatus,
          job_status: "done",
          files_generating: false,
          preview_files: publishedFiles,
          ...(finalStatus === "approved" ? { release_status: "released" } : {}),
        },
      });
      try {
        await vi.waitFor(() => expect(r2Mocks.copyR2Object).toHaveBeenCalledTimes(1));
        const current = await LotListing.findById(listing._id).lean();
        expect(current).toMatchObject({ artifact_repair_required: true, preview_files: storedFiles });
        const state = resolveReportGenerationStateForProfile("lotListing", current, current?.preview_files);
        expect(state).toMatchObject({
          generation_state: "processing",
          job_status: "processing",
          files_ready: false,
          workflow_stage: finalStatus === "preview" ? "preparing_preview" : "generating_files",
        });
        expect(state.job_error).toBeUndefined();
        expect(() => assertReportFilesReadyForWorkflow("lotListing", current))
          .toThrow(expect.objectContaining({ code: "FILES_GENERATING" }));
      } finally {
        releaseCopy();
        await publishing;
      }
      const finalized = await LotListing.findById(listing._id).lean();
      expect(finalized?.artifact_repair_required).toBeUndefined();
      expect(finalized?.preview_files).toMatchObject(publishedFiles);
      expect(resolveReportGenerationStateForProfile("lotListing", finalized, finalized?.preview_files))
        .toMatchObject({ generation_state: "ready", files_ready: true });
    }
  );

  it("stages every artifact, promotes immutable keys under a token lease, and finalizes atomically", async () => {
    const generationToken = "lot-publish-generation";
    const listing = await createPublishingListing(generationToken);

    const result = await stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken,
      artifacts,
      finalizeSet: {
        status: "approved",
        job_status: "done",
        files_generating: false,
        files_regenerating: false,
        preview_files: {
          excel: "https://assetinsight.test/lot-listings/LOT-PUBLISH-100.xlsx",
          images: "https://assetinsight.test/lot-listings/LOT-PUBLISH-100-images.zip",
        },
      },
      finalizeUnset: ["job_error"],
    });

    expect(result.published).toBe(true);
    expect(r2Mocks.uploadBufferToR2).toHaveBeenCalledTimes(2);
    const stagedKeys = r2Mocks.uploadBufferToR2.mock.calls.map((call) => call[3]);
    expect(stagedKeys.every((key) =>
      String(key).startsWith(
        `lot-listings/.staging/${String(listing._id)}/${generationToken}/`
      )
    )).toBe(true);
    expect(r2Mocks.copyR2Object.mock.calls.map((call) => call.slice(1))).toEqual([
      [stagedKeys[0], artifacts[0].key],
      [stagedKeys[1], artifacts[1].key],
    ]);
    expect(r2Mocks.deleteFromR2.mock.calls.map((call) => call[1])).toEqual(
      stagedKeys
    );

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      job_id: generationToken,
      job_status: "done",
      status: "approved",
      files_generating: false,
    });
    expect(persisted.artifact_publish_token).toBeUndefined();
    expect(persisted.artifact_publish_expires_at).toBeUndefined();
    expect(persisted.artifact_repair_required).toBeUndefined();
  });

  it("holds a live publication lease that blocks a competing workflow claim", async () => {
    const generationToken = "lot-publish-live-lease";
    const listing = await createPublishingListing(generationToken);
    let releaseCopy!: () => void;
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    r2Mocks.copyR2Object.mockImplementationOnce(() => copyGate);

    const publishing = stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken,
      artifacts,
      finalizeSet: {
        status: "approved",
        job_status: "done",
        files_generating: false,
      },
    });
    await vi.waitFor(() => {
      expect(r2Mocks.copyR2Object).toHaveBeenCalledTimes(1);
    });

    const locked: any = await LotListing.findById(listing._id).lean();
    expect(isLotListingArtifactPublicationLive(locked)).toBe(true);
    const competingClaim = await LotListing.findOneAndUpdate(
      {
        _id: listing._id,
        ...lotListingArtifactPublicationAvailableCondition(),
      },
      { $set: { job_id: "newer-generation" } },
      { returnDocument: "after" }
    );
    expect(competingClaim).toBeNull();

    releaseCopy();
    expect((await publishing).published).toBe(true);
  });

  it("never promotes staged bytes when generation ownership changed", async () => {
    const listing = await createPublishingListing("newer-generation");

    const result = await stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken: "stale-generation",
      artifacts,
      finalizeSet: { status: "approved", job_status: "done" },
    });

    expect(result).toMatchObject({
      published: false,
      reason: "generation-changed",
    });
    expect(r2Mocks.copyR2Object).not.toHaveBeenCalled();
    expect(r2Mocks.deleteFromR2).toHaveBeenCalledTimes(2);
    expect((await LotListing.findById(listing._id).lean())?.job_id).toBe(
      "newer-generation"
    );
  });

  it("cleans staging keys and leaves an explicit repair barrier after a copy failure", async () => {
    const generationToken = "lot-publish-copy-failure";
    const listing = await createPublishingListing(generationToken);
    r2Mocks.copyR2Object.mockRejectedValueOnce(new Error("R2 copy unavailable"));

    await expect(
      stageAndPublishLotListingArtifacts({
        reportId: String(listing._id),
        generationToken,
        artifacts,
        finalizeSet: { status: "approved", job_status: "done" },
      })
    ).rejects.toThrow("R2 copy unavailable");

    expect(r2Mocks.deleteFromR2).toHaveBeenCalledTimes(2);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      job_id: generationToken,
      job_status: "processing",
      artifact_repair_required: true,
    });
    expect(persisted.artifact_publish_token).toBeUndefined();
    expect(persisted.artifact_publish_expires_at).toBeUndefined();
  });

  it("does not regress a published report when staging cleanup is unavailable", async () => {
    const generationToken = "lot-publish-cleanup-outage";
    const listing = await createPublishingListing(generationToken);
    r2Mocks.deleteFromR2.mockRejectedValue(new Error("R2 delete unavailable"));

    const result = await stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken,
      artifacts,
      finalizeSet: {
        status: "approved",
        job_status: "done",
        files_generating: false,
      },
    });

    expect(result.published).toBe(true);
    expect(r2Mocks.deleteFromR2).toHaveBeenCalledTimes(artifacts.length);
    expect(await LotListing.findById(listing._id).lean()).toMatchObject({
      status: "approved",
      job_status: "done",
      files_generating: false,
    });
  });

  it("lets only the reclaimed execution promote immutable keys for one logical generation", async () => {
    const generationToken = "lot-publish-reclaimed-generation";
    const firstExecution = "execution-one";
    const secondExecution = "execution-two";
    const listing = await createPublishingListing(
      generationToken,
      firstExecution
    );
    let releaseFirstUpload!: () => void;
    const firstUploadGate = new Promise<void>((resolve) => {
      releaseFirstUpload = resolve;
    });
    r2Mocks.uploadBufferToR2.mockImplementationOnce(
      async (_buffer: Buffer, _contentType: string, _bucket: string, key: string) => {
        await firstUploadGate;
        return `https://assetinsight.test/${key}`;
      }
    );

    const staleAttempt = stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken,
      executionToken: firstExecution,
      assertOwned: vi.fn().mockResolvedValue(undefined),
      artifacts,
      finalizeSet: { status: "approved", job_status: "done" },
    });
    await vi.waitFor(() => {
      expect(r2Mocks.uploadBufferToR2).toHaveBeenCalled();
    });

    await LotListing.updateOne(
      { _id: listing._id, job_execution_token: firstExecution },
      { $set: { job_execution_token: secondExecution } }
    );
    releaseFirstUpload();

    await expect(staleAttempt).resolves.toMatchObject({
      published: false,
      reason: "execution-changed",
    });
    expect(r2Mocks.copyR2Object).not.toHaveBeenCalled();

    const winner = await stageAndPublishLotListingArtifacts({
      reportId: String(listing._id),
      generationToken,
      executionToken: secondExecution,
      assertOwned: vi.fn().mockResolvedValue(undefined),
      artifacts,
      finalizeSet: { status: "approved", job_status: "done" },
      finalizeUnset: ["job_execution_token"],
    });

    expect(winner.published).toBe(true);
    expect(r2Mocks.copyR2Object).toHaveBeenCalledTimes(artifacts.length);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      status: "approved",
      job_status: "done",
      job_id: generationToken,
    });
    expect(persisted.job_execution_token).toBeUndefined();
  });

  it("ignores stale progress after a second execution claims the report", async () => {
    const generationToken = "lot-progress-reclaimed-generation";
    const listing = await createPublishingListing(
      generationToken,
      "execution-two"
    );

    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: String(listing._id),
      generationToken,
      executionToken: "execution-one",
      stage: "generating_files",
      progressPercent: 80,
      message: "stale attempt",
    });
    await setReportGenerationProgress({
      kind: "lotListing",
      reportId: String(listing._id),
      generationToken,
      executionToken: "execution-two",
      stage: "generating_files",
      progressPercent: 25,
      message: "winning attempt",
    });

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.generation_progress).toMatchObject({
      progressPercent: 25,
      message: "winning attempt",
    });
  });
});
