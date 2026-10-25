import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import {
  cleanupStaleReportJobTempFiles,
  getReportJobTempStats,
} from "../src/utils/reportJobTempMaintenance.js";

let mongo: MongoMemoryServer;
const originalMaxAge = process.env.REPORT_JOB_TEMP_MAX_AGE_HOURS;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  process.env.REPORT_JOB_TEMP_MAX_AGE_HOURS = "1";
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalMaxAge === undefined) {
    delete process.env.REPORT_JOB_TEMP_MAX_AGE_HOURS;
  } else {
    process.env.REPORT_JOB_TEMP_MAX_AGE_HOURS = originalMaxAge;
  }
});

describe.sequential("report job temp maintenance", () => {
  it("retains source files referenced only by an embedded report-job outbox", async () => {
    const originalCwd = process.cwd();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "report-outbox-temp-"));
    const uploadDirectory = path.join(workspace, "uploads", "report-jobs");
    const sourcePath = path.join(uploadDirectory, "pending.jpg");
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(sourcePath, "pending source");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(sourcePath, old, old);

    try {
      process.chdir(workspace);
      const reportId = new mongoose.Types.ObjectId();
      const report = await AssetReport.create({
        _id: reportId,
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "mixed",
        imageUrls: [],
        lots: [],
        status: "processing",
        job_id: "outbox-preview",
        job_status: "queued",
        report_job_outbox: {
          token: "outbox-token",
          type: "asset-preview",
          reportId: reportId.toString(),
          progressId: "outbox-preview",
          idempotencyKey: "asset-preview:outbox-preview",
          createdAt: new Date(),
          payload: { images: [{ path: sourcePath }], videos: [] },
        },
      });
      expect(
        await AssetReport.findOne({
          "report_job_outbox.token": { $type: "string" },
        })
          .select("+report_job_outbox")
          .lean()
      ).toHaveProperty("report_job_outbox.payload.images.0.path", sourcePath);
      await expect(getReportJobTempStats()).resolves.toMatchObject({
        activeReferencedFiles: 1,
      });
      expect(
        await AssetReport.findById(report._id)
          .select("+report_job_outbox")
          .lean()
      ).toHaveProperty("report_job_outbox.payload.images.0.path", sourcePath);
      await expect(cleanupStaleReportJobTempFiles()).resolves.toMatchObject({
        removed: 0,
        skippedActive: 1,
      });
      await expect(access(sourcePath)).resolves.toBeUndefined();

      await AssetReport.updateOne(
        { _id: report._id },
        { $unset: { report_job_outbox: 1 } }
      );
      await expect(cleanupStaleReportJobTempFiles()).resolves.toMatchObject({
        removed: 1,
        skippedActive: 0,
      });
      await expect(access(sourcePath)).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
