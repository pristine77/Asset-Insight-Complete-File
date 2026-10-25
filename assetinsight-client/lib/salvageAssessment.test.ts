import { describe, expect, it } from "vitest";
import { formatAssessmentMoney, isSalvageAssessmentV2 } from "./salvageAssessment";

describe("Salvage assessment transport helpers", () => {
  it("does not mistake legacy or malformed data for the v2 assessment", () => {
    for (const value of [null, [], {}, { valuation: { fairMarketValue: 1000 } }, { schemaVersion: 2 }]) expect(isSalvageAssessmentV2(value)).toBe(false);
  });
  it("keeps unknown values unavailable while preserving explicit zero", () => {
    for (const value of [null, undefined, "100", NaN, Infinity]) expect(formatAssessmentMoney(value)).toBe("Unavailable");
    expect(formatAssessmentMoney(null, "fr")).toBe("Indisponible");
    expect(formatAssessmentMoney(null, "es")).toBe("No disponible");
    expect(formatAssessmentMoney(0)).toContain("0.00");
    expect(formatAssessmentMoney(1000.125)).toContain("1,000.13");
  });
});
