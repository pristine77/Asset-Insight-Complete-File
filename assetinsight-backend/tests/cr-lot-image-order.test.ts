import { describe, expect, it } from "vitest";
import { selectCrSummaryImages } from "../src/utils/crLotImageOrder.js";

describe("selectCrSummaryImages", () => {
  it("orders a five-image CR grid as first, last, second, third, fourth", () => {
    expect(selectCrSummaryImages(["1", "2", "3", "4", "5", "6"])).toEqual([
      "1",
      "6",
      "2",
      "3",
      "4",
    ]);
  });

  it("does not duplicate images for short lots", () => {
    expect(selectCrSummaryImages(["1"])).toEqual(["1"]);
    expect(selectCrSummaryImages(["1", "2"])).toEqual(["1", "2"]);
    expect(selectCrSummaryImages(["1", "2", "3"])).toEqual(["1", "3", "2"]);
  });

  it("honors an explicit grid limit", () => {
    expect(selectCrSummaryImages(["1", "2", "3", "4"], 3)).toEqual([
      "1",
      "4",
      "2",
    ]);
  });
});
