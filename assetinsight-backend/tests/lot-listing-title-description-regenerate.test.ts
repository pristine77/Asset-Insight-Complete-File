/*
 * Title and Description are two separate fields. Employees reported
 * (2026-10-10) that after editing both in the web app and pressing Save &
 * Regenerate, the Description came back equal to the Title. This drives the
 * real path end to end -- the web app's POST /lot-listing/:id/resubmit handler
 * and the regeneration job it queues -- with both fields edited, and checks
 * each is kept exactly as typed in the saved preview and the root lots.
 *
 * Setup (stand-ins for storage, AI and file builders) is the same as
 * lot-listing-watermark-policy.test.ts.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";
import { runLotListingJob, runRegenerateLotListingJob } from "../src/jobs/lotListingJob.js";
import { generateLotListingXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";
import { detectBundleLotNumbersFromPhotos } from "../src/service/bundleLotAnalysisPolicy.js";
import { resubmitLotListing, submitLotListingForApproval } from "../src/controller/lotListing.controller.js";

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
  processImageWithLogo: vi.fn(async (buffer: Buffer) => ({ buffer: Buffer.concat([Buffer.from("marked:"), buffer]), format: "jpeg", logo: "stamped", pixelsChanged: true })),
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
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
beforeEach(async () => {
  vi.clearAllMocks();
  await mongoose.connection.db!.dropDatabase();
  upstream.lots.mockResolvedValue([{ lotNumber: "12" }]);
  vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, "157"]]));
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const photo = (index: number) => ({
  fieldname: "images", originalname: `photo-${index}.jpg`, mimetype: "image/jpeg", buffer: Buffer.from(`original-${index}`),
  r2PublicUrl: `https://assetinsight.pro/uploads/direct/photo-${index}.jpg`,
}) as Express.Multer.File;

function fakeRes() {
  const out: any = { statusCode: 0, body: undefined };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (body: any) => { out.body = body; return out; };
  out.setHeader = () => out;
  return out;
}

const EDITED_TITLE = "2018 Manac Frac Shack Bi-Fuel FracFueller Trailer";
const EDITED_DESCRIPTION = "Bi-fuel fueling trailer with enclosure, fuel manifold, pump, hoses and portable ramp.";

describe("web Save & Regenerate with an edited title and description", () => {
  it("keeps each exactly as typed, through the save and the regenerated files", async () => {
    const report = await runLotListingJob({
      user: { id: new mongoose.Types.ObjectId().toString(), email: "editor@example.test" },
      images: [photo(1), photo(2), photo(3)],
      details: { contract_no: "901665", sales_date: "2026-09-07", location: "Regina, SK", draft_preview: true,
        include_damage_analysis: false, watermark_images: false,
        mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot" }] },
    });
    // Submitted and approved earlier, so the web app offers Save & Regenerate.
    await LotListing.updateOne({ _id: report._id }, { $set: {
      status: "approved", is_draft_preview: false, job_status: "done", files_generating: false, files_regenerating: false,
    } });
    const stored: any = await LotListing.findById(report._id).lean();

    const edited = { ...stored.preview_data, lots: stored.preview_data.lots.map((lot: any) => ({
      ...lot, title: EDITED_TITLE, description: EDITED_DESCRIPTION })) };
    const res = fakeRes();
    await resubmitLotListing({ params: { id: String(stored._id) }, userId: String(stored.user), body: { preview_data: edited },
      user: { _id: String(stored.user), email: "editor@example.test", name: "Editor" } } as any, res as any);
    expect(res.statusCode).toBe(202);

    const saved: any = await LotListing.findById(stored._id).lean();
    expect(saved.preview_data.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });
    expect(saved.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });

    vi.mocked(generateLotListingXlsxFromReport).mockClear();
    await runRegenerateLotListingJob({ listingId: String(saved._id), generationToken: saved.job_id,
      user: { id: String(saved.user), email: "editor@example.test" }, previewDataSnapshot: saved.preview_data });

    const regenerated: any = await LotListing.findById(stored._id).lean();
    expect(regenerated.job_status).toBe("done");
    expect(regenerated.preview_data.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });
    expect(regenerated.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });
    // The workbook builder is handed both, each as typed.
    expect(vi.mocked(generateLotListingXlsxFromReport).mock.calls[0][0].lots[0]).toMatchObject({
      title: EDITED_TITLE, description: EDITED_DESCRIPTION,
    });
  });

  it("keeps each exactly as typed on the first Save & Generate from Preview Ready", async () => {
    const report = await runLotListingJob({
      user: { id: new mongoose.Types.ObjectId().toString(), email: "editor@example.test" },
      images: [photo(1), photo(2), photo(3)],
      details: { contract_no: "901665", sales_date: "2026-09-07", location: "Regina, SK", draft_preview: true,
        include_damage_analysis: false, watermark_images: false,
        mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot" }] },
    });
    // Preview Ready: the web app offers Save & Generate (POST /lot-listing/:id/submit-approval).
    await LotListing.updateOne({ _id: report._id }, { $set: {
      status: "preview", is_draft_preview: false, job_status: "done", files_generating: false, files_regenerating: false,
    } });
    const stored: any = await LotListing.findById(report._id).lean();

    const edited = { ...stored.preview_data, lots: stored.preview_data.lots.map((lot: any) => ({
      ...lot, title: EDITED_TITLE, description: EDITED_DESCRIPTION })) };
    const res = fakeRes();
    await submitLotListingForApproval({ params: { id: String(stored._id) }, userId: String(stored.user), body: { preview_data: edited },
      user: { _id: String(stored.user), email: "editor@example.test", name: "Editor" } } as any, res as any);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(202);

    const saved: any = await LotListing.findById(stored._id).lean();
    expect(saved.preview_data.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });

    vi.mocked(generateLotListingXlsxFromReport).mockClear();
    await runRegenerateLotListingJob({ listingId: String(saved._id), generationToken: saved.job_id,
      user: { id: String(saved.user), email: "editor@example.test" }, previewDataSnapshot: saved.preview_data });

    const generated: any = await LotListing.findById(stored._id).lean();
    expect(generated.job_status).toBe("done");
    expect(generated.preview_data.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });
    expect(generated.lots[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION });
    expect(vi.mocked(generateLotListingXlsxFromReport).mock.calls[0][0].lots[0]).toMatchObject({
      title: EDITED_TITLE, description: EDITED_DESCRIPTION,
    });
  });
});
