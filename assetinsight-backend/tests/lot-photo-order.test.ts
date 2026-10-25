import { describe, expect, it } from "vitest";
import { createLotPhotoResolver, firstReportImageManifest } from "../src/utils/lotPhotoOrder.js";
import { buildOrderedLotImageZipEntries } from "../src/jobs/assetReportJob/imageNaming.js";
import { collectPublicApiLotImageSources, collectPublicApiReportImageSources } from "../src/service/publicApiImagePayloadService.js";
import { collectAuctioneer2ResyncPhotoUrls } from "../src/service/auctioneer2PhotoResyncService.js";

const photo = (name: string | number) => `https://assetinsight.test/photos/${name}.jpg`;

describe("saved lot photo identity and order", () => {
  it("does not replace the first displayed photo with a stale indexed photo or selected cover", () => {
    const globals = [photo("rear"), photo("passenger"), photo("serial"), photo("extra")];
    const lot = {
      lot_number: "222", title: "2019 Stoughton Dry Van",
      image_urls: [photo("passenger"), photo("rear"), photo("serial")],
      image_indexes: [0, 1, 2], image_url: photo("rear"), cover_index: 0,
      extra_image_urls: [photo("extra")],
    };
    const expected = [photo("passenger"), photo("rear"), photo("serial"), photo("extra")];
    expect(createLotPhotoResolver(globals)(lot)).toEqual(expected.map((url) => ({ url, globalIndex: globals.indexOf(url) })));
    expect(buildOrderedLotImageZipEntries([lot], globals).map((entry) => entry.url)).toEqual(expected);
    expect(collectPublicApiLotImageSources({ imageUrls: globals }, lot, 0).map((entry) => entry.url)).toEqual(expected);
    expect(collectAuctioneer2ResyncPhotoUrls({ delivery: { manifest: { previewData: { imageUrls: globals } } } }, {}, lot)).toEqual(expected);
  });

  it("preserves partial URL arrays, index-only trailing photos, extras and nested legacy photos", () => {
    const globals = Array.from({ length: 8 }, (_, index) => photo(index));
    const lot = { image_urls: [globals[1]], image_indexes: [0, 2, 3], extra_image_urls: [photo("extra-only")], extra_image_indexes: [4, 5], items: [{ image_index: 6 }, { image_url: globals[7] }] };
    expect(createLotPhotoResolver(globals)(lot).map((entry) => entry.url)).toEqual([globals[1], globals[2], globals[3], photo("extra-only"), globals[5], globals[6], globals[7]]);
  });

  it("keeps holes and duplicate root positions, using the immutable manifest before live data", () => {
    const frozen = [photo("first"), photo("first"), "", photo("last")];
    const live = [photo("different"), photo("last")];
    const lot = { image_indexes: [3, 0], extra_image_indexes: [1] };
    expect(firstReportImageManifest(frozen, live)).toEqual(frozen);
    expect(collectPublicApiLotImageSources({ imageUrls: live, preview_data: { imageUrls: frozen } }, lot, 0).map((entry) => entry.url)).toEqual([photo("last"), photo("first")]);
    expect(collectAuctioneer2ResyncPhotoUrls({ delivery: { manifest: { previewData: { imageUrls: frozen } } } }, { imageUrls: live }, lot)).toEqual([photo("last"), photo("first")]);
  });

  it("does not fill an explicitly empty frozen manifest with later live images", () => {
    expect(firstReportImageManifest([], [photo("later")])).toEqual([]);
    expect(collectAuctioneer2ResyncPhotoUrls({ delivery: { manifest: { previewData: { imageUrls: [] } } } }, { imageUrls: [photo("later")] }, { image_indexes: [0] })).toEqual([]);
  });

  it("never coerces missing indexes into photo zero and retains scalar-only legacy images", () => {
    const resolve = createLotPhotoResolver([photo("zero"), photo("one")]);
    expect(resolve({ image_indexes: [null, "", false, undefined, -1, "not-an-index", 1.1] })).toEqual([]);
    expect(resolve({ image_url: photo("legacy") })).toEqual([{ url: photo("legacy") }]);
    expect(resolve({ image_index: 1 })).toEqual([{ url: photo("one"), globalIndex: 1 }]);
    expect(resolve({ image_indexes: ["1"] })).toEqual([{ url: photo("one"), globalIndex: 1 }]);
  });

  it("keeps all 41 photos plus report-only extras and does not count a changed cover twice", () => {
    const main = Array.from({ length: 41 }, (_, index) => photo(index));
    const extra = photo("report-only");
    const lot = { lot_number: 222, image_urls: main, image_indexes: main.map((_, index) => index), image_url: main[30], cover_index: 30, extra_image_urls: [extra] };
    const entries = buildOrderedLotImageZipEntries([lot], [...main, extra]);
    expect(entries.map((entry) => entry.url)).toEqual([...main, extra]);
    expect(entries[0].filename).toContain("Lot-001_Photo-001_");
    expect(new Set(entries.map((entry) => entry.filename)).size).toBe(42);
  });

  it("preserves shared photos for each lot, includes URL-only additions and keeps unassigned originals", () => {
    const shared = photo("shared");
    const entries = buildOrderedLotImageZipEntries([
      { lot_number: 222, image_urls: [shared, photo("added")], image_indexes: [0] },
      { lot_number: 223, image_indexes: [0] },
    ], [shared, photo("unassigned")]);
    expect(entries.map(({ url, lotIndex }) => ({ url, lotIndex }))).toEqual([
      { url: shared, lotIndex: 0 }, { url: photo("added"), lotIndex: 0 },
      { url: shared, lotIndex: 1 }, { url: photo("unassigned"), lotIndex: 2 },
    ]);
  });

  it("excludes deleted URLs and positions even when mirrored in direct and nested references", () => {
    const globals = [photo(0), photo(1), photo(2), photo(3)];
    const lot = { image_urls: globals, image_indexes: [0, 1, 2, 3], items: [{ image_url: globals[1] }] };
    expect(createLotPhotoResolver(globals, [1], [globals[2]])(lot).map((entry) => entry.url)).toEqual([globals[0], globals[3]]);
    expect(buildOrderedLotImageZipEntries([lot], globals, [1], [globals[2]]).map((entry) => entry.url)).toEqual([globals[0], globals[3]]);
  });

  it.each(["deleted_image_urls", "deleted_image_indexes"])("does not resurrect a lot-only %s deletion as an unassigned image", (key) => {
    const globals = [photo(0), photo(1)];
    const first = { image_urls: globals, [key]: key === "deleted_image_urls" ? [globals[0]] : [0] };
    expect(buildOrderedLotImageZipEntries([first], globals).map((entry) => entry.url)).toEqual([globals[1]]);
    expect(collectPublicApiReportImageSources({ imageUrls: globals }, [first]).map((entry) => entry.url)).toEqual([globals[1]]);
    const shared = { image_urls: [globals[0]] };
    expect(buildOrderedLotImageZipEntries([first, shared], globals).map((entry) => entry.url)).toEqual([globals[1], globals[0]]);
    expect(collectPublicApiReportImageSources({ imageUrls: globals }, [first, shared]).map((entry) => entry.url)).toEqual([globals[1], globals[0]]);
    expect(buildOrderedLotImageZipEntries([{ image_urls: [globals[0]], [key]: first[key] }], [globals[0]])).toEqual([]);
  });

  it("does not treat malformed deletion markers as image zero", () => {
    const globals = [photo(0)];
    const lot = { image_urls: globals };
    const deleted_image_indexes = [null, false, "", undefined];
    expect(buildOrderedLotImageZipEntries([lot], globals, deleted_image_indexes).map((entry) => entry.url)).toEqual(globals);
    expect(collectPublicApiReportImageSources({ imageUrls: globals, deleted_image_indexes }, [lot]).map((entry) => entry.url)).toEqual(globals);
  });

  it("resolves a 5,000-photo fixture with stable group boundaries", () => {
    const globals = Array.from({ length: 5000 }, (_, index) => photo(index));
    const lots = Array.from({ length: 100 }, (_, lotIndex) => ({ lot_number: lotIndex + 1, image_urls: globals.slice(lotIndex * 50, (lotIndex + 1) * 50), image_indexes: Array.from({ length: 50 }, (_, index) => lotIndex * 50 + index) }));
    const entries = buildOrderedLotImageZipEntries(lots, globals);
    expect(entries).toHaveLength(5000);
    expect(entries.map((entry) => entry.url)).toEqual(globals);
    expect(entries.every((entry, index) => entry.lotIndex === Math.floor(index / 50) && entry.photoIndex === index % 50 + 1)).toBe(true);
  });
});
