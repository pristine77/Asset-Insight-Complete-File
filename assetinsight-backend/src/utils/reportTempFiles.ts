import fs from "fs/promises";
import path from "path";
import {
  readR2ObjectBuffer,
  resolvePersistedR2StorageTarget,
} from "./r2Storage/r2Upload.js";

export async function readMulterFileBuffer(
  file: Express.Multer.File
): Promise<Buffer> {
  const anyFile = file as any;
  if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
    return anyFile.buffer as Buffer;
  }
  if (typeof anyFile?.r2Key === "string" && anyFile.r2Key) {
    const storageTarget = resolvePersistedR2StorageTarget({
      r2Bucket: anyFile.r2Bucket,
    });
    return readR2ObjectBuffer(
      storageTarget.bucketName,
      anyFile.r2Key
    );
  }
  if (typeof anyFile?.path === "string" && anyFile.path) {
    return fs.readFile(anyFile.path);
  }
  return Buffer.alloc(0);
}

export async function cleanupMulterFiles(
  files: Array<Express.Multer.File | undefined> | undefined
): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) return;

  await Promise.all(
    files.map(async (file) => {
      const filePath = (file as any)?.path;
      if (!filePath || typeof filePath !== "string") return;
      try {
        await fs.rm(filePath, { force: true });
      } catch {}
    })
  );
}

const reportJobUploadDirectory = () =>
  path.resolve(process.cwd(), "uploads", "report-jobs");

/**
 * Remove only server-created multipart inputs owned by the durable report
 * queue. Queue payloads are persisted data and must never become an arbitrary
 * local-path deletion primitive.
 */
export async function cleanupReportJobSourceFiles(
  files: Array<Express.Multer.File | undefined> | undefined
): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) return;

  const configuredRoot = reportJobUploadDirectory();
  const realRoot = await fs.realpath(configuredRoot).catch(() => configuredRoot);
  const rootPrefix = `${realRoot}${path.sep}`;
  await Promise.all(
    files.map(async (file) => {
      const rawPath = (file as any)?.path;
      if (!rawPath || typeof rawPath !== "string") return;
      const resolvedPath = path.resolve(rawPath);
      try {
        const realPath = await fs.realpath(resolvedPath);
        if (realPath !== realRoot && !realPath.startsWith(rootPrefix)) return;
        const stat = await fs.lstat(resolvedPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return;
        await fs.rm(realPath, { force: true });
      } catch {
        // Already removed, inaccessible, or no longer a regular owned file.
      }
    })
  );
}
