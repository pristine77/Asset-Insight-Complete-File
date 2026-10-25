import { describe, expect, it } from "vitest";
import { assertMixedLotPhotoManifest, assertReportLotPhotoManifest, resolveGroupModelImageIndex, resolveGroupModelImageUrl } from "../src/utils/mixedLotPhotoManifest.js";

describe("explicit lot photo manifests", () => {
  it("matches worker defaults while preserving ungrouped Lot and non-mixed Asset behavior", () => {
    expect(() => assertReportLotPhotoManifest("asset", { mixed_lots: [{ count: 1, extraCount: 1, mode: "single_lot" }] }, 2)).not.toThrow();
    expect(() => assertReportLotPhotoManifest("asset", {}, 2)).toThrow(/mapping/);
    expect(() => assertReportLotPhotoManifest("lotListing", {}, 2)).not.toThrow();
    expect(() => assertReportLotPhotoManifest("lotListing", { mixed_lots: [{ count: 1, extra_count: 1 }] }, 2)).not.toThrow();
    for (const grouping_mode of ["per_item", "per_photo", "combined", "single_lot"]) expect(() => assertReportLotPhotoManifest("asset", { grouping_mode }, 2)).not.toThrow();
  });
  it("checks 5,000 photos without changing separate groups or their capture order", () => {
    const groups = Array.from({ length: 100 }, (_, index) => ({ count: 48, extra_count: 2, mode: "single_lot", lot_number: "222", source_key: `separate-${index}` }));
    const before = structuredClone(groups);
    expect(() => assertMixedLotPhotoManifest(groups, 5000)).not.toThrow();
    expect(groups).toEqual(before);
  });

  it.each([
    undefined, [], [{ count: 0, extra_count: 4, mode: "single_lot" }],
    [{ count: 3, mode: "single_lot" }], [{ count: 5, mode: "single_lot" }],
    [{ count: 2, mode: "single_lot" }, { count: 2, mode: "unknown" }],
    [{ count: "4photos", mode: "single_lot" }], [{ count: 3.5, extra_count: 0.5, mode: "single_lot" }],
    [{ count: 4, extra_count: -1, mode: "single_lot" }],
    [{ count: 2, extra_count: 1, mode: "single_lot" }, { count: 2, mode: "single_lot" }],
  ])("rejects malformed boundaries without clipping or regrouping: %j", (groups) => {
    expect(() => assertMixedLotPhotoManifest(groups, 4)).toThrow(/lot photo mapping/i);
  });

  it("supports integer string counts and the established extra-count alias", () => {
    expect(() => assertMixedLotPhotoManifest([{ count: "3", extraCount: "1", mode: "single_lot" }], 4)).not.toThrow();
    expect(() => assertMixedLotPhotoManifest([{ count: 4 }], 4, { allowMissingMode: true })).not.toThrow();
    expect(() => assertMixedLotPhotoManifest([{ count: 4 }], 4)).toThrow();
  });

  it("limits model URL references to this group's sampled main-photo inputs", () => {
    const urls = ["earlier-lot", "lot-2-first", "sampled-out", "lot-2-last", "report-only"];
    for (const url of [urls[0], urls[2], urls[4], "unknown", null]) {
      expect(resolveGroupModelImageUrl(url, [1, 3], urls)).toBeUndefined();
    }
    expect(resolveGroupModelImageUrl(urls[3], [1, 3], urls)).toBe(urls[3]);
  });

  it("resolves repeated URLs to their own group's original position", () => {
    const urls = ["shared-photo", "first-serial", "shared-photo", "second-serial"];
    expect(resolveGroupModelImageIndex("shared-photo", [0, 1], urls)).toBe(0);
    expect(resolveGroupModelImageIndex("shared-photo", [2, 3], urls)).toBe(2);
    expect(resolveGroupModelImageIndex("first-serial", [2, 3], urls)).toBeUndefined();
    expect(resolveGroupModelImageIndex(null, [2, 3], urls)).toBeUndefined();
  });
});
