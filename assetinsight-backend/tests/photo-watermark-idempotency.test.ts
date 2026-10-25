import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImageWithLogo, prepareImageWithoutWatermark } from "../src/utils/imageProcessing.js";
import { addPhotoWatermarkReceipt, hasPhotoWatermarkReceipt } from "../src/utils/photoWatermarkReceipt.js";

const logo = "public/logoNobg.png";
const photo = () => sharp({ create: {
  width: 640, height: 480, channels: 3, background: "#bbc5cc",
} }).jpeg().toBuffer();

describe("watermark receipt", () => {
  it("records completion without changing decoded pixels or adding private EXIF", async () => {
    const original = await photo();
    const marked = addPhotoWatermarkReceipt(original);
    expect(hasPhotoWatermarkReceipt(original)).toBe(false);
    expect(hasPhotoWatermarkReceipt(marked)).toBe(true);
    expect(addPhotoWatermarkReceipt(marked)).toBe(marked);
    expect(await sharp(marked).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
    expect((await sharp(marked).metadata()).exif).toBeUndefined();
  });

  it("does not trust truncated, stale, or malformed receipts", async () => {
    const marked = addPhotoWatermarkReceipt(await photo());
    const changedPixels = Buffer.from(marked);
    changedPixels[changedPixels.length - 10] ^= 1;
    const changedLength = Buffer.from(marked);
    changedLength.writeUInt16BE(65535, 4);
    const changedVersion = Buffer.from(marked);
    changedVersion[10] ^= 1;
    for (const input of [Buffer.alloc(0), Buffer.from("not a photo"), marked.subarray(0, 30), changedPixels, changedLength, changedVersion]) {
      expect(hasPhotoWatermarkReceipt(input)).toBe(false);
    }
  });
});

describe("new-photo watermark processing is idempotent", () => {
  it("adds one logo, then preserves exact bytes across re-upload and changed stamp options", async () => {
    const original = await photo();
    const first = await processImageWithLogo(original, logo, { logoScale: 0.2 });
    expect(first.buffer).not.toEqual(original);
    expect(hasPhotoWatermarkReceipt(first.buffer)).toBe(true);
    const second = await processImageWithLogo(first.buffer, logo);
    const third = await processImageWithLogo(second.buffer, logo, { logoPosition: "top_right" });
    expect(second.buffer).toBe(first.buffer);
    expect(third.buffer).toBe(first.buffer);
  });

  it("retains one-logo bytes with watermarking disabled", async () => {
    const first = await processImageWithLogo(await photo(), logo);
    const disabled = await prepareImageWithoutWatermark(first.buffer, "image/jpeg", "capture.jpg");
    expect(disabled.buffer).toBe(first.buffer);
    expect(hasPhotoWatermarkReceipt(disabled.buffer)).toBe(true);
  });

  it("does not pretend a legacy unmarked JPEG has a receipt", async () => {
    const legacy = await sharp((await processImageWithLogo(await photo(), logo)).buffer).jpeg().toBuffer();
    expect(hasPhotoWatermarkReceipt(legacy)).toBe(false);
    // Legacy pixels cannot be unwatermarked using metadata; opt-out preserves them.
    expect((await prepareImageWithoutWatermark(legacy, "image/jpeg", "legacy.jpg")).buffer).toBe(legacy);
  });
});
