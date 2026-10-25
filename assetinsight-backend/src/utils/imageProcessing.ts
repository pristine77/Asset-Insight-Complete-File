import {Jimp} from "jimp";
import path from "path";
import fs from "fs/promises";
import sharp from "sharp";
import { addPhotoWatermarkReceipt, hasPhotoWatermarkReceipt } from "./photoWatermarkReceipt.js";
import { reportActivityContext } from "./reportActivityContext.js";
import { activityHash } from "./reportActivitySnapshot.js";

const HEIC_MIME_PATTERN = /^image\/(?:heic|heif|heic-sequence|heif-sequence)$/i;
const HEIC_EXT_PATTERN = /\.(?:heic|heif)$/i;
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

export function isHeicLikeImage(
  input?: Buffer | null,
  mimetype?: string | null,
  filename?: string | null
): boolean {
  if (mimetype && HEIC_MIME_PATTERN.test(mimetype)) return true;
  if (filename && HEIC_EXT_PATTERN.test(filename)) return true;

  if (!input || input.length < 12) return false;
  const brand = input.subarray(8, 12).toString("ascii").toLowerCase();
  return HEIC_BRANDS.has(brand);
}

export async function normalizeHeicToJpegBuffer(
  inputBuffer: Buffer,
  options: { maxInputPixels?: number } = {}
): Promise<Buffer> {
  if (!isHeicLikeImage(inputBuffer)) return inputBuffer;

  if (Number.isFinite(options.maxInputPixels)) {
    const decodeModule = (await import("heic-decode")) as any;
    const decode = decodeModule.default || decodeModule;
    const images = await decode.all({ buffer: inputBuffer });
    try {
      const first = images?.[0];
      const width = Number(first?.width || 0);
      const height = Number(first?.height || 0);
      const pixels = width * height;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        !Number.isSafeInteger(pixels)
      ) {
        throw new Error("Unable to read safe HEIC image dimensions");
      }
      if (pixels > Number(options.maxInputPixels)) {
        throw new Error(
          `HEIC image exceeds the ${Number(options.maxInputPixels)}-pixel decode limit`
        );
      }
    } finally {
      images?.dispose?.();
    }
  }

  const mod = (await import("heic-convert")) as any;
  const convert = mod.default || mod;
  const converted = await convert({
    buffer: inputBuffer,
    format: "JPEG",
    quality: 0.94,
  });

  return Buffer.isBuffer(converted) ? converted : Buffer.from(converted);
}

/**
 * Prepare a user image for durable storage without applying a watermark.
 * Non-HEIC images retain their original bytes and MIME type so re-uploading an
 * already-watermarked photo never introduces another lossy processing pass.
 */
export async function prepareImageWithoutWatermark(
  inputBuffer: Buffer,
  mimetype?: string | null,
  filename?: string | null
): Promise<{ buffer: Buffer; mimetype: string; extension: string }> {
  if (isHeicLikeImage(inputBuffer, mimetype, filename)) {
    return {
      buffer: await normalizeHeicToJpegBuffer(inputBuffer),
      mimetype: "image/jpeg",
      extension: ".jpg",
    };
  }

  const originalExtension = path.extname(String(filename || "")).toLowerCase();
  return {
    buffer: inputBuffer,
    mimetype: String(mimetype || "image/jpeg"),
    extension: originalExtension || ".jpg",
  };
}

async function encodeJpegUnderMaxBytes(
  image: any,
  maxBytes: number,
  startQuality: number
): Promise<Buffer> {
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  const qualities = [
    clamp(startQuality, 60, 95),
    92,
    88,
    84,
    80,
    76,
    72,
    68,
    64,
    60,
  ].filter((q, i, arr) => arr.indexOf(q) === i);

  let out: Buffer = await image.getBuffer("image/jpeg", { quality: qualities[0]! });
  if (out.length <= maxBytes) return out;

  for (const q of qualities.slice(1)) {
    out = await image.getBuffer("image/jpeg", { quality: q });
    if (out.length <= maxBytes) return out;
  }

  let current = image;
  let w = current.width;
  let h = current.height;

  while (out.length > maxBytes && w > 640 && h > 640) {
    w = Math.max(640, Math.round(w * 0.9));
    h = Math.max(640, Math.round(h * 0.9));
    current = current.resize({ w, h });

    for (const q of [82, 78, 74, 70, 66, 62, 60, 58, 55, 52, 50, 45]) {
      out = await current.getBuffer("image/jpeg", { quality: q });
      if (out.length <= maxBytes) return out;
    }
  }

  return out;
}

export type EnhanceOptions = {
  saturation?: number;  // 1.0 = no change, 1.4 = +40%
  sharpness?: number;   // 0.0 = no change, 0.4 = +40% 
  contrast?: number;    // 1.0 = no change, 1.3 = +30%
};

/**
 * Enhance image with saturation, sharpness, and contrast adjustments
 * Default values: +40% saturation, +40% sharpness, +30% contrast
 */
export async function enhanceImage(
  inputBuffer: Buffer,
  options: EnhanceOptions = {}
): Promise<Buffer> {
  const normalizedBuffer = await normalizeHeicToJpegBuffer(inputBuffer);
  const image = await Jimp.read(normalizedBuffer);

  const maxBytes = 500 * 1024;
  const startQuality = 92;
  return await encodeJpegUnderMaxBytes(image, maxBytes, startQuality);
}

export type ProcessOptions = {
  maxBytes?: number; // Optional max file size limit (default: Infinity = no limit)
  quality?: number; // JPEG quality (default 98 - near lossless)
  logoScale?: number; // portion of image width (e.g., 0.10 = 10%)
  logoMarginPx?: number; // margin from edges in px
  logoMarginPct?: number; // portion of min(imgW,imgH) for margin (e.g., 0.02 = 2%)
  logoPosition?: "top_right" | "bottom_right"; // default bottom_right
};

let cachedLogoBuffer: Buffer | null = null;

async function readLogoBuffer(logoPath: string): Promise<Buffer> {
  if (cachedLogoBuffer) return cachedLogoBuffer;
  const absLogoPath = path.isAbsolute(logoPath)
    ? logoPath
    : path.resolve(process.cwd(), logoPath);
  cachedLogoBuffer = await fs.readFile(absLogoPath);
  return cachedLogoBuffer;
}

async function encodeSharpJpegUnderMaxBytes(
  image: sharp.Sharp,
  maxBytes: number,
  startQuality: number
): Promise<Buffer> {
  const qualities = [
    startQuality,
    92,
    88,
    84,
    80,
    76,
    72,
    68,
    64,
    60,
  ]
    .map((quality) => Math.max(60, Math.min(98, quality)))
    .filter((quality, index, arr) => arr.indexOf(quality) === index);

  for (const quality of qualities) {
    const output = await image.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (output.length <= maxBytes) return output;
  }

  return image.clone().jpeg({ quality: 60, mozjpeg: true }).toBuffer();
}

async function processImageWithLogoSharp(
  inputBuffer: Buffer,
  logoPath: string,
  options: Required<Pick<ProcessOptions, "quality" | "maxBytes" | "logoScale" | "logoMarginPx" | "logoMarginPct" | "logoPosition">>
): Promise<Buffer> {
  const normalizedBuffer = await normalizeHeicToJpegBuffer(inputBuffer);
  const image = sharp(normalizedBuffer, { failOn: "none" }).rotate();
  const metadata = await image.metadata();
  const imgW = metadata.width || 0;
  const imgH = metadata.height || 0;
  if (!imgW || !imgH) throw new Error("Unable to read image dimensions");

  const logoTargetW = Math.max(24, Math.round(imgW * options.logoScale));
  const logo = await sharp(await readLogoBuffer(logoPath))
    .resize({ width: logoTargetW, withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  const dynMargin = Math.max(
    options.logoMarginPx,
    Math.round(
      Math.min(imgW, imgH) * Math.max(0, Math.min(0.1, options.logoMarginPct))
    )
  );

  const left = Math.max(0, imgW - logo.info.width - dynMargin);
  const top =
    options.logoPosition === "bottom_right"
      ? Math.max(0, imgH - logo.info.height - dynMargin)
      : Math.max(0, dynMargin);

  const composed = image.composite([{ input: logo.data, left, top }]);
  return encodeSharpJpegUnderMaxBytes(composed, options.maxBytes, options.quality);
}

/**
 * Apply the requested logo once to a new photo. Re-uploading our exact encoded
 * output is a byte-preserving no-op, even if later callers use different options.
 * Legacy/unmarked sources still require the existing explicit opt-out when they
 * already contain a logo. This does not remove logos from saved report photos.
 */
export async function processImageWithLogo(
  inputBuffer: Buffer,
  logoPath: string,
  options: ProcessOptions = {}
): Promise<{ buffer: Buffer; format: "jpeg" }> {
  if (hasPhotoWatermarkReceipt(inputBuffer)) {
    // A valid receipt establishes an existing logo, not who captured the photo.
    const receipts = reportActivityContext.getStore()?.verifiedLogoReceipts;
    if (receipts && receipts.size < 5000) receipts.add(activityHash(inputBuffer));
    if (inputBuffer[0] === 0xff && inputBuffer[1] === 0xd8) {
      return { buffer: inputBuffer, format: "jpeg" };
    }
    // Existing callers expect JPEG when opting in. Convert a marked native
    // WebP/AVIF without compositing another logo; default-off uploads stay intact.
    const jpeg = await encodeSharpJpegUnderMaxBytes(
      sharp(inputBuffer).rotate(), options.maxBytes ?? 500 * 1024, options.quality ?? 98,
    );
    return { buffer: addPhotoWatermarkReceipt(jpeg), format: "jpeg" };
  }
  const quality = options.quality ?? 98;
  const maxBytes = options.maxBytes ?? 500 * 1024;
  const logoScale = options.logoScale ?? 0.10;
  const logoMarginPx = options.logoMarginPx ?? 20;
  const logoMarginPct = options.logoMarginPct ?? 0.02;
  const logoPosition = options.logoPosition ?? "bottom_right";

  try {
    const buffer = await processImageWithLogoSharp(inputBuffer, logoPath, {
      quality,
      maxBytes,
      logoScale,
      logoMarginPx,
      logoMarginPct,
      logoPosition,
    });
    return { buffer: addPhotoWatermarkReceipt(buffer), format: "jpeg" };
  } catch (sharpError) {
    console.warn("[imageProcessing] Sharp image processing failed; falling back to Jimp:", sharpError);
  }

  const normalizedBuffer = await normalizeHeicToJpegBuffer(inputBuffer);

  // Read image - KEEP ORIGINAL SIZE
  const image = await Jimp.read(normalizedBuffer);
  const imgW = image.width;
  const imgH = image.height;

  // Read logo and resize proportionally to image width
  const logo = await Jimp.read(await readLogoBuffer(logoPath));
  const logoTargetW = Math.max(24, Math.round(imgW * logoScale));
  logo.resize({ w: logoTargetW });
  const lw = logo.width;
  const lh = logo.height;

  // Dynamic margin combines pixel and percent-based margins
  const dynMargin = Math.max(
    logoMarginPx,
    Math.round(Math.min(imgW, imgH) * Math.max(0, Math.min(0.1, logoMarginPct)))
  );

  // Position with margin (default: bottom-right)
  const left = Math.max(0, imgW - lw - dynMargin);
  const top = logoPosition === "bottom_right"
    ? Math.max(0, imgH - lh - dynMargin)
    : Math.max(0, dynMargin);

  // Composite logo onto original image (no resize, no crop)
  const composed = image.composite(logo, left, top);

  const out = await encodeJpegUnderMaxBytes(composed, maxBytes, quality);

  return { buffer: addPhotoWatermarkReceipt(out), format: "jpeg" };
}
