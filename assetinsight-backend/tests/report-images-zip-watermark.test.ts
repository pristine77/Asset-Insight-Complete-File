import PizZip from "pizzip";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const downloadMocks = vi.hoisted(() => ({
  get: vi.fn(),
  cloudinaryConfigured: vi.fn(),
  cloudinaryUrl: vi.fn(),
  resolveStorage: vi.fn(),
  storageStream: vi.fn(),
}));

vi.mock("axios", () => ({ default: { get: downloadMocks.get } }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  resolveR2ObjectLocationFromUrl: downloadMocks.resolveStorage,
  getR2ObjectStream: downloadMocks.storageStream,
}));
vi.mock("../src/utils/cloudinary.js", () => ({
  isCloudinaryFetchConfigured: downloadMocks.cloudinaryConfigured,
  getCloudinaryCustomUrl: downloadMocks.cloudinaryUrl,
}));

import { generateImagesZip } from "../src/jobs/assetReportJob/imagesZip.js";
import { processImageWithLogo } from "../src/utils/imageProcessing.js";

const sourceUrl = "https://assetinsight.test/photos/mobile-capture.jpg";
const optimizedUrl = "https://optimizer.example.test/mobile-capture.jpg";
let watermarkedSource: Buffer;

function readExportedPhoto(archive: Buffer): Buffer {
  const zip = new PizZip(archive);
  expect(Object.keys(zip.files)).toEqual(["mobile-capture.jpg"]);
  return zip.file("mobile-capture.jpg")!.asNodeBuffer();
}

beforeAll(async () => {
  const photo = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 220, g: 225, b: 230 },
    },
  }).png().toBuffer();

  // Match a photo already processed during mobile upload. Its logo placement
  // differs from ZIP's old defaults, making a second stamp visible as well as
  // changing the bytes asserted below.
  ({ buffer: watermarkedSource } = await processImageWithLogo(
    photo,
    "public/logoNobg.png",
    { logoScale: 0.18, logoMarginPx: 8, logoMarginPct: 0 },
  ));
  expect((await sharp(watermarkedSource).metadata()).format).toBe("jpeg");
});

beforeEach(() => {
  vi.resetAllMocks();
  downloadMocks.cloudinaryConfigured.mockReturnValue(false);
  downloadMocks.resolveStorage.mockReturnValue(null);
  downloadMocks.cloudinaryUrl.mockReturnValue(optimizedUrl);
  downloadMocks.get.mockImplementation(async (url: string) => {
    if (url !== sourceUrl) throw new Error("Unexpected image download");
    return { data: watermarkedSource };
  });
});

describe("report images ZIP preserves previously watermarked photos", () => {
  it("fails the package instead of silently replacing a missing first photo with photo two", async () => {
    const privateUrl = "https://assetinsight.test/private-photo?secret=do-not-log";
    downloadMocks.get.mockImplementation(async (url: string) => {
      if (url === privateUrl) throw new Error(privateUrl);
      return { data: watermarkedSource };
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(generateImagesZip([privateUrl, sourceUrl], undefined, { optimizeSize: false }))
        .rejects.toThrow("Failed to include photo 1 of 2 in the media ZIP");
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it("preserves every one of 41 original photos in order despite out-of-order download completion", async () => {
    const urls = Array.from({ length: 41 }, (_, index) => `https://assetinsight.test/${index}.jpg`);
    const names = urls.map((_, index) => `Lot-001_Photo-${String(index + 1).padStart(3, "0")}.jpg`);
    downloadMocks.get.mockImplementation(async (url: string) => {
      const index = urls.indexOf(url);
      await new Promise((resolve) => setTimeout(resolve, (41 - index) % 5));
      return { data: Buffer.from(`original-photo-${index}`) };
    });
    const zip = new PizZip(await generateImagesZip(urls, undefined, { optimizeSize: false, filenames: names }));
    expect(Object.keys(zip.files)).toEqual(names);
    names.forEach((name, index) => expect(zip.file(name)!.asNodeBuffer()).toEqual(Buffer.from(`original-photo-${index}`)));
  });

  it("rejects an empty image download and does not leave other batch reads running", async () => {
    let active = 0;
    downloadMocks.get.mockImplementation(async (url: string) => {
      active += 1;
      await new Promise((resolve) => setTimeout(resolve, url === sourceUrl ? 1 : 10));
      active -= 1;
      return { data: url === sourceUrl ? Buffer.alloc(0) : watermarkedSource };
    });
    await expect(generateImagesZip([sourceUrl, "https://assetinsight.test/second.jpg"], undefined, { optimizeSize: false }))
      .rejects.toThrow("Failed to include photo 1 of 2");
    expect(active).toBe(0);
  });

  it("includes ordered camera clips byte-for-byte alongside photos, with unique names", async () => {
    const clip = Buffer.from("original 720p camera clip");
    downloadMocks.get.mockImplementation(async (url: string) => ({ data: url === sourceUrl ? watermarkedSource : clip }));
    const archive = await generateImagesZip([sourceUrl], undefined, {
      optimizeSize: false,
      rawFiles: [{ url: "https://assetinsight.test/one.mp4", filename: "Lot-002_Video-001.mp4" }, { url: "https://assetinsight.test/two.mp4", filename: "Lot-002_Video-001.mp4" }],
    });
    const zip = new PizZip(archive);
    expect(Object.keys(zip.files)).toEqual(["mobile-capture.jpg", "Lot-002_Video-001.mp4", "Lot-002_Video-001 (2).mp4"]);
    expect(zip.file("Lot-002_Video-001.mp4")!.asNodeBuffer()).toEqual(clip);
    expect(zip.file("Lot-002_Video-001 (2).mp4")!.asNodeBuffer()).toEqual(clip);
  });

  it("does not publish a successful incomplete ZIP when an original video fails", async () => {
    downloadMocks.get.mockRejectedValue(new Error("https://private-source.example/credential"));
    await expect(generateImagesZip([], undefined, { rawFiles: [{ url: "https://assetinsight.test/unavailable.mp4", filename: "clip.mp4" }] })).rejects.toThrow("Failed to include video 1 in the media ZIP");
  });

  it("limits raw-media fetches to four and preserves order across batches", async () => {
    let active = 0;
    let peak = 0;
    const original = process.env.REPORT_ZIP_VIDEO_FETCH_CONCURRENCY;
    process.env.REPORT_ZIP_VIDEO_FETCH_CONCURRENCY = "50";
    try {
      downloadMocks.get.mockImplementation(async (url: string) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { data: Buffer.from(url) };
      });
      const rawFiles = Array.from({ length: 11 }, (_, index) => ({ url: `https://assetinsight.test/${index}.mp4`, filename: `${index}.mp4` }));
      const zip = new PizZip(await generateImagesZip([], undefined, { rawFiles }));
      expect(peak).toBe(4);
      expect(Object.keys(zip.files)).toEqual(rawFiles.map((file) => file.filename));
      for (const file of rawFiles) expect(zip.file(file.filename)!.asNodeBuffer()).toEqual(Buffer.from(file.url));
    } finally {
      if (original === undefined) delete process.env.REPORT_ZIP_VIDEO_FETCH_CONCURRENCY;
      else process.env.REPORT_ZIP_VIDEO_FETCH_CONCURRENCY = original;
    }
  });

  it("also prevents a second logo when a caller accidentally repeats watermark opt-in", async () => {
    const archive = await generateImagesZip([sourceUrl], undefined, { watermark: true, optimizeSize: false });
    expect(readExportedPhoto(archive)).toEqual(watermarkedSource);
  });

  it("copies the stored photo unchanged with default export options", async () => {
    const archive = await generateImagesZip([sourceUrl]);

    expect(readExportedPhoto(archive)).toEqual(watermarkedSource);
    expect(downloadMocks.get).toHaveBeenCalledTimes(1);
    expect(downloadMocks.cloudinaryUrl).not.toHaveBeenCalled();
  });

  it("keeps the same photo bytes through repeated saves/exports with watermark disabled", async () => {
    const firstExport = readExportedPhoto(await generateImagesZip(
      [sourceUrl],
      undefined,
      { watermark: false, optimizeSize: false },
    ));
    downloadMocks.get.mockResolvedValue({ data: firstExport });

    const secondExport = readExportedPhoto(await generateImagesZip(
      [sourceUrl],
      undefined,
      { watermark: false, optimizeSize: false },
    ));

    expect(firstExport).toEqual(watermarkedSource);
    expect(secondExport).toEqual(watermarkedSource);
  });

  it("packages optimized photo bytes without applying a second logo", async () => {
    const optimizedPhoto = await sharp(watermarkedSource)
      .resize({ width: 480 })
      .jpeg({ quality: 85 })
      .toBuffer();
    downloadMocks.cloudinaryConfigured.mockReturnValue(true);
    downloadMocks.get.mockImplementation(async (url: string) => {
      if (url !== optimizedUrl) throw new Error("Unexpected image download");
      return { data: optimizedPhoto };
    });

    const archive = await generateImagesZip([sourceUrl]);

    expect(readExportedPhoto(archive)).toEqual(optimizedPhoto);
    expect(downloadMocks.get).toHaveBeenCalledTimes(1);
    expect(downloadMocks.get).toHaveBeenCalledWith(
      optimizedUrl,
      expect.objectContaining({ responseType: "arraybuffer" }),
    );
  });

  it("preserves the stored photo when optimization fails and falls back to the original", async () => {
    downloadMocks.cloudinaryConfigured.mockReturnValue(true);
    downloadMocks.get.mockImplementation(async (url: string) => {
      if (url === optimizedUrl) throw new Error("Optimizer unavailable");
      if (url === sourceUrl) return { data: watermarkedSource };
      throw new Error("Unexpected image download");
    });

    const archive = await generateImagesZip([sourceUrl]);

    expect(readExportedPhoto(archive)).toEqual(watermarkedSource);
    expect(downloadMocks.get.mock.calls.map(([url]) => url)).toEqual([
      optimizedUrl,
      sourceUrl,
    ]);
  });

  it("retains an explicit watermark opt-in for callers that provide unprocessed images", async () => {
    const unprocessedPhoto = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 220, g: 225, b: 230 },
      },
    }).jpeg().toBuffer();
    downloadMocks.get.mockResolvedValue({ data: unprocessedPhoto });
    const expected = await processImageWithLogo(unprocessedPhoto, "public/logoNobg.png");

    const archive = await generateImagesZip(
      [sourceUrl],
      undefined,
      { watermark: true, optimizeSize: false },
    );

    const photo = readExportedPhoto(archive);
    expect(photo).toEqual(expected.buffer);
    expect(photo).not.toEqual(unprocessedPhoto);
  });
});
