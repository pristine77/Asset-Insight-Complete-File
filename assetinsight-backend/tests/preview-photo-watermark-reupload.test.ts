import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ upload: vi.fn(async (_bytes, _type, _bucket, key) => `https://assetinsight.test/${key}`) }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  getCurrentR2StorageTarget: () => ({ bucketName: "asset-insight-test", publicBaseUrl: "https://assetinsight.test", generation: "current" }),
  getR2PublicUrl: (key: string) => `https://assetinsight.test/${key}`,
  uploadBufferToR2: storage.upload,
}));
vi.mock("../src/utils/reportTempFiles.js", () => ({
  readMulterFileBuffer: async (file: Express.Multer.File) => file.buffer,
  cleanupMulterFiles: async () => {},
}));

import { appendImagesToPreviewLot } from "../src/utils/previewLotImageUpload.js";
import { processImageWithLogo } from "../src/utils/imageProcessing.js";

beforeEach(() => { vi.clearAllMocks(); });

describe.each(["asset", "lot-listing"] as const)("%s real-image re-upload", (kind) => {
  it("preserves one logo and coalesces a downloaded-photo retry without altering saved media", async () => {
    const source = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#c8d2da" } }).jpeg().toBuffer();
    const marked = (await processImageWithLogo(source, "public/logoNobg.png")).buffer;
    const file = { fieldname: "images", originalname: "capture.jpg", mimetype: "image/jpeg", buffer: marked } as Express.Multer.File;
    const saved = "https://images.sellsnap.store/legacy-main.jpg";
    const input = {
      kind, reportId: "66c000000000000000000001", lotKey: "157", watermarkImages: true,
      rootImageUrls: [saved],
      previewData: { lots: [{ lot_id: "157", image_indexes: [0], image_urls: [saved], cover_index: 0 }] },
      files: [file],
    };
    const first = await appendImagesToPreviewLot(input);
    expect(storage.upload.mock.calls[0][0]).toBe(marked);
    expect(first.imageUrls[0]).toBe(saved);
    expect(first.previewData.lots[0].cover_index).toBe(0);
    const retry = await appendImagesToPreviewLot({ ...input,
      rootImageUrls: first.imageUrls, previewData: first.previewData,
      files: [{ ...file, originalname: "downloaded-copy.jpg" }],
    });
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(retry.imageUrls).toEqual(first.imageUrls);
    expect(retry.duplicatesSkipped).toBe(1);
  });
});
