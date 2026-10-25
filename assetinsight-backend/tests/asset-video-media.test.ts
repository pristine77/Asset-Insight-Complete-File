import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), stream: vi.fn(), analyze: vi.fn(), detect: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(),
  uploadBufferToR2: mocks.upload,
  uploadFilePathToR2: mocks.stream,
}));
vi.mock("../src/service/assetOpenAIService.js", () => ({ analyzeAssetImages: mocks.analyze }));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (original) => ({
  ...await original<typeof import("../src/service/bundleLotAnalysisPolicy.js")>(),
  detectBundleLotNumbersFromPhotos: mocks.detect,
}));
vi.mock("../src/service/vehicleApiService.js", async (original) => ({
  ...await original<typeof import("../src/service/vehicleApiService.js")>(),
  enrichLotsWithVin: async (lots: any[]) => lots,
}));
vi.mock("../src/service/reportGenerationProgressService.js", () => ({ setReportGenerationProgress: vi.fn() }));
vi.mock("../src/service/assetEmailService.js", () => ({ sendPreviewReadyEmail: vi.fn() }));
vi.mock("../src/utils/reportJobMongoQueue.js", async (original) => ({
  ...await original<typeof import("../src/utils/reportJobMongoQueue.js")>(),
  updateMongoReportJobProgress: vi.fn(),
  endMongoReportJobProgress: vi.fn(),
}));

import { assignAssetLotVideos, buildAssetVideoZipInputs, uploadAssetPreviewVideos } from "../src/jobs/assetReportJob/videos.js";
import { runAssetPreviewJob } from "../src/jobs/assetReportJob/previewJob.js";
import AssetReport from "../src/models/asset.model.js";
import { syncAssetPreviewDataToRoot } from "../src/utils/assetPreviewRootSync.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.db!.dropDatabase();
  mocks.upload.mockResolvedValue("uploaded");
  mocks.stream.mockResolvedValue("uploaded");
  mocks.detect.mockResolvedValue(new Map([[0, "157"], [1, "158"]]));
  mocks.analyze.mockResolvedValue({ lots: [{ title: "Vehicle", description: "Captured vehicle", estimated_value: "CAD 1500", image_indexes: [0] }] });
});

const video = (name = "capture.mp4") => ({ fieldname: "videos", originalname: name, mimetype: "video/mp4", buffer: Buffer.from("original camera clip") } as Express.Multer.File);
const options = { reportId: "report-video", generationToken: "accepted-job" };

describe("Asset video media", () => {
  it("uploads original bytes to position/content-bound current R2 keys on exact retries", async () => {
    const first = await uploadAssetPreviewVideos([video(), video()], options);
    expect(await uploadAssetPreviewVideos([video(), video()], options)).toEqual(first);
    expect(new Set(first).size).toBe(2);
    expect(first[0]).toMatch(/^https:\/\/assetinsight.test\/uploads\/asset\/videos\/[a-f0-9]{24}\/000000-[a-f0-9]{64}\.mp4$/);
    expect(mocks.upload.mock.calls[0].slice(0, 3)).toEqual([video().buffer, "video/mp4", "asset-insight-test"]);
  });

  it("reuses verified R2 media without copying and ignores an unrelated public URL", async () => {
    const saved = { r2Key: "source/clip.mp4", r2Bucket: "asset-insight-test", r2PublicUrl: "https://untrusted.example/clip.mp4" };
    expect(await uploadAssetPreviewVideos([saved as any], options)).toEqual(["https://assetinsight.test/source/clip.mp4"]);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(await uploadAssetPreviewVideos([{ r2Key: "old/clip.mov" } as any], options)).toEqual(["https://images.sellsnap.test/old/clip.mov"]);
  });

  it("streams multipart video from disk and uses actual size rather than supplied size", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "asset-video-test-"));
    try {
      const source = path.join(directory, "clip.mov");
      await writeFile(source, Buffer.from("original mov bytes"));
      const file = { path: source, originalname: "clip.mov", mimetype: "video/quicktime", size: 999999 } as Express.Multer.File;
      const urls = await uploadAssetPreviewVideos([file], options);
      expect(urls[0]).toMatch(/\.mov$/);
      expect(mocks.stream).toHaveBeenCalledWith(source, "video/quicktime", "asset-insight-test", expect.any(String), 18);
      expect(mocks.upload).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("caps concurrent conversions/uploads at four and preserves input order", async () => {
    let active = 0;
    let maximum = 0;
    mocks.upload.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });
    const urls = await uploadAssetPreviewVideos(Array.from({ length: 11 }, () => video()), options);
    expect(maximum).toBe(4);
    expect(urls).toHaveLength(11);
    expect(urls[10]).toContain("/000010-");
  });

  it("refuses missing clips and stops before upload when execution ownership is lost", async () => {
    await expect(uploadAssetPreviewVideos([{} as any], options)).rejects.toThrow("Missing upload video 1");
    await expect(uploadAssetPreviewVideos([video()], { ...options, assertOwned: async () => { throw new Error("lost lease"); } })).rejects.toThrow("lost lease");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps sparse multipart videos on their original lot and only the first split row", () => {
    const lots = [{ mixed_group_index: 1 }, { mixed_group_index: 2 }, { mixed_group_index: 2 }, { mixed_group_index: 3 }];
    const details = { grouping_mode: "mixed", mixed_lots: [{ video_count: 0 }, { video_count: 2 }, { video_count: 0 }] };
    expect(assignAssetLotVideos(lots, [{}, {}], ["a", "b"], details).map((lot) => lot.video_urls)).toEqual([[], ["a", "b"], [], []]);
    expect(assignAssetLotVideos(lots, [{ lotIndex: 2 }], ["c"], details).map((lot) => lot.video_urls)).toEqual([[], [], [], ["c"]]);
  });

  it("does not guess a sparse legacy lot when neither group counts nor indexes exist", () => {
    const lots = assignAssetLotVideos([{ mixed_group_index: 1 }, { mixed_group_index: 2 }], [{}], ["https://assetinsight.test/v.mp4"], { grouping_mode: "mixed" });
    expect(lots.every((lot) => lot.video_urls.length === 0)).toBe(true);
    expect(buildAssetVideoZipInputs(lots, ["https://assetinsight.test/v.mp4"])[0].filename).toContain("Unassigned-Video.mp4");
  });

  it("retains per-lot order, deduplicates references and excludes edited non-manifest sources", () => {
    const clips = ["https://assetinsight.test/v1.mp4", "https://assetinsight.test/v2.mov"];
    const lots = [{ title: "Truck", video_urls: [clips[1], clips[1], "https://private.invalid/injected"] }];
    const entries = buildAssetVideoZipInputs(lots, clips);
    expect(entries.map((entry) => entry.url)).toEqual([clips[1], clips[0]]);
    expect(entries[0].filename).toBe("Lot-001_Video-001_Truck - Lot #1.mov");
  });

  it.each([false, true])("persists clips through initial preview, explicit edits and reopening (direct R2: %s)", async (direct) => {
    const userId = new mongoose.Types.ObjectId();
    const images = [0, 1].map((index) => ({ r2Key: `photos/${index}.jpg`, r2Bucket: "asset-insight-test", r2PublicUrl: `https://assetinsight.test/photos/${index}.jpg`, originalname: `${index}.jpg`, mimetype: "image/jpeg" } as any));
    const clips = direct ? [{ r2Key: "captures/clip.mp4", r2Bucket: "asset-insight-test", lotIndex: 1 } as any] : [video()];
    await runAssetPreviewJob({ user: { id: String(userId), email: "video@example.test" }, images, videos: clips, details: {
      grouping_mode: "mixed", watermark_images: false, draft_preview: true, include_damage_analysis: false,
      mixed_lots: [{ count: 1, mode: "single_lot", video_count: 0 }, { count: 1, mode: "single_lot", video_count: 1 }],
    } });
    const report: any = await AssetReport.findOne({ user: userId });
    expect(report.status).toBe("preview");
    expect(report.videoUrls).toHaveLength(1);
    expect(report.preview_data.videoUrls).toEqual(report.videoUrls);
    expect(report.lots.map((lot: any) => lot.video_urls)).toEqual([[], report.videoUrls]);
    expect(report.preview_data.lots.map((lot: any) => lot.video_urls)).toEqual([[], report.videoUrls]);
    expect(mocks.analyze.mock.calls.every(([urls]) => urls.every((url: string) => url.endsWith(".jpg")))).toBe(true);
    const edited = { ...report.preview_data, lots: report.preview_data.lots.map((lot: any) => ({ ...lot, title: "Reviewed vehicle" })) };
    report.preview_data = edited;
    syncAssetPreviewDataToRoot(report, edited);
    await report.save();
    const reopened: any = await AssetReport.findById(report._id).lean();
    expect(reopened.lots[1].video_urls).toEqual(report.videoUrls);
    expect(buildAssetVideoZipInputs(reopened.preview_data.lots, reopened.videoUrls)).toHaveLength(1);
    expect(reopened.imageUrls).toEqual(images.map((image) => image.r2PublicUrl));
  });
});
