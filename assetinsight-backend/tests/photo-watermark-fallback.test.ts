import sharp from "sharp";
import { expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ nextDecode: false }));
vi.mock("sharp", async (original) => {
  const actual = await original<typeof import("sharp")>();
  const wrapper = (...args: any[]) => {
    if (failure.nextDecode) {
      failure.nextDecode = false;
      throw new Error("TEST_SHARP_FALLBACK");
    }
    return (actual.default as any)(...args);
  };
  return { ...actual, default: Object.assign(wrapper, actual.default) };
});

import { processImageWithLogo } from "../src/utils/imageProcessing.js";
import { hasPhotoWatermarkReceipt } from "../src/utils/photoWatermarkReceipt.js";

it("protects Jimp fallback output from a later second Sharp watermark", async () => {
  const source = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#bac8d2" } }).jpeg().toBuffer();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    failure.nextDecode = true;
    const first = await processImageWithLogo(source, "public/logoNobg.png");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("falling back to Jimp"), expect.any(Error));
    expect(hasPhotoWatermarkReceipt(first.buffer)).toBe(true);
    expect((await sharp(first.buffer).metadata()).width).toBe(320);
    const second = await processImageWithLogo(first.buffer, "public/logoNobg.png");
    expect(second.buffer).toBe(first.buffer);
  } finally {
    warning.mockRestore();
    failure.nextDecode = false;
  }
});
