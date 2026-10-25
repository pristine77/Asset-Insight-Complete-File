import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * A spec the appraiser deleted in Preview must stay deleted through Save &
 * Generate. Deletion is recorded as a tombstone in condition_report_specs_deleted;
 * every renderer hides tombstoned fields, so this suite pins the one stage that
 * used to ignore them: enrichment, which inferred, cached and researched values
 * straight back into removed fields — under the category's canonical label, so
 * the renderers could not even recognise them as the thing that was deleted.
 */

const openaiMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: openaiMock.create } },
}));

const settings = vi.hoisted(() => ({ webEnabled: false }));
vi.mock("../src/service/systemSettingsService.js", () => ({
  isAuctioneerSpecWebSearchEnabled: vi.fn(async () => settings.webEnabled),
}));

// vPIC is never reached from a unit test; VIN enrichment passes lots through.
vi.mock("../src/service/vehicleApiService.js", () => ({
  enrichLotsWithVin: vi.fn(async (lots: any[]) => lots),
  applyVinModelYearFallback: vi.fn((lots: any[]) => lots),
  extractVinFromText: vi.fn(() => ""),
}));

import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";

const HOURS = "Hours (Showing Unverified)";

const lot = (overrides: Record<string, unknown> = {}) => ({
  lot_number: "826",
  title: "2019 Kenworth T800 Control Van",
  description: "Control van, 2450 hours showing.",
  categories: "Control Van",
  condition_report_specs: {},
  ...overrides,
});

const specsOf = (result: { lots: any[] }, index = 0): Record<string, string> =>
  result.lots[index]?.condition_report_specs ?? {};

beforeEach(() => {
  settings.webEnabled = false;
  openaiMock.create.mockReset();
});

describe("spec enrichment honours deliberate deletions", () => {
  it("still infers a blank field when nothing was deleted", async () => {
    const result = await enrichLotListingSpecs({ mode: "pictureOnly", lots: [lot()] });

    expect(specsOf(result)[HOURS]).toMatch(/^2,?450(?:\s|$)/);
    expect(result.analyses[0].visible_filled).toContain(HOURS);
  });

  it("does not infer a value back into a field the appraiser deleted", async () => {
    const result = await enrichLotListingSpecs({
      mode: "pictureOnly",
      lots: [lot({ condition_report_specs_deleted: [HOURS] })],
    });

    expect(specsOf(result)).not.toHaveProperty(HOURS);
    expect(result.analyses[0].visible_filled).not.toContain(HOURS);
    // The tombstone itself must survive the pass for the renderers downstream.
    expect(result.lots[0].condition_report_specs_deleted).toContain(HOURS);
  });

  it("matches the deletion by label variant, so a sibling label cannot smuggle it back", async () => {
    // The appraiser removed "Hours"; the category's canonical label is longer.
    const result = await enrichLotListingSpecs({
      mode: "pictureOnly",
      lots: [lot({ condition_report_specs_deleted: ["Hours"] })],
    });

    expect(specsOf(result)).not.toHaveProperty(HOURS);
  });

  it("lets a deletion beat even an explicit selection for its mapped field at the boundary", async () => {
    /*
       The selection setter itself is deliberately left ungated (a Legal or Running
       Condition choice is the appraiser's own input), but the normalization that
       closes enrichment rebuilds the stored specs from rendered rows and applies
       the tombstones to every row. So a removed mapped field stays removed; the
       un-deleted case is covered by the existing selection suite.
    */
    const result = await enrichLotListingSpecs({
      mode: "pictureOnly",
      lots: [
        lot({
          condition_report_selections: { legal: "Salvage" },
          condition_report_specs_deleted: ["Ownership Type"],
        }),
      ],
    });

    expect(specsOf(result)).not.toHaveProperty("Ownership Type");
    expect(result.lots[0].condition_report_specs_deleted).toContain("Ownership Type");
  });

  describe("with web research enabled", () => {
    beforeEach(() => {
      settings.webEnabled = true;
      openaiMock.create.mockResolvedValue({
        output_text: JSON.stringify({
          condition_report_specs: [
            { field: "Fuel Type", value: "Diesel", source_url: "https://example.test/spec", confidence: "high" },
            { field: "Drive Type", value: "6x4", source_url: "https://example.test/spec", confidence: "high" },
          ],
          unresolved_fields: [],
          sources: [],
        }),
      });
    });

    it("neither asks for a deleted field nor keeps a value returned for it", async () => {
      const result = await enrichLotListingSpecs({
        lots: [lot({ condition_report_specs_deleted: ["Fuel Type"] })],
      });

      expect(openaiMock.create).toHaveBeenCalled();
      // Not paid for: the removed field appears nowhere in any provider request.
      const requests = JSON.stringify(openaiMock.create.mock.calls);
      expect(requests).toContain("Drive Type");
      expect(requests).not.toContain("Fuel Type");
      // Not kept: a value the provider returns for it anyway is discarded.
      expect(specsOf(result)).not.toHaveProperty("Fuel Type");
      expect(specsOf(result)).toMatchObject({ "Drive Type": "6x4" });
      expect(result.analyses[0].web_filled).not.toContain("Fuel Type");
    });
  });
});
