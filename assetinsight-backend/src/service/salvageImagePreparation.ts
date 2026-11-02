import axios from "axios";
import sharp from "sharp";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { drawDamageLoops, salvageDamageCropBox, type SalvageDamageMark } from "../utils/salvageDamageMarks.js";

/**
 * Damage marks (owner, 2026-11-01; utils/salvageDamageMarks.ts): a marked
 * photo's copy has its loops drawn on, as the report prints it, and when close-
 * ups are asked for, damageCrops holds a full-detail close-up of each loop's
 * area, cut from the clean full-size original (not the 1600 px copy), in the
 * order the loops were drawn.
 *
 * The report cover shows clean photos (owner, 2026-11-01: "clean photos on
 * the cover"): for the indexes in cleanCopyIndexes, a marked photo also
 * returns cleanBuffer, the same copy without its loops, from the same download.
 */
export type SalvagePreparedPhoto = { buffer: Buffer; width: number; height: number; damageCrops?: Buffer[]; cleanBuffer?: Buffer };
export const SALVAGE_MAX_PHOTOS = 50;
export const SALVAGE_AI_BATCH_SIZE = 10;

/** Ephemeral AI/document copies only; stored originals and URL order are unchanged. */
export async function prepareSalvagePhotos(imageUrls: string[], options: {
  maxEncodedBytes?: number;
  /** Damage marks per photo, aligned with imageUrls; their loops are drawn on the copies. */
  damageMarks?: (SalvageDamageMark | undefined)[];
  /** Also cut a close-up of each marked area (the analysis asks; documents do not). */
  damageCloseUps?: boolean;
  /** Photos that also need a copy without loops (the report cover). */
  cleanCopyIndexes?: number[];
} = {}): Promise<SalvagePreparedPhoto[]> {
  if (imageUrls.length > SALVAGE_MAX_PHOTOS) throw new Error("Salvage supports at most 50 photos; no photos were discarded.");
  let encodedBytes = 64 * 1024;
  return mapWithConcurrency(imageUrls, 4, async (url, index) => {
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer", timeout: 30_000, maxContentLength: 30 * 1024 * 1024,
        maxBodyLength: 30 * 1024 * 1024, maxRedirects: 3,
      });
      const normalized = await normalizeHeicToJpegBuffer(Buffer.from(response.data as ArrayBuffer), { maxInputPixels: 40_000_000 });
      const result = await sharp(normalized, { limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
      const mark = options.damageMarks?.[index];
      const buffer = mark?.loops.length ? await drawDamageLoops(result.data, result.info.width, result.info.height, mark.loops) : result.data;
      encodedBytes += Math.ceil(buffer.length / 3) * 4;
      const cleanBuffer = buffer !== result.data && options.cleanCopyIndexes?.includes(index) ? result.data : undefined;
      if (cleanBuffer) encodedBytes += Math.ceil(cleanBuffer.length / 3) * 4;
      let damageCrops: Buffer[] | undefined;
      if (options.damageCloseUps && mark?.regions.length) {
        // The loops were placed on the photo as displayed, so crop the
        // orientation-corrected original at full resolution.
        const oriented = await sharp(normalized, { limitInputPixels: 40_000_000 }).rotate().toBuffer({ resolveWithObject: true });
        damageCrops = [];
        for (const region of mark.regions) {
          const crop = await sharp(oriented.data, { limitInputPixels: 40_000_000 })
            .extract(salvageDamageCropBox(region, oriented.info.width, oriented.info.height))
            .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 }).toBuffer();
          encodedBytes += Math.ceil(crop.length / 3) * 4;
          damageCrops.push(crop);
        }
      }
      if (encodedBytes > (options.maxEncodedBytes ?? 256 * 1024 * 1024)) throw new Error("Image preparation size limit exceeded.");
      return { buffer, width: result.info.width, height: result.info.height, ...(damageCrops ? { damageCrops } : {}), ...(cleanBuffer ? { cleanBuffer } : {}) };
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
