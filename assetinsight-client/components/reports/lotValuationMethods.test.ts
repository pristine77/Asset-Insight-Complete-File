import { describe, expect, it } from "vitest";
import {
  buildLotValuationLines,
  formatLotValuationValue,
  parseLotEstimatedValue,
} from "./lotValuationMethods";

describe("lot valuation method display", () => {
  it("keeps an explicit empty choice and never restores stale calculated methods", () => {
    expect(buildLotValuationLines(1200, [], [{ method: "FLV", percentage: 52 }], true)).toEqual([]);
    expect(buildLotValuationLines(1200, [], [{ method: "FLV", percentage: 52 }], false)).toEqual([
      { method: "FML", fullName: "Fair Market Value", percentage: 100, value: 1200 },
    ]);
    expect(buildLotValuationLines(1200, ["FLV"], [{ method: "FLV", percentage: 0 }], false)[0].value).toBe(0);
  });
  it("projects every selected method from a lot's base estimate in saved order", () => {
    const lines = buildLotValuationLines(
      "US$42,000",
      ["FML", "TKV", "OLV", "FLV"],
      [
        { method: "OLV", fullName: "Orderly Liquidation Value", percentage: 77 },
        { method: "FML", fullName: "Fair Market Value", percentage: 100 },
        { method: "FLV", fullName: "Forced Liquidation Value", percentage: 52 },
        { method: "TKV", fullName: "Trade Value", percentage: 70 },
      ]
    );

    expect(lines.map((line) => line.method)).toEqual(["FML", "TKV", "OLV", "FLV"]);
    expect(lines.map((line) => line.value)).toEqual([42000, 29400, 32340, 21840]);
    expect(lines[1]).toMatchObject({
      fullName: "Trade Value",
      percentage: 70,
    });
  });

  it("deduplicates selected methods and does not invent a missing percentage", () => {
    const lines = buildLotValuationLines(
      10000,
      ["olv", "OLV", "TKV"],
      [{ method: "OLV", percentage: "80%" }]
    );

    expect(lines).toEqual([
      {
        method: "OLV",
        fullName: "Orderly Liquidation Value",
        percentage: 80,
        value: 8000,
      },
      {
        method: "TKV",
        fullName: "Trade Value",
        percentage: null,
        value: null,
      },
    ]);
  });

  it("parses legacy formatted amounts and formats ISO or legacy currency labels", () => {
    expect(parseLotEstimatedValue("CAD 25,500.50")).toBe(25500.5);
    expect(parseLotEstimatedValue("Not valued")).toBeNull();
    expect(formatLotValuationValue(42000, "USD")).toContain("42,000");
    expect(formatLotValuationValue(42000, "US$")).toContain("42,000");
    expect(formatLotValuationValue(null, "CAD")).toBe("—");
  });
});
