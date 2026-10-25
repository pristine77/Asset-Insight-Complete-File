import { describe, expect, it } from "vitest";

import { getPreviewLotPhotoEntries } from "./previewLotPhotos";
import { removeLotPhotoReference } from "./previewPhotoDeletion";
describe("preview photo provenance and deletion round trips", () => {
  it.each([false, true])("retains an explicit different cover when deleting the scalar photo (stale root: %s)", (staleRoot) => {
    const data = { lots: [{
      image_index: 0, image_url: "first.jpg",
      image_indexes: [0, 1], image_urls: ["first.jpg", "second.jpg"],
      cover_index: 1, cover_url: "second.jpg",
    }] };
    const roots = staleRoot ? ["foreign.jpg", "first.jpg", "second.jpg"] : ["first.jpg", "second.jpg"];
    const selected = getPreviewLotPhotoEntries(data.lots[0], roots)[0];
    const next = removeLotPhotoReference(data, 0, selected);
    expect(next.lots[0].image_url).toBeUndefined();
    expect(next.lots[0].cover_url).toBe("second.jpg");
    expect(next.lots[0].cover_index).toBe(1);
    expect(getPreviewLotPhotoEntries(next.lots[0], roots).map(({ url }) => url)).toEqual(["second.jpg"]);
  });
it("preserves report-only slots and confirmed repeated-URL positions", () => {
    const data = { lots: [{ image_indexes: [2], image_urls: ["shared.jpg"],
      extra_image_indexes: [0, 3], extra_image_urls: ["missing-extra.jpg", "extra.jpg"] }] };
    const repeatedRoot = ["shared.jpg", "other.jpg", "shared.jpg", "extra.jpg"];
    const entries = getPreviewLotPhotoEntries(data.lots[0], repeatedRoot);
    expect(entries).toEqual([
      { url: "shared.jpg", globalIndex: 2 },
      { url: "missing-extra.jpg", globalIndex: null },
      { url: "extra.jpg", globalIndex: 3 },
    ]);
    const next = removeLotPhotoReference(data, 0, entries[1]);
    expect(next.lots[0].image_indexes).toEqual([2]);
    expect(next.lots[0].extra_image_indexes).toEqual([3]);
    expect(next.deleted_image_indexes).toEqual([]);
    expect(getPreviewLotPhotoEntries(next.lots[0], repeatedRoot)).toEqual([entries[0], entries[2]]);
  });
  const root = ["unrelated.jpg", "first.jpg", "second.jpg"];

  it("deletes mismatched URL slots without resurrecting trailing indexes", () => {
    const data = { lots: [{ image_indexes: [0, 1], image_urls: ["first.jpg", "second.jpg"] }] };
    const first = getPreviewLotPhotoEntries(data.lots[0], root)[0];
    expect(first).toEqual({ url: "first.jpg", globalIndex: null });
    const next = removeLotPhotoReference(data, 0, first);
    expect(next.lots[0]).toEqual({ image_indexes: [1], image_urls: ["second.jpg"], extra_image_indexes: undefined });
    expect(next.deleted_image_indexes).toEqual([]);
    expect(next.deleted_image_urls).toEqual(["first.jpg"]);
    const reopened = getPreviewLotPhotoEntries(JSON.parse(JSON.stringify(next)).lots[0], root);
    expect(reopened).toEqual([{ url: "second.jpg", globalIndex: null }]);
    const emptied = removeLotPhotoReference(next, 0, reopened[0]);
    expect(getPreviewLotPhotoEntries(emptied.lots[0], root)).toEqual([]);
    expect(emptied.deleted_image_indexes).toEqual([]);
    expect(emptied.deleted_image_urls).toEqual(["first.jpg", "second.jpg"]);
  });

  it("keeps index and URL holes aligned instead of shifting later photos", () => {
    expect(getPreviewLotPhotoEntries({
      image_indexes: [0, 2], image_urls: ["", "second.jpg"],
    }, root)).toEqual([
      { url: "unrelated.jpg", globalIndex: 0 },
      { url: "second.jpg", globalIndex: 2 },
    ]);
    expect(getPreviewLotPhotoEntries({
      image_indexes: [null, false, "", "2"], image_urls: [],
    }, root)).toEqual([{ url: "second.jpg", globalIndex: 2 }]);
    expect(getPreviewLotPhotoEntries({ image_index: false }, root)).toEqual([]);
  });

  it("preserves missing originals as URL-only entries and removes their paired slots", () => {
    const data = { lots: [{ image_indexes: [0, 2], image_urls: ["missing.jpg", "second.jpg"] }] };
    const entries = getPreviewLotPhotoEntries(data.lots[0], root);
    expect(entries).toEqual([{ url: "missing.jpg", globalIndex: null }, { url: "second.jpg", globalIndex: 2 }]);
    const next = removeLotPhotoReference(data, 0, entries[0]);
    expect(next.lots[0].image_indexes).toEqual([2]);
    expect(next.deleted_image_indexes).toEqual([]);
    expect(getPreviewLotPhotoEntries(next.lots[0], root)).toEqual([{ url: "second.jpg", globalIndex: 2 }]);
  });

  it("preserves shared URL references in another lot", () => {
    const data = { lots: [
      { image_indexes: [0, 1], image_urls: ["first.jpg", "second.jpg"] },
      { image_indexes: [1], image_urls: ["first.jpg"] },
    ] };
    const first = getPreviewLotPhotoEntries(data.lots[0], root)[0];
    const next = removeLotPhotoReference(data, 0, first);
    expect(next.deleted_image_indexes).toEqual([]);
    expect(next.deleted_image_urls).toEqual([]);
    expect(getPreviewLotPhotoEntries(next.lots[0], root)).toEqual([{ url: "second.jpg", globalIndex: null }]);
    expect(getPreviewLotPhotoEntries(next.lots[1], root)).toEqual([{ url: "first.jpg", globalIndex: 1 }]);
  });

  it("deletes a stale scalar URL without retaining its paired scalar index", () => {
    const data = { lots: [{ image_index: 0, image_url: "first.jpg" }] };
    const next = removeLotPhotoReference(data, 0, getPreviewLotPhotoEntries(data.lots[0], root)[0]);
    expect(next.lots[0].image_index).toBeUndefined();
    expect(next.deleted_image_indexes).toEqual([]);
    expect(getPreviewLotPhotoEntries(next.lots[0], root)).toEqual([]);
  });
});

describe("preview lot photo resolution", () => {
  it("keeps lot-local URL order when compacted indexes are paired with a stale root list", () => {
    const staleRoot = [
      "lot-1012-a.jpg",
      "deleted.jpg",
      "lot-1013-a.jpg",
      "lot-1013-b.jpg",
      "lot-1014-a.jpg",
      "lot-1014-b.jpg",
    ];
    const lot1013 = {
      image_indexes: [1, 2],
      image_urls: ["lot-1013-a.jpg", "lot-1013-b.jpg"],
    };
    const lot1014 = {
      image_indexes: [3, 4],
      image_urls: ["lot-1014-a.jpg", "lot-1014-b.jpg"],
      image_url: "lot-1013-b.jpg",
    };

    expect(getPreviewLotPhotoEntries(lot1013, staleRoot).map((entry) => entry.url)).toEqual([
      "lot-1013-a.jpg",
      "lot-1013-b.jpg",
    ]);
    expect(getPreviewLotPhotoEntries(lot1014, staleRoot).map((entry) => entry.url)).toEqual([
      "lot-1014-a.jpg",
      "lot-1014-b.jpg",
    ]);
  });

  it("falls back to global indexes when a legacy lot has no URL arrays", () => {
    expect(
      getPreviewLotPhotoEntries(
        { image_indexes: [2], extra_image_indexes: [3] },
        ["zero.jpg", "one.jpg", "main.jpg", "extra.jpg"]
      )
    ).toEqual([
      { globalIndex: 2, url: "main.jpg" },
      { globalIndex: 3, url: "extra.jpg" },
    ]);
  });

  it("keeps unmatched trailing indexes in partially migrated URL arrays", () => {
    expect(
      getPreviewLotPhotoEntries(
        {
          image_indexes: [0, 1],
          image_urls: ["main-a.jpg"],
          extra_image_indexes: [2, 3],
          extra_image_urls: ["extra-a.jpg"],
        },
        ["main-a.jpg", "main-b.jpg", "extra-a.jpg", "extra-b.jpg"]
      )
    ).toEqual([
      { globalIndex: 0, url: "main-a.jpg" },
      { globalIndex: 1, url: "main-b.jpg" },
      { globalIndex: 2, url: "extra-a.jpg" },
      { globalIndex: 3, url: "extra-b.jpg" },
    ]);
  });

  it("uses the scalar image URL only when no main array representation exists", () => {
    expect(
      getPreviewLotPhotoEntries(
        { image_url: "cover.jpg" },
        ["other.jpg", "cover.jpg"]
      )
    ).toEqual([{ globalIndex: 1, url: "cover.jpg" }]);
  });

  it("trusts a scalar URL and its paired index over a stale root URL", () => {
    expect(
      getPreviewLotPhotoEntries(
        { image_indexes: [], image_index: 0, image_url: "correct.jpg" },
        ["foreign.jpg", "correct.jpg"]
      )
    ).toEqual([{ globalIndex: null, url: "correct.jpg" }]);
  });

  it("keeps the remapped preview index when deleting against a stale root list", () => {
    const lot = {
      image_indexes: [0, 1],
      image_urls: ["lot-1013-a.jpg", "lot-1013-b.jpg"],
    };
    const entries = getPreviewLotPhotoEntries(lot, [
      "lot-1012-tail.jpg",
      "lot-1013-a.jpg",
      "lot-1013-b.jpg",
    ]);

    expect(entries[0]).toEqual({ globalIndex: null, url: "lot-1013-a.jpg" });
    const next = removeLotPhotoReference({ lots: [lot] }, 0, entries[0]);
    expect(next.lots[0].image_indexes).toEqual([1]);
    expect(next.lots[0].image_urls).toEqual(["lot-1013-b.jpg"]);
    expect(next.deleted_image_indexes).toEqual([]);
    expect(next.deleted_image_urls).toEqual(["lot-1013-a.jpg"]);
  });
});
