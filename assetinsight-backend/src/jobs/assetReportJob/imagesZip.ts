import archiver from "archiver";
import axios from "axios";
import {
  getCloudinaryCustomUrl,
  isCloudinaryFetchConfigured,
} from "../../utils/cloudinary.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../../utils/concurrency.js";
import { processImageWithLogo } from "../../utils/imageProcessing.js";

// Options used when packaging report images into a ZIP archive.
export type GenerateImagesZipOptions = {
  optimizeSize?: boolean;
  maxSizeKB?: number;
  enhance?: boolean;
  /** Only enable for raw, unprocessed inputs; saved report photos are already prepared. */
  watermark?: boolean;
  filenames?: string[];
  rawFiles?: Array<{ url: string; filename: string }>;
};

function normalizeZipFilename(filename: string, watermark: boolean): string {
  const fallback = "image.jpg";
  const safe = String(filename || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  const withName = safe || fallback;
  return watermark ? withName.replace(/\.[^.]+$/, "") + ".jpg" : withName;
}

function resolveZipFilenames(
  imageUrls: string[],
  renameMap: Record<string, string> | undefined,
  filenames: string[],
  watermark: boolean
): string[] {
  const used = new Set<string>();

  return imageUrls.map((imageUrl, i) => {
    let desired = filenames[i] || renameMap?.[imageUrl];
    if (!desired || typeof desired !== "string") {
      const clean = imageUrl.split("?")[0];
      const urlParts = clean.split("/");
      desired = urlParts[urlParts.length - 1] || `image-${i + 1}.jpg`;
    }

    let filename = normalizeZipFilename(desired, watermark);
    if (used.has(filename)) {
      const base = filename.replace(/\.[^.]+$/, "");
      const ext = (filename.match(/\.[^.]+$/) || [".jpg"])[0];
      let duplicateIndex = 2;
      while (used.has(`${base} (${duplicateIndex})${ext}`)) {
        duplicateIndex += 1;
      }
      filename = `${base} (${duplicateIndex})${ext}`;
    }
    used.add(filename);
    return filename;
  });
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  const buffer = Buffer.from(response.data as ArrayBuffer);
  if (buffer.length === 0) throw new Error("Empty image response");
  return buffer;
}

async function downloadRawFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return Buffer.from(response.data as ArrayBuffer);
}

function resolveRawFilenames(
  rawFiles: Array<{ url: string; filename: string }>,
  imageFilenames: string[]
): string[] {
  const used = new Set(imageFilenames);
  return rawFiles.map((file, index) => {
    let filename = normalizeZipFilename(file.filename || `video-${index + 1}.mp4`, false);
    if (used.has(filename)) {
      const base = filename.replace(/\.[^.]+$/, "");
      const ext = (filename.match(/\.[^.]+$/) || [".mp4"])[0];
      let duplicateIndex = 2;
      while (used.has(`${base} (${duplicateIndex})${ext}`)) duplicateIndex += 1;
      filename = `${base} (${duplicateIndex})${ext}`;
    }
    used.add(filename);
    return filename;
  });
}

function shouldLogImageProgress(index: number, total: number): boolean {
  const completed = index + 1;
  return completed <= 3 || completed === total || completed % 25 === 0;
}

// Generate a ZIP buffer from image URLs while keeping filenames stable and unique.
export async function generateImagesZip(
  imageUrls: string[],
  renameMap?: Record<string, string>,
  options?: GenerateImagesZipOptions
): Promise<Buffer> {
  const {
    optimizeSize = true,
    maxSizeKB = 500,
    enhance = false,
    watermark = false,
    filenames = [],
    rawFiles = [],
  } = options || {};

  return new Promise(async (resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("data", (chunk: Buffer) => chunks.push(chunk));
      archive.on("end", () => resolve(Buffer.concat(chunks)));
      archive.on("error", (err: any) => reject(err));

      const configuredZipConcurrency = getPositiveIntEnv("REPORT_ZIP_FETCH_CONCURRENCY", 8);
      // Avoid retaining many decoded/downloaded images at once. The archive
      // remains ordered because each bounded batch is appended sequentially.
      const zipFetchConcurrency = Math.max(
        1,
        Math.min(
          configuredZipConcurrency,
          imageUrls.length >= 300 ? 3 : imageUrls.length >= 150 ? 4 : 8,
        ),
      );
      const imageBatchSize = Math.max(zipFetchConcurrency, zipFetchConcurrency * 2);
      const resolvedFilenames = resolveZipFilenames(imageUrls, renameMap, filenames, watermark);
      const resolvedRawFilenames = resolveRawFilenames(rawFiles, resolvedFilenames);
      const useCloudinaryOptimization = optimizeSize && isCloudinaryFetchConfigured();

      console.log(
        `[generateImagesZip] Processing ${imageUrls.length} images${useCloudinaryOptimization ? ` (Cloudinary target <${maxSizeKB}KB)` : ""} with concurrency ${zipFetchConcurrency}`
      );

      for (let batchStart = 0; batchStart < imageUrls.length; batchStart += imageBatchSize) {
        const batchUrls = imageUrls.slice(batchStart, batchStart + imageBatchSize);
        const downloads = await mapWithConcurrency(
          batchUrls,
          zipFetchConcurrency,
          async (imageUrl, localIndex) => {
            const i = batchStart + localIndex;
            try {
              let imageBuffer: Buffer;
              if (useCloudinaryOptimization) {
                try {
                  const downloadUrl = getCloudinaryCustomUrl(imageUrl, {
                    width: 1600,
                    height: 1200,
                    quality: "auto:good",
                    format: "jpg",
                    enhance,
                  });
                  imageBuffer = await downloadImage(downloadUrl);
                } catch {
                  console.warn(
                    `[generateImagesZip] Cloudinary fetch failed for image ${i + 1}; retrying the original object`
                  );
                  imageBuffer = await downloadImage(imageUrl);
                }
              } else {
                imageBuffer = await downloadImage(imageUrl);
              }

              if (watermark) {
                try {
                  const processed = await processImageWithLogo(
                    imageBuffer,
                    "public/logoNobg.png",
                    { maxBytes: maxSizeKB * 1024 },
                  );
                  imageBuffer = processed.buffer;
                } catch {
                  console.warn(
                    `[generateImagesZip] Watermark processing failed for image ${i + 1}, using downloaded image`
                  );
                }
              }
              const sizeKB = Math.round(imageBuffer.length / 1024);
              if (shouldLogImageProgress(i, imageUrls.length)) {
                console.log(
                  `[generateImagesZip] Image ${i + 1}/${imageUrls.length}: ${sizeKB}KB`
                );
              }

              return { imageBuffer, filename: resolvedFilenames[i] };
            } catch {
              // Never publish a successful package with a missing photo. In
              // particular, losing photo one silently changes the apparent lead
              // photo and hides the failure from appraisers and auction staff.
              // Keep source URLs/provider diagnostics out of user-facing errors.
              return { error: new Error(`Failed to include photo ${i + 1} of ${imageUrls.length} in the media ZIP. Retry generation when the original is available.`) };
            }
          }
        );

        // Settle the bounded batch before failing so no background fetches
        // outlive this failed generation or race its retry.
        const failed = downloads.find((download) => download.error);
        if (failed?.error) {
          archive.abort();
          throw failed.error;
        }
        for (const download of downloads) {
          if (download.error) throw download.error;
          archive.append(download.imageBuffer, { name: download.filename });
        }
        // Yield between batches so lease heartbeats and HTTP health checks are
        // not starved while a very large final media package is assembled.
        await new Promise<void>((resolveBatch) => setImmediate(resolveBatch));
      }

      // Videos and other raw media are intentionally appended after all
      // photos. They are copied byte-for-byte without image transforms.
      const rawFetchConcurrency = Math.min(4, getPositiveIntEnv("REPORT_ZIP_VIDEO_FETCH_CONCURRENCY", 3));
      for (let start = 0; start < rawFiles.length; start += rawFetchConcurrency) {
        const rawDownloads = await mapWithConcurrency(
          rawFiles.slice(start, start + rawFetchConcurrency),
          rawFetchConcurrency,
          async (file, index) => {
            try {
              return {
                buffer: await downloadRawFile(file.url),
                filename: resolvedRawFilenames[start + index],
              };
            } catch {
              // A missing clip must fail publication, never silently disappear.
              archive.abort();
              throw new Error(`Failed to include video ${start + index + 1} in the media ZIP. Retry generation when the original is available.`);
            }
          }
        );
        for (const download of rawDownloads) {
          // Camera clips are already compressed. Storing avoids wasted CPU and
          // preserves every original byte; only one bounded batch is downloaded.
          archive.append(download.buffer, { name: download.filename, store: true });
        }
        await new Promise<void>((resolveBatch) => setImmediate(resolveBatch));
      }

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}
