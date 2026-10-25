import { describe, expect, it, vi } from "vitest";
import {
  analyzeMixedAssetGroupWithFallback,
  buildMixedAssetFallbackLots,
} from "../src/jobs/assetReportJob/mixedGroupAnalysis.js";

describe("asset preview mixed-group fallback", () => {
  it("preserves every submitted main image when analysis throws", async () => {
    const providerError = new Error("provider unavailable");
    const analyze = vi.fn().mockRejectedValue(providerError);

    const result = await analyzeMixedAssetGroupWithFallback({
      analyze,
      fallbackContext: {
        groupIndex: 3,
        subMode: "per_item",
        sourceKey: "auction-lot-4",
        currency: "CAD",
        imageUrls: ["main-1", "main-2", "extra-1"],
        mainImageIndexes: [0, 1],
        extraImageIndexes: [2],
        coverIndex: 0,
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe(providerError);
    expect(result.fallbackLots).toHaveLength(2);
    expect(result.fallbackLots).toEqual([
      expect.objectContaining({
        title: "Lot 4 Image 1",
        image_indexes: [0],
        image_urls: ["main-1"],
        extra_image_indexes: [2],
        extra_image_urls: ["extra-1"],
        auctioneer_source_key: "auction-lot-4:1",
        tags: ["mode:per_item", "needs_review"],
      }),
      expect.objectContaining({
        title: "Lot 4 Image 2",
        image_indexes: [1],
        image_urls: ["main-2"],
        extra_image_indexes: [2],
        extra_image_urls: ["extra-1"],
        auctioneer_source_key: "auction-lot-4:2",
        tags: ["mode:per_item", "needs_review"],
      }),
    ]);
  });

  it("preserves a complete single-lot manifest when analysis returns no rows", async () => {
    const result = await analyzeMixedAssetGroupWithFallback({
      analyze: vi.fn().mockResolvedValue({ lots: [] }),
      fallbackContext: {
        groupIndex: 0,
        subMode: "single_lot",
        currency: "USD",
        imageUrls: ["photo-1", "photo-2", "photo-3"],
        mainImageIndexes: [0, 1, 2],
        extraImageIndexes: [],
        coverIndex: 2,
      },
    });

    expect(result.outcome).toBe("empty");
    expect(result.fallbackLots).toEqual([
      expect.objectContaining({
        title: "Lot 1",
        image_url: "photo-3",
        image_indexes: [0, 1, 2],
        image_urls: ["photo-1", "photo-2", "photo-3"],
        estimated_value: "USD 0",
        condition: "Needs manual review",
      }),
    ]);
  });

  it("does not add fallback rows when analysis returns usable lots", async () => {
    const providerResult = {
      lots: [{ title: "Analyzed asset", image_indexes: [0] }],
    };
    const result = await analyzeMixedAssetGroupWithFallback({
      analyze: vi.fn().mockResolvedValue(providerResult),
      fallbackContext: {
        groupIndex: 0,
        subMode: "per_photo",
        currency: "CAD",
        imageUrls: ["photo-1"],
        mainImageIndexes: [0],
        extraImageIndexes: [],
      },
    });

    expect(result).toEqual({
      result: providerResult,
      fallbackLots: [],
      outcome: "analyzed",
    });
  });

  it("drops invalid manifest indexes instead of creating broken fallback rows", () => {
    expect(
      buildMixedAssetFallbackLots(
        {
          groupIndex: 0,
          subMode: "per_photo",
          currency: "CAD",
          imageUrls: ["photo-1"],
          mainImageIndexes: [-1, 0, 5],
          extraImageIndexes: [2],
        },
        "Review this lot",
      ),
    ).toEqual([
      expect.objectContaining({
        image_indexes: [0],
        image_urls: ["photo-1"],
        extra_image_indexes: [],
      }),
    ]);
  });
});
