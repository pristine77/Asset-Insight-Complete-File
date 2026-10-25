import PizZip from "pizzip";
import { describe, expect, it } from "vitest";
import { restoreEditedLotFields } from "../src/jobs/assetReportJob/restoreEditedLotFields.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../src/service/auctioneerSpecSheetDocxService.js";
import { resolveCrLotDescription } from "../src/utils/crLotDescription.js";
import { AUCTION_DESCRIPTION_MAX_LENGTH, normalizePreviewLotsForBusinessRules } from "../src/utils/previewLotNormalization.js";

describe("Asset preview edit preservation", () => {
  it.each(["", " \n "])("preserves an explicit blank description %j without restoring legacy details", description => {
    const lot = { lot_id: "reviewed-clear", title: "Reviewed title", description, details: "Old legacy narrative" };
    const reviewed = normalizePreviewLotsForBusinessRules({ lots: [lot] }, { preserveDescription: true });
    expect(reviewed.lots[0].description).toBe(description);
    expect(resolveCrLotDescription(reviewed.lots[0], reviewed.lots[0].title)).toBe("Reviewed title");
    const initial = normalizePreviewLotsForBusinessRules({ lots: [lot] });
    expect(initial.lots[0].description).toBe("Old legacy narrative");
  });

  it("keeps distinct multiline descriptions and edited lot numbers unchanged", () => {
    const firstDescription =
      "First custom line\nSecond custom line with stock-photo context, Completeness: N/A, Legal: N/A";
    const secondDescription =
      "Different first line\nDifferent second line for the other lot and more than sixty characters";

    const normalized = normalizePreviewLotsForBusinessRules(
      {
        lots: [
          {
            lot_id: "duplicate-ai-id",
            lot_number: "825291",
            title: "Livestock gates",
            description: firstDescription,
          },
          {
            lot_id: "duplicate-ai-id",
            lot_number: "825295",
            title: "Livestock gates",
            description: secondDescription,
          },
        ],
      },
      { preserveDescription: true }
    );

    expect(normalized.lots.map((lot: any) => lot.lot_number)).toEqual([
      "825291",
      "825295",
    ]);
    expect(normalized.lots.map((lot: any) => lot.description)).toEqual([
      firstDescription,
      secondDescription,
    ]);
  });

  it("keeps concise normalization for non-Asset callers", () => {
    const normalized = normalizePreviewLotsForBusinessRules({
      lots: [
        {
          lot_id: "lot-listing-1",
          lot_number: "1",
          title: "Livestock gates",
          description:
            "First custom line\nSecond custom line that is deliberately longer than the AI description limit. " +
            "Ten-foot galvanized livestock gates with chain latches and hinge pins, stacked on a pallet, ".repeat(3),
        },
      ],
    });

    expect(normalized.lots[0].description).not.toContain("\n");
    expect(normalized.lots[0].description.length).toBeLessThanOrEqual(AUCTION_DESCRIPTION_MAX_LENGTH);
  });

  it("uses the saved Title for every CR without replacing the stored narrative", () => {
    const lot = {
      title: "Shared generated title",
      description: "First edited line\nSecond edited line",
    };

    expect(resolveCrLotDescription(lot, lot.title)).toBe(lot.title);
    expect(resolveCrLotDescription({ ...lot, description: "  " }, lot.title)).toBe(lot.title);
    expect(resolveCrLotDescription({ description: "Legacy description" }, "Legacy fallback")).toBe("Legacy description");
    expect(lot.description).toBe("First edited line\nSecond edited line");
  });

  it("falls back to lot position when generated siblings share an internal id", () => {
    const restored = restoreEditedLotFields(
      [
        {
          lot_id: "duplicate-ai-id",
          lot_number: "1",
          description: "Generated first",
        },
        {
          lot_id: "duplicate-ai-id",
          lot_number: "2",
          description: "Generated second",
        },
      ],
      [
        {
          lot_id: "duplicate-ai-id",
          lot_number: "825291",
          description: "Edited first lot",
        },
        {
          lot_id: "duplicate-ai-id",
          lot_number: "825295",
          description: "Edited second lot",
        },
      ]
    );

    expect(restored.map((lot) => [lot.lot_number, lot.description])).toEqual([
      ["825291", "Edited first lot"],
      ["825295", "Edited second lot"],
    ]);
  });

  it("still follows unique stable ids when generated lot order changes", () => {
    const restored = restoreEditedLotFields(
      [
        { lot_id: "lot-b", lot_number: "2", description: "Generated B" },
        { lot_id: "lot-a", lot_number: "1", description: "Generated A" },
      ],
      [
        { lot_id: "lot-a", lot_number: "101", description: "Edited A" },
        { lot_id: "lot-b", lot_number: "202", description: "Edited B" },
      ]
    );

    expect(restored.map((lot) => [lot.lot_number, lot.description])).toEqual([
      ["202", "Edited B"],
      ["101", "Edited A"],
    ]);
  });

  it("writes each edited Title and line break into the CR DOCX rather than the hidden narrative", async () => {
    const buffer = await generateAuctioneerSpecSheetDocxFromReport({
      contract_no: "EDIT-PRESERVATION",
      lots: [
        {
          lot_id: "lot-1",
          lot_number: "825291",
          title: "First edited Title\nFirst continuation",
          description: "First hidden narrative",
          image_urls: [],
        },
        {
          lot_id: "lot-2",
          lot_number: "825295",
          title: "Second edited Title\nSecond continuation",
          description: "Second hidden narrative",
          image_urls: [],
        },
      ],
    });
    const xml = new PizZip(buffer).file("word/document.xml")?.asText() || "";

    expect(xml).toContain("Lot # 825291");
    expect(xml).toContain("Lot # 825295");
    expect(xml).toContain("First edited Title");
    expect(xml).toContain("First continuation");
    expect(xml).toContain("Second edited Title");
    expect(xml).toContain("Second continuation");
    expect(xml).toContain("<w:br");
    expect(xml).not.toContain("First hidden narrative");
    expect(xml).not.toContain("Second hidden narrative");
  });
});
