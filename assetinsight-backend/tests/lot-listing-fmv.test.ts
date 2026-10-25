import { describe, expect, it } from "vitest";
import { fillMissingFmvFromAvailableValues, getLotEstimatedValueText,
  isEstimatedValueMissing } from "../src/utils/lotListingFmv.js";

describe("optional Lot Listing value normalization", () => {
  it.each([undefined, null, "", " ", "CAD 0", 0, -1, "Not found", "N/A", "12.3.4", "--100"])("recognizes an absent/invalid optional amount %s", (value) => {
    expect(isEstimatedValueMissing(value)).toBe(true);
  });
  it.each([1, "CA$18,500", "CAD 0.01", "USD 42,000.25"])("accepts a positive saved amount %s", (value) => {
    expect(isEstimatedValueMissing(value)).toBe(false);
  });
  it("retains canonical value precedence and legacy aliases without mutation", () => {
    const lot = { estimated_value: "CAD 800", fmv: "CAD 900", image_urls: ["first", "last"] };
    expect(getLotEstimatedValueText(lot)).toBe("CAD 800");
    expect(getLotEstimatedValueText({ fmv: "CAD 900" })).toBe("CAD 900");
    expect(getLotEstimatedValueText({ valuation: { fair_market_value: "CAD 500" } })).toBe("CAD 500");
    const result = fillMissingFmvFromAvailableValues([lot], "CAD", 99999);
    expect(result).toEqual([lot]);
    expect(lot.image_urls).toEqual(["first", "last"]);
  });
  it("preserves the existing one-missing-lot remainder rule without requiring a value", () => {
    const lots = [{ lot_number: "750", estimated_value: "CAD 800" }, { lot_number: "751", estimated_value: "" }];
    const snapshot = structuredClone(lots);
    const prepared = fillMissingFmvFromAvailableValues(lots, "CAD", 1000);
    expect(prepared[1].estimated_value).toBe("CAD 200");
    expect(lots).toEqual(snapshot);
  });
  it("lists every affected display lot and never spreads a total across missing lots", () => {
    const lots = Array.from({ length: 30 }, (_, index) => ({ lot_number: String(750 + index), estimated_value: "", image_urls: [`photo-${index}`] }));
    const before = structuredClone(lots);
    expect(fillMissingFmvFromAvailableValues(lots, "CAD", 50000)).toEqual(before);
    expect(lots).toEqual(before);
  });
  it("leaves absent values blank when there is no saved total", () => {
    const lots = [{ lot_number: "001A", estimated_value: "" }];
    expect(fillMissingFmvFromAvailableValues(lots, "CAD", 0)).toEqual(lots);
    expect(fillMissingFmvFromAvailableValues([], "CAD", 0)).toEqual([]);
  });
});
