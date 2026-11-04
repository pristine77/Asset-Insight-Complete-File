import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  watermark: vi.fn(async (buffer: Buffer) => ({ buffer })),
  analyze: vi.fn(),
  detect: vi.fn(),
  upload: vi.fn(),
  publicUrl: vi.fn(),
  pdf: vi.fn(),
  contractLots: vi.fn(),
  comparison: vi.fn(),
}));

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser: vi.fn(async () => {}) }));
vi.mock("../src/service/auctioneer2Client.js", async (original) => ({
  ...await original<typeof import("../src/service/auctioneer2Client.js")>(),
  getContractLots: mocks.contractLots,
  getAuctioneer2ConfigStatus: () => ({ baseUrl: "https://auctioneer.example/api/external" }),
}));
vi.mock("../src/service/assetOpenAIService.js", () => ({ analyzeAssetImages: mocks.analyze }));
vi.mock("../src/service/assetValuationService.js", () => ({ generateComparisonTableWithAI: mocks.comparison }));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (original) => ({
  ...await original<typeof import("../src/service/bundleLotAnalysisPolicy.js")>(),
  detectBundleLotNumbersFromPhotos: mocks.detect,
}));
vi.mock("../src/utils/imageProcessing.js", () => ({
  isHeicLikeImage: () => false,
  processImageWithLogo: mocks.watermark,
  prepareImageWithoutWatermark: async (buffer: Buffer) => ({ buffer, mimetype: "image/jpeg", extension: ".jpg" }),
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  uploadBufferToR2: mocks.upload,
  uploadToR2: mocks.upload,
  getR2PublicUrl: mocks.publicUrl,
}));
vi.mock("../src/service/vehicleApiService.js", async (original) => ({
  ...await original<typeof import("../src/service/vehicleApiService.js")>(),
  enrichLotsWithVin: async (lots: any[]) => lots,
}));
vi.mock("../src/service/lotListingSpecEnrichmentService.js", () => ({
  enrichAuctioneerImportSpecs: async ({ lots }: { lots: any[] }) => ({
    // A later general-analysis value must not replace the first-photo identity.
    lots: lots.map((lot) => ({ ...lot, lot_number: "9999" })), analyses: [],
  }),
}));
vi.mock("../src/service/reportGenerationProgressService.js", () => ({ setReportGenerationProgress: vi.fn() }));
vi.mock("../src/utils/reportJobMongoQueue.js", async (original) => ({
  ...await original<typeof import("../src/utils/reportJobMongoQueue.js")>(),
  updateMongoReportJobProgress: vi.fn(),
  endMongoReportJobProgress: vi.fn(),
}));
vi.mock("../src/service/assetPdfService.js", () => ({ generateAssetPdfFromReport: mocks.pdf }));

import AssetReport from "../src/models/asset.model.js";
import AuctioneerWorkItem from "../src/models/auctioneerWorkItem.model.js";
import { remapBundleItemImages, runAssetPreviewJob } from "../src/jobs/assetReportJob/previewJob.js";
import { runAssetReportJob } from "../src/jobs/assetReportJob.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.comparison.mockImplementation(async (base: number, methods: string[]) => ({ baseFMV: base,
    methods: methods.map(method => ({ method, percentage: method === "FML" ? 100 : 52, value: base * (method === "FML" ? 1 : 0.52) })) }));
  mocks.publicUrl.mockImplementation((key: string) => `https://assetinsight.test/${key}`);
  await mongoose.connection.db!.dropDatabase();
  mocks.contractLots.mockResolvedValue([{ lotNumber: "12" }]);
  mocks.detect.mockResolvedValue(new Map([[0, "157"], [1, "1000A"]]));
  mocks.analyze.mockImplementation(async (urls: string[]) => ({
    lots: [{
      title: "Heartland Sundance Travel Trailer",
      description: "Travel trailer with visible frame label",
      lot_number: "9999",
      estimated_value: "CAD 25000",
      image_indexes: [0, urls.length - 1],
      items: [{ title: "Frame label", image_local_index: urls.length - 1 }],
    }],
  }));
  // Legacy orchestration is verified through persistence; stop before artifact work.
  mocks.pdf.mockRejectedValue(new Error("TEST_ARTIFACT_BOUNDARY"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }));
});

function input(groupingMode: "mixed" | "single_lot") {
  const count = groupingMode === "mixed" ? 122 : 104;
  return {
    user: { id: new mongoose.Types.ObjectId().toString(), email: "scan@example.test" },
    images: Array.from({ length: count }, (_, index) => ({
      buffer: Buffer.from(`source-photo-${index}`),
      originalname: `photo-${index}.jpg`,
      mimetype: "image/jpeg",
    } as Express.Multer.File)),
    details: {
      grouping_mode: groupingMode,
      currency: "CAD",
      watermark_images: false,
      draft_preview: true,
      cover_index: 50,
      mixed_lots: groupingMode === "mixed" ? [
        { mode: "single_lot", count: 104, extra_count: 2, cover_index: 50 },
        { mode: "single_lot", count: 15, extra_count: 1, cover_index: 12 },
      ] : undefined,
    },
  };
}

async function importedInput(sourceNumbers?: string[]) {
  const jobInput = input("mixed");
  const reportId = new mongoose.Types.ObjectId();
  const workId = new mongoose.Types.ObjectId();
  await AuctioneerWorkItem.collection.insertOne({
    _id: workId, source: "auctioneer2", kind: sourceNumbers ? "scheduleA" : "unknown",
    cycleKey: `test-${workId}`, clientSubmissionId: `test-${workId}`,
    linkedReportId: reportId, linkedReportModel: "AssetReport", selectedReportType: "asset",
    claimedBy: new mongoose.Types.ObjectId(jobInput.user.id),
    contract: { id: "incoming-contract", eventId: "incoming-event", contractNo: "93530" },
    snapshot: { lots: (sourceNumbers || []).map((lotNumber, index) => ({ sourceKey: `source-${index}`, lotNumber })) },
    delivery: { status: "not_ready", lots: [] },
  });
  await AssetReport.collection.insertOne({
    _id: reportId, user: new mongoose.Types.ObjectId(jobInput.user.id), auctioneerWorkItem: workId,
    status: "processing", job_status: "queued", job_id: `initial-${reportId}`,
  });
  return { ...jobInput, reportId: String(reportId) };
}

describe("Asset Bundle scan orchestration", () => {
  it.each(["modern", "legacy"])("%s keeps FMV-only table-off processing free of comparison analysis", async (mode) => {
    const jobInput = input("single_lot");
    Object.assign(jobInput.details, { include_valuation_table: false, valuation_methods: ["FML"] });
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    expect(mocks.comparison).not.toHaveBeenCalled();
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(report.valuation_methods).toEqual(["FML"]);
  });
  it.each(["modern", "legacy"])("%s calculates selected FLV with the comparison table off and keeps its saved percentage", async (mode) => {
    const jobInput = input("single_lot");
    Object.assign(jobInput.details, { include_valuation_table: false, valuation_methods: ["FLV"] });
    const before = structuredClone(jobInput.details);
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(report.valuation_methods).toEqual(["FLV"]);
    expect(report.include_valuation_table).toBe(false);
    expect(report.valuation_data.methods).toEqual([{ method: "FLV", percentage: 52, value: 13000 }]);
    expect(mocks.comparison).toHaveBeenCalledTimes(1);
    expect(jobInput.details).toEqual(before);
    if (mode === "modern") expect(report.preview_data.valuation_data).toEqual(report.valuation_data);
  });
  it.each([
    ["modern", false], ["legacy", false],
    ["modern", true], ["legacy", true],
  ] as const)("FMV update review: %s persists the correct empty-selection default with table=%s", async (mode, table) => {
    const jobInput = input("single_lot");
    Object.assign(jobInput.details, { include_valuation_table: table, valuation_methods: [] });
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(report.valuation_methods).toEqual(table ? [] : ["FML"]);
    if (mode === "modern") expect(report.preview_data.valuation_methods).toEqual(table ? [] : ["FML"]);
  });

  it.each(["modern", "legacy"])("%s ignores malformed reviewed numbers without suppressing sign detection", async (mode) => {
    const jobInput = input("mixed");
    (jobInput.details as any).smart_upload_grouping_method = "lot_number";
    jobInput.details.mixed_lots!.forEach((group) => { (group as any).reviewed_lot_number = "VIN 2500"; });
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const lots = mode === "modern" ? report.preview_data.lots : report.lots;
    expect(mocks.detect.mock.calls[0][0]).toHaveLength(2);
    expect(lots.map((lot: any) => lot.lot_number)).toEqual(["157", "1000A"]);
    expect(lots.map((lot: any) => lot.analysis_metadata.bundle_lot_number_detection.numberSource)).toEqual(["first_main_photo", "first_main_photo"]);
  });
  it.each(["modern", "legacy"])("%s keeps reviewed lot numbers and all source media without another sign scan", async (mode) => {
    const jobInput = input("mixed");
    (jobInput.details as any).smart_upload_grouping_method = "lot_number";
    jobInput.details.mixed_lots!.forEach((group, index) => { (group as any).reviewed_lot_number = String(2500 + index); });
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const lots = mode === "modern" ? report.preview_data.lots : report.lots;
    expect(mocks.detect.mock.calls[0][0]).toEqual([]);
    expect(lots.map((lot: any) => lot.lot_number)).toEqual(["2500", "2501"]);
    expect(lots.map((lot: any) => lot.image_urls.length)).toEqual([104, 15]);
    expect(lots.map((lot: any) => lot.analysis_metadata.bundle_lot_number_detection.numberSource)).toEqual(["reviewed_upload", "reviewed_upload"]);
  });
  it.each(["modern", "legacy"])("%s resolves a shared source URL within its own manual group", async (mode) => {
    const jobInput = input("mixed");
    jobInput.images = jobInput.images.slice(0, 4);
    jobInput.details.mixed_lots = [
      { mode: "per_item", count: 2, extra_count: 0, cover_index: 0 },
      { mode: "per_item", count: 2, extra_count: 0, cover_index: 0 },
    ];
    const sharedUrl = "https://assetinsight.test/shared-original.jpg";
    mocks.publicUrl.mockImplementation((key: string) =>
      /(\/00000[02]-|photo-[02]\.jpg$)/.test(key) ? sharedUrl : `https://assetinsight.test/${key}`,
    );
    mocks.analyze.mockImplementation(async (photos: string[]) => ({
      lots: [{ title: "Separate trailer", estimated_value: "CAD 100", image_indexes: [], image_url: photos[0] }],
    }));
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const lots = mode === "modern" ? report.preview_data.lots : report.lots;
    expect(mocks.analyze.mock.calls.map(([photos]) => photos[0])).toEqual([sharedUrl, sharedUrl]);
    expect(lots.map((lot: any) => lot.image_indexes)).toEqual([[0], [2]]);
    expect(lots.map((lot: any) => lot.mixed_group_index)).toEqual([1, 2]);
    expect(new Set(lots.map((lot: any) => lot.lot_id)).size).toBe(2);
  });

  it.each(["modern", "legacy"])("%s keeps manual groups separate when model photo URLs point into another lot", async (mode) => {
    const jobInput = input("mixed");
    jobInput.images = jobInput.images.slice(0, 4);
    jobInput.details.mixed_lots = [
      { mode: "per_item", count: 2, extra_count: 0, cover_index: 0 },
      { mode: "per_item", count: 2, extra_count: 0, cover_index: 0 },
    ];
    let firstPhoto = "";
    mocks.analyze.mockImplementation(async (photos: string[]) => {
      firstPhoto ||= photos[0];
      return { lots: [{ title: "Separate trailer", estimated_value: "CAD 100", lot_number: "222", image_indexes: [0], image_url: firstPhoto }] };
    });
    await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const lots = mode === "modern" ? report.preview_data.lots : report.lots;
    expect(lots).toHaveLength(2);
    expect(lots.map((lot: any) => lot.image_url)).toEqual([report.imageUrls[0], report.imageUrls[2]]);
    expect(lots.map((lot: any) => lot.image_indexes)).toEqual([[0], [2]]);
    expect(lots.map((lot: any) => lot.mixed_group_index)).toEqual([1, 2]);
    expect(new Set(lots.map((lot: any) => lot.lot_id)).size).toBe(2);
  });

  it("refuses an incomplete mixed manifest before analysis instead of shifting photos into another group", async () => {
    const jobInput = input("mixed");
    jobInput.images = jobInput.images.slice(0, 4);
    jobInput.details.mixed_lots = [
      { mode: "single_lot", count: 0, extra_count: 1, cover_index: 0 },
      { mode: "single_lot", count: 3, extra_count: 0, cover_index: 0 },
    ];
    await expect(runAssetPreviewJob(jobInput)).rejects.toThrow(/lot.*photo.*mapping/i);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it.each(["222", null])("keeps independent Bundle identities and all media with sticker=%s", async (number) => {
    const jobInput = input("mixed");
    mocks.detect.mockResolvedValue(new Map([[0, number], [1, number]]));
    mocks.analyze.mockImplementation(async (photos: string[]) => ({ lots: [{
      title: photos[0], description: "Independent submitted unit", estimated_value: "CAD 100",
      image_indexes: [0], lot_number: "222",
    }] }));
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const lots = report.preview_data.lots;
    expect(lots).toHaveLength(2);
    expect(lots.map((lot: any) => lot.lot_id)).toEqual(["lot-001", "lot-002"]);
    expect(lots.map((lot: any) => String(lot.lot_number))).toEqual(number ? ["222", "222"] : ["1", "2"]);
    expect(lots.map((lot: any) => lot.image_urls)).toEqual([report.imageUrls.slice(0, 104), report.imageUrls.slice(106, 121)]);
    expect(lots.map((lot: any) => lot.extra_image_urls)).toEqual([report.imageUrls.slice(104, 106), report.imageUrls.slice(121)]);
    expect(lots.map((lot: any) => lot.title)).toEqual([report.imageUrls[0], report.imageUrls[106]]);
  });

  it("persists event-continuing fallback numbers on the actual imported Asset initial job", async () => {
    mocks.detect.mockResolvedValue(new Map([[0, null], [1, null]]));
    const jobInput = await importedInput();
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findById(jobInput.reportId).lean();
    expect(report.status).toBe("preview");
    expect(report.preview_data.lots.map((lot: any) => lot.lot_number)).toEqual(["13", "14"]);
    expect(mocks.contractLots).toHaveBeenCalledWith("incoming-contract");
    expect(report.imageUrls).toHaveLength(122);
    expect(report.preview_data.lots[0]).toMatchObject({
      image_url: report.imageUrls[50], image_urls: report.imageUrls.slice(0, 104),
      extra_image_urls: report.imageUrls.slice(104, 106),
      analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback", resolvedLotNumber: "13" } },
    });
    expect(report.preview_data.lots[1]).toMatchObject({
      image_url: report.imageUrls[118], image_urls: report.imageUrls.slice(106, 121),
      extra_image_urls: [report.imageUrls[121]],
    });
    expect(await AssetReport.countDocuments()).toBe(1);
  });

  it("preserves imported Asset sticker numbers after general enrichment", async () => {
    const jobInput = await importedInput();
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findById(jobInput.reportId).lean();
    expect(report.preview_data.lots.map((lot: any) => lot.lot_number)).toEqual(["157", "1000A"]);
    expect(mocks.contractLots).not.toHaveBeenCalled();
    expect(report.imageUrls).toHaveLength(122);
  });

  it("does not restart fallback numbering for another undelivered imported Asset report", async () => {
    mocks.detect.mockResolvedValue(new Map([[0, null], [1, null]]));
    const first = await importedInput();
    await runAssetPreviewJob(first);
    const second = await importedInput();
    await runAssetPreviewJob(second);
    const reports: any[] = await AssetReport.find().sort({ _id: 1 }).lean();
    expect(reports.map((report) => report.preview_data.lots.map((lot: any) => lot.lot_number))).toEqual([["13", "14"], ["15", "16"]]);
    expect(reports.every((report) => report.status === "preview" && report.imageUrls.length === 122)).toBe(true);
  });

  it("tracks missing per-item Asset numbers through later enrichment before event allocation", async () => {
    const jobInput = await importedInput();
    jobInput.images = jobInput.images.slice(0, 3);
    jobInput.details.mixed_lots = [{ mode: "per_item" as any, count: 2, extra_count: 1, cover_index: 0 }];
    mocks.analyze.mockResolvedValueOnce({ lots: [{
      title: "Workbench", description: "Workbench with drawer.", lot_number: null,
      estimated_value: "CAD 800", image_indexes: [0],
    }] });
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findById(jobInput.reportId).lean();
    expect(report.preview_data.lots[0].lot_number).toBe("13");
    expect(report.preview_data.lots[0].sub_mode).toBe("per_item");
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.contractLots).toHaveBeenCalledWith("incoming-contract");
    expect(report.imageUrls).toHaveLength(3);
  });

  it("preserves Schedule A source numbers when neither Asset sticker is readable", async () => {
    mocks.detect.mockResolvedValue(new Map([[0, null], [1, null]]));
    const jobInput = await importedInput(["0012A", "0157"]);
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findById(jobInput.reportId).lean();
    expect(report.preview_data.lots.map((lot: any) => lot.lot_number)).toEqual(["0012A", "0157"]);
    expect(report.preview_data.lots.map((lot: any) => lot.auctioneer_source_key)).toEqual(["source-0", "source-1"]);
    expect(mocks.contractLots).not.toHaveBeenCalled();
    expect(report.preview_data.lots[0].image_url).toBe(report.imageUrls[50]);
    expect(report.imageUrls).toHaveLength(122);
  });

  it("does not publish report-local fallback numbers when the existing Auctioneer lots cannot be read", async () => {
    mocks.detect.mockResolvedValue(new Map([[0, null], [1, null]]));
    mocks.contractLots.mockRejectedValue(new Error("Auctioneer is temporarily unavailable"));
    const jobInput = await importedInput();
    await expect(runAssetPreviewJob(jobInput)).rejects.toThrow("Auctioneer is temporarily unavailable");
    const report: any = await AssetReport.findById(jobInput.reportId).lean();
    expect(report.job_status).toBe("error");
    expect(report.preview_data?.lots || []).toHaveLength(0);
    expect(await AssetReport.countDocuments()).toBe(1);
  });

  it.each(["modern", "legacy"])("%s defaults watermarking off and preserves explicit opt-in", async (mode) => {
    for (const choice of [undefined, false, true, "false", "true"]) {
      vi.clearAllMocks();
      const jobInput: any = input("single_lot");
      jobInput.images = jobInput.images.slice(0, 2);
      jobInput.details.watermark_images = choice;
      jobInput.details.cover_index = 0;
      await (mode === "modern" ? runAssetPreviewJob : runAssetReportJob)(jobInput);
      const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
      const enabled = choice === true || choice === "true";
      expect(report.watermark_images).toBe(enabled);
      expect(report.imageUrls).toHaveLength(2);
      expect(mocks.watermark).toHaveBeenCalledTimes(enabled ? 2 : 0);
      expect(mocks.upload.mock.calls[0][0]).toEqual(jobInput.images[0].buffer);
    }
  });
  it.each(["mixed", "single_lot"] as const)("modern %s uses endpoints and retains the complete media manifest", async (mode) => {
    const jobInput = input(mode);
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(report.status).toBe("preview");
    expect(report.imageUrls).toHaveLength(jobInput.images.length);
    const urls = report.imageUrls;
    expect(mocks.detect.mock.calls[0][0][0]).toEqual({
      groupIndex: 0, sourceImageIndex: 0, imageUrl: urls[0],
    });
    expect(mocks.analyze.mock.calls[0][0]).toEqual([...urls.slice(0, 99), urls[103]]);
    const lots = report.preview_data.lots;
    expect(lots[0].lot_number).toBe("157");
    expect(lots[0].image_url).toBe(urls[50]);
    expect(lots[0].image_indexes).toEqual(Array.from({ length: 104 }, (_, index) => index));
    expect(lots[0].image_urls).toEqual(urls.slice(0, 104));
    expect(lots[0].items[0]).toMatchObject({ image_index: 103, image_url: urls[103] });
    expect(lots[0].analysis_metadata.bundle_lot_number_detection).toMatchObject({
      numberSource: "first_main_photo", sourceImageIndex: 0,
      selectedImageLimit: 100, analyzedImageCount: 100,
    });
    if (mode === "mixed") {
      expect(mocks.detect.mock.calls[0][0][1]).toEqual({
        groupIndex: 1, sourceImageIndex: 106, imageUrl: urls[106],
      });
      expect(mocks.analyze.mock.calls[1][0]).toEqual([...urls.slice(106, 115), urls[120]]);
      expect(lots[0].extra_image_urls).toEqual(urls.slice(104, 106));
      expect(lots[1].extra_image_urls).toEqual([urls[121]]);
      expect(lots[1].lot_number).toBe("1000A");
      expect(lots[1].image_url).toBe(urls[118]);
      expect(lots[1].image_urls).toEqual(urls.slice(106, 121));
      expect(lots[1].items[0]).toMatchObject({ image_index: 120, image_url: urls[120] });
    }
    expect(mocks.upload).toHaveBeenCalledTimes(jobInput.images.length);
  });

  it.each(["mixed", "single_lot"] as const)("legacy %s uses the same selection before artifact generation", async (mode) => {
    const jobInput = input(mode);
    await runAssetReportJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(report.imageUrls).toHaveLength(jobInput.images.length);
    const firstCallUrls = mocks.analyze.mock.calls[0][0] as string[];
    expect(firstCallUrls).toHaveLength(100);
    expect(firstCallUrls[0]).toContain("photo-0.jpg");
    expect(firstCallUrls[98]).toContain("photo-98.jpg");
    expect(firstCallUrls[99]).toContain("photo-103.jpg");
    expect(mocks.detect.mock.calls[0][0][0].imageUrl).toBe(firstCallUrls[0]);
    expect(report.lots[0].lot_number).toBe("157");
    expect(report.lots[0].image_urls).toEqual(report.imageUrls.slice(0, 104));
    expect(report.lots[0].image_url).toBe(report.imageUrls[50]);
    expect(report.lots[0].items[0]).toMatchObject({ image_index: 103, image_url: report.imageUrls[103] });
    if (mode === "mixed") {
      const highLotUrls = mocks.analyze.mock.calls[1][0] as string[];
      expect(highLotUrls).toHaveLength(10);
      expect(highLotUrls[0]).toContain("photo-106.jpg");
      expect(highLotUrls[9]).toContain("photo-120.jpg");
      expect(report.lots[1].lot_number).toBe("1000A");
      expect(report.lots[1].image_urls).toEqual(report.imageUrls.slice(106, 121));
      expect(report.lots[1].image_url).toBe(report.imageUrls[118]);
    }
    expect(mocks.pdf).toHaveBeenCalledOnce();
  });

  it.each([
    { detected: "1000", number: "1000", limit: 10 },
    { detected: null, number: 1, limit: 100 },
  ])("standalone detected=$detected uses the correct cap and sequential fallback", async ({ detected, number, limit }) => {
    mocks.detect.mockResolvedValue(new Map([[0, detected]]));
    const jobInput = input("single_lot");
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(mocks.analyze.mock.calls[0][0]).toEqual([
      ...report.imageUrls.slice(0, limit - 1), report.imageUrls[103],
    ]);
    expect(String(report.preview_data.lots[0].lot_number)).toBe(String(number));
    expect(report.preview_data.lots[0].image_urls).toHaveLength(104);
  });

  it("retains the existing non-Bundle limit without calling the lot detector", async () => {
    const baseInput = input("single_lot");
    const jobInput = { ...baseInput, details: { ...baseInput.details, grouping_mode: "per_item" } };
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.analyze.mock.calls[0][0]).toEqual(report.imageUrls.slice(0, 50));
    expect(mocks.analyze.mock.calls[0][1]).toBe("per_item");
  });

  it("uses the Bundle group position for fallback after a non-Bundle group and report-only photos", async () => {
    const jobInput = input("mixed");
    jobInput.images = jobInput.images.slice(0, 108);
    jobInput.details.mixed_lots = [
      { mode: "per_item", count: 2, extra_count: 1, cover_index: 0 },
      { mode: "single_lot", count: 104, extra_count: 1, cover_index: 50 },
    ];
    mocks.detect.mockResolvedValue(new Map([[1, null]]));
    await runAssetPreviewJob(jobInput);
    const report: any = await AssetReport.findOne({ user: jobInput.user.id }).lean();
    const urls = report.imageUrls;
    expect(mocks.detect.mock.calls[0][0]).toEqual([
      { groupIndex: 1, sourceImageIndex: 3, imageUrl: urls[3] },
    ]);
    expect(mocks.analyze.mock.calls[0].slice(0, 2)).toEqual([urls.slice(0, 2), "per_item"]);
    expect(mocks.analyze.mock.calls[1][0]).toEqual([...urls.slice(3, 102), urls[106]]);
    const lot = report.preview_data.lots[1];
    expect(String(lot.lot_number)).toBe("2");
    expect(lot.image_urls).toEqual(urls.slice(3, 107));
    expect(lot.extra_image_urls).toEqual([urls[107]]);
    expect(lot.image_url).toBe(urls[53]);
    expect(lot.items[0]).toMatchObject({ image_index: 106, image_url: urls[106] });
  });

  it("does not interpret invalid model-local indexes as original image indexes", () => {
    const result = remapBundleItemImages({ items: [
      { image_local_index: 2 }, { image_index: 99 }, { image_index: null }, { image_index: -1 },
      { image_url: "photo-103" }, { image_url: "photo-99" },
    ] }, [0, 1, 103], Array.from({ length: 104 }, (_, index) => `photo-${index}`));
    expect(result.items).toEqual([
      { image_index: 103, image_url: "photo-103" }, {}, {}, {},
      { image_index: 103, image_url: "photo-103" }, {},
    ]);
  });
});
