import { describe, expect, it } from "vitest";
import { applyCaptureLotIdentities, assertUniqueInitialLotNumbers, readCaptureLotIdentity, resolveInitialAutomaticLotNumbers } from "../src/service/captureLotIdentity.js";
import { initialLotNumberFallbackIndexes } from "../src/service/initialLotNumberProvenance.js";

describe("capture group identity", () => {
  it("reserves later photographed labels before assigning colliding automatic fallbacks", () => {
    const input = [
      { lot_id: "a", lot_number: "1", image_urls: ["photo-a"], analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback", resolvedLotNumber: 1 } } },
      { lot_id: "b", lot_number: "1", image_urls: ["photo-b"], analysis_metadata: { bundle_lot_number_detection: { numberSource: "first_main_photo", resolvedLotNumber: "1" } } },
      { lot_id: "c", lot_number: "2", image_urls: ["photo-c"], analysis_metadata: { capture_lot_identity: { id: "capture-c", number: "2", applied: true } } },
    ];
    const before = structuredClone(input);
    const result = resolveInitialAutomaticLotNumbers(input);
    expect(result.map(lot => lot.lot_number)).toEqual(["3", "1", "2"]);
    expect(result.map(lot => [lot.lot_id, lot.image_urls])).toEqual(input.map(lot => [lot.lot_id, lot.image_urls]));
    expect(result[0].analysis_metadata.bundle_lot_number_detection.resolvedLotNumber).toBe("3");
    expect(resolveInitialAutomaticLotNumbers(result)).toEqual(result);
    expect(input).toEqual(before);
  });
  it("only repairs proven automatic duplicates and never guesses explicit or unknown identities", () => {
    const fallback = { initial_lot_number: { version: 1, source: "sequential_fallback" } };
    const input = [{ lot_number: "7", analysis_metadata: fallback }, { lot_number: "7", analysis_metadata: fallback },
      { lot_number: "27A" }, { lot_number: "27a" }];
    const result = resolveInitialAutomaticLotNumbers(input);
    expect(result.map(lot => lot.lot_number)).toEqual(["7", "1", "27A", "27a"]);
    expect(() => assertUniqueInitialLotNumbers(result)).toThrow(/27a/);
    expect(resolveInitialAutomaticLotNumbers([{lot_number: "1"}, {lot_number: "1"}])).toEqual([{lot_number: "1"}, {lot_number: "1"}]);
  });

  it("preserves assigned and reviewed numbers even when older fallback metadata remains", () => {
    const fallback = { initial_lot_number: { version: 1, source: "sequential_fallback" } };
    const input = [
      { lot_number: "7", auctioneer_source_key: "assigned", analysis_metadata: fallback },
      { lot_number: "7", analysis_metadata: { ...fallback, auctioneer_lot_number: { source: "event_sequence", number: "7" } } },
      { lot_number: "7", analysis_metadata: { ...fallback, bundle_lot_number_detection: { numberSource: "reviewed_upload", resolvedLotNumber: "7" } } },
      { lot_number: "7", analysis_metadata: fallback },
    ];
    expect(resolveInitialAutomaticLotNumbers(input).map(lot => lot.lot_number)).toEqual(["7", "7", "7", "1"]);
  });
  it("keeps explicit non-contiguous labels, stable capture identity and exact image assignment", () => {
    const input = [{ lot_id: "lot-001", lot_number: "901", mixed_group_index: 1, image_indexes: [0,1] }, { lot_id: "lot-002", lot_number: "901", mixed_group_index: 2, image_indexes: [2] }];
    const before = structuredClone(input);
    const result = applyCaptureLotIdentities(input, [{ count: 2, capture_lot_id: "captured-a", capture_lot_number: "27.1" }, { count: 1, capture_lot_id: "captured-b", capture_lot_number: "30A" }]);
    expect(result.map(lot => lot.lot_number)).toEqual(["27.1", "30A"]);
    expect(result.map(lot => lot.image_indexes)).toEqual([[0,1],[2]]);
    expect(input).toEqual(before);
    expect(result[0].analysis_metadata.capture_lot_identity).toEqual({ id:"captured-a", number:"27.1", applied:true });
    expect(initialLotNumberFallbackIndexes(result)).toEqual([]);
    expect(() => assertUniqueInitialLotNumbers(result)).not.toThrow();
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
  it("rejects duplicate initial labels without silently changing the caller's rows", () => {
    const lots = [{lot_number:"Lot #27"},{lot_number:"27"}]; const before=structuredClone(lots);
    expect(() => assertUniqueInitialLotNumbers(lots)).toThrow(/Duplicate lot number 27/);
    expect(lots).toEqual(before);
  });
});
