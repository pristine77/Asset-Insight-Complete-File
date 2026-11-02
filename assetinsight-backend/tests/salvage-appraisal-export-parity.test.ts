import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import sharp from "sharp";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { generateSalvageDocx } from "../src/service/docx/salvageDocxBuilder.js";
import { generateSalvageXlsx } from "../src/service/xlsx/salvageXlsxService.js";
import { rasterSalvageAttachmentPdf } from "../src/service/salvageAppraisalExport.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { normalizeSalvageDamageMarks } from "../src/utils/salvageDamageMarks.js";

// These tests call the actual Word/Excel serializers and bounded local PDF
// rasterizer. Axios can read only synthetic in-memory fixtures, never storage.
const assets = new Map<string, Buffer>();
const url = (name: string) => `https://salvage-export.test/${name}`;
const photo = async (colour: string) => sharp({ create: { width: 120, height: 80, channels: 3, background: colour } }).png().toBuffer();
async function pdfPages(): Promise<Buffer> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [index, dimensions] of [[200, 300], [300, 200], [200, 300]].entries()) {
    const page = pdf.addPage(dimensions); page.drawText(`PAGE-${index + 1}`, { x: 20, y: 80, size: 18, font });
    if (index === 2) page.setRotation(degrees(90));
  }
  return Buffer.from(await pdf.save());
}
const report = (extra: Record<string, unknown> = {}) => ({
  report_number: 1, language: "en", currency: "USD", report_date: "2026-11-02", file_number: "TEST-EXPORT", claim_number: "TEST-CLAIM",
  appraiser_name: "Test Appraiser", appraiser_email: "test@example.test", company_name: "Test Insurer", unit_label: "First tractor", item_type: "Tractor",
  make: "FirstMake", actual_cash_value: 100, value_basis: "acv", appraiser_reserve: null, recommended_reserve: 0, salvage_value: "0",
  imageUrls: [], additional_units: [{ id: "u2", unit_label: "Second trailer", make: "SecondMake", value_basis: "replacement", replacement_cost: 250,
    appraiser_reserve: null, salvage_value: "0", imageUrls: [], licence_plate: "PLATE-2", deductible: "500", repair_summary: { parts: 20, labour: 10, betterment: 5, taxes: 3 } }],
  ...extra,
});
const documentXml = (buffer: Buffer) => new PizZip(buffer).file("word/document.xml")!.asText();
const documentText = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join("|");
async function workbook(buffer: Buffer) { const value = new ExcelJS.Workbook(); await value.xlsx.load(buffer as any); return value; }

beforeEach(async () => {
  assets.clear(); assets.set(url("first.png"), await photo("#3366aa")); assets.set(url("second.png"), await photo("#22aa66"));
  assets.set(url("signature.png"), await photo("#ffffff")); assets.set(url("appendix.png"), await photo("#aa6622")); assets.set(url("pages.pdf"), await pdfPages());
  vi.spyOn(axios, "get").mockImplementation(async (address) => {
    if (!assets.has(String(address))) throw new Error("Network access blocked by fixture");
    return { data: assets.get(String(address)), status: 200, headers: {} };
  });
});
afterEach(() => vi.restoreAllMocks());

describe("full Salvage appraisal export parity", () => {
  it("keeps all units, mixed value bases, missing reserves, exact totals and saved USD in native Word and Excel", async () => {
    const source = report(), before = structuredClone(source);
    const xml = documentXml(await generateSalvageDocx(source)), text = documentText(xml);
    expect(text).toContain("SecondMake"); expect(text).toContain("PLATE-2"); expect(text).toContain("Replacement Cost");
    expect(text).toContain("US$350.00"); expect(text).not.toContain("CA$350.00");
    expect(text).toContain("Recommended Reserve|Not established");
    expect(xml).toContain("PAGEREF salvage-unit-2"); expect(xml).toContain("w:tbl");
    const book = await workbook(await generateSalvageXlsx(source));
    const summary = book.getWorksheet("Appraisal")!;
    expect(summary.getCell("E4").value).toBe(100); expect(summary.getCell("E5").value).toBe(250);
    expect(summary.getCell("E6").value).toEqual({ formula: "SUM(E4:E5)", result: 350 });
    expect(summary.getCell("F6").value).toBeNull(); expect(summary.getCell("E3").value).toBe("Value");
    expect(summary.getCell("E4").numFmt).toContain("USD");
    expect(book.getWorksheet("Unit 2")!.getSheetValues().flat(3)).toContain("PLATE-2");
    expect(source).toEqual(before);
  });

  it("keeps explicit zero distinct from null and canonical research figures", async () => {
    const assessment = buildSalvageAssessment({ inputs: { make: "SecondMake", model: "Two", province: "SK", effectiveDate: "2026-11-02",
      overrides: { preLoss: { amount: 50000, description: "Verified appraiser value", appraiserReason: "Synthetic documented appraiser value for regression verification." } } } });
    const source = report({ currency: "CAD", additional_units: [{ id: "u2", make: "SecondMake", actual_cash_value: 0, value_basis: "acv", appraiser_reserve: 0,
      replacement_cost: null, salvage_value: "0", assessment, assessment_inputs: assessment.inputs, imageUrls: [] }] });
    const book = await workbook(await generateSalvageXlsx(source));
    expect(book.getWorksheet("Appraisal")!.getCell("E5").value).toBe(0);
    expect(book.getWorksheet("Appraisal")!.getCell("F5").value).toBe(0);
    const text = documentText(documentXml(await generateSalvageDocx(source)));
    expect(text).toContain("$0.00"); expect(text).toContain("SecondMake");
  });

  it("includes designation, signature, all CV/appendix pages and original marked-photo order", async () => {
    const source = report({ imageUrls: [url("first.png")], damage_marks: normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [{ points: [[.1,.1],[.7,.1],[.7,.7],[.1,.7]] }] }], 1),
      additional_units: [{ id: "u2", unit_label: "Second trailer", make: "SecondMake", actual_cash_value: 250, imageUrls: [url("second.png")] }],
      appraiser_profile: { name: "Test Appraiser", designation: "CERTIFIED-SENTINEL", title: "TITLE-SENTINEL", signatureUrl: url("signature.png"), cvUrl: url("pages.pdf") },
      appendices: [{ id: "a", kind: "image", title: "PHOTO-APPENDIX", url: url("appendix.png") }, { id: "b", kind: "pdf", title: "PDF-APPENDIX", url: url("pages.pdf") }] });
    const before = structuredClone(source), bytes = await generateSalvageDocx(source), archive = new PizZip(bytes);
    const xml = documentXml(bytes), text = documentText(xml);
    expect(text).toContain("CERTIFIED-SENTINEL"); expect(text).toContain("TITLE-SENTINEL");
    expect(xml).toContain('descr="Appraiser signature"');
    expect(text).toContain("Appraiser Profile — page 3 / 3"); expect(text).toContain("Appendix B — PDF-APPENDIX — page 3 / 3");
    expect(text.indexOf("Appraiser Profile — page 1 / 3")).toBeLessThan(text.indexOf("Appendix A — PHOTO-APPENDIX — page 1 / 1"));
    expect(text.indexOf("Unit 1 Photo 1")).toBe(-1); // Photo names live in native image descriptions.
    const galleries = [...xml.matchAll(/descr="(Unit \d+ Photo \d+)"/g)].map((match) => match[1]);
    expect(galleries).toEqual(["Unit 1 Photo 1", "Unit 2 Photo 1"]);
    expect(Object.keys(archive.files).filter((name) => name.startsWith("word/media/")).length).toBeGreaterThanOrEqual(9);
    const book = await workbook(await generateSalvageXlsx(source));
    expect(book.getWorksheet("Profile")!.getImages()).toHaveLength(4);
    expect(book.getWorksheet("Appendices")!.getImages()).toHaveLength(4);
    expect(book.getWorksheet("Unit 1")!.getImages()).toHaveLength(1); expect(book.getWorksheet("Unit 2")!.getImages()).toHaveLength(1);
    const all = JSON.stringify(book.getWorksheet("Appendices")!.getSheetValues());
    expect(all.indexOf("PHOTO-APPENDIX")).toBeLessThan(all.indexOf("PDF-APPENDIX"));
    expect(all).toContain("page 3 / 3"); expect(source).toEqual(before);
  }, 30_000);

  it("rasterizes every PDF page in source order with native and explicit source rotations intact", async () => {
    const pages = await rasterSalvageAttachmentPdf(assets.get(url("pages.pdf"))!, 3);
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.width > page.height)).toEqual([false, true, true]);
    expect(pages.every((page) => page.width <= 1600 && page.height <= 1600)).toBe(true);
  });

  it("refuses missing or oversized attachment content instead of producing a partial report", async () => {
    const source = report({ appendices: [{ id: "a", kind: "pdf", title: "Missing attachment", url: url("missing.pdf") }] });
    await expect(generateSalvageDocx(source)).rejects.toThrow("could not be downloaded");
    await expect(generateSalvageXlsx(source)).rejects.toThrow("could not be downloaded");
    await expect(rasterSalvageAttachmentPdf(Buffer.from("%PDF-"), 61)).rejects.toThrow("supported document limits");
  });
});
