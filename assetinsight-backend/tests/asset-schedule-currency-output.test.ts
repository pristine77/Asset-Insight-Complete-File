import { describe, expect, it } from "vitest";
import { buildScheduleRows } from "../src/service/assetSchedulePdfService.js";

function values(currency: string, amount: unknown) {
  return buildScheduleRows({ currency, valuation_methods: ["FML"], lots: [{ lot_number: "1", title: "Synthetic currency fixture", estimated_value: amount, image_urls: [] }] })[0].valuations.map(row => row.value);
}

describe("Asset Schedule A PDF currency output", () => {
  it.each([
    ["CAD", 1234.567, "CAD 1,234.57"],
    ["USD", 1234.567, "USD 1,234.57"],
    ["EUR", 1234.567, "EUR 1,234.57"],
    ["GBP", 1234.567, "GBP 1,234.57"],
    ["INR", 1234.567, "INR 1,234.57"],
    ["JPY", 1234.567, "JPY 1,235"],
    ["KWD", 1234.567, "KWD 1,234.567"],
  ])("prints %s with its ISO code and correct minor units", (currency, amount, expected) => {
    expect(values(String(currency), amount)).toEqual([expected]);
  });
  it("preserves an explicit zero and leaves an unknown amount blank", () => {
    expect(values("EUR", 0)).toEqual(["EUR 0.00"]);
    expect(values("EUR", "Unknown")).toEqual([""]);
  });
});
