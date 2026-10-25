/*
 * What an employee edits and saves in Preview stays exactly as saved (owner,
 * 2026-10-11). Reported: "Went through and added all the details I wanted.
 * Deleted the ones I didn't want and hit Save & Generate but when I came back
 * it had added more details ... stating the dimensions of the item twice ...
 * or even change some stuff."
 *
 * This repeats those steps on a Tank Trailers lot through the real server
 * paths: the AI preview, the web app's spec edits (same shape as
 * assetinsight-client/lib/previewSpecEdits.ts), Save & Generate
 * (POST /lot-listing/:id/submit-approval), the generation job, then a second
 * edit with Save & Regenerate (POST /lot-listing/:id/resubmit). After each
 * save it checks the stored report and what the real Excel and Word
 * condition report builders print: exactly the saved fields and values, the
 * saved Title under Description, with the independent narrative retained in
 * storage and no reviewed specification deleted, added or changed.
 *
 * Setup (stand-ins for storage, AI and file builders during the job) is the
 * same as lot-listing-watermark-policy.test.ts.
 */
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LotListing from "../src/models/lotListing.model.js";
import { runLotListingJob, runRegenerateLotListingJob } from "../src/jobs/lotListingJob.js";
import { detectBundleLotNumbersFromPhotos } from "../src/service/bundleLotAnalysisPolicy.js";
import { analyzeAssetImages } from "../src/service/assetOpenAIService.js";
import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";
import { resubmitLotListing, submitLotListingForApproval } from "../src/controller/lotListing.controller.js";
import { buildSpecReportData } from "../src/service/auctioneerSpecPdfRefreshService.js";

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
// The AI's first pass, as it would come back for a tank trailer.
vi.mock("../src/service/assetOpenAIService.js", () => ({
  analyzeAssetImages: vi.fn(async () => ({ lots: [{
    lot_number: "073", title: "2019 Manac Frac Shack Tri-Axle Tank Trailer",
    description: "2019 Manac Frac Shack Tri-Axle Tank Trailer",
    details: "Overall length 53 ft, 102 in wide. Includes pump, hose reel and meter.",
    categories: "Tank Trailers", estimated_value: "CA$85,000", item_condition: "Untested",
    serial_number: "2M5131613L1187405",
    condition_report_specs: [
      { field: "Serial Number", value: "2M5131613L1187405" },
      { field: "GVWR", value: "100,849 lb" },
      { field: "Overall Length", value: "53FT" },
      { field: "Tank Capacity (Gallons)", value: "7900" },
      { field: "Tank Material", value: "steel" },
      { field: "Number of Axles", value: "3" },
      { field: "Axle Rating", value: "9,200 KG" },
      { field: "Suspension Type", value: "Air Spring" },
      { field: "Brake Type", value: "Pneumatic Drum" },
      { field: "Tire Size", value: "255/70R22.5" },
      { field: "Wheel Type", value: "Steel" },
      { field: "Heated", value: "Yes" },
      { field: "Pump", value: "Positive Displacement" },
      { field: "Metered System", value: "Yes" },
    ],
    image_indexes: [0, 1],
  }] })),
  normalizeAssetAiLot: (lot: unknown) => lot,
}));
vi.mock("../src/service/bundleLotAnalysisPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/service/bundleLotAnalysisPolicy.js")>()),
  detectBundleLotNumbersFromPhotos: vi.fn(async () => new Map([[0, "073"]])),
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
  vi.mocked(detectBundleLotNumbersFromPhotos).mockResolvedValue(new Map([[0, "073"]]));
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

const specRecord = (value: unknown): Record<string, string> => Array.isArray(value)
  ? Object.fromEntries(value.map((entry: any) => [String(entry?.field ?? "").trim(), String(entry?.value ?? "")]).filter(([field]) => field))
  : value && typeof value === "object" ? { ...(value as Record<string, string>) } : {};

/** One field edit exactly as the web app's applyPreviewSpecEdit records it (non-serial fields). */
function editSpec(lot: any, field: string, value: string, options: { deleted?: boolean; added?: boolean } = {}) {
  const same = (candidate: unknown) => String(candidate ?? "").trim().toLowerCase() === field.toLowerCase();
  const specs = specRecord(lot.condition_report_specs);
  const overrides = specRecord(lot.condition_report_specs_manual_overrides);
  for (const key of Object.keys(specs)) if (same(key)) delete specs[key];
  for (const key of Object.keys(overrides)) if (same(key)) delete overrides[key];
  const deleted = (Array.isArray(lot.condition_report_specs_deleted) ? lot.condition_report_specs_deleted : [])
    .filter((entry: unknown) => !same(entry));
  if (options.deleted) deleted.push(field); else specs[field] = value;
  overrides[field] = options.deleted ? "" : value;
  const next: any = { ...lot, condition_report_specs: specs, condition_report_specs_manual_overrides: overrides,
    condition_report_specs_deleted: deleted };
  if (Array.isArray(lot.condition_report_specs_custom_order) || options.added) {
    const order = (lot.condition_report_specs_custom_order || []).filter((entry: unknown) => !same(entry));
    if (options.added && !options.deleted) order.push(field);
    next.condition_report_specs_custom_order = order;
  }
  return next;
}

const realXlsx = () => vi.importActual<typeof import("../src/service/xlsx/assetXlsxService.js")>("../src/service/xlsx/assetXlsxService.js");
const realDocx = () => vi.importActual<typeof import("../src/service/auctioneerSpecSheetDocxService.js")>("../src/service/auctioneerSpecSheetDocxService.js");

async function excelRow(reportData: any) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await (await realXlsx()).generateLotListingXlsxFromReport(reportData));
  const sheet = workbook.getWorksheet("Sheet1")!;
  const values = new Map<string, string>();
  sheet.getRow(1).eachCell((cell, column) => values.set(String(cell.value), String(sheet.getRow(2).getCell(column).value ?? "")));
  return values;
}

/** Field/value pairs printed in the Excel Condition Report column. */
function excelSpecRows(conditionReportHtml: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const match of conditionReportHtml.matchAll(/<tr><td[^>]*><b>([^<]*)<\/b><\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)) {
    rows[match[1]] = match[2];
  }
  return rows;
}

async function docxText(reportData: any): Promise<string> {
  const buffer = await (await realDocx()).generateAuctioneerSpecSheetDocxFromReport(reportData);
  const xml = new PizZip(buffer).file("word/document.xml")?.asText() || "";
  return xml.replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "");
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The stored lot, the Excel and the Word condition report all carry exactly `expected`. */
async function expectExactlySaved(listingId: string, expected: Record<string, string>, description: string, gone: string[]) {
  const listing: any = await LotListing.findById(listingId).lean();
  expect(listing.job_status).toBe("done");
  for (const lot of [listing.preview_data.lots[0], listing.lots[0]]) {
    expect(lot.description).toBe(description);
    expect(specRecord(lot.condition_report_specs)).toEqual(expected);
  }

  const reportData = buildSpecReportData(listing);
  const row = await excelRow(reportData);
  expect(row.get("Description")).toBe(listing.preview_data.lots[0].title);
  const printed = excelSpecRows(row.get("Condition Report") || "");
  // Every saved value printed once, unchanged, under its saved field name.
  expect(Object.keys(printed).map(norm).sort()).toEqual(Object.keys(expected).map(norm).sort());
  for (const [field, value] of Object.entries(expected)) {
    const printedField = Object.keys(printed).find((candidate) => norm(candidate) === norm(field))!;
    expect(norm(printed[printedField])).toBe(norm(value));
  }

  const text = await docxText(reportData);
  expect(text).toContain(listing.preview_data.lots[0].title);
  expect(text).not.toContain(description);
  for (const value of Object.values(expected)) expect(text).toContain(value);
  for (const field of gone) expect(norm(text)).not.toContain(norm(field));
}

describe("an employee's saved condition report edits stay exactly as saved", () => {
  it("through Save & Generate and a later Save & Regenerate", async () => {
    const report = await runLotListingJob({
      user: { id: new mongoose.Types.ObjectId().toString(), email: "lotter@example.test" },
      images: [photo(1), photo(2), photo(3)],
      details: { contract_no: "90165", sales_date: "2026-09-28", location: "Grande Prairie, AB", draft_preview: true,
        include_damage_analysis: false, watermark_images: false,
        mixed_lots: [{ count: 2, extra_count: 1, cover_index: 1, mode: "single_lot" }] },
    });
    await LotListing.updateOne({ _id: report._id }, { $set: {
      status: "preview", is_draft_preview: false, job_status: "done", files_generating: false, files_regenerating: false,
    } });
    const stored: any = await LotListing.findById(report._id).lean();
    const userId = String(stored.user);
    const request = (previewData: any) => ({ params: { id: String(stored._id) }, userId, body: { preview_data: previewData },
      user: { _id: userId, email: "lotter@example.test", name: "Lotter" } }) as any;

    // The employee's review: a new Description, two fields deleted, one value
    // changed, dimensions and a hose reel added.
    const description = "Mobile XPX/E/FT Diesel Refueling Station Mounted on 2019 Manac Tri/A Step Deck Semi Trailer";
    const title = "Reviewed 2019 Manac Tri-Axle Tank Trailer with Pump, Hose Reel and Meter — Title-only summary TEST";
    let lot = { ...stored.preview_data.lots[0], title, description };
    lot = editSpec(lot, "Heated", "", { deleted: true });
    lot = editSpec(lot, "Metered System", "", { deleted: true });
    lot = editSpec(lot, "Tank Capacity (Gallons)", "8000");
    lot = editSpec(lot, "Dimensions", "53 ft x 102 in", { added: true });
    lot = editSpec(lot, "Hose Reel", "Yes", { added: true });
    const firstSave = specRecord(lot.condition_report_specs);
    expect(firstSave).not.toHaveProperty("Heated");
    expect(firstSave).toMatchObject({ "Tank Capacity (Gallons)": "8000", Dimensions: "53 ft x 102 in" });

    // Save & Generate.
    const generate = fakeRes();
    await submitLotListingForApproval(request({ ...stored.preview_data, lots: [lot] }), generate);
    expect(generate.statusCode, JSON.stringify(generate.body)).toBe(202);
    // Count only what happens after the save (the AI preview above used both).
    vi.mocked(analyzeAssetImages).mockClear();
    vi.mocked(enrichLotListingSpecs).mockClear();
    let saved: any = await LotListing.findById(stored._id).lean();
    await runRegenerateLotListingJob({ listingId: String(saved._id), generationToken: saved.job_id,
      user: { id: userId, email: "lotter@example.test" }, previewDataSnapshot: saved.preview_data });
    // Saved work is never sent back through the AI or the spec look-up.
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(enrichLotListingSpecs).not.toHaveBeenCalled();
    await expectExactlySaved(String(stored._id), firstSave, description, ["Heated", "Metered System"]);

    // Second review: delete the added dimensions row, change the pump.
    saved = await LotListing.findById(stored._id).lean();
    lot = editSpec(saved.preview_data.lots[0], "Dimensions", "", { deleted: true });
    lot = editSpec(lot, "Pump", "Centrifugal");
    const secondSave = specRecord(lot.condition_report_specs);
    const regenerate = fakeRes();
    await resubmitLotListing(request({ ...saved.preview_data, lots: [lot] }), regenerate);
    expect(regenerate.statusCode, JSON.stringify(regenerate.body)).toBe(202);
    saved = await LotListing.findById(stored._id).lean();
    await runRegenerateLotListingJob({ listingId: String(saved._id), generationToken: saved.job_id,
      user: { id: userId, email: "lotter@example.test" }, previewDataSnapshot: saved.preview_data });
    expect(analyzeAssetImages).not.toHaveBeenCalled();
    expect(enrichLotListingSpecs).not.toHaveBeenCalled();
    await expectExactlySaved(String(stored._id), secondSave, description, ["Heated", "Metered System", "Dimensions"]);
  });
});
