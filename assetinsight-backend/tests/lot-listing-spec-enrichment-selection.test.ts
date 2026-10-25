import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: vi.fn() } },
}));

vi.mock("../src/service/systemSettingsService.js", () => ({
  isAuctioneerSpecWebSearchEnabled: vi.fn(async () => false),
}));

import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";

describe("lot-listing Legal selection enrichment", () => {
  it("overwrites stale mapped specs and removes them when the latest selection is N/A", async () => {
    const result = await enrichLotListingSpecs({
      mode: "pictureOnly",
      lots: [
        {
          lot_number: "1",
          categories: "Control Van",
          condition_report_selections: { legal: "Salvage" },
          condition_report_specs: { "Ownership Type": "No Title" },
        },
        {
          lot_number: "2",
          categories: "Control Van",
          condition_report_selections: { legal: "N/A" },
          condition_report_specs: { "Title Status": "No Title" },
        },
        {
          lot_number: "3",
          categories: "Portable Structures",
          condition_report_selections: { legal: "N/A" },
          condition_report_specs: { "Registration History": "No Title" },
        },
      ],
    });

    expect(result.lots[0].condition_report_specs).toMatchObject({
      "Ownership Type": "Salvage",
    });
    expect(result.lots[1].condition_report_specs).toEqual({});
    expect(result.lots[2].condition_report_specs).toEqual({});
    expect(result.analyses[0].visible_filled).toContain("Ownership Type");
    expect(result.analyses[1].unresolved_fields).not.toContain("Ownership Type");
    expect(result.analyses[2].unresolved_fields).not.toContain(
      "Registration History"
    );
  });
});
