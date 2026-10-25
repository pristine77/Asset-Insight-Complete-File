import { describe, expect, it } from "vitest";
import {
  collectPublicApiLotImageSources,
  collectPublicApiReportImageSources,
  encodePublicApiImagePage,
  getPublicApiImagePagination,
  PublicApiImageEncodingError,
} from "../src/service/publicApiImagePayloadService.js";

describe("public API image payloads", () => {
  it("preserves lot photo order and excludes deleted images", () => {
    const report = {
      imageUrls: ["https://images.sellsnap.store/a.jpg", "https://images.sellsnap.store/b.jpg", "https://images.sellsnap.store/c.jpg", "https://images.sellsnap.store/deleted.jpg", "https://images.sellsnap.store/unassigned.jpg"],
      preview_data: { deleted_image_indexes: [3] },
    };
    const lots = [
      {
        image_indexes: [1, 0],
        image_urls: [
          "https://images.sellsnap.store/b.jpg",
          "https://images.sellsnap.store/a.jpg",
        ],
        extra_image_indexes: [3],
        extra_image_urls: ["https://images.sellsnap.store/deleted.jpg"],
      },
      {
        image_indexes: [2],
        image_urls: ["https://images.sellsnap.store/c.jpg"],
      },
    ];

    const sources = collectPublicApiReportImageSources(report, lots);

    expect(sources.map((source) => source.url)).toEqual([
      "https://images.sellsnap.store/b.jpg",
      "https://images.sellsnap.store/a.jpg",
      "https://images.sellsnap.store/c.jpg",
      "https://images.sellsnap.store/unassigned.jpg",
    ]);
    expect(sources.map((source) => source.order)).toEqual([0, 1, 2, 3]);
    expect(sources.map((source) => source.lotIndex)).toEqual([0, 0, 1, null]);
  });

  it("returns one lot's main photos before extra photos", () => {
    const report = {
      imageUrls: [
        "https://images.sellsnap.store/one.jpg",
        "https://images.sellsnap.store/two.jpg",
        "https://images.sellsnap.store/extra.jpg",
      ],
    };
    const lot = {
      image_indexes: [1, 0],
      extra_image_indexes: [2],
    };

    expect(
      collectPublicApiLotImageSources(report, lot, 4).map((source) => ({
        url: source.url,
        lotIndex: source.lotIndex,
        photoIndex: source.photoIndex,
      }))
    ).toEqual([
      {
        url: "https://images.sellsnap.store/two.jpg",
        lotIndex: 4,
        photoIndex: 0,
      },
      {
        url: "https://images.sellsnap.store/one.jpg",
        lotIndex: 4,
        photoIndex: 1,
      },
      {
        url: "https://images.sellsnap.store/extra.jpg",
        lotIndex: 4,
        photoIndex: 2,
      },
    ]);
  });

  it("keeps a shared image associated with every lot that references it", () => {
    const sharedUrl = "https://images.sellsnap.store/shared.jpg";
    const sources = collectPublicApiReportImageSources(
      { imageUrls: [sharedUrl] },
      [{ image_indexes: [0] }, { image_indexes: [0] }]
    );

    expect(sources.map(({ url, lotIndex }) => ({ url, lotIndex }))).toEqual([
      { url: sharedUrl, lotIndex: 0 },
      { url: sharedUrl, lotIndex: 1 },
    ]);
  });

  it("encodes a deterministic page with metadata and a checksum", async () => {
    const sources = [
      { url: "https://images.sellsnap.store/a.jpg", order: 0, lotIndex: 0, photoIndex: 0 },
      { url: "https://images.sellsnap.store/b.jpg", order: 1, lotIndex: 0, photoIndex: 1 },
      { url: "https://images.sellsnap.store/c.jpg", order: 2, lotIndex: 1, photoIndex: 0 },
    ];
    const loader = async (url: string, lotIndex: number, photoIndex: number) => ({
      buffer: Buffer.from(`bytes:${url}`),
      contentType: "image/jpeg",
      filename: `lot-${lotIndex}-photo-${photoIndex}.jpg`,
      sourceUrl: url,
    });

    const result = await encodePublicApiImagePage(sources, 2, 2, loader);

    expect(result.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 3,
      totalPages: 2,
      hasNextPage: false,
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      url: sources[2].url,
      base64: Buffer.from(`bytes:${sources[2].url}`).toString("base64"),
      content_type: "image/jpeg",
      filename: "lot-1-photo-0.jpg",
      encoding: "base64",
      order: 2,
      lot_index: 1,
      photo_index: 0,
    });
    expect(result.data[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("caps page size and reports image conversion failures", async () => {
    expect(getPublicApiImagePagination({ page: "0", limit: "1000" })).toEqual({
      page: 1,
      limit: 5,
    });

    const source = {
      url: "https://images.sellsnap.store/missing.jpg",
      order: 0,
      lotIndex: 0,
      photoIndex: 0,
    };
    await expect(
      encodePublicApiImagePage([source], 1, 5, async () => {
        throw new Error("object missing");
      })
    ).rejects.toEqual(expect.any(PublicApiImageEncodingError));
  });
});
