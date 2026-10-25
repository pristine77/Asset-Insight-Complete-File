import { describe, expect, it } from "vitest";
import { SMART_UPLOAD_MAX_FILE_BYTES } from "../src/utils/smartUploadLimits.js";
import {
  getSmartUploadManifestImageViolation,
  getUploadSessionFileViolation,
  getUploadSessionPostTransferViolation,
} from "../src/utils/uploadSessionFileValidation.js";
import {
  getUploadSessionFallbackFileLimit,
  getUploadSessionFallbackParserLimit,
  REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES,
  REPORT_UPLOAD_FALLBACK_MAX_SAFE_FILE_BYTES,
} from "../src/utils/uploadSessionFileValidation.js";

const manifestImage = (size: number) => ({
  fieldname: "images",
  mimetype: "image/jpeg",
  originalname: "photo.jpg",
  size,
});

describe("upload-session fallback validation", () => {
  it("accepts only the supported Smart Upload manifest image families", () => {
    expect(
      getSmartUploadManifestImageViolation([
        { fieldname: "images", mimetype: "image/jpeg", originalname: "a.jpg" },
        { fieldname: "images", mimetype: "image/png", originalname: "b.png" },
        { fieldname: "images", mimetype: "image/webp", originalname: "c.webp" },
        {
          fieldname: "images",
          mimetype: "application/octet-stream",
          originalname: "d.HEIC",
        },
        { fieldname: "images", mimetype: "image/heif", originalname: "e.heif" },
      ])
    ).toBeNull();
  });

  it("rejects unsupported and MIME-renamed Smart Upload manifest images", () => {
    expect(
      getSmartUploadManifestImageViolation([
        { fieldname: "images", mimetype: "image/gif", originalname: "photo.gif" },
      ])
    ).toMatchObject({
      statusCode: 415,
      code: "SMART_UPLOAD_UNSUPPORTED_IMAGE",
      data: { fileIndex: 0, fileName: "photo.gif", mimeType: "image/gif" },
    });
    expect(
      getSmartUploadManifestImageViolation([
        { fieldname: "images", mimetype: "image/jpeg", originalname: "photo.png" },
      ])
    ).toMatchObject({
      statusCode: 415,
      code: "SMART_UPLOAD_UNSUPPORTED_IMAGE",
    });
  });

  it("uses Smart Upload's cap but preserves declared ordinary video sizes", () => {
    expect(
      getUploadSessionFallbackFileLimit({
        smartUpload: true,
        declaredBytes: 500 * 1024 * 1024,
      })
    ).toBe(SMART_UPLOAD_MAX_FILE_BYTES);
    expect(
      getUploadSessionFallbackFileLimit({
        smartUpload: false,
        declaredBytes: 500 * 1024 * 1024,
      })
    ).toBe(500 * 1024 * 1024);
    expect(
      getUploadSessionFallbackFileLimit({
        smartUpload: false,
        declaredBytes: REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES + 1,
      })
    ).toBe(REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES);
  });

  it("sets the inclusive multipart parser limit one byte above both allowed boundaries", () => {
    expect(
      getUploadSessionFallbackParserLimit(SMART_UPLOAD_MAX_FILE_BYTES)
    ).toBe(SMART_UPLOAD_MAX_FILE_BYTES + 1);

    const ordinaryDeclaredBytes = 500 * 1024 * 1024;
    expect(
      getUploadSessionFallbackParserLimit(ordinaryDeclaredBytes)
    ).toBe(ordinaryDeclaredBytes + 1);
    expect(
      getUploadSessionFallbackParserLimit(Number.MAX_SAFE_INTEGER)
    ).toBe(REPORT_UPLOAD_FALLBACK_MAX_SAFE_FILE_BYTES + 1);
  });

  it("accepts a Smart Upload image that exactly matches its manifest", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: manifestImage(1_024),
        multipartFile: {
          mimetype: "image/jpeg",
          originalname: "photo.jpg",
          size: 1_024,
        },
      })
    ).toBeNull();
  });

  it("rejects a body whose byte size differs from the manifest", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: manifestImage(1_024),
        multipartFile: {
          mimetype: "image/jpeg",
          originalname: "photo.jpg",
          size: 1_025,
        },
      })
    ).toMatchObject({
      statusCode: 400,
      code: "UPLOAD_FILE_SIZE_MISMATCH",
      data: { actualBytes: 1_025, expectedBytes: 1_024 },
    });
  });

  it("rejects oversized bodies even if middleware is bypassed", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: manifestImage(SMART_UPLOAD_MAX_FILE_BYTES + 1),
        multipartFile: {
          mimetype: "image/jpeg",
          originalname: "photo.jpg",
          size: SMART_UPLOAD_MAX_FILE_BYTES + 1,
        },
      })
    ).toMatchObject({
      statusCode: 413,
      code: "SMART_UPLOAD_FILE_SIZE_LIMIT",
    });
  });

  it("enforces the Smart Upload image MIME contract", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: manifestImage(1_024),
        multipartFile: { mimetype: "application/octet-stream", size: 1_024 },
      })
    ).toMatchObject({
      statusCode: 415,
      code: "SMART_UPLOAD_IMAGE_REQUIRED",
    });
  });

  it("accepts HEIC selected with a generic browser MIME by extension", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: {
          fieldname: "images",
          mimetype: "application/octet-stream",
          originalname: "IMG_1001.HEIC",
          size: 1_024,
        },
        multipartFile: {
          mimetype: "application/octet-stream",
          originalname: "IMG_1001.HEIC",
          size: 1_024,
        },
      })
    ).toBeNull();
  });

  it("accepts equivalent HEIC and HEIF extensions but rejects a renamed image family", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: {
          fieldname: "images",
          mimetype: "application/octet-stream",
          originalname: "IMG_1001.HEIC",
          size: 1_024,
        },
        multipartFile: {
          mimetype: "",
          originalname: "IMG_1001.HEIF",
          size: 1_024,
        },
      })
    ).toBeNull();
    expect(
      getUploadSessionFileViolation({
        smartUpload: true,
        manifestFile: {
          fieldname: "images",
          mimetype: "application/octet-stream",
          originalname: "IMG_1001.HEIC",
          size: 1_024,
        },
        multipartFile: {
          mimetype: "application/octet-stream",
          originalname: "IMG_1001.JPG",
          size: 1_024,
        },
      })
    ).toMatchObject({
      statusCode: 415,
      code: "SMART_UPLOAD_MIME_MISMATCH",
    });
  });

  it("preserves legacy non-Smart sessions without declared size metadata", () => {
    expect(
      getUploadSessionFileViolation({
        smartUpload: false,
        manifestFile: { fieldname: "videos", mimetype: "video/mp4" },
        multipartFile: { mimetype: "video/mp4", size: 1_024 },
      })
    ).toBeNull();
  });

  it("blocks a fallback transfer if completion claimed the session", () => {
    const startedAt = new Date("2026-08-13T10:00:00.000Z");
    expect(
      getUploadSessionPostTransferViolation({
        initialStatus: "uploading",
        latestStatus: "completed",
        initialUpdatedAt: startedAt,
        latestUpdatedAt: new Date(startedAt.getTime() + 1),
      })
    ).toMatchObject({ statusCode: 409, code: "UPLOAD_SESSION_LOCKED" });
  });

  it("allows parallel files to update the session timestamp", () => {
    const startedAt = new Date("2026-08-13T10:00:00.000Z");
    expect(
      getUploadSessionPostTransferViolation({
        initialStatus: "uploading",
        latestStatus: "uploading",
        initialUpdatedAt: startedAt,
        latestUpdatedAt: new Date(startedAt.getTime() + 5_000),
      })
    ).toBeNull();
  });

  it("blocks a fallback transfer if divider detection claimed the files", () => {
    const startedAt = new Date("2026-08-13T10:00:00.000Z");
    expect(
      getUploadSessionPostTransferViolation({
        initialStatus: "uploading",
        latestStatus: "uploading",
        initialUpdatedAt: startedAt,
        latestUpdatedAt: startedAt,
        smartUpload: true,
        latestSmartGroupingStatus: "classifying",
      })
    ).toMatchObject({ statusCode: 409, code: "UPLOAD_SESSION_LOCKED" });
  });
});
