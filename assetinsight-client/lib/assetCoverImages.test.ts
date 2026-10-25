import { describe, expect, it } from "vitest";
import {
  collectAssetCoverImageUrls,
  MAX_ASSET_COVER_IMAGES,
  normalizeAssetCoverImageUrls,
} from "./assetCoverImages";

describe("asset cover image helpers", () => {
  it("collects every unique active report-owned photo in upload order", () => {
    const rootImages = [
      "https://images.test/root-a.jpg",
      "https://images.test/deleted-by-index.jpg",
      "https://images.test/root-c.jpg",
      "https://images.test/unassigned.jpg",
      "https://images.test/root-a.jpg",
    ];
    const previewData = {
      deleted_image_indexes: [1],
      deleted_image_urls: ["https://images.test/deleted-by-url.jpg"],
      lots: [
        {
          image_url: "https://images.test/primary-a.jpg",
          image_urls: [
            "https://images.test/primary-a.jpg",
            "https://images.test/root-a.jpg",
            "https://images.test/deleted-by-url.jpg",
          ],
          image_indexes: [0, 1, 2],
          extra_image_urls: ["https://images.test/extra-a.jpg"],
          items: [
            {
              image_url: "https://images.test/item-a.jpg",
              image_urls: ["https://images.test/item-b.jpg"],
            },
          ],
        },
        {
          cover_url: "https://images.test/cover-b.jpg",
          image_indexes: [2],
        },
      ],
      image_urls: ["https://images.test/preview-only.jpg"],
    };

    expect(collectAssetCoverImageUrls(previewData, rootImages)).toEqual([
      "https://images.test/root-a.jpg",
      "https://images.test/root-c.jpg",
      "https://images.test/unassigned.jpg",
    ]);
  });

  it("normalizes and prunes an ordered persisted selection to four candidates", () => {
    const candidates = ["one.jpg", "two.jpg", "three.jpg", "four.jpg", "five.jpg"];

    expect(
      normalizeAssetCoverImageUrls(
        [" two.jpg ", "missing.jpg", "one.jpg", "two.jpg", "four.jpg", "five.jpg", "three.jpg"],
        candidates
      )
    ).toEqual(["two.jpg", "one.jpg", "four.jpg", "five.jpg"]);
    expect(MAX_ASSET_COVER_IMAGES).toBe(4);
  });

  it("handles malformed values and an explicit zero limit", () => {
    expect(normalizeAssetCoverImageUrls("one.jpg", ["one.jpg"])).toEqual([]);
    expect(normalizeAssetCoverImageUrls(["one.jpg"], ["one.jpg"], 0)).toEqual([]);
    expect(collectAssetCoverImageUrls(null, null)).toEqual([]);
  });
});
