import { describe, expect, it } from "vitest";

import {
  applyDamageAnalysisLotPolicy,
  isDamageAnalysisEligibleForLot,
  parseLotNumberNumericPortion,
} from "./lotDamagePolicy";

describe("lot damage analysis policy", () => {
  it.each([
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

  it("clears above-threshold damage without mutating the input", () => {
    const input = {
      lots: [
        { lot_number: "0999", damage_analysis: "Old dent" },
        { lot_number: "1001", damage_analysis: "Scratch" },
      ],
    };

    const result = applyDamageAnalysisLotPolicy(input);

    expect(result).not.toBe(input);
    expect(result.lots[0].damage_analysis).toBe("Old dent");
    expect(result.lots[1].damage_analysis).toBe("");
    expect(input.lots[0].damage_analysis).toBe("Old dent");
    expect(input.lots[1].damage_analysis).toBe("Scratch");
  });
});
