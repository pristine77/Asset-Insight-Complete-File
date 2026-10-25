import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAuthoritativeBundleLotNumber,
  buildBundleLotNumberPhotoInputs,
  detectBundleLotNumbersFromPhotos,
  getBundleLotAnalysisLimit,
  normalizeDetectedBundleLotNumber,
  reapplyBundleLotNumberDiagnostics,
  resolveBundleLotAnalysisPolicy,
  selectBundleAnalysisImageIndexes,
  selectImagesPreservingEndpoints,
} from "../src/service/bundleLotAnalysisPolicy.js";

const { createResponse, convertImage } = vi.hoisted(() => ({
  createResponse: vi.fn(),
  convertImage: vi.fn(),
}));
vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: createResponse } },
}));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({
  imageUrlToBase64WithMime: convertImage,
}));

beforeEach(() => {
  vi.clearAllMocks();
  convertImage.mockImplementation(async (url: string) => ({
    base64: Buffer.from(url).toString("base64"), mime: "image/jpeg",
  }));
});

describe("Bundle first-main-photo lot analysis policy", () => {
  it.each([
    ["157", "157", 100],
    ["999", "999", 100],
    ["Lot #0999", "0999", 100],
    ["1000", "1000", 10],
    ["1,000", "1000", 10],
    ["1000A", "1000A", 10],
  ])("normalizes %s and selects the expected limit", (input, normalized, limit) => {
    expect(normalizeDetectedBundleLotNumber(input)).toBe(normalized);
    expect(getBundleLotAnalysisLimit(normalized)).toBe(limit);
  });

  it.each([
    "2026 year",
    "$1000",
    "VIN 1000A",
    "2CU148NE262029723",
    "1HGCM82633A004352",
    "Serial: 1000",
    "50 hp",
    "555/1000",
    "157 or 158",
    "uncertain",
    "",
    null,
  ])("rejects ambiguous equipment-label value %s", (input) => {
    expect(normalizeDetectedBundleLotNumber(input)).toBeNull();
  });

  it("uses positional numbering and the standard limit when detection is missing", () => {
    expect(
      resolveBundleLotAnalysisPolicy({
        groupIndex: 2,
        sourceImageIndex: 27,
        detectedLotNumber: null,
        mainImageCount: 80,
      }),
    ).toMatchObject({
      numberSource: "sequential_fallback",
      resolvedLotNumber: 3,
      sourceImageIndex: 27,
      selectedImageLimit: 100,
      analyzedImageCount: 80,
      detectorVersion: "first-main-photo-v3",
    });
  });

  it("reads each Bundle's first main image and skips report-only images", () => {
    const urls = Array.from({ length: 12 }, (_, index) => `image-${index}`);
    expect(
      buildBundleLotNumberPhotoInputs(
        [
          { count: 3, extraCount: 2, mode: "single_lot" },
          { count: 2, extraCount: 1, mode: "per_item" },
          { count: 4, extraCount: 0, mode: "single_lot" },
        ],
        urls,
      ),
    ).toEqual([
      { groupIndex: 0, sourceImageIndex: 0, imageUrl: "image-0" },
      { groupIndex: 2, sourceImageIndex: 8, imageUrl: "image-8" },
    ]);
  });

  it("uses image 1 as the lot-number source for a 200-image Bundle despite a later cover", () => {
    const urls = Array.from({ length: 202 }, (_, index) => `image-${index + 1}`);
    const group = { count: 200, extraCount: 2, mode: "single_lot", coverIndex: 150 };
    expect(
      buildBundleLotNumberPhotoInputs(
        [group],
        urls,
      ),
    ).toEqual([
      { groupIndex: 0, sourceImageIndex: 0, imageUrl: "image-1" },
    ]);
  });

  it("caps model input without removing report media", () => {
    const allMainIndexes = Array.from({ length: 200 }, (_, index) => index);
    const diagnostic = resolveBundleLotAnalysisPolicy({
      groupIndex: 0,
      sourceImageIndex: 0,
      detectedLotNumber: "1001",
      mainImageCount: allMainIndexes.length,
    });
    const selected = selectBundleAnalysisImageIndexes(
      allMainIndexes,
      diagnostic,
    );

    expect(selected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 199]);
    expect(diagnostic.analyzedImageCount).toBe(10);
    expect(allMainIndexes).toHaveLength(200);
    expect(allMainIndexes[199]).toBe(199);
  });

  it("reapplies the lot-number-photo identity after conflicting full analysis", () => {
    expect(
      applyAuthoritativeBundleLotNumber(
        { lot_number: "200", title: "Analyzed lot" },
        { resolvedLotNumber: "1000A" },
      ),
    ).toMatchObject({ lot_number: "1000A", title: "Analyzed lot" });
  });

  it.each([
    ["first-main-photo-v1", "first_main_photo"],
    ["last-main-photo-v2", "last_main_photo"],
    ["first-main-photo-v3", "first_main_photo"],
  ])("preserves user edits and can read %s diagnostics", (detectorVersion, numberSource) => {
    const lot = {
      sub_mode: "single_lot",
      lot_number: "USER-42",
      analysis_metadata: {
        bundle_lot_number_detection: {
          resolvedLotNumber: "1000A",
          // A legacy diagnostic remains compatible because regeneration only
          // needs its resolved value.
          numberSource,
          detectorVersion,
          firstImageIndex: 0,
        },
      },
    };

    expect(
      reapplyBundleLotNumberDiagnostics([lot], {
        preserveExistingLotNumber: true,
      })[0]?.lot_number,
    ).toBe("USER-42");
    expect(reapplyBundleLotNumberDiagnostics([lot])[0]?.lot_number).toBe(
      "1000A",
    );
  });

  it.each([0, 1, 2, 10, 11, 99, 100, 101, 104, 200])(
    "preserves endpoints without duplicating source indexes for %s photos",
    (count) => {
      const source = Object.freeze(Array.from({ length: count }, (_, index) => index));
      for (const limit of [2, 8, 10, 100]) {
        const selected = selectImagesPreservingEndpoints(source, limit);
        expect(selected).toHaveLength(Math.min(count, limit));
        expect(new Set(selected).size).toBe(selected.length);
        expect(selected).not.toBe(source);
        if (count > 0) {
          expect(selected[0]).toBe(0);
          expect(selected.at(-1)).toBe(count - 1);
        }
        if (count > limit) {
          expect(selected).toEqual([...source.slice(0, limit - 1), count - 1]);
        } else {
          expect(selected).toEqual(source);
        }
      }
    },
  );

  it("selects photos 1–99 and 104 for the reported lot 157 example", () => {
    const source = Array.from({ length: 104 }, (_, index) => index + 1);
    const policy = resolveBundleLotAnalysisPolicy({
      groupIndex: 0, sourceImageIndex: 0, detectedLotNumber: "157", mainImageCount: 104,
    });
    expect(selectBundleAnalysisImageIndexes(source, policy)).toEqual([
      ...source.slice(0, 99), 104,
    ]);
    expect(policy).toMatchObject({
      resolvedLotNumber: "157", numberSource: "first_main_photo", analyzedImageCount: 100,
    });
  });

  it("handles empty or invalid selection budgets without modifying sources", () => {
    const source = ["first", "middle", "last"];
    for (const limit of [0, -1, NaN, Infinity]) {
      expect(selectImagesPreservingEndpoints(source, limit)).toEqual([]);
    }
    expect(selectImagesPreservingEndpoints(source, 1)).toEqual(["first"]);
    expect(source).toEqual(["first", "middle", "last"]);
  });

  it("never selects extra photos for an empty main group", () => {
    expect(buildBundleLotNumberPhotoInputs([
      { count: 0, extraCount: 2, mode: "single_lot" },
      { count: 1, mode: "single_lot" },
    ], ["extra-1", "extra-2", "lot-157"])).toEqual([
      { groupIndex: 1, sourceImageIndex: 2, imageUrl: "lot-157" },
    ]);
  });

  it("sends the first-main-photo detector instruction and rejects serial output", async () => {
    createResponse.mockResolvedValue({ output_text: JSON.stringify({ results: [
      { groupIndex: 0, lotNumber: "157" },
      { groupIndex: 1, lotNumber: "VIN 1HGCM82633A004352" },
      { groupIndex: 99, lotNumber: "999" },
    ] }) });
    const inputs = buildBundleLotNumberPhotoInputs([
      { count: 2, extraCount: 1, mode: "single_lot" },
      { count: 2, mode: "single_lot" },
    ], ["lot-sticker", "serial", "extra", "unknown", "serial-2"]);
    const result = await detectBundleLotNumbersFromPhotos(inputs);
    expect([...result]).toEqual([[0, "157"], [1, null]]);
    expect(convertImage.mock.calls.map(([url]) => url)).toEqual(["lot-sticker", "unknown"]);
    const content = createResponse.mock.calls[0]![0].input[0].content;
    expect(content[0].text).toContain("original first main photo");
    expect(content[0].text).toContain("Return null when uncertain");
    expect(content.filter((part: any) => part.type === "input_image")).toHaveLength(2);
  });

  it("falls back safely when lot-number detection fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    createResponse.mockRejectedValue(new Error("provider unavailable"));
    try {
      expect([...await detectBundleLotNumbersFromPhotos([
        { groupIndex: 2, sourceImageIndex: 0, imageUrl: "unreadable" },
      ])]).toEqual([[2, null]]);
    } finally {
      warning.mockRestore();
    }
  });
});
