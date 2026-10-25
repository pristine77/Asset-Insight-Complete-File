import { describe, expect, it } from "vitest";

import {
  removeGalleryPhotoEntry,
  removeLotPhotoReference,
} from "./previewPhotoDeletion";

describe("preview photo deletion", () => {
  it("removes photo 11 from an 82-photo expanded gallery", () => {
    const entries = Array.from({ length: 82 }, (_, globalIndex) => ({
      url: `https://images.sellsnap.store/uploads/${globalIndex}.jpg`,
      globalIndex,
      lotIndex: 0,
    }));

    const result = removeGalleryPhotoEntry(entries, 10, entries[10]);

    expect(result.entries).toHaveLength(81);
    expect(result.entries.some((entry) => entry.globalIndex === 10)).toBe(false);
    expect(result.currentIdx).toBe(10);
    expect(result.entries[result.currentIdx].globalIndex).toBe(11);
  });

  it("tracks URL-only deletion without writing an invalid index", () => {
    const result = removeLotPhotoReference(
      {
        lots: [{ image_urls: ["https://images.sellsnap.store/uploads/fallback.jpg"] }],
        deleted_image_indexes: [-1],
      },
      0,
      {
        url: "https://images.sellsnap.store/uploads/fallback.jpg",
        globalIndex: null,
      }
    );

    expect(result.lots[0].image_urls).toEqual([]);
    expect(result.deleted_image_indexes).toEqual([]);
    expect(result.deleted_image_urls).toEqual([
      "https://images.sellsnap.store/uploads/fallback.jpg",
    ]);
  });

  it("does not mark a photo deleted while another lot references it", () => {
    const result = removeLotPhotoReference(
      {
        lots: [{ image_indexes: [4] }, { cover_index: 4 }],
      },
      0,
      { url: "https://images.sellsnap.store/uploads/4.jpg", globalIndex: 4 }
    );

    expect(result.deleted_image_indexes).toEqual([]);
    expect(result.deleted_image_urls).toEqual([]);
  });
});
