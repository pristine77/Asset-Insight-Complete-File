import { SMART_UPLOAD_MAX_FILE_BYTES } from "./smartUploadLimits.js";

type UploadSessionManifestFile = {
  fieldname?: unknown;
  mimetype?: unknown;
  originalname?: unknown;
  size?: unknown;
};

type MultipartFile = {
  mimetype?: unknown;
  originalname?: unknown;
  size?: unknown;
};

export type UploadSessionFileViolation = {
  statusCode: 400 | 409 | 413 | 415;
  code:
    | "INVALID_UPLOAD_FILE_SIZE"
    | "UPLOAD_FILE_SIZE_MISMATCH"
    | "SMART_UPLOAD_FILE_SIZE_LIMIT"
    | "SMART_UPLOAD_UNSUPPORTED_IMAGE"
    | "SMART_UPLOAD_IMAGE_REQUIRED"
    | "SMART_UPLOAD_MIME_MISMATCH"
    | "UPLOAD_SESSION_LOCKED";
  message: string;
  data?: Record<string, number | string>;
};

export const REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES =
  2 * 1024 * 1024 * 1024;
// Reserve one exactly representable byte above the admitted size for Busboy's
// inclusive fileSize sentinel. The controller still enforces exact manifest
// equality after parsing.
export const REPORT_UPLOAD_FALLBACK_MAX_SAFE_FILE_BYTES =
  Number.MAX_SAFE_INTEGER - 1;

export function getUploadSessionFallbackFileLimit(args: {
  smartUpload: boolean;
  declaredBytes?: unknown;
  ordinaryGlobalMaxBytes?: unknown;
}): number {
  if (args.smartUpload) return SMART_UPLOAD_MAX_FILE_BYTES;

  const configuredGlobalMax = Number(args.ordinaryGlobalMaxBytes);
  const globalMax =
    Number.isSafeInteger(configuredGlobalMax) && configuredGlobalMax > 0
      ? Math.min(
          configuredGlobalMax,
          REPORT_UPLOAD_FALLBACK_MAX_SAFE_FILE_BYTES
        )
      : REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES;
  const declaredBytes = Number(args.declaredBytes);
  return Number.isSafeInteger(declaredBytes) && declaredBytes > 0
    ? Math.min(declaredBytes, globalMax)
    : globalMax;
}

/**
 * Busboy reports LIMIT_FILE_SIZE when the stream reaches its configured
 * threshold, including an exactly equal file. Give the multipart parser one
 * sentinel byte beyond the admitted maximum; post-parse validation remains
 * authoritative and rejects anything other than the exact manifest size.
 */
export function getUploadSessionFallbackParserLimit(
  allowedMaxBytes: unknown
): number {
  const parsed = Number(allowedMaxBytes);
  const bounded =
    Number.isSafeInteger(parsed) && parsed > 0
      ? Math.min(parsed, REPORT_UPLOAD_FALLBACK_MAX_SAFE_FILE_BYTES)
      : REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES;
  return bounded + 1;
}

const normalizedMime = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

const supportedImageExtension = (value: unknown): string | undefined => {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/\.(jpe?g|png|webp|heic|heif)$/);
  if (match?.[1] === "jpg" || match?.[1] === "jpeg") return "jpeg";
  if (match?.[1] === "heic" || match?.[1] === "heif") return "heif";
  return match?.[1];
};

const genericMime = (value: string): boolean =>
  !value || value === "application/octet-stream";

const supportedImageMimeFamily = (value: string): string | undefined => {
  if (value === "image/jpeg" || value === "image/jpg") return "jpeg";
  if (value === "image/png") return "png";
  if (value === "image/webp") return "webp";
  if (
    ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(
      value
    )
  ) {
    return "heif";
  }
  return undefined;
};

export function getSmartUploadManifestImageViolation(
  files: UploadSessionManifestFile[]
): UploadSessionFileViolation | null {
  for (const [index, file] of files.entries()) {
    const extensionFamily = supportedImageExtension(file.originalname);
    const mime = normalizedMime(file.mimetype);
    const mimeFamily = genericMime(mime)
      ? extensionFamily
      : supportedImageMimeFamily(mime);
    if (
      file.fieldname !== "images" ||
      !extensionFamily ||
      !mimeFamily ||
      mimeFamily !== extensionFamily
    ) {
      return {
        statusCode: 415,
        code: "SMART_UPLOAD_UNSUPPORTED_IMAGE",
        message:
          "Smart Upload accepts JPEG, PNG, WebP, HEIC, and HEIF images only.",
        data: {
          fileIndex: index,
          fileName: String(file.originalname || `image-${index + 1}`),
          mimeType: mime || "application/octet-stream",
        },
      };
    }
  }
  return null;
}

/** Validate the multipart body against the durable manifest before R2 write. */
export function getUploadSessionFileViolation(args: {
  smartUpload: boolean;
  manifestFile: UploadSessionManifestFile;
  multipartFile: MultipartFile;
}): UploadSessionFileViolation | null {
  const actualBytes = Number(args.multipartFile.size);
  if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0) {
    return {
      statusCode: 400,
      code: "INVALID_UPLOAD_FILE_SIZE",
      message: "The fallback upload did not contain a valid file size.",
    };
  }
  if (args.smartUpload && actualBytes > SMART_UPLOAD_MAX_FILE_BYTES) {
    return {
      statusCode: 413,
      code: "SMART_UPLOAD_FILE_SIZE_LIMIT",
      message: "Fallback uploads must be 50 MiB or smaller.",
      data: { actualBytes, maxFileBytes: SMART_UPLOAD_MAX_FILE_BYTES },
    };
  }

  const expectedBytes = Number(args.manifestFile.size);
  const hasExpectedBytes = Number.isSafeInteger(expectedBytes) && expectedBytes > 0;
  if (args.smartUpload && !hasExpectedBytes) {
    return {
      statusCode: 400,
      code: "INVALID_UPLOAD_FILE_SIZE",
      message: "This Smart Upload file has no valid size in its manifest.",
    };
  }
  // Legacy non-Smart sessions did not always persist a declared size. Preserve
  // those resumes, but enforce exact equality whenever the manifest has one.
  if (hasExpectedBytes && actualBytes !== expectedBytes) {
    return {
      statusCode: 400,
      code: "UPLOAD_FILE_SIZE_MISMATCH",
      message:
        "The fallback upload size does not match the file selected for this session.",
      data: { actualBytes, expectedBytes },
    };
  }

  if (!args.smartUpload) return null;

  const expectedMime = normalizedMime(args.manifestFile.mimetype);
  const receivedMime = normalizedMime(args.multipartFile.mimetype);
  const expectedExtension = supportedImageExtension(
    args.manifestFile.originalname
  );
  const receivedExtension = supportedImageExtension(
    args.multipartFile.originalname
  );
  const expectedMimeFamily = genericMime(expectedMime)
    ? expectedExtension
    : supportedImageMimeFamily(expectedMime);
  const receivedMimeFamily = genericMime(receivedMime)
    ? receivedExtension
    : supportedImageMimeFamily(receivedMime);
  if (
    args.manifestFile.fieldname !== "images" ||
    !expectedExtension ||
    expectedMimeFamily !== expectedExtension ||
    !receivedExtension ||
    receivedMimeFamily !== receivedExtension
  ) {
    return {
      statusCode: 415,
      code: "SMART_UPLOAD_IMAGE_REQUIRED",
      message: "Smart Upload fallback accepts image files only.",
    };
  }
  if (
    !genericMime(expectedMime) &&
    !genericMime(receivedMime) &&
    receivedMimeFamily !== expectedMimeFamily
  ) {
    return {
      statusCode: 415,
      code: "SMART_UPLOAD_MIME_MISMATCH",
      message:
        "The fallback upload type does not match the image selected for this session.",
      data: { expectedMime, receivedMime },
    };
  }
  // The multipart filename must still identify the same supported image
  // family when either browser omits a useful MIME (common for HEIC/HEIF).
  // This prevents a generic octet-stream body from bypassing the manifest
  // contract merely because both filenames have some image-looking suffix.
  if (expectedExtension !== receivedExtension) {
    return {
      statusCode: 415,
      code: "SMART_UPLOAD_MIME_MISMATCH",
      message:
        "The fallback upload type does not match the image selected for this session.",
      data: {
        expectedMime: expectedExtension,
        receivedMime: receivedExtension,
      },
    };
  }

  return null;
}

export function getUploadSessionPostTransferViolation(args: {
  initialStatus: unknown;
  latestStatus: unknown;
  initialUpdatedAt: unknown;
  latestUpdatedAt: unknown;
  smartUpload?: boolean;
  latestSmartGroupingStatus?: unknown;
  cleanupStartedAt?: unknown;
}): UploadSessionFileViolation | null {
  // `updatedAt` is session-wide. Parallel photo uploads legitimately change it
  // as each independent manifest entry is accepted, so it cannot be used as a
  // file-transfer lock. Completion, cleanup, and Smart Upload classification
  // are the actual ownership boundaries; the controller's atomic per-file
  // update protects against two attempts claiming the same manifest entry.
  const locked =
    ["completed", "queued", "processed"].includes(
      String(args.latestStatus || "")
    ) ||
    Boolean(args.cleanupStartedAt) ||
    (args.smartUpload === true &&
      String(args.latestSmartGroupingStatus || "") !== "uploading");
  if (!locked) return null;
  return {
    statusCode: 409,
    code: "UPLOAD_SESSION_LOCKED",
    message:
      "This upload session changed or was submitted while the file was uploading.",
  };
}
