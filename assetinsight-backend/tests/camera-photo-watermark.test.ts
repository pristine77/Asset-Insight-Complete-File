import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { addPhotoWatermarkReceipt, hasPhotoWatermarkReceipt } from "../src/utils/photoWatermarkReceipt.js";
import { prepareImageWithoutWatermark, processImageWithLogo } from "../src/utils/imageProcessing.js";

describe.each(["jpeg", "webp", "avif"] as const)("camera %s watermark receipt", (format) => {
  it("preserves decoded pixels, verifies exact bytes and rejects corruption", async () => {
    const original = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#c7d5da" } }).toFormat(format).toBuffer();
    const marked = addPhotoWatermarkReceipt(original);
    expect(hasPhotoWatermarkReceipt(marked)).toBe(true);
    expect(addPhotoWatermarkReceipt(marked)).toBe(marked);
    expect(await sharp(marked).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
    expect((await prepareImageWithoutWatermark(marked, `image/${format}`, `camera.${format}`)).buffer).toBe(marked);
    const changed = Buffer.from(marked);
    changed[changed.length - 1] ^= 1;
    expect(hasPhotoWatermarkReceipt(changed)).toBe(false);
    expect(hasPhotoWatermarkReceipt(marked.subarray(0, marked.length - 2))).toBe(false);
    if (format === "webp") expect(marked.readUInt32LE(4)).toBe(marked.length - 8);
  });

  it("never adds a second logo if upload watermark is enabled", async () => {
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#d2d7da" } }).jpeg().toBuffer();
    const oneLogo = (await processImageWithLogo(photo, "public/logoNobg.png", { logoScale: 0.2 })).buffer;
    const encoded = await sharp(oneLogo).toFormat(format).toBuffer();
    const camera = addPhotoWatermarkReceipt(encoded);
    const output = await processImageWithLogo(camera, "public/logoNobg.png", { quality: 98 });
    if (format === "jpeg") expect(output.buffer).toBe(camera);
    else {
      const expected = await sharp(camera).rotate().jpeg({ quality: 98, mozjpeg: true }).toBuffer();
      expect(output.buffer).toEqual(addPhotoWatermarkReceipt(expected));
    }
    expect(hasPhotoWatermarkReceipt(output.buffer)).toBe(true);
  });
});
