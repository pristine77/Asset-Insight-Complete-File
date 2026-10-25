import { describe, expect, it } from "vitest";
import {
  mergeConditionReportSpecsPreservingEdited,
  mergeDeletedSpecFields,
} from "../src/jobs/lotListingJob.js";

/*
 * The regeneration job restores the appraiser's edited specs over whatever a
 * generator produced. Because that merge starts from the generated record, a
 * field the appraiser had deleted used to survive it — the overlay never
 * mentioned the field, so nothing removed it. The merge now also applies the
 * deletion tombstones, which is the last line of defence before persistence.
 */

describe("mergeConditionReportSpecsPreservingEdited", () => {
  it("overlays edited values on generated ones", () => {
    expect(
      mergeConditionReportSpecsPreservingEdited(
        { "Fuel Type": "Gas", "Drive Type": "6x4" },
        { "Fuel Type": "Diesel" }
      )
    ).toEqual({ "Fuel Type": "Diesel", "Drive Type": "6x4" });
  });

  it("removes a generated field the appraiser deleted, even though the overlay never mentions it", () => {
    expect(
      mergeConditionReportSpecsPreservingEdited(
        { "Fuel Type": "Diesel", "Hours (Showing Unverified)": "2450" },
        { "Fuel Type": "Diesel" },
        ["Hours (Showing Unverified)"]
      )
    ).toEqual({ "Fuel Type": "Diesel" });
  });

  it("matches a deletion by label variant", () => {
    expect(
      mergeConditionReportSpecsPreservingEdited(
        { "Hours (Showing Unverified)": "2450" },
        {},
        ["Hours"]
      )
    ).toBeUndefined();
  });

  it("does not remove fields that were not deleted", () => {
    expect(
      mergeConditionReportSpecsPreservingEdited(
        { "Drive Type": "6x4", "Tire Size": "11R22.5" },
        {},
        ["Fuel Type"]
      )
    ).toEqual({ "Drive Type": "6x4", "Tire Size": "11R22.5" });
  });

  it("returns undefined rather than an empty record", () => {
    expect(mergeConditionReportSpecsPreservingEdited({}, {}, ["Anything"])).toBeUndefined();
  });
});

describe("mergeDeletedSpecFields", () => {
  it("unions both tombstone lists without duplicates, keeping the first spelling", () => {
    expect(mergeDeletedSpecFields(["Fuel Type"], ["fuel type", "Drive Type"])).toEqual([
      "Fuel Type",
      "Drive Type",
    ]);
  });

  it("returns undefined when neither side recorded a deletion", () => {
    expect(mergeDeletedSpecFields(undefined, [])).toBeUndefined();
  });
});
