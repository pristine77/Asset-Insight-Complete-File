import { describe, expect, it } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import { resolvePhotoWatermark } from "../src/utils/photoWatermarkPolicy.js";
import { buildLotListingPreviewPersistence } from "../src/utils/lotListingPreviewPersistence.js";
import { buildSpecReportData } from "../src/service/auctioneerSpecPdfRefreshService.js";
import { syncAssetPreviewDataToRoot } from "../src/utils/assetPreviewRootSync.js";

describe("photo watermark defaults", () => {
  it("mirrors explicit preview choices without dropping an existing opt-in on omission", () => {
    const report = new AssetReport();
    syncAssetPreviewDataToRoot(report, { watermark_images: "true" });
    expect(report.watermark_images).toBe(true);
    syncAssetPreviewDataToRoot(report, { client_name: "Edited" });
    expect(report.watermark_images).toBe(true);
    syncAssetPreviewDataToRoot(report, { watermark_images: "false" });
    expect(report.watermark_images).toBe(false);
  });
  it.each([undefined, null, "", "unknown", {}, [], false, "false", 0, "0"])(
    "does not watermark without explicit consent (%j)", (value) => {
      expect(resolvePhotoWatermark(value)).toBe(false);
    }
  );
  it.each([true, "true", 1, "1", " TRUE "])("keeps explicit opt-in (%j)", (value) => {
    expect(resolvePhotoWatermark(value)).toBe(true);
  });
  it("preserves saved choices on partial edits and honors explicit opt-out", () => {
    expect(resolvePhotoWatermark(undefined, true)).toBe(true);
    expect(resolvePhotoWatermark(undefined, false)).toBe(false);
    expect(resolvePhotoWatermark(false, true)).toBe(false);
    expect(resolvePhotoWatermark("false", true)).toBe(false);
  });
  it.each([AssetReport, LotListing])("defaults new model records off", (Model) => {
    expect(new Model().watermark_images).toBe(false);
    expect(new Model({ watermark_images: true }).watermark_images).toBe(true);
    expect(Model.hydrate({ watermark_images: true }).watermark_images).toBe(true);
  });
  it("defaults new Lot Listing previews off without masking a saved root opt-in", () => {
    const listing = new LotListing({ preview_data: { lots: [] } });
    expect(buildSpecReportData(listing).watermark_images).toBe(false);
    const legacy = LotListing.hydrate({ watermark_images: true, preview_data: { lots: [] } });
    expect(legacy.preview_data?.watermark_images).toBeUndefined();
    expect(buildSpecReportData(legacy).watermark_images).toBe(true);
    expect(buildLotListingPreviewPersistence(legacy.preview_data, legacy).set.watermark_images).toBe(true);
  });
  it.each([undefined, false, true])("keeps saved choice through preview persistence and exports (%j)", (choice) => {
    const listing = { watermark_images: choice, imageUrls: ["https://images.sellsnap.store/original.jpg"] };
    const saved = buildLotListingPreviewPersistence({ lots: [] }, listing);
    expect(saved.set.watermark_images).toBe(choice === true);
    const exported = buildSpecReportData(listing);
    expect(exported.watermark_images).toBe(choice === true);
    expect(exported.imageUrls).toEqual(listing.imageUrls);
    expect(buildLotListingPreviewPersistence({ watermark_images: "false" }, listing).set.watermark_images).toBe(false);
    expect(buildSpecReportData({ ...listing, preview_data: { watermark_images: "false" } }).watermark_images).toBe(false);
  });
});
