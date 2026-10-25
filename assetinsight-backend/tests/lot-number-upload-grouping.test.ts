import { describe, expect, it, vi } from "vitest";
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
import { applyReviewedGroupNumbers, buildLotNumberUploadGroups, lotNumberUploadWarnings } from "../src/service/lotNumberUploadGrouping.js";
import { resolveBundleLotAnalysisPolicy } from "../src/service/bundleLotAnalysisPolicy.js";
import { initialLotNumberFallbackIndexes } from "../src/service/initialLotNumberProvenance.js";
const files = (count: number) => Array.from({ length: count }, (_, index) => ({ fileId: `photo-${index}` }));
const start = (index: number, lotNumber: string) => ({ fileId: `photo-${index}`, kind: "lot_start", lotNumber });

describe("lot-number start-photo grouping", () => {
  it("keeps numbered photos as the first photo of their own ordered lots", () => {
    const groups = buildLotNumberUploadGroups(files(7), [start(0, "2500"), start(3, "2501"), start(6, "2502")]);
    expect(groups.map((group) => [group.lotNumber, group.fileIds])).toEqual([
      ["2500", ["photo-0", "photo-1", "photo-2"]], ["2501", ["photo-3", "photo-4", "photo-5"]], ["2502", ["photo-6"]],
    ]);
    expect(groups.map((group) => group.coverFileId)).toEqual(["photo-0", "photo-3", "photo-6"]);
  });
  it("retains an unnumbered leading group and requires review instead of dropping photos", () => {
    const groups = buildLotNumberUploadGroups(files(4), [start(2, "157")]);
    expect(groups[0].fileIds).toEqual(["photo-0", "photo-1"]);
    expect(groups[0].lotNumber).toBeUndefined();
    expect(lotNumberUploadWarnings(groups)[0]).toContain("group 1");
  });
  it("does not treat uncertain, serial or ordinary-image numbers as boundaries", () => {
    const groups = buildLotNumberUploadGroups(files(5), [start(0, "1"), start(1, "VIN 157"),
      { fileId: "photo-2", kind: "uncertain", lotNumber: "12" }, { fileId: "photo-3", kind: "photo", lotNumber: "25" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].imageCount).toBe(5);
  });
  it("preserves consecutive/repeated signs as distinct reviewable groups", () => {
    const groups = buildLotNumberUploadGroups(files(4), [start(0, "1000A"), start(1, "1000a"), start(3, "1001")]);
    expect(groups.map((group) => group.imageCount)).toEqual([1, 2, 1]);
    expect(lotNumberUploadWarnings(groups).join(" ")).toMatch(/appears more than once/);
  });
  it.each([0, 1, 2, 199, 200, 201, 5000])("preserves all %i photos without duplicate identities", (count) => {
    const input = files(count);
    const groups = buildLotNumberUploadGroups(input, input.filter((_, index) => index % 200 === 0).map((file) => ({
      fileId: file.fileId, kind: "lot_start", lotNumber: String(Number(file.fileId.slice(6)) + 2500),
    })));
    expect(groups.flatMap((group) => group.fileIds)).toEqual(input.map((file) => file.fileId));
    expect(groups.every((group) => group.imageCount <= 200)).toBe(true);
  });
  it("flags oversize groups without clipping them", () => {
    const groups = buildLotNumberUploadGroups(files(201), [start(0, "157")]);
    expect(groups[0].imageCount).toBe(201);
    expect(lotNumberUploadWarnings(groups)[0]).toMatch(/200/);
  });
  it("keeps manual numbers authoritative and out of automatic event numbering", () => {
    const groups = applyReviewedGroupNumbers(buildLotNumberUploadGroups(files(2), [start(0, "157")]), [{ lotNumber: "1,000A" }]);
    expect(groups[0].lotNumber).toBe("1000A");
    const diagnostic = resolveBundleLotAnalysisPolicy({ groupIndex: 0, mainImageCount: 104, reviewedLotNumber: groups[0].lotNumber, detectedLotNumber: "2" });
    expect(diagnostic).toMatchObject({ numberSource: "reviewed_upload", resolvedLotNumber: "1000A", selectedImageLimit: 10 });
    expect(initialLotNumberFallbackIndexes([{ lot_number: "1000A", analysis_metadata: { bundle_lot_number_detection: diagnostic } }])).toEqual([]);
  });
});
