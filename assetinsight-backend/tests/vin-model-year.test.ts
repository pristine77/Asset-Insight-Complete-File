import { describe, expect, it } from "vitest";
import {
  extractFullVin,
  modelYearFromVin,
} from "../src/utils/vinModelYear.js";

function vinWith(seventh: string, tenth: string): string {
  const vin = "1HGCM8A63SA004352".split("");
  vin[6] = seventh;
  vin[9] = tenth;
  return vin.join("");
}

describe("VIN model-year fallback", () => {
  it.each([
    ["2", "B", 1981],
    ["2", "3", 2003],
    ["A", "L", 2020],
    ["A", "M", 2021],
    ["A", "T", 2026],
    ["A", "V", 2027],
    ["A", "W", 2028],
    ["A", "Y", 2030],
    ["A", "1", 2031],
  ])(
    "uses seventh-character era %s and year code %s for %i",
    (seventh, tenth, expected) => {
      expect(modelYearFromVin(vinWith(seventh, tenth))).toBe(expected);
    }
  );

  it("extracts a labelled complete VIN", () => {
    const vin = vinWith("A", "S");
    expect(extractFullVin(`VIN: ${vin}`)).toBe(vin);
  });

  it.each(["I", "O", "Q", "U", "Z", "0"])(
    "rejects invalid model-year code %s",
    (code) => {
      expect(modelYearFromVin(vinWith("A", code))).toBeUndefined();
    }
  );

  it("rejects partial VINs and VINs containing I, O, or Q", () => {
    expect(modelYearFromVin("1HGCM8A63SA00435")).toBeUndefined();
    expect(modelYearFromVin(vinWith("A", "S").replace("G", "I"))).toBeUndefined();
  });
});
