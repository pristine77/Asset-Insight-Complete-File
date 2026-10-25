import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  watermark: vi.fn(async (buffer: Buffer) => ({ buffer })),
  cleanupMulterFiles: vi.fn(async () => undefined),
  uploadBufferToR2: vi.fn(async (_buffer, _type, _bucket, key) =>
    `https://assetinsight.test/${key}`
  ),
}));

vi.mock("../src/utils/reportTempFiles.js", () => ({
  readMulterFileBuffer: async (file: Express.Multer.File) => file.buffer,
  cleanupMulterFiles: dependencies.cleanupMulterFiles,
}));

vi.mock("../src/utils/imageProcessing.js", () => ({
  processImageWithLogo: dependencies.watermark,
  prepareImageWithoutWatermark: async (
    buffer: Buffer,
    mimetype: string
  ) => ({ buffer, mimetype, extension: ".jpg" }),
  isHeicLikeImage: () => false,
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  getCurrentR2StorageTarget: () => ({
    bucketName: "asset-insight",
    publicBaseUrl: "https://assetinsight.test",
    generation: "current",
  }),
  getR2PublicUrl: (key: string) => `https://assetinsight.test/${key}`,
  uploadBufferToR2: dependencies.uploadBufferToR2,
}));

import {
  appendImagesToPreviewLot,
} from "../src/utils/previewLotImageUpload.js";

const imageFile = (name: string, bytes = "identical-photo") =>
  ({
    fieldname: "images",
    originalname: name,
    encoding: "7bit",
    mimetype: "image/jpeg",
    size: bytes.length,
    buffer: Buffer.from(bytes),
  }) as Express.Multer.File;

describe("preview image retry deduplication", () => {
  beforeEach(() => {
    dependencies.watermark.mockClear();
    dependencies.cleanupMulterFiles.mockClear();
    dependencies.uploadBufferToR2.mockClear();
  });

  it.each(["asset", "lot-listing"] as const)("defaults new %s preview photos off but retains opt-in", async (kind) => {
    const original = "https://images.sellsnap.store/existing.jpg";
    const input = {
      kind,
      reportId: "66c000000000000000000001",
      lotKey: "8",
      previewData: { lots: [{ lot_id: "8", image_indexes: [0] }] },
      rootImageUrls: [original],
      files: [imageFile("new.jpg")],
    };
    const first = await appendImagesToPreviewLot(input);
    expect(dependencies.watermark).not.toHaveBeenCalled();
    expect(dependencies.uploadBufferToR2.mock.calls[0][0]).toEqual(input.files[0].buffer);
    expect(first.imageUrls[0]).toBe(original);
    const optedIn = await appendImagesToPreviewLot({ ...input, watermarkImages: true });
    expect(dependencies.watermark).toHaveBeenCalledTimes(1);
    expect(optedIn.imageUrls[0]).toBe(original);
  });

  it("stores duplicate files in one batch only once", async () => {
    const result = await appendImagesToPreviewLot({
      kind: "asset",
      reportId: "66c000000000000000000001",
      lotKey: "8",
      previewData: {
        lots: [{ lot_id: "8", image_indexes: [], extra_image_indexes: [] }],
      },
      rootImageUrls: [],
      files: [imageFile("first.jpg"), imageFile("renamed-copy.jpeg")],
      watermarkImages: false,
    });

    expect(dependencies.uploadBufferToR2).toHaveBeenCalledTimes(1);
    expect(result.imageUrls).toHaveLength(1);
    expect(result.added).toHaveLength(1);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.previewData.lots[0].extra_image_indexes).toEqual([0]);
    expect(dependencies.cleanupMulterFiles).toHaveBeenCalledTimes(1);
  });

  it("turns a lost-response retry into a no-op without another R2 write", async () => {
    const initial = await appendImagesToPreviewLot({
      kind: "lot-listing",
      reportId: "66c000000000000000000002",
      lotKey: "lot-4",
      previewData: {
        lots: [{ lot_id: "lot-4", image_indexes: [], extra_image_indexes: [] }],
      },
      rootImageUrls: [],
      files: [imageFile("photo.jpg")],
      watermarkImages: false,
    });

    const retry = await appendImagesToPreviewLot({
      kind: "lot-listing",
      reportId: "66c000000000000000000002",
      lotKey: "4",
      previewData: initial.previewData,
      rootImageUrls: initial.imageUrls,
      files: [imageFile("photo-again.jpg")],
      watermarkImages: false,
    });

    expect(dependencies.uploadBufferToR2).toHaveBeenCalledTimes(1);
    expect(retry.imageUrls).toEqual(initial.imageUrls);
    expect(retry.added).toEqual([]);
    expect(retry.duplicatesSkipped).toBe(1);
  });

  it("keeps image identity stable when a lot number is edited", async () => {
    const initial = await appendImagesToPreviewLot({
      kind: "asset",
      reportId: "66c000000000000000000003",
      lotKey: "4",
      previewData: {
        lots: [
          {
            lot_id: "stable-lot-id",
            lot_number: "4",
            image_indexes: [],
            extra_image_indexes: [],
          },
        ],
      },
      rootImageUrls: [],
      files: [imageFile("photo.jpg")],
      watermarkImages: false,
    });

    const editedPreview = {
      ...initial.previewData,
      lots: initial.previewData.lots.map((lot: any) => ({
        ...lot,
        lot_number: "99",
      })),
    };
    const retry = await appendImagesToPreviewLot({
      kind: "asset",
      reportId: "66c000000000000000000003",
      lotKey: "99",
      previewData: editedPreview,
      rootImageUrls: initial.imageUrls,
      files: [imageFile("renamed.png")],
      watermarkImages: false,
    });

    expect(dependencies.uploadBufferToR2).toHaveBeenCalledTimes(1);
    expect(retry.added).toEqual([]);
    expect(retry.duplicatesSkipped).toBe(1);
  });
});
