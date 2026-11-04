import { describe, expect, it } from "vitest";
import { applyCaptureLotIdentities, readCaptureLotIdentity, renumberRepeatedLotNumbers } from "../src/service/captureLotIdentity.js";
import { initialLotNumberFallbackIndexes } from "../src/service/initialLotNumberProvenance.js";

describe("capture group identity", () => {
  it("keeps explicit non-contiguous labels, stable capture identity and exact image assignment", () => {
    const input = [{ lot_id: "lot-001", lot_number: "901", mixed_group_index: 1, image_indexes: [0,1] }, { lot_id: "lot-002", lot_number: "901", mixed_group_index: 2, image_indexes: [2] }];
    const before = structuredClone(input);
    const result = applyCaptureLotIdentities(input, [{ count: 2, capture_lot_id: "captured-a", capture_lot_number: "27.1" }, { count: 1, capture_lot_id: "captured-b", capture_lot_number: "30A" }]);
    expect(result.map(lot => lot.lot_number)).toEqual(["27.1", "30A"]);
    expect(result.map(lot => lot.image_indexes)).toEqual([[0,1],[2]]);
    expect(input).toEqual(before);
    expect(result[0].analysis_metadata.capture_lot_identity).toEqual({ id:"captured-a", number:"27.1", applied:true });
    expect(initialLotNumberFallbackIndexes(result)).toEqual([]);
    expect(renumberRepeatedLotNumbers(result)).toEqual(result);
  });
  it("does not guess labels for groups expanded into multiple items", () => {
    const result = applyCaptureLotIdentities([{ lot_number:"9", mixed_group_index:1 },{ lot_number:"10", mixed_group_index:1 }], [{count:2,capture_lot_id:"a",capture_lot_number:"27"}]);
    expect(result.map(lot => lot.lot_number)).toEqual(["9","10"]);
    expect(result.every(lot => lot.analysis_metadata.capture_lot_identity.applied === false)).toBe(true);
  });
  it.each(["source_key","source_parent_key","source_lot_id","schedule_a_parent_lot_id"])("keeps assigned identity authority for %s", key => {
    expect(readCaptureLotIdentity({ [key]:"provider", capture_lot_id:"a", capture_lot_number:"1" })).toEqual({});
  });
  it.each([{}, {capture_lot_id:"a"}, {capture_lot_id:"a",capture_lot_number:""}, {capture_lot_id:"a",capture_lot_number:"a\nb"}])("does not invent submitted identity for %j", input => expect(readCaptureLotIdentity(input)).toEqual({}));
  it("does not replace a reviewed Smart Upload identity", () => {
    const result=applyCaptureLotIdentities([{lot_number:"2500",mixed_group_index:1,analysis_metadata:{bundle_lot_number_detection:{numberSource:"reviewed_upload",resolvedLotNumber:"2500"}}}], [{count:1,capture_lot_id:"a",capture_lot_number:"1"}]);
    expect(result[0].lot_number).toBe("2500");
  });
  // Owner, 2026-11-04 ("1 and 2"): a repeat is renumbered, never a stopped report.
  it("keeps the first use of a number and gives a repeat the lowest free number, without changing the caller's rows", () => {
    const lots = [{lot_number:"Lot #27"},{lot_number:"27"},{lot_number:"1"}]; const before=structuredClone(lots);
    const result = renumberRepeatedLotNumbers(lots);
    expect(result.map(lot => lot.lot_number)).toEqual(["Lot #27", "2", "1"]);
    expect(result[1].analysis_metadata.lot_number_dropped).toEqual({ version: 1, value: "27", reason: "repeated" });
    expect(lots).toEqual(before);
  });
  it("renumbers the phone's case: a lot-card number beside the same position number", () => {
    // Lot 3 carries "7" from its lot card; the 7th lot is sent as "7".
    const phone = ["1","2","7","4","5","6","7","8"].map(lot_number => ({ lot_number }));
    const result = renumberRepeatedLotNumbers(phone);
    expect(result.map(lot => lot.lot_number)).toEqual(["1","2","7","4","5","6","3","8"]);
    expect(new Set(result.map(lot => lot.lot_number)).size).toBe(8);
    // A renumbered lot takes a free number in the sale on an Auctioneer work item.
    expect(initialLotNumberFallbackIndexes(result)).toContain(6);
  });
});
