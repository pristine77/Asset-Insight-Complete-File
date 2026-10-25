import {
  applyDamageAnalysisLotPolicy,
  isDamageAnalysisEligibleForLot,
  parseLotNumberNumericPortion,
} from "./lotDamagePolicy";

describe("lot damage analysis policy", () => {
  test.each([
    ["999", 999, true],
    ["0999", 999, true],
    ["Lot #999", 999, true],
    ["lot-001", 1, true],
    ["999A", 999, true],
    ["1000", 1000, true],
    ["1,000", 1000, true],
    ["1000A", 1000, true],
    ["1001", 1001, false],
    ["1,001", 1001, false],
    ["1001A", 1001, false],
    [undefined, null, true],
    ["Warehouse A", null, true],
  ])("handles %p", (value, parsed, eligible) => {
    expect(parseLotNumberNumericPortion(value)).toBe(parsed);
    expect(isDamageAnalysisEligibleForLot(value)).toBe(eligible);
  });

  test("clears damage only for ineligible lots", () => {
    const result = applyDamageAnalysisLotPolicy({
      lots: [
        { lot_number: "999A", damage_analysis: "Old dent" },
        { lot_number: "1001", damage_analysis: "Scratch" },
      ],
    });

    expect(result.lots.map((lot) => lot.damage_analysis)).toEqual(["Old dent", ""]);
  });

  test("uses each lot number instead of the contract number", () => {
    const result = applyDamageAnalysisLotPolicy({
      contract_no: "5000",
      lots: [
        { lot_number: "1000", damage_analysis: "Eligible dent" },
        { lot_number: "1001", damage_analysis: "Ineligible scratch" },
      ],
    });

    expect(result.contract_no).toBe("5000");
    expect(result.lots.map((lot) => lot.damage_analysis)).toEqual(["Eligible dent", ""]);
  });
});
