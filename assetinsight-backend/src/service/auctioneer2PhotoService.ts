/**
 * Imports Auctioneer2 photos into ClearValue-owned storage and returns canonical URLs.
 * Copying at the integration boundary prevents report artifacts from depending on
 * expiring or access-controlled upstream URLs; validation protects storage and image
 * processing from oversized or unsupported upstream content.
 */
import axios from "axios";
import sharp from "sharp";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";
/*
   These failures are all things the person retrying can act on — a photo on a
   host we will not fetch from, an attachment that is not an image, one too
   large to send. Thrown as AuctioneerDeliveryError they reach the screen as
   themselves; thrown as bare Errors, two of them were being replaced by the
   generic "preparing or uploading" message and the operator never learned that
   a storage host or a Cloudinary account was the problem.
*/
import { AuctioneerDeliveryError } from "./auctioneer2DeliveryError.js";
import {
  headR2Object,
  readR2ObjectBuffer,
  resolveR2ObjectLocationFromUrl,
} from "../utils/r2Storage/r2Upload.js";

const MAX_AUCTIONEER_PHOTO_BYTES = 20 * 1024 * 1024;
const AUCTIONEER_ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export type AuctioneerPhotoUpload = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  sourceUrl: string;
};

export function trustedPhotoSource(url: string): "r2" | "cloudinary" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuctioneerDeliveryError("A report photo has an invalid storage URL.");
  }

  if (parsed.username || parsed.password || parsed.port) {
    throw new AuctioneerDeliveryError("A report photo has an invalid storage URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new AuctioneerDeliveryError("Auctioneer delivery accepts HTTPS report photos only.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"].includes(hostname)) {
    throw new AuctioneerDeliveryError("A YouTube video link is saved in the photo list. It must be in the lot's video field. Ask support to review the frozen delivery before retrying; no photos have been removed.");
  }
  if (resolveR2ObjectLocationFromUrl(url)) {
    return "r2";
  }
  if (hostname === "res.cloudinary.com") {
    const configuredCloudName = String(
      process.env.CLOUDINARY_CLOUD_NAME || ""
    ).trim();
    const urlCloudName = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (configuredCloudName && urlCloudName === configuredCloudName) {
      return "cloudinary";
    }
    throw new AuctioneerDeliveryError("The report photo is not stored in Asset Insight's Cloudinary account.");
  }
  throw new AuctioneerDeliveryError(`Report photo storage host is not trusted: ${hostname}`);
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/avif") return ".avif";
  return ".jpg";
}

function normalizeContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

/**
 * The image type the BYTES are, read from their first bytes exactly as
 * Auctioneer 2.0 reads them (its server/imageBytes.ts sniffImageContentType),
 * or null for anything Auctioneer does not take (HEIC, TIFF, BMP, …).
 *
 * WHY (owner, 2026-11-19, contract 825853): a photo was sent labelled with the
 * type its storage claimed, and Auctioneer, which judges the bytes, refused
 * it ("Photo bytes are … but were declared as …" or "not a supported image").
 * The whole delivery stopped at the photos as "status 400". The label sent now
 * always comes from the bytes, so the two systems cannot disagree about it.
 */
export function sniffAuctioneerImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand.includes("avif") || brand.includes("avis")) return "image/avif";
  }
  return null;
}

/** What a photo Auctioneer cannot take is, in words, for the message that names it. */
function describeImageBytes(bytes: Buffer): string {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "HEIC (iPhone)";
  }
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4).toString("binary");
    if (head === "II*\u0000" || head === "MM\u0000*") return "TIFF";
    if (head.startsWith("BM")) return "BMP";
  }
  return "unrecognised image";
}

async function prepareAuctioneerImage(
  input: Buffer,
  photoNumber = 1
): Promise<{ buffer: Buffer; contentType: string; transformed: boolean }> {
  // Sent as-is only when the bytes are a type Auctioneer takes, labelled by
  // the bytes; the storage label is never trusted (see sniffAuctioneerImageType).
  const actualContentType = sniffAuctioneerImageType(input);
  if (
    input.length <= MAX_AUCTIONEER_PHOTO_BYTES &&
    actualContentType &&
    AUCTIONEER_ACCEPTED_IMAGE_TYPES.has(actualContentType)
  ) {
    return {
      buffer: input,
      contentType: actualContentType,
      transformed: false,
    };
  }

  // Anything else (a type Auctioneer does not take, or too large) goes as JPEG.
  const attempts = [
    { width: 6000, quality: 84 },
    { width: 4500, quality: 76 },
    { width: 3200, quality: 68 },
  ];
  let conversionInput = input;
  try {
    // Match Sharp's existing pixel ceiling while supporting HEVC builds through
    // the decoder already used by report uploads. Originals remain untouched.
    conversionInput = await normalizeHeicToJpegBuffer(input, { maxInputPixels: 268_402_689 });
  } catch {
    // Sharp may decode a HEIF-compatible format the fallback decoder cannot.
  }
  for (const attempt of attempts) {
    let output: Buffer;
    try {
      output = await sharp(conversionInput)
        .rotate()
        .resize({
          width: attempt.width,
          height: attempt.width,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: attempt.quality, mozjpeg: true })
        .toBuffer();
    } catch {
      // The converter cannot read it either (an iPhone HEIC, a damaged file):
      // say which photo and what it is, so it can be replaced.
      throw new AuctioneerDeliveryError(
        `A report photo (photo ${photoNumber}) is a ${describeImageBytes(input)} file that Auctioneer 2.0 cannot take, and it could not be converted to JPEG. Contact support to review this photo in the saved delivery before retrying.`
      );
    }
    if (output.length <= MAX_AUCTIONEER_PHOTO_BYTES) {
      return {
        buffer: output,
        contentType: "image/jpeg",
        transformed: true,
      };
    }
  }
  throw new AuctioneerDeliveryError("A report photo could not be reduced below Auctioneer's 20 MB limit.");
}

async function readR2Photo(url: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const location = resolveR2ObjectLocationFromUrl(url);
  if (!location?.bucketName) {
    throw new AuctioneerDeliveryError("Unable to resolve the report photo storage location.");
  }

  const metadata = await headR2Object(location.bucketName, location.key);
  const contentType = String(metadata.contentType || "image/jpeg");
  if (!contentType.toLowerCase().startsWith("image/") && normalizeContentType(contentType) !== "application/octet-stream") {
    throw new AuctioneerDeliveryError("A selected report attachment is not an image.");
  }
  const buffer = await readR2ObjectBuffer(location.bucketName, location.key);
  return { buffer, contentType };
}

async function readCloudinaryPhoto(url: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: Math.max(
      5_000,
      Number(
        process.env.AUCTIONEER2_API_TIMEOUT_MS ||
          process.env.AUCTIONEER2_TIMEOUT_MS
      ) || 30_000
    ),
    maxContentLength: 35 * 1024 * 1024,
    maxBodyLength: 35 * 1024 * 1024,
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const contentType = String(response.headers["content-type"] || "image/jpeg");
  if (!contentType.toLowerCase().startsWith("image/") && normalizeContentType(contentType) !== "application/octet-stream") {
    throw new AuctioneerDeliveryError("A selected Cloudinary attachment is not an image.");
  }
  return { buffer: Buffer.from(response.data), contentType };
}

export async function loadAuctioneerPhoto(
  sourceUrl: string,
  lotIndex: number,
  photoIndex: number
): Promise<AuctioneerPhotoUpload> {
  const source = trustedPhotoSource(sourceUrl);
  const loaded =
    source === "r2"
      ? await readR2Photo(sourceUrl)
      : await readCloudinaryPhoto(sourceUrl);
  const prepared = await prepareAuctioneerImage(
    loaded.buffer,
    photoIndex + 1
  );
  // The transmitted filename must describe the bytes we actually send. Source
  // URLs can carry stale or misleading extensions (for example AVIF at .jpg),
  // and unsupported formats are transcoded to JPEG above.
  const safeExtension = extensionForContentType(prepared.contentType);
  return {
    buffer: prepared.buffer,
    contentType: prepared.contentType,
    filename: `lot-${String(lotIndex + 1).padStart(3, "0")}-photo-${String(
      photoIndex + 1
    ).padStart(3, "0")}${safeExtension}`,
    sourceUrl,
  };
}

export function collectApprovedPhotoUrls(lot: any): string[] {
  const deletedUrls = new Set(
    (Array.isArray(lot?.deleted_image_urls) ? lot.deleted_image_urls : [])
      .map((value: unknown) => String(value || "").trim())
      .filter(Boolean)
  );
  const urls = [
    lot?.image_url,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !deletedUrls.has(value));
  return Array.from(new Set(urls));
}
