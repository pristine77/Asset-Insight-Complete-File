import { describe, expect, it } from "vitest";
import { initialLotNumberFallbackIndexes, markInitialLotNumberFallback } from "../src/service/initialLotNumberProvenance.js";
import { normalizeLotsForReportOrdering } from "../src/jobs/assetReportJob/lotOrdering.js";
import { normalizeLotsForBusinessRules } from "../src/utils/previewLotNormalization.js";

describe("initial lot number provenance", () => {
  it("distinguishes explicit 1 from a generated 1 through later normalization", () => {
    const lots = [
      { lot_number: "1" }, { lot_number: null, lot_id: "lot-002" },
      { lot_number: "157", analysis_metadata: { bundle_lot_number_detection: { numberSource: "first_main_photo" } } },
      { lot_number: 4, analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback" } } },
    ].map(markInitialLotNumberFallback);
    const normalized = normalizeLotsForBusinessRules(normalizeLotsForReportOrdering(lots, "per_item"));
    expect(initialLotNumberFallbackIndexes(normalized)).toEqual([1, 3]);
    expect(lots[0]).not.toHaveProperty("analysis_metadata.initial_lot_number");
  });

  it("keeps mixed/per-photo empty fallback provenance when lot_id supplies a label", () => {
    const lot = { lot_number: " ", lot_id: "lot-002", image_urls: ["first", "last"] };
    const normalized = normalizeLotsForBusinessRules([markInitialLotNumberFallback(lot)]);
    expect(initialLotNumberFallbackIndexes(normalized)).toEqual([0]);
    expect(normalized[0].image_urls).toEqual(lot.image_urls);
    expect(lot).not.toHaveProperty("analysis_metadata");
  });

  it("never classifies detected or nonempty unmarked numbers by their position", () => {
    const lots = ["1", "2", "1000A"].map((lot_number) => ({ lot_number }));
    expect(initialLotNumberFallbackIndexes(lots)).toEqual([]);
    expect(initialLotNumberFallbackIndexes([{ lot_number: "1", analysis_metadata: {
      initial_lot_number: { source: "sequential_fallback" },
      bundle_lot_number_detection: { numberSource: "last_main_photo" },
    } }])).toEqual([]);
  });
});
