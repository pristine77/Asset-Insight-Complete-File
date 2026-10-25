import { describe, expect, it } from "vitest";
import { normalizeLotListingValuationMethods } from "../src/utils/lotListingValuationMethods.js";

describe("normalizeLotListingValuationMethods", () => {
  it("normalizes, validates, and de-duplicates every supported selection", () => {
    expect(
      normalizeLotListingValuationMethods([
        " fml ",
        "OLV",
        "fml",
        "unsupported",
        "FLV",
      ])
    ).toEqual(["FML", "OLV", "FLV"]);
  });

  it("uses the legacy FML default only when no value was supplied", () => {
    expect(normalizeLotListingValuationMethods(undefined)).toEqual(["FML"]);
    expect(normalizeLotListingValuationMethods([])).toEqual([]);
    expect(normalizeLotListingValuationMethods(["unsupported"])).toEqual([]);
  });
});
