import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import {
  getSmartUploadLimitViolation,
  SMART_UPLOAD_MAX_FILE_BYTES,
  SMART_UPLOAD_MAX_FILE_COUNT,
  SMART_UPLOAD_MAX_TOTAL_BYTES,
} from "../src/utils/smartUploadLimits.js";

const manifestFile = (index: number, size: number) => ({
  fileId: `images-${index}`,
  originalname: `image-${index}.jpg`,
  size,
});

describe("Smart Upload admission limits", () => {
  it("supports a 5,000-image direct-to-R2 batch without increasing byte limits", () => {
    expect(SMART_UPLOAD_MAX_FILE_COUNT).toBe(5_000);
    expect(SMART_UPLOAD_MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(SMART_UPLOAD_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024 * 1024);
  });

  it.each([4_999, 5_000])("accepts %i images within the aggregate byte limit", (count) => {
    const files = Array.from({ length: count }, (_, index) =>
      manifestFile(index, 4 * 1024 * 1024)
    );
    expect(getSmartUploadLimitViolation(files)).toBeNull();
  });

  it("still rejects 5,000 individually valid images above the total byte limit", () => {
    const files = Array.from({ length: 5_000 }, (_, index) =>
      manifestFile(index, 5 * 1024 * 1024)
    );
    expect(getSmartUploadLimitViolation(files)).toMatchObject({
      statusCode: 413,
      code: "SMART_UPLOAD_TOTAL_SIZE_LIMIT",
      data: { maxTotalBytes: SMART_UPLOAD_MAX_TOTAL_BYTES },
    });
  });

  it("accepts the file-count and per-file boundaries", () => {
    const files = Array.from(
      { length: SMART_UPLOAD_MAX_FILE_COUNT },
      (_, index) => manifestFile(index, 1)
    );
    files[0].size = SMART_UPLOAD_MAX_FILE_BYTES;

    expect(getSmartUploadLimitViolation(files)).toBeNull();
  });

  it("accepts the aggregate byte boundary", () => {
    const fullFiles = Math.floor(
      SMART_UPLOAD_MAX_TOTAL_BYTES / SMART_UPLOAD_MAX_FILE_BYTES
    );
    const files = Array.from({ length: fullFiles }, (_, index) =>
      manifestFile(index, SMART_UPLOAD_MAX_FILE_BYTES)
    );
    files.push(
      manifestFile(
        fullFiles,
        SMART_UPLOAD_MAX_TOTAL_BYTES -
          fullFiles * SMART_UPLOAD_MAX_FILE_BYTES
      )
    );

    expect(getSmartUploadLimitViolation(files)).toBeNull();
  });

  it("rejects a manifest above the image-count limit", () => {
    const files = Array.from(
      { length: SMART_UPLOAD_MAX_FILE_COUNT + 1 },
      (_, index) => manifestFile(index, 1)
    );

    expect(getSmartUploadLimitViolation(files)).toMatchObject({
      statusCode: 413,
      code: "SMART_UPLOAD_FILE_COUNT_LIMIT",
      message: "Smart Upload accepts up to 5,000 images per report. Split this selection into separate reports.",
      data: {
        actualFileCount: 5_001,
        maxFileCount: 5_000,
      },
    });
  });

  it("keeps a realistic 5,000-image compact persisted manifest well below the BSON limit", () => {
    // Pure in-memory fixture: no database connection, image bytes, R2 or providers.
    // Long filenames and Mongoose subdocument IDs are included. This establishes
    // realistic capacity, not a blanket size guarantee for arbitrary Mixed details.
    const files = Array.from({ length: 5_000 }, (_, index) => {
      const fileId = `images-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const originalname = `${"photo-".repeat(40)}${String(index).padStart(5, "0")}.jpg`;
      return {
        ...manifestFile(index, 4 * 1024 * 1024),
        fileId,
        originalname,
        key: `uploads/report-sessions/lotListing/00000000-0000-4000-8000-000000000001/${String(index + 1).padStart(5, "0")}-${fileId}-${originalname}`,
        fieldname: "images",
        mimetype: "image/jpeg",
        lastModified: 1_789_000_000_000,
        captureTimestamp: 1_789_000_000_000 + index * 1000,
        captureOrder: index,
        originalOrder: index,
        imageIndex: index % 200,
        lotIndex: Math.floor(index / 200),
        role: "main",
        uploadedAt: new Date("2026-09-10T00:00:00Z"),
        verifiedSize: 4 * 1024 * 1024,
      };
    });
    const session = new ReportUploadSession({
      type: "lotListing", status: "uploading", user: new mongoose.Types.ObjectId(),
      jobId: "fixture-job", clientSubmissionId: "fixture-submission", smartUpload: true,
      r2Bucket: "asset-insight", r2PublicBaseUrl: "https://assetinsight.pro",
      expectedFileCount: files.length, expectedImageCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      details: { smart_upload: true, client_name: "Synthetic sizing fixture", contract_no: "QA-5000" },
      files,
      smartGrouping: {
        status: "review_ready", progressPercent: 100, revision: 1,
        classificationJobId: "fixture-classification", dividerFileIds: [], warnings: [],
        groups: Array.from({ length: 25 }, (_, groupIndex) => ({
          groupIndex, imageCount: 200, overLimit: false,
          fileIds: files.slice(groupIndex * 200, (groupIndex + 1) * 200).map((file) => file.fileId),
          coverFileId: files[groupIndex * 200].fileId,
        })),
        metrics: files.map((file) => ({
          fileId: file.fileId, meanLuminance: 150, darkPixelRatio: 0.01,
          variance: 1000, isDivider: false,
        })),
      },
    });
    expect(session.files).toHaveLength(5_000);
    const bytes = mongoose.mongo.BSON.calculateObjectSize(session.toObject());
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeLessThan(8 * 1024 * 1024); // At least half of Mongo's 16 MiB remains.
  });

  it("requires every image to declare a positive integer size", () => {
    expect(
      getSmartUploadLimitViolation([manifestFile(0, 0)])
    ).toMatchObject({
      statusCode: 400,
      code: "SMART_UPLOAD_INVALID_FILE_SIZE",
    });
    expect(
      getSmartUploadLimitViolation([manifestFile(0, Number.NaN)])
    ).toMatchObject({
      statusCode: 400,
      code: "SMART_UPLOAD_INVALID_FILE_SIZE",
    });
  });

  it("rejects an image above the per-file byte limit", () => {
    expect(
      getSmartUploadLimitViolation([
        manifestFile(0, SMART_UPLOAD_MAX_FILE_BYTES + 1),
      ])
    ).toMatchObject({
      statusCode: 413,
      code: "SMART_UPLOAD_FILE_SIZE_LIMIT",
      data: { maxFileBytes: SMART_UPLOAD_MAX_FILE_BYTES },
    });
  });

  it("rejects an aggregate above the report byte limit", () => {
    const fullFiles = Math.floor(
      SMART_UPLOAD_MAX_TOTAL_BYTES / SMART_UPLOAD_MAX_FILE_BYTES
    );
    const files = Array.from({ length: fullFiles + 1 }, (_, index) =>
      manifestFile(index, SMART_UPLOAD_MAX_FILE_BYTES)
    );

    expect(getSmartUploadLimitViolation(files)).toMatchObject({
      statusCode: 413,
      code: "SMART_UPLOAD_TOTAL_SIZE_LIMIT",
      data: { maxTotalBytes: SMART_UPLOAD_MAX_TOTAL_BYTES },
    });
  });
});
