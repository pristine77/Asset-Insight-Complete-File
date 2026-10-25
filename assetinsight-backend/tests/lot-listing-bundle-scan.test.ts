import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeLotListingGroupsWithAssetService,
  repairWeakLotListingLotsWithAssetService,
} from "../src/jobs/lotListingJob.js";
import { analyzeAssetImages } from "../src/service/assetOpenAIService.js";
import { detectBundleLotNumbersFromPhotos } from "../src/service/bundleLotAnalysisPolicy.js";
import { imageUrlToBase64WithMime } from "../src/service/assetOpenAIService/imageUtils.js";
import openai from "../src/utils/openaiClient.js";

vi.mock("../src/service/assetOpenAIService.js", () => ({
  analyzeAssetImages: vi.fn(),
  normalizeAssetAiLot: (lot: unknown) => lot,
}));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({
  imageUrlToBase64WithMime: vi.fn(),
  registerFocusBoxes: vi.fn(),
  clearFocusBoxes: vi.fn(),
}));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/service/bundleLotAnalysisPolicy.js")>()),
  detectBundleLotNumbersFromPhotos: vi.fn(),
}));
vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: vi.fn() } },
}));

const urls = (count: number, prefix = "main") =>
  Array.from({ length: count }, (_, i) => `https://photos.example.test/${prefix}-${i + 1}.jpg`);
const expectedScan = (photos: string[], limit: number) =>
  photos.length <= limit ? photos : [...photos.slice(0, limit - 1), photos.at(-1)!];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, "157"]]));
  vi.mocked(analyzeAssetImages).mockResolvedValue({
    lots: [{
      lot_number: "99999",
      title: "Travel Trailer",
      description: "Travel trailer",
      estimated_value: "CAD 8000",
      image_indexes: [0, 99],
    }],
  } as any);
  vi.mocked(imageUrlToBase64WithMime).mockImplementation(async (url) => ({
    base64: Buffer.from(url).toString("base64"),
    mime: "image/jpeg",
  }));
  vi.mocked(openai.responses.create).mockResolvedValue({ output_text: "{}" } as any);
});

describe("Lot Listing Bundle initial scan orchestration", () => {
  it("keeps reviewed upload numbers without re-reading their sign photos", async () => {
    const photos = urls(104);
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 104, mode: "single_lot", reviewed_lot_number: "2500", cover_index: 9 }], photos, [], "en", "CAD", false,
      undefined, undefined, { groupingMethod: "lot_number" },
    );
    expect(vi.mocked(detectBundleLotNumbersFromPhotos).mock.calls[0][0]).toEqual([]);
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(expectedScan(photos, 10));
    expect(result.lots[0]).toMatchObject({ lot_number: "2500", image_urls: photos,
      analysis_metadata: { bundle_lot_number_detection: { numberSource: "reviewed_upload", resolvedLotNumber: "2500" } } });
  });
  it.each([undefined, "black_divider"] as const)("does not honor reviewed-upload fields for ordinary/black upload mode %s", async (groupingMethod) => {
    const photos = urls(2);
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 2, mode: "single_lot", reviewed_lot_number: "2500" }], photos, [], "en", "CAD", false,
      undefined, undefined, { groupingMethod },
    );
    expect(vi.mocked(detectBundleLotNumbersFromPhotos).mock.calls[0][0]).toEqual([
      { groupIndex: 0, sourceImageIndex: 0, imageUrl: photos[0] },
    ]);
    expect(result.lots[0]).toMatchObject({ lot_number: "157",
      analysis_metadata: { bundle_lot_number_detection: { numberSource: "first_main_photo" } } });
  });
  it("rejects malformed reviewed numbers without skipping normal sign detection", async () => {
    const photos = urls(2);
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 2, mode: "single_lot", reviewed_lot_number: "VIN 2500" }], photos, [], "en", "CAD", false,
      undefined, undefined, { groupingMethod: "lot_number" },
    );
    expect(vi.mocked(detectBundleLotNumbersFromPhotos).mock.calls[0][0]).toHaveLength(1);
    expect(result.lots[0].lot_number).toBe("157");
  });
  it("resolves a shared source URL to its position inside each independent lot", async () => {
    const sharedUrl = "https://photos.example.test/shared-original.jpg";
    const photos = [sharedUrl, urls(1, "first-serial")[0], sharedUrl, urls(1, "second-serial")[0]];
    vi.mocked(analyzeAssetImages).mockResolvedValue({ lots: [{ title: "Trailer", image_indexes: [], image_url: sharedUrl }] } as any);
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 2, mode: "per_item" }, { count: 2, mode: "per_item" }], photos, [], "en", "CAD", false,
    );
    expect(result.lots).toHaveLength(2);
    expect(result.lots.map((lot) => lot.image_indexes)).toEqual([[0], [2]]);
    expect(result.lots.map((lot) => lot.image_urls)).toEqual([[sharedUrl], [sharedUrl]]);
  });

  it("does not attach a model URL from a different explicit lot", async () => {
    const photos = urls(4);
    vi.mocked(analyzeAssetImages).mockResolvedValue({ lots: [{ title: "Trailer", lot_number: "222", image_indexes: [], image_url: photos[0] }] } as any);
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 2, mode: "per_item" }, { count: 2, mode: "per_item" }], photos, [], "en", "CAD", false,
    );
    expect(result.lots).toHaveLength(2);
    expect(result.lots.map((lot) => lot.image_urls)).toEqual([[photos[0]], [photos[2]]]);
  });

  it("rejects mismatched explicit lot counts instead of silently dropping a group", async () => {
    await expect(analyzeLotListingGroupsWithAssetService(
      [{ count: 3, mode: "single_lot" }, { count: 3, mode: "single_lot" }], urls(4), [], "en", "CAD", false,
    )).rejects.toThrow(/lot.*photo.*mapping/i);
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(detectBundleLotNumbersFromPhotos).not.toHaveBeenCalled();
  });

  it("retains sparse per-lot video groups without feeding clips to image analysis", async () => {
    const photos = urls(3);
    const videos = ["https://assetinsight.test/clip1.mp4", "https://assetinsight.test/clip2.mp4"];
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 1, mode: "single_lot", video_count: 0 }, { count: 1, mode: "single_lot", video_count: 2 }, { count: 1, mode: "single_lot", video_count: 0 }],
      photos, videos, "en", "CAD", false,
    );
    expect(result.lots.map((lot) => lot.video_urls)).toEqual([[], videos, []]);
    expect(vi.mocked(analyzeAssetImages).mock.calls.map(([inputs]) => inputs)).toEqual(photos.map((photo) => [photo]));
  });

  it.each([false, true])("scans photos 1–99 and 104 while retaining every photo (explicit group: %s)", async (explicitGroup) => {
    const main = urls(104);
    const result = await analyzeLotListingGroupsWithAssetService(
      explicitGroup ? [{ count: 104, mode: "single_lot", cover_index: 56 }] : [],
      main, [], "en", "CAD", false,
    );

    expect(detectBundleLotNumbersFromPhotos).toHaveBeenCalledWith([
      { groupIndex: 0, sourceImageIndex: 0, imageUrl: main[0] },
    ]);
    expect(analyzeAssetImages).toHaveBeenCalledWith(expectedScan(main, 100), "single_lot", "en", "CAD", false);
    expect(result.lots[0]).toMatchObject({
      lot_number: "157",
      image_indexes: Array.from({ length: 104 }, (_, index) => index),
      image_urls: main,
      image_url: main[explicitGroup ? 56 : 0],
      cover_index: explicitGroup ? 56 : 0,
      analysis_metadata: {
        bundle_lot_number_detection: {
          numberSource: "first_main_photo",
          sourceImageIndex: 0,
          analyzedImageCount: 100,
          selectedImageLimit: 100,
        },
      },
    });
  });

  it.each(["1000", "1,000", "1000A"])("retains first nine and last for high lot %s", async (lotNumber) => {
    const main = urls(104);
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, lotNumber]]));
    const result = await analyzeLotListingGroupsWithAssetService(
      [{ count: 104, mode: "single_lot" }], main, [], "en", "CAD", false,
    );
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(expectedScan(main, 10));
    expect(result.lots[0].image_urls).toEqual(main);
    expect(result.lots[0].lot_number).toBe(lotNumber.replaceAll(",", ""));
  });

  it("excludes report-only photos and reads each group's first photo independent of cover", async () => {
    const first = urls(104, "first");
    const extras = urls(2, "report-only");
    const second = urls(104, "second");
    const all = [...first, ...extras, ...second];
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, "157"], [1, "1000"]]));
    const result = await analyzeLotListingGroupsWithAssetService(
      [
        { count: 104, extra_count: 2, mode: "single_lot", cover_index: 50 },
        { count: 104, mode: "single_lot", cover_index: 30 },
      ], all, [], "en", "CAD", false,
    );
    expect(detectBundleLotNumbersFromPhotos).toHaveBeenCalledWith([
      { groupIndex: 0, sourceImageIndex: 0, imageUrl: first[0] },
      { groupIndex: 1, sourceImageIndex: 106, imageUrl: second[0] },
    ]);
    expect(vi.mocked(analyzeAssetImages).mock.calls.map((call) => call[0])).toEqual([
      expectedScan(first, 100), expectedScan(second, 10),
    ]);
    expect(result.lots[0].extra_image_urls).toEqual(extras);
    expect(result.lots[0].image_urls).toEqual(first);
    expect(result.lots[1].image_urls).toEqual(second);
    expect(result.lots[1].image_indexes).toEqual(Array.from({ length: 104 }, (_, i) => i + 106));
  });

  it("uses sequential fallback and preserves the complete manifest if analysis fails", async () => {
    const main = urls(104);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map());
      vi.mocked(analyzeAssetImages).mockRejectedValue(new Error("simulated analysis failure"));
      const result = await analyzeLotListingGroupsWithAssetService([], main, [], "en", "CAD", false);
      expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(expectedScan(main, 100));
      expect(result.lots[0]).toMatchObject({ lot_number: 1, image_urls: main });
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["per_item", "per_photo"])("does not change %s sampling", async (mode) => {
    const main = urls(104);
    await analyzeLotListingGroupsWithAssetService([{ count: 104, mode }], main, [], "en", "CAD", false);
    expect(detectBundleLotNumbersFromPhotos).not.toHaveBeenCalled();
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(main.slice(0, 50));
  });
});

describe("Lot Listing Bundle repair scan orchestration", () => {
  it.each([
    ["157", 0], ["157", 103], ["1000", 0], ["1000", 103],
  ])("does not substitute another endpoint when photo %s/%s fails preparation", async (lotNumber, failedIndex) => {
    const main = urls(104);
    const extras = urls(2, "report-only");
    const lot = {
      lot_number: lotNumber,
      sub_mode: "single_lot",
      title: "Travel Trailer",
      description: "User's saved details",
      image_indexes: Array.from({ length: main.length }, (_, index) => index),
      image_urls: main,
      image_url: main[45],
      cover_index: 45,
      extra_image_indexes: [104, 105],
      extra_image_urls: extras,
    };
    vi.mocked(analyzeAssetImages).mockResolvedValue({ lots: [{}] } as any);
    vi.mocked(imageUrlToBase64WithMime).mockImplementation(async (url) => {
      if (url === main[Number(failedIndex)]) throw new Error("simulated unavailable reference photo");
      return { base64: Buffer.from(url).toString("base64"), mime: "image/jpeg" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await repairWeakLotListingLotsWithAssetService(
        [lot], [...main, ...extras], "en", "CAD", false, ["FML"],
      );
      expect(analyzeAssetImages).toHaveBeenCalledOnce();
      expect(openai.responses.create).not.toHaveBeenCalled();
      expect(result.lots[0]).toMatchObject(lot);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["157", 100], ["999", 100], ["1000", 10], ["1,000", 10], ["1000A", 10],
  ])("keeps serial/VIN endpoint within full and focused limits for lot %s", async (lotNumber, limit) => {
    const main = urls(104);
    const extras = urls(2, "report-only");
    const lot = {
      lot_number: lotNumber,
      sub_mode: "single_lot",
      title: "Travel Trailer",
      description: "The user's edited description\nSecond line",
      image_indexes: Array.from({ length: main.length }, (_, i) => i),
      image_urls: main,
      image_url: main[45],
      cover_index: 45,
      extra_image_indexes: [104, 105],
      extra_image_urls: extras,
    };
    vi.mocked(analyzeAssetImages).mockResolvedValue({
      lots: [{ lot_number: "99999", image_indexes: [0], image_urls: [main[0]] }],
    } as any);
    const result = await repairWeakLotListingLotsWithAssetService([lot], [...main, ...extras], "en", "CAD", false, ["FML"]);

    const fullSelection = expectedScan(main, Number(limit));
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(fullSelection);
    expect(detectBundleLotNumbersFromPhotos).not.toHaveBeenCalled();
    const requests = vi.mocked(openai.responses.create).mock.calls.map(([request]) => request as any);
    expect(requests).toHaveLength(2);
    const requestPhotos = (request: any): string[] => request.input[0].content
      .filter((input: any) => input.type === "input_image")
      .map((input: any) => Buffer.from(input.image_url.split(",")[1], "base64").toString());
    expect(requestPhotos(requests[0])).toEqual(expectedScan(fullSelection, 12));
    expect(requestPhotos(requests[1])).toEqual(expectedScan(fullSelection, 8));
    expect(requests[0].instructions).toContain("last supplied photo is the serial/VIN reference");
    expect(result.lots[0]).toMatchObject(lot);
    expect(imageUrlToBase64WithMime).not.toHaveBeenCalledWith(extras[0]);
    expect(imageUrlToBase64WithMime).not.toHaveBeenCalledWith(extras[1]);
  });

  it("keeps existing non-Bundle repair image selection unchanged", async () => {
    const main = urls(40);
    vi.mocked(analyzeAssetImages).mockResolvedValue({ lots: [{}] } as any);
    await repairWeakLotListingLotsWithAssetService([
      { lot_number: "157", sub_mode: "per_item", image_urls: main },
    ], main, "en", "CAD", false, ["FML"]);
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(main.slice(0, 30));
    const prepared = vi.mocked(imageUrlToBase64WithMime).mock.calls.map(([url]) => url);
    expect(prepared).toEqual([...main.slice(0, 12), ...main.slice(0, 8)]);
  });

  it("keeps non-Bundle focused passes tolerant of individual photo preparation errors", async () => {
    const main = urls(40);
    vi.mocked(analyzeAssetImages).mockResolvedValue({ lots: [{}] } as any);
    vi.mocked(imageUrlToBase64WithMime).mockImplementation(async (url) => {
      if (url === main[0]) throw new Error("simulated unavailable photo");
      return { base64: Buffer.from(url).toString("base64"), mime: "image/jpeg" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await repairWeakLotListingLotsWithAssetService([
        { lot_number: "157", sub_mode: "per_item", image_urls: main },
      ], main, "en", "CAD", false, ["FML"]);
      const requests = vi.mocked(openai.responses.create).mock.calls.map(([request]) => request as any);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.input[0].content.filter((input: any) => input.type === "input_image").length)).toEqual([11, 7]);
      expect(result.lots[0].image_urls).toEqual(main);
    } finally {
      warn.mockRestore();
    }
  });
});
