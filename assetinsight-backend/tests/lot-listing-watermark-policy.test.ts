import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";
import AuctioneerWorkItem from "../src/models/auctioneerWorkItem.model.js";
import { runLotListingJob, runRegenerateLotListingJob } from "../src/jobs/lotListingJob.js";
import { generateLotListingXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";
import { prepareImageWithoutWatermark, processImageWithLogo } from "../src/utils/imageProcessing.js";
import { readMulterFileBuffer } from "../src/utils/reportTempFiles.js";
import { uploadBufferToR2 } from "../src/utils/r2Storage/r2Upload.js";
import { generateImagesZip } from "../src/jobs/assetReportJob/imagesZip.js";
import { analyzeAssetImages } from "../src/service/assetOpenAIService.js";
import { resolveReportGenerationStateForProfile } from "../src/utils/reportFileState.js";
import { getReportDownloadAccessForGeneration } from "../src/service/reportReleaseService.js";
import { detectBundleLotNumbersFromPhotos } from "../src/service/bundleLotAnalysisPolicy.js";
import { generateScheduleAPdfFromReport } from "../src/service/scheduleAReportPdfService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../src/service/auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../src/service/auctioneerSpecSheetDocxService.js";
import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";

const upstream = vi.hoisted(() => ({ lots: vi.fn() }));
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/service/auctioneer2Client.js", async (original) => ({
  ...await original<typeof import("../src/service/auctioneer2Client.js")>(),
  getContractLots: upstream.lots,
  getAuctioneer2ConfigStatus: () => ({ baseUrl: "https://auctioneer.example/api/external" }),
}));

vi.mock("../src/utils/imageProcessing.js", async (original) => ({
  ...await original<typeof import("../src/utils/imageProcessing.js")>(),
  prepareImageWithoutWatermark: vi.fn(async (buffer: Buffer) => ({ buffer, mimetype: "image/jpeg", extension: ".jpg" })),
  processImageWithLogo: vi.fn(async (buffer: Buffer) => ({ buffer: Buffer.concat([Buffer.from("marked:"), buffer]) })),
}));
vi.mock("../src/utils/reportTempFiles.js", () => ({
  readMulterFileBuffer: vi.fn(async (file: Express.Multer.File) => file.buffer),
  cleanupMulterFiles: vi.fn(async () => {}),
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>()),
  uploadBufferToR2: vi.fn(async (_buffer, _type, _bucket, key) => `https://assetinsight.pro/${key}`),
  uploadFilePathToR2: vi.fn(async () => { throw new Error("Unexpected file upload"); }),
  readR2ObjectBuffer: vi.fn(async () => { throw new Error("Unexpected storage read"); }),
  copyR2Object: vi.fn(async () => {}),
  deleteFromR2: vi.fn(async () => {}),
  getR2PublicUrl: (key: string) => `https://assetinsight.pro/${key}`,
}));
vi.mock("../src/service/assetOpenAIService.js", () => ({
  analyzeAssetImages: vi.fn(async () => ({ lots: [{
    lot_number: "157", title: "Steel workbench", description: "Steel workbench with a single drawer and four legs.",
    categories: "Shop Equipment", estimated_value: "CAD 800", item_condition: "Used", serial_number: "WORKBENCH-157",
    condition_report_specs: { Manufacturer: "Acme", Model: "Workbench", "Serial Number": "WORKBENCH-157", Material: "Steel" },
    image_indexes: [0, 1],
  }] })),
  normalizeAssetAiLot: (lot: unknown) => lot,
}));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/service/bundleLotAnalysisPolicy.js")>()),
  detectBundleLotNumbersFromPhotos: vi.fn(async () => new Map([[0, "157"]])),
}));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({
  registerFocusBoxes: vi.fn(), clearFocusBoxes: vi.fn(),
  imageUrlToBase64WithMime: vi.fn(async () => ({ base64: "ZmFrZQ==", mime: "image/jpeg" })),
}));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn(async () => ({ output_text: "{}" })) } } }));
vi.mock("../src/service/lotListingSpecEnrichmentService.js", () => ({ enrichLotListingSpecs: vi.fn(async ({ lots }) => ({ lots, analyses: [] })) }));
vi.mock("../src/service/reportGenerationProgressService.js", () => ({ setReportGenerationProgress: vi.fn(async () => {}) }));
vi.mock("../src/service/xlsx/assetXlsxService.js", () => ({ generateLotListingXlsxFromReport: vi.fn(async () => Buffer.from("xlsx")) }));
vi.mock("../src/service/scheduleAReportPdfService.js", () => ({ generateScheduleAPdfFromReport: vi.fn(async () => Buffer.from("schedule")) }));
vi.mock("../src/service/auctioneerSpecSheetPdfService.js", () => ({ generateAuctioneerSpecSheetPdfFromReport: vi.fn(async () => Buffer.from("pdf")) }));
vi.mock("../src/service/auctioneerSpecSheetDocxService.js", () => ({ generateAuctioneerSpecSheetDocxFromReport: vi.fn(async () => Buffer.from("docx")) }));
vi.mock("../src/jobs/assetReportJob/imagesZip.js", () => ({ generateImagesZip: vi.fn(async () => Buffer.from("zip")) }));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser: vi.fn(async () => {}) }));
vi.mock("../src/service/auctionsoftLotListingPush.js", () => ({ pushAuctionsoftLotListingIfReady: vi.fn(async () => {}) }));

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.db!.dropDatabase();
  upstream.lots.mockResolvedValue([{ lotNumber: "12" }]);
  vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, "157"]]));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const uploadedPhoto = (index: number, direct = false) => ({
  fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg", buffer: Buffer.from(`original-${index}`),
  ...(direct ? { r2PublicUrl: `https://assetinsight.pro/uploads/direct/photo-${index}.jpg` } : {}),
}) as Express.Multer.File;

async function generate(watermark: boolean | undefined, direct = false, providedImages?: Express.Multer.File[]) {
  const images = providedImages || [uploadedPhoto(1, direct), uploadedPhoto(2, direct), uploadedPhoto(3, direct)];
  const report = await runLotListingJob({
    user: { id: new mongoose.Types.ObjectId().toString(), email: "watermark@example.test" },
    images,
    details: {
      contract_no: "WATERMARK-POLICY", sales_date: "2026-09-07", location: "Regina, SK", draft_preview: true,
      include_damage_analysis: false,
      mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot" }],
      ...(watermark === undefined ? {} : { watermark_images: watermark }),
    },
  });
  return { images, stored: await LotListing.findById(report._id).lean() as any };
}

async function importedInput(sourceNumber?: string) {
  const reportId = new mongoose.Types.ObjectId();
  const workId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  await AuctioneerWorkItem.collection.insertOne({
    _id: workId, source: "auctioneer2", kind: sourceNumber ? "scheduleA" : "unknown",
    cycleKey: `test-${workId}`, clientSubmissionId: `test-${workId}`,
    linkedReportId: reportId, linkedReportModel: "LotListing", selectedReportType: "lotListing",
    claimedBy: ownerId, contract: { id: "incoming-contract", eventId: "incoming-event", contractNo: "93530" },
    snapshot: { lots: sourceNumber ? [{ sourceKey: "schedule-a-source", lotNumber: sourceNumber }] : [] },
    delivery: { status: "not_ready", lots: [] },
  });
  await LotListing.collection.insertOne({
    _id: reportId, user: ownerId, auctioneerWorkItem: workId,
    status: "processing", job_status: "queued", job_id: `initial-${reportId}`,
  });
  return {
    listingId: String(reportId),
    user: { id: String(ownerId), email: "incoming@example.test" },
    images: [uploadedPhoto(1, true), uploadedPhoto(2, true), uploadedPhoto(3, true)],
    details: {
      contract_no: "93530", sales_date: "2026-09-07", location: "Regina, SK", draft_preview: true,
      include_damage_analysis: false, watermark_images: false,
      mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot", ...(sourceNumber ? { source_key: "schedule-a-source" } : {}) }],
    },
  };
}

describe("Lot Listing initial-job watermark orchestration", () => {
  it("keeps reordered siblings with duplicate legacy IDs attached to their own reviewed specs and media", async () => {
    const { stored } = await generate(false, true);
    const lots = ["1829", "1825"].map((number, index) => ({
      ...stored.preview_data.lots[0], lot_id: "duplicated-legacy-id", lot_number: number,
      title: `Independent structure ${number}`, description: `Reviewed description ${number}`,
      condition_report_specs: { "Overall Width": `${number} mm` },
      condition_report_specs_manual_overrides: { "Overall Width": `${number} mm` },
      image_indexes: [index], image_urls: [stored.imageUrls[index]], extra_image_indexes: [], extra_image_urls: [],
    }));
    const preview = { ...stored.preview_data, lots };
    const token = "duplicate-id-reviewed-specs";
    await LotListing.updateOne({ _id: stored._id }, { $set: {
      status: "processing", job_status: "queued", job_id: token,
      files_generating: true, files_regenerating: false, preview_data: preview, lots,
    } });
    await runRegenerateLotListingJob({ listingId: String(stored._id), generationToken: token,
      user: { id: String(stored.user), email: "duplicate-specs@example.test" }, previewDataSnapshot: preview });
    const completed: any = await LotListing.findById(stored._id).lean();
    for (const output of [completed.lots, completed.preview_data.lots,
      (vi.mocked(generateLotListingXlsxFromReport).mock.calls.at(-1)?.[0] as any).lots]) {
      expect(output.map((lot: any) => lot.lot_number)).toEqual(["1829", "1825"]);
      for (const source of lots) {
        const actual = output.find((lot: any) => lot.lot_number === source.lot_number);
        expect(actual).toMatchObject({ lot_id: source.lot_id, title: source.title, description: source.description,
          condition_report_specs: source.condition_report_specs,
          condition_report_specs_manual_overrides: source.condition_report_specs_manual_overrides,
          image_urls: source.image_urls, image_indexes: source.image_indexes });
      }
    }
  });

  it.each([{}, { "Overall Width": "18 ft", Manufacturer: "" }])(
    "keeps the reviewed spec snapshot through first generation, failure retry and regeneration (%j)", async (specs) => {
      const { stored } = await generate(false, true);
      // Initial analysis still runs. Only the subsequent saved-preview file job
      // treats missing/cleared specs as intentional instead of asking AI again.
      expect(analyzeAssetImages).toHaveBeenCalled();
      expect(enrichLotListingSpecs).toHaveBeenCalled();
      const snapshot = { ...stored.preview_data, lots: stored.preview_data.lots.map((lot: any) => ({
        ...lot, categories: "Portable Structures", description: "Width: 20 ft; Manufacturer: Old Co",
        condition_report_specs: specs, condition_report_specs_manual_overrides: specs,
        condition_report_specs_deleted: ["Overall Height"],
      })) };
      const originalSnapshot = structuredClone(snapshot);
      for (const round of [1, 2]) {
        const token = `reviewed-specs-${round}`;
        await LotListing.updateOne({ _id: stored._id }, { $set: {
          status: "processing", job_status: "queued", job_id: token,
          files_generating: true, files_regenerating: round === 2,
          preview_data: snapshot, lots: snapshot.lots,
        } });
        vi.clearAllMocks();
        const input = { listingId: String(stored._id), generationToken: token,
          user: { id: String(stored.user), email: "reviewed-specs@example.test" }, previewDataSnapshot: snapshot };
        if (round === 1) {
          vi.mocked(generateImagesZip).mockRejectedValueOnce(new Error("Fixture archive interruption"));
          await expect(runRegenerateLotListingJob(input)).rejects.toThrow("Fixture archive interruption");
          await LotListing.updateOne({ _id: stored._id }, { $set: { job_status: "queued", status: "processing" } });
        }
        await runRegenerateLotListingJob(input);
        const completed: any = await LotListing.findById(stored._id).lean();
        expect(completed.job_status).toBe("done");
        for (const lots of [completed.lots, completed.preview_data.lots]) {
          expect(lots[0].condition_report_specs || {}).toEqual(specs);
          expect(lots[0].condition_report_specs_manual_overrides || {}).toEqual(specs);
          expect(lots[0].condition_report_specs_reviewed).toBe(true);
          expect(lots[0].condition_report_specs_deleted).toContain("Overall Height");
        }
        for (const generator of [generateLotListingXlsxFromReport, generateScheduleAPdfFromReport,
          generateAuctioneerSpecSheetPdfFromReport, generateAuctioneerSpecSheetDocxFromReport]) {
          expect(generator).toHaveBeenCalled();
          for (const [data] of vi.mocked(generator).mock.calls) {
            expect((data as any).lots[0]).toMatchObject({ condition_report_specs: specs, condition_report_specs_reviewed: true });
          }
        }
        expect(analyzeAssetImages).not.toHaveBeenCalled();
        expect(enrichLotListingSpecs).not.toHaveBeenCalled();
        expect(completed.imageUrls).toEqual(stored.imageUrls);
        expect(snapshot).toEqual(originalSnapshot);
      }
      expect(await LotListing.countDocuments()).toBe(1);
    }
  );

  it("publishes a saved Lot Listing with blank FMV and no appraisal selections", async () => {
    const { stored } = await generate(false, true);
    const preview = { ...stored.preview_data, total_value: 0, lots: stored.preview_data.lots.map((lot: any) => ({
      ...lot, estimated_value: "", condition_report_selections: {},
    })) };
    const token = "optional-lot-values";
    await LotListing.updateOne({ _id: stored._id }, { $set: {
      status: "processing", job_status: "queued", job_id: token, total_value: 0,
      files_generating: true, files_regenerating: true, preview_data: preview, lots: preview.lots,
    } });
    vi.clearAllMocks();
    await runRegenerateLotListingJob({ listingId: String(stored._id), generationToken: token,
      user: { id: String(stored.user), email: "optional-values@example.test" }, previewDataSnapshot: preview });
    const completed: any = await LotListing.findById(stored._id).lean();
    expect(completed).toMatchObject({ status: "approved", job_status: "done", release_status: "released" });
    expect(completed.job_error).toBeUndefined();
    expect(completed.preview_files).toMatchObject({ excel: expect.any(String), images: expect.any(String) });
    expect(completed.imageUrls).toEqual(stored.imageUrls);
    expect(completed.preview_data.lots[0]).toMatchObject({
      description: preview.lots[0].description, lot_number: preview.lots[0].lot_number,
      image_urls: preview.lots[0].image_urls, estimated_value: "",
    });
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(vi.mocked(uploadBufferToR2).mock.calls.every(([, mime]) => !/^(image|video)\//.test(mime))).toBe(true);
  });

  it.each([false, true])("persists original video and includes it in initial/regenerated ZIP (direct: %s)", async (direct) => {
    const file = { fieldname: "videos", originalname: "capture.mp4", mimetype: "video/mp4", buffer: Buffer.from("original camera video"),
      ...(direct ? { r2PublicUrl: "https://assetinsight.pro/uploads/direct/capture.mp4" } : {}) } as Express.Multer.File;
    const created = await runLotListingJob({
      user: { id: new mongoose.Types.ObjectId().toString(), email: "video@example.test" },
      images: [uploadedPhoto(1, true), uploadedPhoto(2, true)], videos: [file],
      details: { contract_no: "VIDEO-LOT", sales_date: "2026-09-24", location: "Regina, SK", draft_preview: true, include_damage_analysis: false,
        mixed_lots: [{ count: 2, video_count: 1, mode: "single_lot" }] },
    });
    const stored: any = await LotListing.findById(created._id).lean();
    expect(stored.videoUrls).toHaveLength(1);
    expect(stored.preview_data.videoUrls).toEqual(stored.videoUrls);
    expect(stored.preview_data.lots[0].video_urls).toEqual(stored.videoUrls);
    expect(vi.mocked(generateImagesZip).mock.calls.at(-1)?.[2]?.rawFiles).toEqual([
      { url: stored.videoUrls[0], filename: expect.stringMatching(/Lot-001_Video-001_.*\.mp4$/) },
    ]);
    const uploadedClips = vi.mocked(uploadBufferToR2).mock.calls.filter(([, mime]) => mime === "video/mp4");
    expect(uploadedClips).toHaveLength(direct ? 0 : 1);
    if (!direct) expect(uploadedClips[0][0]).toEqual(file.buffer);
    const token = "video-regeneration";
    await LotListing.updateOne({ _id: stored._id }, { $set: { status: "processing", job_status: "queued", job_id: token, files_generating: true, files_regenerating: true } });
    vi.clearAllMocks();
    await runRegenerateLotListingJob({ listingId: String(stored._id), generationToken: token,
      user: { id: String(stored.user), email: "video@example.test" }, previewDataSnapshot: stored.preview_data });
    expect(vi.mocked(generateImagesZip).mock.calls.at(-1)?.[2]?.rawFiles?.map((entry) => entry.url)).toEqual(stored.videoUrls);
    expect(vi.mocked(uploadBufferToR2).mock.calls.every(([, mime]) => !/^(image|video)\//.test(mime))).toBe(true);
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect((await LotListing.findById(stored._id).lean())?.videoUrls).toEqual(stored.videoUrls);
  });

  it("persists event-continuing numbers through the imported Lot Listing initial worker", async () => {
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, null]]));
    const jobInput = await importedInput();
    await runLotListingJob(jobInput);
    const stored: any = await LotListing.findById(jobInput.listingId).lean();
    expect(stored).toMatchObject({ status: "preview", job_status: "done" });
    expect(stored.lots[0].lot_number).toBe("13");
    expect(stored.preview_data.lots[0]).toMatchObject({
      lot_number: "13", image_urls: stored.imageUrls.slice(0, 2), extra_image_urls: [stored.imageUrls[2]],
      cover_index: 1,
      analysis_metadata: { bundle_lot_number_detection: { numberSource: "sequential_fallback", resolvedLotNumber: "13" } },
    });
    expect(stored.imageUrls).toEqual(jobInput.images.map((file) => (file as any).r2PublicUrl));
    expect(upstream.lots).toHaveBeenCalledWith("incoming-contract");
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(await LotListing.countDocuments()).toBe(1);
  });

  it("preserves readable Lot Listing sticker numbers despite an earlier remote contract number", async () => {
    const jobInput = await importedInput();
    await runLotListingJob(jobInput);
    const stored: any = await LotListing.findById(jobInput.listingId).lean();
    expect(stored.preview_data.lots[0].lot_number).toBe("157");
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(stored.imageUrls).toHaveLength(3);
    expect(stored.preview_data.lots[0].image_urls[stored.preview_data.lots[0].cover_index]).toBe(stored.imageUrls[1]);
  });

  it("restores Schedule A lot number in Lot Listing when the sticker is unreadable", async () => {
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, null]]));
    const jobInput = await importedInput("0018A");
    await runLotListingJob(jobInput);
    const stored: any = await LotListing.findById(jobInput.listingId).lean();
    expect(stored.preview_data.lots[0]).toMatchObject({ lot_number: "0018A", auctioneer_source_key: "schedule-a-source" });
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(stored.imageUrls).toHaveLength(3);
  });

  it("does not restart fallback numbering for another undelivered imported Lot Listing", async () => {
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, null]]));
    const first = await importedInput();
    await runLotListingJob(first);
    const second = await importedInput();
    await runLotListingJob(second);
    const reports: any[] = await LotListing.find().sort({ _id: 1 }).lean();
    expect(reports.map((report) => report.preview_data.lots[0].lot_number)).toEqual(["13", "14"]);
    expect(reports.every((report) => report.status === "preview" && report.imageUrls.length === 3)).toBe(true);
  });

  it.each([undefined, "00730A"])("keeps allocated or manually edited numbers after an initial artifact failure and retry (%s)", async (manualNumber) => {
    vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, null]]));
    const jobInput = await importedInput();
    vi.mocked(generateImagesZip).mockRejectedValueOnce(new Error("Interrupted initial artifact generation"));
    await expect(runLotListingJob(jobInput)).rejects.toThrow("Interrupted initial artifact generation");
    const failed: any = await LotListing.findById(jobInput.listingId).lean();
    expect(failed.preview_data.lots[0].lot_number).toBe("13");
    const expectedNumber = manualNumber || "13";
    await LotListing.updateOne({ _id: jobInput.listingId }, { $set: {
      status: "processing", job_status: "queued",
      "preview_data.lots.0.lot_number": expectedNumber, "lots.0.lot_number": expectedNumber,
    } });
    await runLotListingJob(jobInput);
    const retried: any = await LotListing.findById(jobInput.listingId).lean();
    expect(retried.preview_data.lots[0].lot_number).toBe(expectedNumber);
    expect(retried.lots[0].lot_number).toBe(expectedNumber);
    expect(retried.imageUrls).toEqual(failed.imageUrls);
    expect(retried.preview_data.lots[0].image_urls[retried.preview_data.lots[0].cover_index]).toBe(retried.imageUrls[1]);
    expect(retried.preview_data.lots[0].extra_image_urls).toEqual([retried.imageUrls[2]]);
    expect(await LotListing.countDocuments()).toBe(1);
  });

  it("normalizes direct-R2 HEIC main/extra photos while leaving ordinary JPEG URLs intact", async () => {
    const main = { ...uploadedPhoto(1, true), originalname: "camera.heic", mimetype: "image/heic" };
    const jpeg = uploadedPhoto(2, true);
    const extra = { ...uploadedPhoto(3, true), originalname: "extra.heif", mimetype: "application/octet-stream" };
    const { stored } = await generate(undefined, true, [main, jpeg, extra]);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(readMulterFileBuffer).toHaveBeenCalledTimes(2);
    expect(prepareImageWithoutWatermark).toHaveBeenCalledTimes(2);
    const uploads = vi.mocked(uploadBufferToR2).mock.calls.filter((call) => String(call[3]).startsWith("uploads/lot-listing/"));
    expect(uploads).toHaveLength(2);
    expect(uploads.every((call) => call[1] === "image/jpeg" && String(call[3]).endsWith(".jpg"))).toBe(true);
    expect(stored.imageUrls[1]).toBe((jpeg as any).r2PublicUrl);
    expect(stored.imageUrls).toHaveLength(3);
    expect(stored.preview_data.lots[0].extra_image_urls).toEqual([stored.imageUrls[2]]);
  });
  it.each([undefined, false])("does not stamp photos when watermark preference is %s; all media/order/cover remain stored", async (watermark) => {
    const { images, stored } = await generate(watermark);
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(prepareImageWithoutWatermark).toHaveBeenCalledTimes(3);
    const mediaUploads = vi.mocked(uploadBufferToR2).mock.calls.filter((call) => String(call[3]).startsWith("uploads/lot-listing/"));
    expect(mediaUploads.map(([buffer]) => buffer)).toEqual(images.map((file) => file.buffer));
    const urls = mediaUploads.map((call) => `https://assetinsight.pro/${call[3]}`);
    expect(stored.imageUrls).toEqual(urls);
    expect(stored.watermark_images).toBe(false);
    expect(stored.preview_data.watermark_images).toBe(false);
    expect(stored.preview_data.lots[0]).toMatchObject({ image_urls: urls.slice(0, 2), image_indexes: [0, 1], extra_image_urls: urls.slice(2), extra_image_indexes: [2], cover_index: 1 });
    expect(stored.status).toBe("preview");
    expect(stored.job_status).toBe("done");
    expect(generateImagesZip).toHaveBeenCalledWith(expect.arrayContaining(urls), expect.anything(), expect.objectContaining({ watermark: false }));
  });

  it("retains explicit opt-in, stamps each newly prepared photo once, and does not stamp again for ZIP", async () => {
    const { images, stored } = await generate(true);
    expect(processImageWithLogo).toHaveBeenCalledTimes(3);
    expect(prepareImageWithoutWatermark).not.toHaveBeenCalled();
    expect(vi.mocked(processImageWithLogo).mock.calls.map(([buffer]) => buffer)).toEqual(images.map((file) => file.buffer));
    const mediaUploads = vi.mocked(uploadBufferToR2).mock.calls.filter((call) => String(call[3]).startsWith("uploads/lot-listing/"));
    expect(mediaUploads.map(([buffer]) => buffer)).toEqual(images.map((file) => Buffer.concat([Buffer.from("marked:"), file.buffer])));
    expect(stored.watermark_images).toBe(true);
    expect(stored.preview_data.watermark_images).toBe(true);
    expect(stored.imageUrls).toHaveLength(3);
    expect(generateImagesZip).toHaveBeenCalledWith(expect.arrayContaining(stored.imageUrls), expect.anything(), expect.objectContaining({ watermark: false }));
  });

  it.each([undefined, "approved", "pending_approval"])("publishes and auto-releases saved edits with target %s, without photo reuploads", async (target) => {
    const { stored } = await generate(false, true);
    const description = "Websites for reference: https://www.freightfarms.com/\n\nLeafy Green Machine (Greenhouse) — complete equipment and condition notes.\n- Lighting, racks and irrigation included.\nAdditional notes remain after export.";
    const preview = { ...stored.preview_data, lots: stored.preview_data.lots.map((lot: any) => ({ ...lot, description, lot_number: "0730A" })) };
    const token = "description-regeneration-test";
    await LotListing.updateOne({ _id: stored._id }, { $set: {
      status: "processing", job_status: "queued", job_id: token,
      files_regenerating: true, files_generating: true,
      preview_data: preview, lots: preview.lots,
      generation_target_status: target,
      approval_assigned_to: new mongoose.Types.ObjectId(),
      release_status: "pending_release",
    } });
    vi.clearAllMocks();
    await runRegenerateLotListingJob({ listingId: String(stored._id), generationToken: token,
      user: { id: String(stored.user), email: "regeneration@example.test" }, previewDataSnapshot: preview });
    const regenerated: any = await LotListing.findById(stored._id).lean();
    expect(regenerated.job_status).toBe("done");
    expect(regenerated.status).toBe("approved");
    expect(regenerated.release_status).toBe("released");
    expect(regenerated.release_assigned_source).toBe("auto_released");
    expect(regenerated.released_at).toEqual(regenerated.approval_processed_at);
    expect(regenerated.approval_assigned_to).toBeUndefined();
    expect(regenerated.generation_target_status).toBeUndefined();
    expect(regenerated.preview_files).toMatchObject({
      excel: expect.any(String), images: expect.any(String),
    });
    const state = resolveReportGenerationStateForProfile("lotListing", regenerated, regenerated.preview_files);
    expect(state.workflow_stage).toBe("ready");
    expect(getReportDownloadAccessForGeneration(regenerated, state).allowed).toBe(true);
    expect(regenerated.preview_data.lots[0].description).toBe(description);
    expect(regenerated.lots[0].description).toBe(description);
    expect(regenerated.preview_data.lots[0].lot_number).toBe("0730A");
    expect(regenerated.lots[0].lot_number).toBe("0730A");
    expect(regenerated.imageUrls).toEqual(stored.imageUrls);
    expect(vi.mocked(generateLotListingXlsxFromReport).mock.calls[0][0].lots[0].description).toBe(description);
    expect(vi.mocked(generateLotListingXlsxFromReport).mock.calls[0][0].lots[0].lot_number).toBe("0730A");
    expect(upstream.lots).not.toHaveBeenCalled();
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(vi.mocked(uploadBufferToR2).mock.calls.some((call) => String(call[3]).startsWith("uploads/"))).toBe(false);
  });

  it.each([
    "Caterpillar 420E IT 4WD Backhoe Loader\nAppraiser's saved inspection notes.",
    "",
    "Owner-authored historical note\nRunning Condition: Does not Start or Run; Completeness: Missing Parts; Legal: No Title",
  ])("never appends, strips or replaces a saved description during repeated file generation (%j)", async (description) => {
    const { stored } = await generate(false, true);
    const selections = { condition: "Starts and Runs", completeness: "Has Keys", legal: "N/A" };
    let preview = {
      ...stored.preview_data,
      lots: stored.preview_data.lots.map((lot: any) => ({
        ...lot,
        lot_number: "278",
        description,
        condition_report_selections: selections,
      })),
    };
    for (const round of [1, 2]) {
      // The next explicit save changes only selections; no saved prose should
      // change merely because those separate structured fields changed.
      const currentSelections = round === 1 ? selections : { condition: "N/A", completeness: "N/A", legal: "N/A" };
      preview.lots[0].condition_report_selections = currentSelections;
      const unchangedSnapshot = structuredClone(preview);
      const token = `description-selections-${round}`;
      await LotListing.updateOne({ _id: stored._id }, { $set: {
        status: "processing", job_status: "queued", job_id: token,
        files_regenerating: true, files_generating: true,
        preview_data: preview, lots: preview.lots,
      } });
      vi.clearAllMocks();
      await runRegenerateLotListingJob({
        listingId: String(stored._id), generationToken: token,
        user: { id: String(stored.user), email: "description@example.test" },
        previewDataSnapshot: preview,
      });
      const regenerated: any = await LotListing.findById(stored._id).lean();
      expect(regenerated).toMatchObject({ job_status: "done", status: "approved", release_status: "released" });
      for (const lots of [regenerated.lots, regenerated.preview_data.lots]) {
        expect(lots[0].description).toBe(description);
        expect(lots[0].condition_report_selections).toEqual(currentSelections);
        expect(lots[0].lot_number).toBe("278");
      }
      for (const generator of [generateLotListingXlsxFromReport, generateScheduleAPdfFromReport,
        generateAuctioneerSpecSheetPdfFromReport, generateAuctioneerSpecSheetDocxFromReport]) {
        expect(generator).toHaveBeenCalled();
        const reportData = vi.mocked(generator).mock.calls[0][0] as any;
        expect(reportData.lots[0].description).toBe(description);
        expect(reportData.lots[0].condition_report_selections).toEqual(currentSelections);
      }
      expect(preview).toEqual(unchangedSnapshot);
      expect(regenerated.imageUrls).toEqual(stored.imageUrls);
      expect(analyzeAssetImages).not.toHaveBeenCalled();
      expect(processImageWithLogo).not.toHaveBeenCalled();
      expect(vi.mocked(uploadBufferToR2).mock.calls.every(([, mime]) => !/^(image|video)\//.test(mime))).toBe(true);
      preview = regenerated.preview_data;
    }
    expect(await LotListing.countDocuments()).toBe(1);
  });

  it("keeps a failed regeneration unavailable even with old artifact URLs, and can retry the same report", async () => {
    const { stored } = await generate(false, true);
    const token = "failed-generation-test";
    await LotListing.updateOne({ _id: stored._id }, { $set: {
      status: "processing", job_status: "queued", job_id: token,
      files_generating: true, files_regenerating: true,
      generation_target_status: "pending_approval",
      generation_progress: { previousStatus: "approved" },
      release_status: "pending_release",
    } });
    vi.mocked(generateImagesZip).mockRejectedValueOnce(new Error("Photo archive could not be generated"));
    const input = { listingId: String(stored._id), generationToken: token,
      user: { id: String(stored.user), email: "regeneration@example.test" }, previewDataSnapshot: stored.preview_data };
    await expect(runRegenerateLotListingJob(input)).rejects.toThrow("Photo archive could not be generated");
    const failed: any = await LotListing.findById(stored._id).lean();
    expect(failed.preview_files).toEqual(stored.preview_files);
    expect(failed.released_at).toBeFalsy();
    const state = resolveReportGenerationStateForProfile("lotListing", failed, failed.preview_files);
    expect(state).toMatchObject({
      workflow_stage: "error", job_error: "Photo archive could not be generated",
    });
    expect(getReportDownloadAccessForGeneration(failed, state).allowed).toBe(false);
    await LotListing.updateOne({ _id: stored._id }, { $set: { job_status: "queued", status: "processing" } });
    await runRegenerateLotListingJob(input);
    const recovered: any = await LotListing.findById(stored._id).lean();
    expect(recovered).toMatchObject({ status: "approved", job_status: "done", release_status: "released" });
    expect(recovered.imageUrls).toEqual(stored.imageUrls);
    expect(await LotListing.countDocuments()).toBe(1);
  });

  it.each([undefined, false])("reuses direct-R2 URLs when preference is %s, without reads/transforms/reuploads", async (watermark) => {
    const { stored } = await generate(watermark, true);
    const expected = [1, 2, 3].map((index) => `https://assetinsight.pro/uploads/direct/photo-${index}.jpg`);
    expect(readMulterFileBuffer).not.toHaveBeenCalled();
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(prepareImageWithoutWatermark).not.toHaveBeenCalled();
    expect(vi.mocked(uploadBufferToR2).mock.calls.filter((call) => String(call[3]).startsWith("uploads/"))).toHaveLength(0);
    expect(stored.imageUrls).toEqual(expected);
    expect(stored.preview_data.lots[0]).toMatchObject({ image_urls: expected.slice(0, 2), image_indexes: [0, 1], extra_image_urls: expected.slice(2), extra_image_indexes: [2], cover_index: 1 });
    expect(vi.mocked(analyzeAssetImages).mock.calls[0][0]).toEqual(expected.slice(0, 2));
  });
});
