import {
  removeGalleryPhotoEntry,
  removeLotPhotoReference,
} from "./previewPhotoDeletion";

describe("preview photo deletion", () => {
  test("removes an expanded-gallery entry and selects the next image", () => {
    const entries = Array.from({ length: 82 }, (_, globalIndex) => ({
      url: `https://images.sellsnap.store/uploads/${globalIndex}.jpg`,
      globalIndex,
      lotIndex: 0,
    }));

    const result = removeGalleryPhotoEntry(entries, 10, entries[10]);

    expect(result.entries).toHaveLength(81);
    expect(result.currentIdx).toBe(10);
    expect(result.entries[result.currentIdx].globalIndex).toBe(11);
  });

  test("closes cleanly after the final entry is removed", () => {
    const entry = { url: "file:///only.jpg", globalIndex: null, lotIndex: 2 };
    const result = removeGalleryPhotoEntry([entry], 0, {
      ...entry,
      lotIndex: 2,
    });

    expect(result.entries).toEqual([]);
    expect(result.currentIdx).toBe(0);
  });

  test("tracks a URL-only image and never stores -1", () => {
    const result = removeLotPhotoReference(
      {
        lots: [{ extra_image_urls: ["file:///fallback.jpg"] }],
        deleted_image_indexes: [-1],
      },
      0,
      { url: "file:///fallback.jpg", globalIndex: null }
    );

    expect(result.lots[0].extra_image_urls).toEqual([]);
    expect(result.deleted_image_indexes).toEqual([]);
    expect(result.deleted_image_urls).toEqual(["file:///fallback.jpg"]);
  });

  test("preserves shared images", () => {
    const result = removeLotPhotoReference(
      { lots: [{ image_indexes: [7] }, { image_indexes: [7] }] },
      0,
      { url: "https://images.sellsnap.store/uploads/7.jpg", globalIndex: 7 }
    );

    expect(result.deleted_image_indexes).toEqual([]);
    expect(result.deleted_image_urls).toEqual([]);
  });
});
