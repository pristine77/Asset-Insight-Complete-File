// Smart Upload sends image bytes directly to R2 in bounded pages; Mongo only
// stores the compact manifest and classifier metrics. Five thousand compact
// entries fit within the document limit (see the BSON sizing regression fixture);
// local browser recovery stays best-effort and never gates a server-backed session.
export const SMART_UPLOAD_MAX_FILE_COUNT = 5_000;
export const SMART_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SMART_UPLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

type SmartUploadManifestFile = {
  fileId?: string;
  originalname?: string;
  size?: number;
};

export type SmartUploadLimitViolation = {
  statusCode: 400 | 413;
  code:
    | "SMART_UPLOAD_INVALID_FILE_SIZE"
    | "SMART_UPLOAD_FILE_COUNT_LIMIT"
    | "SMART_UPLOAD_FILE_SIZE_LIMIT"
    | "SMART_UPLOAD_TOTAL_SIZE_LIMIT";
  message: string;
  data: Record<string, number | string>;
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
};

/**
 * Admission control for Smart Upload manifests. This must run before a Mongo
 * session, R2 key, or presigned URL is created. File sizes are required and
 * bounded because client-declared metadata otherwise permits unbounded upload
 * sessions; storage verification still checks the resulting object size.
 */
export function getSmartUploadLimitViolation(
  files: SmartUploadManifestFile[]
): SmartUploadLimitViolation | null {
  if (files.length > SMART_UPLOAD_MAX_FILE_COUNT) {
    return {
      statusCode: 413,
      code: "SMART_UPLOAD_FILE_COUNT_LIMIT",
      message: `Smart Upload accepts up to ${SMART_UPLOAD_MAX_FILE_COUNT.toLocaleString("en-US")} images per report. Split this selection into separate reports.`,
      data: {
        actualFileCount: files.length,
        maxFileCount: SMART_UPLOAD_MAX_FILE_COUNT,
      },
    };
  }

  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    const size = Number(file.size);
    const fileName = String(
      file.originalname || file.fileId || `image ${index + 1}`
    );
    if (!Number.isSafeInteger(size) || size <= 0) {
      return {
        statusCode: 400,
        code: "SMART_UPLOAD_INVALID_FILE_SIZE",
        message: `${fileName} does not include a valid file size. Re-select the images and try again.`,
        data: {
          fileId: String(file.fileId || ""),
          fileIndex: index,
        },
      };
    }
    if (size > SMART_UPLOAD_MAX_FILE_BYTES) {
      return {
        statusCode: 413,
        code: "SMART_UPLOAD_FILE_SIZE_LIMIT",
        message: `${fileName} is ${formatBytes(size)}. Each Smart Upload image must be ${formatBytes(SMART_UPLOAD_MAX_FILE_BYTES)} or smaller.`,
        data: {
          actualBytes: size,
          fileId: String(file.fileId || ""),
          fileIndex: index,
          maxFileBytes: SMART_UPLOAD_MAX_FILE_BYTES,
        },
      };
    }

    totalBytes += size;
  }

  if (totalBytes > SMART_UPLOAD_MAX_TOTAL_BYTES) {
    return {
      statusCode: 413,
      code: "SMART_UPLOAD_TOTAL_SIZE_LIMIT",
      message: `This Smart Upload is ${formatBytes(totalBytes)}. A report can contain up to ${formatBytes(SMART_UPLOAD_MAX_TOTAL_BYTES)} of images. Reduce the selection or split it into separate reports.`,
      data: {
        actualTotalBytes: totalBytes,
        maxTotalBytes: SMART_UPLOAD_MAX_TOTAL_BYTES,
      },
    };
  }

  return null;
}
