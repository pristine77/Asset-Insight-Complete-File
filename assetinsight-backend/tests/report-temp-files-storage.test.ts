import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const readObject = vi.hoisted(() => vi.fn(async () => Buffer.from("stored")));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return { ...actual, readR2ObjectBuffer: readObject };
});

import {
  cleanupReportJobSourceFiles,
  readMulterFileBuffer,
} from "../src/utils/reportTempFiles.js";

const originalEnvironment = {
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  R2_LEGACY_BUCKET_NAME: process.env.R2_LEGACY_BUCKET_NAME,
  R2_LEGACY_PUBLIC_URL: process.env.R2_LEGACY_PUBLIC_URL,
};

beforeEach(() => {
  process.env.R2_BUCKET_NAME = "asset-insight";
  process.env.R2_PUBLIC_URL = "https://assetinsight.pro";
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
  readObject.mockClear();
});

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("durable report source storage", () => {
  it("reads newly serialized files from their snapshotted current bucket", async () => {
    await readMulterFileBuffer({
      r2Key: "uploads/report-sessions/current.jpg",
      r2Bucket: "asset-insight",
    } as any);

    expect(readObject).toHaveBeenCalledWith(
      "asset-insight",
      "uploads/report-sessions/current.jpg"
    );
  });

  it("reads metadata-free queued files from the legacy bucket", async () => {
    await readMulterFileBuffer({
      r2Key: "uploads/report-sessions/legacy.jpg",
    } as any);

    expect(readObject).toHaveBeenCalledWith(
      "sellsnap",
      "uploads/report-sessions/legacy.jpg"
    );
  });

  it("deletes only regular files inside the report-job temp root", async () => {
    const originalCwd = process.cwd();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "report-job-cleanup-"));
    const ownedDirectory = path.join(workspace, "uploads", "report-jobs");
    const ownedFile = path.join(ownedDirectory, "owned.jpg");
    const outsideFile = path.join(workspace, "outside.jpg");
    const escapingLink = path.join(ownedDirectory, "outside-link.jpg");
    await mkdir(ownedDirectory, { recursive: true });
    await writeFile(ownedFile, "owned");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, escapingLink);

    try {
      process.chdir(workspace);
      await cleanupReportJobSourceFiles([
        { path: ownedFile } as Express.Multer.File,
        { path: outsideFile } as Express.Multer.File,
        { path: escapingLink } as Express.Multer.File,
      ]);

      await expect(access(ownedFile)).rejects.toThrow();
      await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
      await expect(access(escapingLink)).resolves.toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
