import fs from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadBuffer: vi.fn(), uploadFile: vi.fn(),
  heicConvert: vi.fn().mockResolvedValue(Buffer.from("normalized-jpeg-fixture")),
}));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn() } } }));
vi.mock("heic-convert", () => ({ default: mocks.heicConvert }));
vi.mock("../src/utils/imageProcessing.js", async (original) => {
  const actual = await original<typeof import("../src/utils/imageProcessing.js")>();
  return { ...actual, prepareImageWithoutWatermark: vi.fn(actual.prepareImageWithoutWatermark),
    processImageWithLogo: vi.fn().mockRejectedValue(new Error("Unexpected watermark pass")) };
});
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  uploadBufferToR2: mocks.uploadBuffer, uploadToR2: mocks.uploadFile,
  getR2PublicUrl: (key: string) => `https://assetinsight.test/${key}`,
}));
vi.mock("../src/service/openAIService.js", () => ({
  analyzeFarmlandImages: vi.fn().mockResolvedValue({}), analyzeCommercialImages: vi.fn().mockResolvedValue({}),
  analyzeRealEstateImages: vi.fn().mockResolvedValue({}),
}));
vi.mock("../src/service/webSearchService.js", () => ({
  findFarmlandComparables: vi.fn().mockResolvedValue([]), findComparableProperties: vi.fn().mockResolvedValue([]),
  findCommercialComparables: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/service/marketTrendSebSearch.js", () => ({ marketTrendSearch: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/service/realEstateAIContent.js", () => ({ generateRealEstateReportContent: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/service/salvageOpenAIService.js", () => ({ analyzeSalvageImages: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/service/salvageWebSearchService.js", () => ({ findComparableSalvageItems: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/service/salvageValuationService.js", () => ({ calculateSalvageValue: vi.fn().mockResolvedValue({}) }));

import { prepareImageWithoutWatermark, processImageWithLogo } from "../src/utils/imageProcessing.js";
import RealEstateReport from "../src/models/realEstate.model.js";
import SalvageReport from "../src/models/salvage.model.js";
import { runRealEstatePreviewJob, runRealEstateReportJob } from "../src/jobs/realEstateReportJob.js";
import { createRealEstate } from "../src/controller/realEstate.controller.js";

const STOP = new Error("TEST_STOP_BEFORE_PERSISTENCE_AND_ARTIFACTS");
const user = { id: "507f1f77bcf86cd799439011" };
const details = { property_type: "residential", property_details: {}, house_details: {} };
const file = (name: string, mimetype = "image/png") => ({
  originalname: name, mimetype, buffer: Buffer.from(`untouched-${name}`),
} as Express.Multer.File);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // No Mongo connection, provider request, storage write or generated artifact.
  vi.spyOn(RealEstateReport.prototype, "save").mockRejectedValue(STOP);
  vi.spyOn(SalvageReport.prototype, "save").mockRejectedValue(STOP);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Real Estate new-photo watermark default", () => {
  it.each([runRealEstatePreviewJob, runRealEstateReportJob])("preserves main and report-only bytes/MIME/order without a watermark (%s)", async (run) => {
    const main = file("main.png");
    const extra = file("map.webp", "image/webp");
    await expect(run({ user, details, images: [main], extraImages: [extra] })).rejects.toBe(STOP);
    expect(prepareImageWithoutWatermark).toHaveBeenCalledTimes(2);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(mocks.uploadBuffer).toHaveBeenCalledTimes(2);
    expect(mocks.uploadBuffer.mock.calls[0][0]).toBe(main.buffer);
    expect(mocks.uploadBuffer.mock.calls[0][1]).toBe("image/png");
    expect(mocks.uploadBuffer.mock.calls[0][3]).toMatch(/main\.png$/);
    expect(mocks.uploadBuffer.mock.calls[1][0]).toBe(extra.buffer);
    expect(mocks.uploadBuffer.mock.calls[1][1]).toBe("image/webp");
    expect(mocks.uploadBuffer.mock.calls[1][3]).toMatch(/map\.webp$/);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it.each([runRealEstatePreviewJob, runRealEstateReportJob])("converts HEIC main and extra images to JPEG without a logo (%s)", async (run) => {
    const main = { ...file("main.heic", "image/heic"), buffer: Buffer.from("xxxxftypheic-fixture-main") };
    const extra = { ...file("extra.heic", "image/heic"), buffer: Buffer.from("xxxxftypheic-fixture-extra") };
    await expect(run({ user, details, images: [main], extraImages: [extra] })).rejects.toBe(STOP);
    expect(mocks.heicConvert).toHaveBeenCalledTimes(2);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(mocks.uploadBuffer).toHaveBeenCalledTimes(2);
    for (const call of mocks.uploadBuffer.mock.calls) {
      expect(call[0]).toEqual(Buffer.from("normalized-jpeg-fixture"));
      expect(call[1]).toBe("image/jpeg");
      expect(call[3]).toMatch(/\.jpg$/);
      expect(call[3]).not.toContain(".heic");
    }
  });

  it("retains legacy disk-backed main and extra image preparation without a logo", async () => {
    const main = file("main.png");
    const extra = file("extra.png");
    const actualRead = fs.readFile.bind(fs);
    const buffers = new Map([["/isolated-fixture-main", main.buffer], ["/isolated-fixture-extra", extra.buffer]]);
    vi.spyOn(fs, "readFile").mockImplementation(((input: any, ...args: any[]) => {
      const buffer = buffers.get(String(input));
      return buffer ? Promise.resolve(buffer) : (actualRead as any)(input, ...args);
    }) as any);
    const disk = (source: Express.Multer.File, path: string) => ({ ...source, buffer: undefined, path } as unknown as Express.Multer.File);
    await expect(runRealEstateReportJob({ user, details, images: [disk(main, "/isolated-fixture-main")], extraImages: [disk(extra, "/isolated-fixture-extra")] })).rejects.toBe(STOP);
    expect(mocks.uploadBuffer.mock.calls.map((call) => call[0])).toEqual([main.buffer, extra.buffer]);
    expect(processImageWithLogo).not.toHaveBeenCalled();
  });

  it.each([runRealEstatePreviewJob, runRealEstateReportJob])("keeps original unwatermarked bytes if compatibility preparation fails (%s)", async (run) => {
    vi.mocked(prepareImageWithoutWatermark).mockRejectedValueOnce(new Error("Decode unavailable"))
      .mockRejectedValueOnce(new Error("Decode unavailable"));
    const main = file("main.png");
    const extra = file("extra.png");
    await expect(run({ user, details, images: [main], extraImages: [extra] })).rejects.toBe(STOP);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    if (run === runRealEstatePreviewJob) {
      expect(mocks.uploadBuffer.mock.calls.map((call) => call[0])).toEqual([main.buffer, extra.buffer]);
      expect(mocks.uploadBuffer.mock.calls.map((call) => call[1])).toEqual(["image/png", "image/png"]);
    } else {
      expect(mocks.uploadFile.mock.calls.map((call) => call[0])).toEqual([main, extra]);
    }
  });

  it("keeps the already-unwatermarked sync upload path unchanged", async () => {
    const main = file("original.png");
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await createRealEstate({ user: { _id: user.id }, body: { details: JSON.stringify(details) }, files: [main] } as any, response as any);
    expect(response.status).toHaveBeenCalledWith(500); // Deliberate stop before persistence.
    expect(mocks.uploadFile.mock.calls[0][0]).toBe(main);
    expect(mocks.uploadFile.mock.calls[0][2]).toMatch(/original\.png$/);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(prepareImageWithoutWatermark).not.toHaveBeenCalled();
  });
});

// Salvage now uses durable preview/file jobs. Original-byte/order/watermark
// characterization lives in salvage-durable-job.test.ts with isolated Mongo.
