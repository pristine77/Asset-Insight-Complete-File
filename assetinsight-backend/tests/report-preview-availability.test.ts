import { describe, expect, it } from "vitest";
import { hasSavedReportPreview } from "../src/utils/reportPreviewAvailability.js";
import { resolveReportGenerationStateForProfile } from "../src/utils/reportFileState.js";

describe("saved preview availability", () => {
  it.each(["asset", "lotListing"] as const)("keeps %s failure separate from saved preview and download readiness", (kind) => {
    expect(resolveReportGenerationStateForProfile(kind, {
      status: "error", job_status: "error", preview_data: { lots: [{ lot_number: "5507" }] },
    })).toMatchObject({ preview_available: true, generation_state: "error", files_ready: false });
  });
  it.each([undefined, {}, { lots: [] }, { lots: [null] }, { lots: [{}] }, { lots: ["lot"] }])(
    "does not invent a preview from empty or malformed data: %j", (preview_data) => {
      expect(hasSavedReportPreview("asset", { preview_data, imageUrls: ["photo.jpg"] })).toBe(false);
    },
  );
  it("supports legacy Lot root lots but never replaces explicitly empty canonical lots", () => {
    const lots = [{ lot_number: "5507" }];
    expect(hasSavedReportPreview("lotListing", { lots })).toBe(true);
    expect(hasSavedReportPreview("lotListing", { lots, preview_data: { lots: [] } })).toBe(false);
    expect(hasSavedReportPreview("asset", { lots })).toBe(false);
  });
  it("recognizes only the failed Lot default shell, not edited metadata or deleted photos", () => {
    const shell = { include_damage_analysis: true, bank_photos_enabled: false, valuation_methods: ["FML"], lots: [], deleted_image_indexes: [], deleted_image_urls: [], videoUrls: [] };
    const report = { status: "error", lots: [{ lot_number: "5507" }], preview_data: shell };
    expect(hasSavedReportPreview("lotListing", report)).toBe(true);
    expect(hasSavedReportPreview("lotListing", { ...report, status: "processing" })).toBe(false);
    expect(hasSavedReportPreview("lotListing", { ...report, preview_data: { ...shell, contract_no: "93530" } })).toBe(false);
    expect(hasSavedReportPreview("lotListing", { ...report, preview_data: { ...shell, deleted_image_indexes: [0] } })).toBe(false);
  });
});
