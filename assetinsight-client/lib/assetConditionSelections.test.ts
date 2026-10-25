import { describe, expect, it } from "vitest";
import { ASSET_CONDITION_SELECTION_GROUPS, applyAssetConditionSelection, applyAssetConditionSelectionToLots, getSharedAssetConditionSelection, normalizeAssetConditionSelection } from "./assetConditionSelections";

const makeLot = (number: number) => ({ lot_number: String(number), description: "Owner narrative\nDo not replace.",
  image_urls: [`https://fixture.test/${number}.jpg`], image_indexes: [number - 1], extra_image_urls: ["https://fixture.test/extra.jpg"],
  condition_report_selections: { condition: "N/A", completeness: "Has Keys", legal: "No Title" },
  condition_report_specs: { "Running Condition": "Old value", VIN: "Saved VIN" },
  condition_report_specs_deleted: ["Running Condition", "Colour"], condition_report_specs_custom_order: ["VIN"] });

describe("Asset bulk required selections", () => {
  for (const group of ASSET_CONDITION_SELECTION_GROUPS) {
    it.each(group.options)(`${group.label}: %s changes only the selected group on lots 4,8,9`, (value) => {
      const lots = Array.from({ length: 100 }, (_, index) => makeLot(index + 1));
      const snapshot = structuredClone(lots);
      const indexes = new Set([3, 7, 8]);
      const result = applyAssetConditionSelectionToLots(lots, indexes, group.key, value);
      expect(lots).toEqual(snapshot);
      result.forEach((lot, index) => {
        if (!indexes.has(index)) { expect(lot).toBe(lots[index]); return; }
        expect(lot.condition_report_selections).toEqual({ ...lots[index].condition_report_selections, [group.key]: value });
        for (const field of ["lot_number", "description", "image_urls", "image_indexes", "extra_image_urls", "condition_report_specs_custom_order"] as const) expect(lot[field]).toBe(lots[index][field]);
        if (group.key !== "condition") expect(lot.condition_report_specs).toBe(lots[index].condition_report_specs);
      });
      expect(getSharedAssetConditionSelection(result, indexes, group.key)).toBe(normalizeAssetConditionSelection(value));
    });
  }
  it("supports all 100, one, zero and no targets without dropping media or changing invalid indices", () => {
    const lots = Array.from({ length: 100 }, (_, index) => makeLot(index + 1));
    const result = applyAssetConditionSelectionToLots(lots, new Set(lots.map((_, index) => index)), "completeness", "Missing Parts");
    expect(result).toHaveLength(100);
    expect(result.every((lot) => lot.condition_report_selections.completeness === "Missing Parts")).toBe(true);
    expect(applyAssetConditionSelectionToLots([], new Set([0]), "legal", "N/A")).toEqual([]);
    expect(applyAssetConditionSelectionToLots([lots[0]], new Set([-1, 1, 100]), "legal", "N/A")[0]).toBe(lots[0]);
    expect(applyAssetConditionSelectionToLots([lots[0]], new Set(), "legal", "N/A")[0]).toBe(lots[0]);
    expect(applyAssetConditionSelectionToLots([lots[0]], new Set([0]), "legal", "N/A")[0].condition_report_selections.legal).toBe("N/A");
  });
  it("synchronizes running specs and deleted markers for legacy arrays and N/A without changing other specs", () => {
    const lot = { ...makeLot(1), condition_report_specs: [{ field: "Running condition", value: "Old value" }, { field: "VIN", value: "Saved VIN" }] };
    const updated = applyAssetConditionSelection(lot, "condition", "Starts and Runs");
    expect(updated.condition_report_specs).toEqual({ "Running condition": "Starts and Runs", VIN: "Saved VIN" });
    expect(updated.condition_report_specs_deleted).toEqual(["Colour"]);
    const cleared = applyAssetConditionSelection(updated, "condition", "N/A");
    expect(cleared.condition_report_specs).toEqual({ VIN: "Saved VIN" });
    expect(cleared.condition_report_selections.condition).toBe("N/A");
    expect(lot.condition_report_specs).toHaveLength(2);
  });
  it("handles aliases/mixed selection and rejects values outside the selected group", () => {
    const lots = [makeLot(1), makeLot(2)];
    expect(applyAssetConditionSelection(lots[0], "legal", "Has Keys")).toBe(lots[0]);
    expect(getSharedAssetConditionSelection(lots, new Set(), "legal")).toBe("");
    const mixed = applyAssetConditionSelectionToLots(lots, new Set([0]), "legal", "Salvage");
    expect(getSharedAssetConditionSelection(mixed, new Set([0, 1]), "legal")).toBe("");
    expect(normalizeAssetConditionSelection(" Untested ")).toBe("unverified running condition");
    expect(normalizeAssetConditionSelection("non-operational")).toBe("does not start or run");
    expect(normalizeAssetConditionSelection("not applicable")).toBe("n/a");
  });

  it("keeps Running and Working Condition aliases in sync, including N/A before save", () => {
    const lot = { ...makeLot(1),
      condition_report_specs: { "Working Condition": "Old working value", "Running Condition": "Old running value", VIN: "Saved VIN" },
      condition_report_specs_deleted: ["Working Condition", "Running Condition", "Colour"],
    };
    const updated = applyAssetConditionSelection(lot, "condition", "Starts and Runs");
    expect(updated.condition_report_specs).toEqual({ "Working Condition": "Starts and Runs", "Running Condition": "Starts and Runs", VIN: "Saved VIN" });
    expect(updated.condition_report_specs_deleted).toEqual(["Colour"]);
    expect(applyAssetConditionSelection(updated, "condition", "N/A").condition_report_specs).toEqual({ VIN: "Saved VIN" });
  });
});
