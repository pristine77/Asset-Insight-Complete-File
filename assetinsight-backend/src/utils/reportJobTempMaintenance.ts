import fs from "fs/promises";
import path from "path";
import ReportJob from "../models/reportJob.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import SalvageReport from "../models/salvage.model.js";
import { getPositiveIntEnv } from "./concurrency.js";

export type ReportJobTempStats = {
  dir: string;
  exists: boolean;
  files: number;
  bytes: number;
  activeReferencedFiles: number;
};

const reportJobUploadDir = () =>
  path.resolve(process.cwd(), "uploads", "report-jobs");

async function getActiveReportJobTempPaths(): Promise<Set<string>> {
  const [activeJobs, assetOutboxes, lotListingOutboxes, salvageSources] = await Promise.all([
    ReportJob.find({
      status: { $in: ["queued", "processing"] },
      type: { $in: ["asset-preview", "lot-listing-preview"] },
    })
      .select("payload.images payload.videos")
      .lean(),
    AssetReport.find({
      "report_job_outbox.type": "asset-preview",
      "report_job_outbox.token": { $type: "string" },
    })
      .select("+report_job_outbox")
      .lean(),
    LotListing.find({
      "report_job_outbox.type": "lot-listing-preview",
      "report_job_outbox.token": { $type: "string" },
    })
      .select("+report_job_outbox")
      .lean(),
    // Keep failed uploads recoverable until their original-photo checkpoint exists.
    SalvageReport.find({ "source_files.0": { $exists: true } }).select("+source_files").lean(),
  ]);

  const active = new Set<string>();
  const payloadOwners = [
    ...(salvageSources as any[]).map(report => ({ images: report.source_files })),
    ...(activeJobs as any[]).map((job) => job?.payload),
    ...(assetOutboxes as any[]).map((report) => report?.report_job_outbox?.payload),
    ...(lotListingOutboxes as any[]).map(
      (report) => report?.report_job_outbox?.payload
    ),
  ];
  for (const payload of payloadOwners) {
    const files = [
      ...(Array.isArray(payload?.images) ? payload.images : []),
      ...(Array.isArray(payload?.videos) ? payload.videos : []),
    ];
    for (const file of files) {
      if (typeof file?.path === "string" && file.path) {
        const resolved = path.resolve(file.path);
        active.add(await fs.realpath(resolved).catch(() => resolved));
      }
    }
  }
  return active;
}

export async function getReportJobTempStats(): Promise<ReportJobTempStats> {
  const dir = reportJobUploadDir();
  const active = await getActiveReportJobTempPaths();
  let files = 0;
  let bytes = 0;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      files += 1;
      const stat = await fs.stat(path.join(dir, entry.name));
      bytes += stat.size;
    }
    return {
      dir,
      exists: true,
      files,
      bytes,
      activeReferencedFiles: active.size,
    };
  } catch {
    return {
      dir,
      exists: false,
      files: 0,
      bytes: 0,
      activeReferencedFiles: active.size,
    };
  }
}

export async function cleanupStaleReportJobTempFiles(): Promise<{
  scanned: number;
  removed: number;
  skippedActive: number;
  removedBytes: number;
}> {
  const dir = reportJobUploadDir();
  const active = await getActiveReportJobTempPaths();
  const maxAgeMs =
    getPositiveIntEnv("REPORT_JOB_TEMP_MAX_AGE_HOURS", 24) * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0;
  let removed = 0;
  let skippedActive = 0;
  let removedBytes = 0;

  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { scanned, removed, skippedActive, removedBytes };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.resolve(dir, entry.name);
    const canonicalFilePath = await fs.realpath(filePath).catch(() => filePath);
    scanned += 1;
    if (active.has(canonicalFilePath)) {
      skippedActive += 1;
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.rm(filePath, { force: true });
      removed += 1;
      removedBytes += stat.size;
    } catch {}
  }

  return { scanned, removed, skippedActive, removedBytes };
}

export function startReportJobTempMaintenance() {
  if (process.env.REPORT_JOB_TEMP_CLEANUP_ENABLED === "false") return;
  const intervalMs =
    getPositiveIntEnv("REPORT_JOB_TEMP_CLEANUP_INTERVAL_MINUTES", 60) *
    60 *
    1000;
  const run = async () => {
    try {
      const result = await cleanupStaleReportJobTempFiles();
      if (result.removed > 0) {
        console.log("[ReportTempCleanup]", result);
      }
    } catch (error) {
      console.error("[ReportTempCleanup] failed:", error);
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
}
