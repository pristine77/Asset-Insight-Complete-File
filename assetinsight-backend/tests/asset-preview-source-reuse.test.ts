import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import { runAssetPreviewJob } from "../src/jobs/assetReportJob/previewJob.js";
import { analyzeAssetImages } from "../src/service/assetOpenAIService.js";
import { prepareImageWithoutWatermark, processImageWithLogo } from "../src/utils/imageProcessing.js";
import { cleanupMulterFiles, readMulterFileBuffer } from "../src/utils/reportTempFiles.js";
import { getR2PublicUrl, uploadBufferToR2 } from "../src/utils/r2Storage/r2Upload.js";

vi.mock("../src/utils/imageProcessing.js", async (original) => ({
  ...await original<typeof import("../src/utils/imageProcessing.js")>(),
  prepareImageWithoutWatermark: vi.fn(async (buffer: Buffer) => ({ buffer, mimetype: "image/jpeg", extension: ".jpg" })),
  processImageWithLogo: vi.fn(async (buffer: Buffer) => ({ buffer: Buffer.concat([Buffer.from("marked:"), buffer]) })),
}));
vi.mock("../src/utils/reportTempFiles.js", () => ({
  readMulterFileBuffer: vi.fn(async (file: Express.Multer.File) => file.buffer || Buffer.from(file.originalname)),
  cleanupMulterFiles: vi.fn(async () => {}),
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(),
  uploadBufferToR2: vi.fn(async () => "mock upload"),
  readR2ObjectBuffer: vi.fn(async () => { throw new Error("Unexpected storage access"); }),
}));
vi.mock("../src/service/assetOpenAIService.js", () => ({
  analyzeAssetImages: vi.fn(async () => ({ lots: [{
    lot_number: "157", title: "Workbench", description: "Steel workbench with one drawer.",
    categories: "Shop Equipment", estimated_value: "CAD 800", image_indexes: [0, 1],
  }] })),
}));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (original) => ({
  ...await original<typeof import("../src/service/bundleLotAnalysisPolicy.js")>(),
  detectBundleLotNumbersFromPhotos: vi.fn(async () => new Map([[0, "157"]])),
}));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({
  registerFocusBoxes: vi.fn(), clearFocusBoxes: vi.fn(),
}));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn(() => { throw new Error("Unexpected provider call"); }) } } }));
vi.mock("../src/service/vehicleApiService.js", async (original) => ({
  ...await original<typeof import("../src/service/vehicleApiService.js")>(),
  enrichLotsWithVin: vi.fn(async (lots) => lots),
}));
vi.mock("../src/service/lotListingSpecEnrichmentService.js", () => ({ enrichAuctioneerImportSpecs: vi.fn(async ({ lots }) => ({ lots, analyses: [] })) }));
vi.mock("../src/service/reportGenerationProgressService.js", () => ({ setReportGenerationProgress: vi.fn(async () => {}) }));
vi.mock("../src/service/assetEmailService.js", () => ({ sendPreviewReadyEmail: vi.fn(() => { throw new Error("Unexpected email"); }) }));

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.db!.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function directPhoto(index: number, overrides: Record<string, unknown> = {}): Express.Multer.File {
  const key = `uploads/asset/sessions/test/photo-${index}.jpg`;
  return {
    fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg",
    r2Key: key, r2Bucket: "asset-insight-test", r2PublicUrl: `https://assetinsight.test/${key}`,
    ...overrides,
  } as Express.Multer.File;
}

async function generate(images: Express.Multer.File[], details: Record<string, unknown> = {}) {
  const userId = new mongoose.Types.ObjectId();
  await runAssetPreviewJob({
    user: { id: String(userId), email: "source-reuse@example.test" },
    images,
    details: {
      contract_no: "SOURCE-REUSE", draft_preview: true, include_damage_analysis: false,
      grouping_mode: "mixed",
      mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot" }],
      ...details,
    },
  }, { deferSourceFileCleanup: true });
  return await AssetReport.findOne({ user: userId }).lean() as any;
}

describe("Asset preview durable source reuse", () => {
  it.each([undefined, false])("reuses verified direct sources with watermark %s while preserving cover and report-only photos", async (watermark) => {
    const images = [directPhoto(1), directPhoto(2), directPhoto(3)];
    const urls = images.map((file: any) => file.r2PublicUrl);
    const stored = await generate(images, { watermark_images: watermark });

    expect(readMulterFileBuffer).not.toHaveBeenCalled();
    expect(prepareImageWithoutWatermark).not.toHaveBeenCalled();
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(uploadBufferToR2).not.toHaveBeenCalled();
    expect(stored.imageUrls).toEqual(urls);
    expect(stored.preview_data.lots[0]).toMatchObject({
      image_url: urls[1], image_urls: urls.slice(0, 2), image_indexes: [0, 1],
      extra_image_urls: urls.slice(2), extra_image_indexes: [2],
    });
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(urls.slice(0, 2));
    expect(cleanupMulterFiles).not.toHaveBeenCalled();
  });

  it("preserves all 5000 source photos in order without downloading or uploading them again", async () => {
    const images = Array.from({ length: 5000 }, (_, index) => directPhoto(index));
    const urls = images.map((file: any) => file.r2PublicUrl);
    const stored = await generate(images, { grouping_mode: "single_lot", cover_index: 4998 });

    expect(stored.imageUrls).toEqual(urls);
    expect(stored.preview_data.lots[0].image_urls).toEqual(urls);
    expect(stored.preview_data.lots[0].image_url).toBe(urls[4998]);
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual([...urls.slice(0, 99), urls[4999]]);
    expect(readMulterFileBuffer).not.toHaveBeenCalled();
    expect(uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("retains HEIC conversion for main and extra photos while reusing the JPEG in between", async () => {
    const images = [
      directPhoto(1, { originalname: "camera.heic", mimetype: "image/heic" }),
      directPhoto(2),
      directPhoto(3, { originalname: "extra.HEIF", mimetype: "application/octet-stream" }),
    ];
    const stored = await generate(images);

    expect(readMulterFileBuffer).toHaveBeenCalledTimes(2);
    expect(prepareImageWithoutWatermark).toHaveBeenCalledTimes(2);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    const uploads = vi.mocked(uploadBufferToR2).mock.calls;
    expect(uploads).toHaveLength(2);
    expect(uploads.every((call) => call[1] === "image/jpeg" && call[3].endsWith(".jpg"))).toBe(true);
    expect(stored.imageUrls).toEqual([getR2PublicUrl(uploads[0][3]), (images[1] as any).r2PublicUrl, getR2PublicUrl(uploads[1][3])]);
    expect(stored.preview_data.lots[0].extra_image_urls).toEqual(stored.imageUrls.slice(2));
  });

  it("keeps explicit watermark opt-in on the bounded transform/upload path", async () => {
    const images = [directPhoto(1), directPhoto(2), directPhoto(3)];
    const stored = await generate(images, { watermark_images: true });
    expect(readMulterFileBuffer).toHaveBeenCalledTimes(3);
    expect(processImageWithLogo).toHaveBeenCalledTimes(3);
    expect(prepareImageWithoutWatermark).not.toHaveBeenCalled();
    expect(uploadBufferToR2).toHaveBeenCalledTimes(3);
    expect(stored.imageUrls.every((url: string) => url.includes("/uploads/asset/initial/"))).toBe(true);
  });

  it("keeps required conversions bounded and retains source order when they finish out of order", async () => {
    const previous = process.env.ASSET_IMAGE_UPLOAD_CONCURRENCY;
    process.env.ASSET_IMAGE_UPLOAD_CONCURRENCY = "2";
    let active = 0;
    let maximum = 0;
    vi.mocked(prepareImageWithoutWatermark).mockImplementation(async (buffer) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, buffer.toString().includes("-0.") ? 10 : 1));
      active -= 1;
      return { buffer, mimetype: "image/jpeg", extension: ".jpg" };
    });
    try {
      const images = Array.from({ length: 12 }, (_, index) => directPhoto(index, {
        originalname: `photo-${index}.heic`, mimetype: "image/heic",
      }));
      const stored = await generate(images, { grouping_mode: "single_lot" });
      expect(maximum).toBe(2);
      expect(uploadBufferToR2).toHaveBeenCalledTimes(12);
      const uploadedByContents = new Map(vi.mocked(uploadBufferToR2).mock.calls.map(([buffer, , , key]) => [buffer.toString(), getR2PublicUrl(key)]));
      expect(stored.imageUrls).toEqual(images.map((file) => uploadedByContents.get(file.originalname)));
    } finally {
      if (previous === undefined) delete process.env.ASSET_IMAGE_UPLOAD_CONCURRENCY;
      else process.env.ASSET_IMAGE_UPLOAD_CONCURRENCY = previous;
      vi.mocked(prepareImageWithoutWatermark).mockImplementation(async (buffer) => ({ buffer, mimetype: "image/jpeg", extension: ".jpg" }));
    }
  });

  it.each([
    ["URL without source identity", { r2Key: undefined }],
    ["different key", { r2Key: "uploads/asset/other/photo.jpg" }],
    ["different storage generation", { r2Bucket: "sellsnap-test" }],
    ["foreign origin", { r2PublicUrl: "https://untrusted.example/photo.jpg" }],
    ["credential-bearing URL", { r2PublicUrl: "https://user@assetinsight.test/uploads/asset/sessions/test/photo-1.jpg" }],
    ["path traversal", { r2PublicUrl: "https://assetinsight.test/uploads/../asset/sessions/test/photo-1.jpg" }],
    ["local replacement bytes", { buffer: Buffer.from("replacement bytes") }],
    ["local source path", { path: "/tmp/no-real-read-permitted.jpg" }],
  ])("does not trust %s as a reusable server source", async (_name, overrides) => {
    const image = directPhoto(1, overrides as Record<string, unknown>);
    const stored = await generate([image], { grouping_mode: "single_lot" });
    expect(readMulterFileBuffer).toHaveBeenCalledWith(image);
    expect(prepareImageWithoutWatermark).toHaveBeenCalledTimes(1);
    expect(uploadBufferToR2).toHaveBeenCalledTimes(1);
    expect(stored.imageUrls[0]).toContain("/uploads/asset/initial/");
  });

  it("keeps a matching legacy source read-only instead of copying or deleting it", async () => {
    const image = directPhoto(1, {
      r2Bucket: "sellsnap-test",
      r2PublicUrl: "https://images.sellsnap.test/uploads/asset/sessions/test/photo-1.jpg",
    });
    const stored = await generate([image], { grouping_mode: "single_lot" });
    expect(stored.imageUrls).toEqual([(image as any).r2PublicUrl]);
    expect(readMulterFileBuffer).not.toHaveBeenCalled();
    expect(uploadBufferToR2).not.toHaveBeenCalled();
    expect(cleanupMulterFiles).not.toHaveBeenCalled();
  });

  it("does not analyze or publish a reusable image after execution ownership is lost", async () => {
    const generation = "source-reuse-ownership";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(), status: "processing", job_status: "queued", job_id: generation,
      grouping_mode: "single_lot",
    });
    let checks = 0;
    await expect(runAssetPreviewJob({
      reportId: String(report._id), progressId: generation,
      user: { id: String(report.user), email: "ownership@example.test" }, images: [directPhoto(1)],
      details: { draft_preview: true, grouping_mode: "single_lot" },
    }, {
      deferSourceFileCleanup: true,
      executionContext: {
        executionToken: "current-attempt", signal: new AbortController().signal,
        assertOwned: async () => {
          if (++checks === 3) throw Object.assign(new Error("Lease lost"), { code: "REPORT_JOB_OWNERSHIP_LOST" });
        },
      },
    })).rejects.toMatchObject({ code: "REPORT_JOB_OWNERSHIP_LOST" });
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(readMulterFileBuffer).not.toHaveBeenCalled();
    expect(uploadBufferToR2).not.toHaveBeenCalled();
    expect(cleanupMulterFiles).not.toHaveBeenCalled();
    expect((await AssetReport.findById(report._id).lean())?.status).toBe("processing");
  });
});
