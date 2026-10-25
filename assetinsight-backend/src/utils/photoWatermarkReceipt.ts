import { createHash, timingSafeEqual } from "node:crypto";

// Private JPEG APP15 / WebP RIFF / AVIF free-box receipts, not EXIF.
// The receipt itself contains no location/device metadata.
// Bind it to the exact encoded photo so a stale receipt on edited bytes cannot
// incorrectly claim that the current pixels have already been processed.
const PREFIX = Buffer.from("AssetInsight:photo-watermark:v1\0", "ascii");
const DIGEST_BYTES = 32;
const PAYLOAD_BYTES = PREFIX.length + DIGEST_BYTES;
const RECEIPT_BYTES = 4 + PAYLOAD_BYTES;
const isJpeg = (input: Buffer) => input.length >= 2 && input[0] === 0xff && input[1] === 0xd8;
const isWebp = (input: Buffer) => input.length >= 12 && input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP";
const isAvif = (input: Buffer) => input.length >= 16 && input.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(input.toString("ascii", 8, 12));
const BOX_BYTES = 8 + PAYLOAD_BYTES;

function photoDigest(input: Buffer, receiptBytes = 0): Buffer {
  return createHash("sha256")
    .update(input.subarray(0, 2))
    .update(input.subarray(2 + receiptBytes))
    .digest();
}

export function hasPhotoWatermarkReceipt(input: Buffer): boolean {
  // Camera WebP/AVIF keep their original container and encoded pixels. A final
  // application chunk/free box is ignored by image decoders, never appended as
  // invalid trailing data outside the RIFF container.
  if (isWebp(input) || isAvif(input)) {
    const offset = input.length - BOX_BYTES;
    if (offset < 12) return false;
    const webp = isWebp(input);
    if (webp ? (input.readUInt32LE(4) !== input.length - 8 || input.toString("ascii", offset, offset + 4) !== "aiwm" || input.readUInt32LE(offset + 4) !== PAYLOAD_BYTES)
      : (input.readUInt32BE(offset) !== BOX_BYTES || input.toString("ascii", offset + 4, offset + 8) !== "free")) return false;
    if (!input.subarray(offset + 8, offset + 8 + PREFIX.length).equals(PREFIX)) return false;
    const original = Buffer.from(input.subarray(0, offset));
    if (webp) original.writeUInt32LE(original.length - 8, 4);
    return timingSafeEqual(input.subarray(offset + 8 + PREFIX.length), createHash("sha256").update(original).digest());
  }
  if (!isJpeg(input) || input.length < 2 + RECEIPT_BYTES) return false;
  if (input[2] !== 0xff || input[3] !== 0xef) return false;
  if (input.readUInt16BE(4) !== PAYLOAD_BYTES + 2) return false;
  if (!input.subarray(6, 6 + PREFIX.length).equals(PREFIX)) return false;
  const digest = input.subarray(6 + PREFIX.length, 2 + RECEIPT_BYTES);
  return timingSafeEqual(digest, photoDigest(input, RECEIPT_BYTES));
}

/** Stamp only freshly encoded watermark output; ordinary uploads stay unchanged. */
export function addPhotoWatermarkReceipt(input: Buffer): Buffer {
  if (hasPhotoWatermarkReceipt(input)) return input;
  if (isWebp(input) || isAvif(input)) {
    const box = Buffer.alloc(BOX_BYTES);
    if (isWebp(input)) {
      if (input.readUInt32LE(4) !== input.length - 8) throw new Error("Invalid WebP container size");
      box.write("aiwm", 0, "ascii");
      box.writeUInt32LE(PAYLOAD_BYTES, 4);
    } else {
      box.writeUInt32BE(BOX_BYTES, 0);
      box.write("free", 4, "ascii");
    }
    PREFIX.copy(box, 8);
    createHash("sha256").update(input).digest().copy(box, 8 + PREFIX.length);
    const output = Buffer.concat([input, box]);
    if (isWebp(input)) output.writeUInt32LE(output.length - 8, 4);
    return output;
  }
  if (!isJpeg(input)) throw new Error("Watermark output must be JPEG, WebP or AVIF");
  const marker = Buffer.alloc(RECEIPT_BYTES);
  marker[0] = 0xff;
  marker[1] = 0xef;
  marker.writeUInt16BE(PAYLOAD_BYTES + 2, 2);
  PREFIX.copy(marker, 4);
  photoDigest(input).copy(marker, 4 + PREFIX.length);
  return Buffer.concat([input.subarray(0, 2), marker, input.subarray(2)]);
}
