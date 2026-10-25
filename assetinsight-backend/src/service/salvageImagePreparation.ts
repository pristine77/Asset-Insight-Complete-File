import axios from "axios";
import sharp from "sharp";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

export type SalvagePreparedPhoto = { buffer: Buffer; width: number; height: number };
export const SALVAGE_MAX_PHOTOS = 50;
export const SALVAGE_AI_BATCH_SIZE = 10;

/** Ephemeral AI/document copies only; stored originals and URL order are unchanged. */
export async function prepareSalvagePhotos(imageUrls: string[], options: { maxEncodedBytes?: number } = {}): Promise<SalvagePreparedPhoto[]> {
  if (imageUrls.length > SALVAGE_MAX_PHOTOS) throw new Error("Salvage supports at most 50 photos; no photos were discarded.");
  let encodedBytes = 64 * 1024;
  return mapWithConcurrency(imageUrls, 4, async (url) => {
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer", timeout: 30_000, maxContentLength: 30 * 1024 * 1024,
        maxBodyLength: 30 * 1024 * 1024, maxRedirects: 3,
      });
      const normalized = await normalizeHeicToJpegBuffer(Buffer.from(response.data as ArrayBuffer), { maxInputPixels: 40_000_000 });
      const result = await sharp(normalized, { limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
      encodedBytes += Math.ceil(result.data.length / 3) * 4;
      if (encodedBytes > (options.maxEncodedBytes ?? 256 * 1024 * 1024)) throw new Error("Image preparation size limit exceeded.");
      return { buffer: result.data, width: result.info.width, height: result.info.height };
    } catch {
      // A partial report would silently lose evidence. Fail without logging URLs,
      // which may contain bearer-like data, and retain every original for retry.
      throw new Error("A salvage photo could not be prepared. Original photos are retained; retry report generation.");
    }
  });
}

/** Bound each AI request independently; a document's complete gallery is not one AI request. */
export function salvagePhotoBatches(imageUrls: string[]): { startIndex: number; urls: string[] }[] {
  if (imageUrls.length > SALVAGE_MAX_PHOTOS) throw new Error("Salvage supports at most 50 photos; no photos were discarded.");
  return Array.from({ length: Math.ceil(imageUrls.length / SALVAGE_AI_BATCH_SIZE) }, (_, batch) => ({
    startIndex: batch * SALVAGE_AI_BATCH_SIZE,
    urls: imageUrls.slice(batch * SALVAGE_AI_BATCH_SIZE, (batch + 1) * SALVAGE_AI_BATCH_SIZE),
  }));
}
