import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { getPositiveIntEnv, mapWithConcurrency } from "../../utils/concurrency.js";
import { readMulterFileBuffer } from "../../utils/reportTempFiles.js";
import {
  getR2PublicUrl,
  resolvePersistedR2StorageTarget,
  uploadBufferToR2,
  uploadFilePathToR2,
} from "../../utils/r2Storage/r2Upload.js";
import { buildOrderedLotVideoZipEntries } from "./imageNaming.js";

/** Capture encoding belongs to the camera. Uploads preserve the original clip. */
export async function uploadAssetPreviewVideos(
  videos: Express.Multer.File[],
  options: { reportId: string; generationToken: string; assertOwned?: () => Promise<void> },
): Promise<string[]> {
  const scope = createHash("sha256").update(`asset-video-v1\0${options.reportId}\0${options.generationToken}`).digest("hex").slice(0, 24);
  return mapWithConcurrency(videos, Math.min(4, getPositiveIntEnv("ASSET_VIDEO_UPLOAD_CONCURRENCY", 4)), async (file: any, index) => {
    await options.assertOwned?.();
    // These keys came from the verified upload/draft manifest. Never trust an
    // arbitrary public URL or copy an existing R2 original to another object.
    if (!file.buffer?.length && !file.path && typeof file.r2Key === "string" && file.r2Key) {
      return getR2PublicUrl(file.r2Key, resolvePersistedR2StorageTarget({ r2Bucket: file.r2Bucket }));
    }
    const extension = String(file.originalname || "").match(/\.(mp4|mov|m4v|webm|avi)$/i)?.[0].toLowerCase()
      || (file.mimetype === "video/quicktime" ? ".mov" : ".mp4");
    const contentType = file.mimetype || (extension === ".mov" ? "video/quicktime" : "video/mp4");
    const hash = createHash("sha256");
    let size: number;
    let buffer: Buffer | undefined;
    const localPath = !file.buffer?.length && typeof file.path === "string" ? file.path : undefined;
    if (localPath) {
      size = (await stat(localPath)).size;
      for await (const chunk of createReadStream(localPath)) hash.update(chunk);
    } else {
      buffer = await readMulterFileBuffer(file);
      size = buffer.length;
      hash.update(buffer);
    }
    if (!size) throw new Error(`Missing upload video ${index + 1}`);
    const key = `uploads/asset/videos/${scope}/${String(index).padStart(6, "0")}-${hash.digest("hex")}${extension}`;
    await options.assertOwned?.();
    if (localPath) await uploadFilePathToR2(localPath, contentType, process.env.R2_BUCKET_NAME!, key, size);
    else await uploadBufferToR2(buffer!, contentType, process.env.R2_BUCKET_NAME!, key);
    return getR2PublicUrl(key);
  });
}

/** Attach a group's clips once, independently of photo/cover/model indexes. */
export function assignAssetLotVideos(lots: any[], videos: any[], videoUrls: string[], details: any): any[] {
  const groups: any[] = Array.isArray(details?.mixed_lots) ? details.mixed_lots : [];
  const countAssignments: number[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const count = Number(groups[groupIndex]?.video_count ?? groups[groupIndex]?.videoCount);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    const remaining = Math.min(count, videoUrls.length - countAssignments.length);
    for (let index = 0; index < remaining; index += 1) {
      countAssignments.push(groupIndex);
    }
  }
  const urlsByGroup = new Map<number, string[]>();
  videoUrls.forEach((url, index) => {
    const declared = videos[index]?.lotIndex;
    const group = Number.isInteger(declared) && declared >= 0 ? declared : countAssignments[index];
    if (group === undefined) return; // retained as unassigned report media, never guessed
    const groupUrls = urlsByGroup.get(group) || [];
    groupUrls.push(url);
    urlsByGroup.set(group, groupUrls);
  });
  const seen = new Set<number>();
  return lots.map((lot, index) => {
    if ((details?.grouping_mode || "mixed") !== "mixed") return { ...lot, video_urls: index === 0 ? videoUrls : [] };
    const group = Number(lot?.mixed_group_index) - 1;
    const groupUrls = !seen.has(group) ? urlsByGroup.get(group) || [] : [];
    seen.add(group);
    return { ...lot, video_urls: groupUrls };
  });
}

/** Only persisted report media may be fetched; edited URLs cannot add sources. */
export function buildAssetVideoZipInputs(lots: any[], reportVideoUrls: string[]) {
  const manifest = Array.isArray(reportVideoUrls) ? reportVideoUrls.filter((url) => typeof url === "string" && url.trim()).map((url) => url.trim()) : [];
  const allowed = new Set(manifest);
  const safeLots = (Array.isArray(lots) ? lots : []).map((lot) => ({
    ...lot,
    video_urls: (Array.isArray(lot?.video_urls) ? lot.video_urls : []).filter((url: unknown) => typeof url === "string" && allowed.has(url.trim())),
  }));
  return buildOrderedLotVideoZipEntries(safeLots, manifest).map(({ url, filename }) => ({ url, filename }));
}
