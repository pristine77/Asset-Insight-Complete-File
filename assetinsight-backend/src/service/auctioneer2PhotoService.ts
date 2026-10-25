/**
 * Imports Auctioneer2 photos into ClearValue-owned storage and returns canonical URLs.
 * Copying at the integration boundary prevents report artifacts from depending on
 * expiring or access-controlled upstream URLs; validation protects storage and image
 * processing from oversized or unsupported upstream content.
 */
import axios from "axios";
import sharp from "sharp";
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

async function prepareAuctioneerImage(
  input: Buffer,
  sourceContentType: string
): Promise<{ buffer: Buffer; contentType: string; transformed: boolean }> {
  const normalizedContentType = normalizeContentType(sourceContentType);
  if (
    input.length <= MAX_AUCTIONEER_PHOTO_BYTES &&
    AUCTIONEER_ACCEPTED_IMAGE_TYPES.has(normalizedContentType)
  ) {
    return {
      buffer: input,
      contentType: normalizedContentType,
      transformed: false,
    };
  }

  const attempts = [
    { width: 6000, quality: 84 },
    { width: 4500, quality: 76 },
    { width: 3200, quality: 68 },
  ];
  for (const attempt of attempts) {
    const output = await sharp(input)
      .rotate()
      .resize({
        width: attempt.width,
        height: attempt.width,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer();
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
  if (!contentType.toLowerCase().startsWith("image/")) {
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
  if (!contentType.toLowerCase().startsWith("image/")) {
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
    loaded.contentType
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
