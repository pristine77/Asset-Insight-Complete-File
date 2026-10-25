import { describe, expect, it } from "vitest";
import {
  compactDeletedReportImages,
  getOwnedReportImageKey,
  runReportImageDeletionJob,
} from "../src/utils/reportImageDeletion.js";

describe("report image deletion compaction", () => {
  it("removes an unused image and remaps every later global index", () => {
    const urls = [
      "https://images.sellsnap.store/uploads/asset/0.jpg",
      "https://images.sellsnap.store/uploads/asset/1.jpg",
      "https://images.sellsnap.store/uploads/asset/2.jpg",
      "https://images.sellsnap.store/uploads/asset/3.jpg",
    ];
    const result = compactDeletedReportImages(
      {
        deleted_image_indexes: [1],
        lots: [
          {
            image_indexes: [0, 2],
            extra_image_indexes: [3],
            cover_index: 2,
            items: [{ image_index: 3 }],
          },
        ],
      },
      urls
    );

    expect(result.removedIndexes).toEqual([1]);
    expect(result.removedUrls).toEqual([urls[1]]);
    expect(result.imageUrls).toEqual([urls[0], urls[2], urls[3]]);
    expect(result.previewData.lots[0].image_indexes).toEqual([0, 1]);
    expect(result.previewData.lots[0].extra_image_indexes).toEqual([2]);
    expect(result.previewData.lots[0].cover_index).toBe(1);
    expect(result.previewData.lots[0].items[0].image_index).toBe(2);
    expect(result.previewData.deleted_image_indexes).toEqual([]);
  });

  it("prunes deleted cover photos while preserving the remaining selected order", () => {
    const urls = [
      "https://images.sellsnap.store/uploads/asset/cover-1.jpg",
      "https://images.sellsnap.store/uploads/asset/cover-2.jpg",
      "https://images.sellsnap.store/uploads/asset/cover-3.jpg",
    ];
    const result = compactDeletedReportImages(
      {
        cover_image_urls: [urls[2], urls[1], urls[0], urls[2]],
        deleted_image_indexes: [1],
        lots: [{ image_indexes: [0, 2] }],
      },
      urls
    );

    expect(result.previewData.cover_image_urls).toEqual([urls[2], urls[0]]);
    expect(result.imageUrls).toEqual([urls[0], urls[2]]);
    expect(result.removedUrls).toEqual([urls[1]]);
  });

  it("keeps a root image when another lot still references it", () => {
    const urls = [
      "https://images.sellsnap.store/uploads/asset/a.jpg",
      "https://images.sellsnap.store/uploads/asset/shared.jpg",
    ];
    const result = compactDeletedReportImages(
      {
        deleted_image_indexes: [1],
        lots: [{ image_indexes: [0] }, { image_indexes: [1] }],
      },
      urls
    );

    expect(result.removedUrls).toEqual([]);
    expect(result.imageUrls).toEqual(urls);
    expect(result.previewData.lots[1].image_indexes).toEqual([1]);
  });

  it("supports URL-only deletion markers without producing invalid indexes", () => {
    const target = "https://images.sellsnap.store/uploads/lot-listing/url-only.jpg";
    const result = compactDeletedReportImages(
      {
        deleted_image_urls: [target],
        deleted_image_indexes: [-1],
        lots: [{ image_indexes: [0] }],
      },
      ["https://images.sellsnap.store/uploads/lot-listing/keep.jpg", target]
    );

    expect(result.removedIndexes).toEqual([1]);
    expect(result.imageUrls).toHaveLength(1);
    expect(result.previewData.deleted_image_urls).toEqual([]);
  });

  it("queues an owned URL-only fallback even when it was never in the root index", () => {
    const fallback =
      "https://images.sellsnap.store/uploads/asset/preview-additions/fallback.jpg";
    const result = compactDeletedReportImages(
      {
        deleted_image_urls: [fallback],
        lots: [{ image_indexes: [0], image_urls: [] }],
      },
      ["https://images.sellsnap.store/uploads/asset/keep.jpg"]
    );

    expect(result.imageUrls).toHaveLength(1);
    expect(result.removedIndexes).toEqual([]);
    expect(result.removedUrls).toEqual([fallback]);
  });
});

describe("owned report upload keys", () => {
  it("accepts only exact current-origin report upload paths", () => {
    expect(
      getOwnedReportImageKey(
        "https://assetinsight.test/uploads/asset/preview-additions/photo.jpg?cache=1"
      )
    ).toBe("uploads/asset/preview-additions/photo.jpg");
    expect(
      getOwnedReportImageKey(
        "https://assetinsight.test/uploads/lot-listing/photo.jpg"
      )
    ).toBe("uploads/lot-listing/photo.jpg");
    expect(getOwnedReportImageKey("https://example.com/uploads/asset/photo.jpg")).toBeNull();
    expect(getOwnedReportImageKey("https://assetinsight.test/previews/report.xlsx")).toBeNull();
    expect(getOwnedReportImageKey("https://assetinsight.test/uploads/asset/../cv/file.pdf")).toBeNull();
  });

  it("retains legacy report images instead of treating them as deletion targets", () => {
    expect(
      getOwnedReportImageKey(
        "https://images.sellsnap.test/uploads/asset/preview-additions/photo.jpg"
      )
    ).toBeNull();
    expect(
      getOwnedReportImageKey(
        "https://images.sellsnap.test/uploads/lot-listing/photo.jpg"
      )
    ).toBeNull();
  });

  it("completes an already-queued legacy deletion job without touching storage", async () => {
    await expect(
      runReportImageDeletionJob({
        payload: {
          url: "https://images.sellsnap.test/uploads/asset/legacy.jpg",
          key: "uploads/asset/legacy.jpg",
        },
      } as any)
    ).resolves.toBeUndefined();
  });
});
