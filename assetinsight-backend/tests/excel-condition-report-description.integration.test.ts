import mongoose from "mongoose";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let mongo: MongoMemoryServer;
let Asset: any;
let Listing: any;
let ReportJob: any;
let getEditor: typeof import("../src/service/excelConditionReportService.js")["getExcelConditionReports"];
let saveEditor: typeof import("../src/service/excelConditionReportService.js")["saveExcelConditionReports"];
let rerun: typeof import("../src/controller/pdfReport.controller.js")["rerunAdminExcelAndCr"];
let runJob: typeof import("../src/jobs/excelCrRegenerationJob.js")["runExcelCrRegenerationJob"];
let buildData: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["buildSpecReportData"];
let realXlsx: typeof import("../src/service/xlsx/assetXlsxService.js")["generateAssetXlsxFromReport"];
let realDocx: typeof import("../src/service/auctioneerSpecSheetDocxService.js")["generateAuctioneerSpecSheetDocxFromReport"];
const rendered = { xlsx: [] as any[], pdf: [] as any[], docx: [] as any[] };
const uploaded: { key: string; bytes: Buffer }[] = [];
const media = Array.from({ length: 18 }, (_, index) => `https://assetinsight.test/qa/original-${index}.jpg`);
const originalDescription = "Saved description distinct from the title.\nThe operator's original detailed notes.";
const updatedDescription = "Edited description TEST.\nSecond line with carefully reviewed dimensions. " + "Keep all reviewed details. ".repeat(16);
const editedTitle = "Edited 2000 Trailtech Reel Trailer TEST — complete reviewed equipment Title with axle configuration and operator-approved identifying details";
const model = (kind: string): any => kind === "asset" ? Asset : Listing;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: Asset } = await import("../src/models/asset.model.js"));
  ({ default: Listing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  const xlsx = await import("../src/service/xlsx/assetXlsxService.js");
  realXlsx = xlsx.generateAssetXlsxFromReport;
  vi.spyOn(xlsx, "generateAssetXlsxFromReport").mockImplementation(async (data, options) => {
    rendered.xlsx.push(structuredClone(data));
    return realXlsx(data, options);
  });
  const pdf = await import("../src/service/auctioneerSpecSheetPdfService.js");
  vi.spyOn(pdf, "generateAuctioneerSpecSheetPdfFromReport").mockImplementation(async (data) => {
    rendered.pdf.push(structuredClone(data));
    return Buffer.from("isolated renderer receipt, not actual PDF bytes");
  });
  const docx = await import("../src/service/auctioneerSpecSheetDocxService.js");
  realDocx = docx.generateAuctioneerSpecSheetDocxFromReport;
  vi.spyOn(docx, "generateAuctioneerSpecSheetDocxFromReport").mockImplementation(async (data) => {
    rendered.docx.push(structuredClone(data));
    return Buffer.from("isolated renderer receipt, not actual DOCX bytes");
  });
  const schedule = await import("../src/service/scheduleAReportPdfService.js");
  vi.spyOn(schedule, "generateScheduleAPdfFromReport").mockResolvedValue(Buffer.from("schedule receipt"));
  vi.spyOn(schedule, "generateAndUploadScheduleAPdf").mockResolvedValue({ url: "https://assetinsight.test/qa/schedule.pdf" } as any);
  const r2 = await import("../src/utils/r2Storage/r2Upload.js");
  vi.spyOn(r2, "uploadBufferToR2").mockImplementation(async (bytes, _type, _bucket, key) => {
    uploaded.push({ key: String(key), bytes: Buffer.from(bytes) });
    return `https://assetinsight.test/${key}`;
  });
  ({ getExcelConditionReports: getEditor, saveExcelConditionReports: saveEditor } = await import("../src/service/excelConditionReportService.js"));
  ({ buildSpecReportData: buildData } = await import("../src/service/auctioneerSpecPdfRefreshService.js"));
  ({ rerunAdminExcelAndCr: rerun } = await import("../src/controller/pdfReport.controller.js"));
  ({ runExcelCrRegenerationJob: runJob } = await import("../src/jobs/excelCrRegenerationJob.js"));
});

beforeEach(async () => {
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([Asset.syncIndexes(), Listing.syncIndexes(), ReportJob.syncIndexes()]);
  for (const values of Object.values(rendered)) values.length = 0;
  uploaded.length = 0;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await mongo.stop();
});

async function makeReport(kind: string, nested = false) {
  const record = {
    lot_id: "qa-row", lot_number: "600", title: "Original trailer title", description: originalDescription, details: "Legacy details must not return after a clear",
    categories: "Portable Structures", image_indexes: media.map((_, index) => index), image_urls: media,
    condition_report_specs_reviewed: true, condition_report_specs: { "Overall Width": "20 ft", "Overall Height": "" },
    condition_report_specs_manual_overrides: { "Overall Width": "20 ft", "Deleted Detail": "" },
    condition_report_specs_deleted: ["Deleted Detail"],
  };
  const lots = nested ? [{ ...record, lot_id: "qa-parent", title: "Parent title", description: "Parent description", items: [{ ...record, image_url: media[0], image_index: 0 }] }] : [record];
  return model(kind).create({ user: new mongoose.Types.ObjectId(), grouping_mode: nested ? "catalogue" : "single_lot",
    status: "approved", job_status: "done", imageUrls: media, lots, contract_no: "QA-CR-DESCRIPTION", sales_date: new Date("2026-10-13"), location: "Regina, SK",
    preview_data: { lots: structuredClone(lots), contract_no: "QA-CR-DESCRIPTION", currency: "CAD", include_damage_analysis: false },
  });
}

async function runCombined(id: string, body: any) {
  const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await rerun({ params: { id }, body, user: { role: "admin" } } as any, response);
  return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
}

describe.sequential("Admin Excel/CR separate saved description", () => {
  it.each(["asset", "lotListing"])("exports a title-only %s edit after the real regeneration job while retaining the separate narrative", async (kind) => {
    const report = await makeReport(kind);
    const editor = await getEditor(String(report._id));
    const result = await runCombined(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => {
      const { description: _hiddenNarrative, ...rowWithoutNarrative } = row;
      return { ...rowWithoutNarrative, title: editedTitle };
    }) });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const queued = await model(kind).findById(report._id).lean();
    await runJob({ kind: kind as any, reportId: String(report._id), generationToken: queued.job_id });
    const persisted = await model(kind).findById(report._id).lean();
    for (const lot of [persisted.lots[0], persisted.preview_data.lots[0]]) {
      expect(lot).toMatchObject({ title: editedTitle, description: originalDescription });
    }
    expect(persisted.imageUrls).toEqual(media);
    for (const key of ["xlsx", "pdf", "docx"] as const) {
      expect(rendered[key][0].lots[0]).toMatchObject({ title: editedTitle, description: originalDescription, image_urls: media });
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploaded.find(item => item.key.endsWith(".xlsx"))!.bytes as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe(editedTitle);
    const data = buildData(persisted);
    data.imageUrls = [];
    data.lots = data.lots.map((lot: any) => ({ ...lot, image_urls: [], image_indexes: [], image_indices: [], cover_image_url: "" }));
    const xml = new PizZip(await realDocx(data)).file("word/document.xml")!.asText();
    expect(xml).toContain(editedTitle);
    expect(xml).not.toContain(originalDescription.split("\n")[0]);
  });

  it.each([["asset", false], ["lotListing", false], ["asset", true]] as const)("exposes and saves edited %s descriptions independently (catalogue: %s), including explicit blanks", async (kind, nested) => {
    const report = await makeReport(kind, nested);
    const editor = await getEditor(String(report._id));
    expect((editor.rows[0] as any).description).toBe(originalDescription);
    expect(editor.rows[0].descriptionScope).toBe(nested ? "item" : "lot");
    const saved = await saveEditor(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description: updatedDescription })) });
    expect((saved.rows[0] as any).description).toBe(updatedDescription);
    let persisted = await model(kind).findById(report._id).lean();
    const savedRecord = nested ? persisted.preview_data.lots[0].items[0] : persisted.preview_data.lots[0];
    expect(savedRecord).toMatchObject({ title: "Original trailer title", description: updatedDescription,
      condition_report_specs: { "Overall Width": "20 ft", "Overall Height": "" }, condition_report_specs_deleted: ["Deleted Detail"], image_urls: media });
    if (nested) expect(persisted.preview_data.lots[0].description).toBe("Parent description");
    expect(persisted.imageUrls).toEqual(media);
    const legacyRows = saved.rows.map(row => { const copy = { ...row } as any; delete copy.description; return copy; });
    const legacySave = await saveEditor(String(report._id), { revision: saved.revision, rows: legacyRows });
    expect((legacySave.rows[0] as any).description).toBe(updatedDescription);
    const cleared = await saveEditor(String(report._id), { revision: legacySave.revision, rows: legacySave.rows.map(row => ({ ...row, description: "" })) });
    expect((cleared.rows[0] as any).description).toBe("");
    persisted = await model(kind).findById(report._id).lean();
    expect((nested ? persisted.lots[0].items[0] : persisted.lots[0]).description).toBe("");
    expect((nested ? persisted.preview_data.lots[0].items[0] : persisted.preview_data.lots[0]).description).toBe("");
  });

  it.each(["asset", "lotListing"])("retains the full %s narrative in combined regeneration but exports its separate Title", async (kind) => {
    const report = await makeReport(kind);
    const editor = await getEditor(String(report._id));
    const result = await runCombined(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description: updatedDescription })) });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.data.editor.rows[0].description).toBe(updatedDescription);
    const queued = await model(kind).findById(report._id).lean();
    await runJob({ kind: kind as any, reportId: String(report._id), generationToken: queued.job_id });
    const persisted = await model(kind).findById(report._id).lean();
    expect(persisted.preview_data.lots[0]).toMatchObject({ title: "Original trailer title", description: updatedDescription, image_urls: media });
    expect(persisted.lots[0]).toMatchObject({ title: "Original trailer title", description: updatedDescription, image_urls: media });
    expect(persisted.imageUrls).toEqual(media);
    expect(persisted.job_status).toBe("done");
    for (const key of ["xlsx", "pdf", "docx"] as const) expect(rendered[key][0].lots[0].description).toBe(updatedDescription);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploaded.find(item => item.key.endsWith(".xlsx"))!.bytes as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe("Original trailer title");
    // Actual DOCX construction with media omitted only in this output-content
    // fixture; the worker and saved report above retain all 18 original refs.
    const data = buildData(persisted);
    data.imageUrls = [];
    data.lots = data.lots.map((lot: any) => ({ ...lot, image_urls: [], image_indexes: [], image_indices: [], cover_image_url: "" }));
    const bytes = await realDocx(data);
    const xml = new PizZip(bytes).file("word/document.xml")!.asText();
    expect(xml).toContain("Original trailer title");
    expect(xml).not.toContain("Edited description TEST.");
    expect(xml).not.toContain("Second line with carefully reviewed dimensions.");
    expect(xml).not.toContain(originalDescription.split("\n")[0]);
  });

  it("does not materialize an inherited parent description on a title-only nested Asset edit", async () => {
    const kind = "asset";
    const report = await makeReport(kind, true);
    await model(kind).updateOne({ _id: report._id }, { $unset: { "lots.0.items.0.description": 1, "preview_data.lots.0.items.0.description": 1 } });
    const editor = await getEditor(String(report._id));
    expect((editor.rows[0] as any).description).toBe("");
    await saveEditor(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, title: "Specific item TEST" })) });
    const persisted = await model(kind).findById(report._id).lean();
    expect(persisted.preview_data.lots[0].items[0]).not.toHaveProperty("description");
    expect(persisted.preview_data.lots[0].description).toBe("Parent description");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await realXlsx(buildData(persisted)) as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe("Specific item TEST");
  });

  it("exports a grouped child's saved Title in Excel and the independent parent Title in CR after regeneration", async () => {
    const report = await makeReport("asset", true);
    const editor = await getEditor(String(report._id));
    const result = await runCombined(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => {
      const { description: _hiddenNarrative, ...fields } = row;
      return { ...fields, title: editedTitle };
    }) });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const queued = await Asset.findById(report._id).lean();
    await runJob({ kind: "asset", reportId: String(report._id), generationToken: queued.job_id });
    const persisted = await Asset.findById(report._id).lean();
    for (const lot of [persisted.lots[0], persisted.preview_data.lots[0]]) {
      expect(lot).toMatchObject({ title: "Parent title", description: "Parent description", image_urls: media });
      expect(lot.items[0]).toMatchObject({ title: editedTitle, description: originalDescription, image_url: media[0], image_index: 0,
        condition_report_specs: { "Overall Width": "20 ft", "Overall Height": "" }, condition_report_specs_deleted: ["Deleted Detail"] });
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploaded.find(item => item.key.endsWith(".xlsx"))!.bytes as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe(editedTitle);
    const data = buildData(persisted);
    data.imageUrls = [];
    data.lots = data.lots.map((lot: any) => ({ ...lot, image_urls: [], image_indexes: [], image_indices: [], cover_image_url: "",
      items: lot.items.map((item: any) => ({ ...item, image_urls: [], image_indexes: [] })) }));
    const xml = new PizZip(await realDocx(data)).file("word/document.xml")!.asText();
    expect(xml).toContain("Parent title");
    expect(xml).not.toContain("Parent description");
    expect(xml).not.toContain(editedTitle);
    expect(persisted.imageUrls).toEqual(media);
  });

  it.each(["", " \n "])("preserves an explicitly cleared Asset description %j through later status-only saves", async description => {
    const report = await makeReport("asset");
    const editor = await getEditor(String(report._id));
    await saveEditor(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description })) });
    const loaded = await Asset.findById(report._id);
    loaded.job_status = "done";
    loaded.markModified("job_status");
    await loaded.save();
    const persisted = await Asset.findById(report._id).lean();
    expect(persisted.lots[0].description).toBe(description);
    expect(persisted.preview_data.lots[0].description).toBe(description);
    expect((await getEditor(String(report._id))).rows[0].description).toBe(description);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await realXlsx(buildData(persisted)) as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe("Original trailer title");
  });

  it.each([undefined, null])("retains legacy missing-description repair for %s", async description => {
    const report = await Asset.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot", imageUrls: [],
      lots: [{ lot_id: "legacy-row", title: "Legacy title", description, details: "Existing legacy narrative" }] });
    expect(report.lots[0].description).toBe("Existing legacy narrative");
  });

  it.each(["asset", "lotListing"])("keeps an explicit %s clear through combined regeneration without reviving old details", async kind => {
    const report = await makeReport(kind);
    const editor = await getEditor(String(report._id));
    const result = await runCombined(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description: "" })) });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const queued = await model(kind).findById(report._id).lean();
    await runJob({ kind: kind as any, reportId: String(report._id), generationToken: queued.job_id });
    const persisted = await model(kind).findById(report._id).lean();
    expect(persisted.lots[0].description).toBe("");
    expect(persisted.preview_data.lots[0].description).toBe("");
    expect(persisted.imageUrls).toEqual(media);
    for (const key of ["xlsx", "pdf", "docx"] as const) {
      expect(rendered[key][0].lots[0]).toMatchObject({ title: "Original trailer title", description: "", image_urls: media });
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploaded.find(item => item.key.endsWith(".xlsx"))!.bytes as any);
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe("Original trailer title");
  });

  it.each(["asset", "lotListing"])("rejects stale or malformed %s description edits without creating jobs or losing media", async (kind) => {
    const report = await makeReport(kind);
    const editor = await getEditor(String(report._id));
    await expect(saveEditor(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description: { bad: true } })) })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_EXCEL_CONDITION_REPORT" });
    const saved = await saveEditor(String(report._id), { revision: editor.revision, rows: editor.rows.map(row => ({ ...row, description: updatedDescription })) });
    const stale = await runCombined(String(report._id), { revision: editor.revision, rows: editor.rows });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("REPORT_REVISION_CHANGED");
    expect(await ReportJob.countDocuments()).toBe(0);
    const persisted = await model(kind).findById(report._id).lean();
    expect(persisted.preview_data.lots[0].description).toBe(updatedDescription);
    expect(persisted.imageUrls).toEqual(media);
    expect((saved.rows[0] as any).description).toBe(updatedDescription);
  });
});
