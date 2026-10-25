import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import PizZip from "pizzip";

const renderer = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => ({
  once: vi.fn(), close: vi.fn(async () => undefined), newPage: vi.fn(async () => ({
    on: vi.fn(), setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
    setViewport: vi.fn(async () => undefined), evaluate: vi.fn(async () => undefined),
    setContent: vi.fn(async (html: string) => { renderer.html.push(html.replace(/data:image\/[^;]+;base64,[^"]+/g, "fixture-image")); }),
    pdf: vi.fn(async () => { const { PDFDocument } = await import("pdf-lib");
      const document = await PDFDocument.create(); document.addPage([612, 792]); return document.save(); }),
  })),
})) } }));

import {
  auctioneerSpecFieldAliases, buildAuctioneerSpecRows, deriveAuctioneerSerial,
  markPreviewDataSpecsReviewed, normalizeAuctioneerLotSpecs, normalizeVisiblePresenceValue,
} from "../src/utils/auctioneerSpecRows.js";
import { generateAssetXlsxFromReport, generateLotListingXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../src/service/auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../src/service/auctioneerSpecSheetDocxService.js";

const fixture = () => ({ lot_number: "1826", title: "Synthetic portable structure", categories: "Portable Structures",
  condition_report_specs: { "Overall Length": "30 ft", "Overall Width": "20 ft", "Overall Height": "12 ft",
    Length: "30 ft", Width: "20 ft", Height: "12 ft", "Internal Width": "17 ft", "Cargo Length": "27 ft" } });
const rows = (lot: any) => Object.fromEntries(buildAuctioneerSpecRows(lot).filter(row => row.value).map(row => [row.field, row.value]));
const reviewed = (lot: any) => markPreviewDataSpecsReviewed({ lots: [lot] }).lots[0];

describe("reviewed CR specification authority", () => {
  it("collapses only category-unambiguous overall dimension aliases", () => {
    const normalized = normalizeAuctioneerLotSpecs(fixture());
    expect(normalized.condition_report_specs).toEqual({ "Overall Length": "30 ft", "Overall Width": "20 ft", "Overall Height": "12 ft",
      "Internal Width": "17 ft", "Cargo Length": "27 ft" });
    expect(auctioneerSpecFieldAliases("Width", ["Overall Width"])).toContain("Overall Width");
    expect(auctioneerSpecFieldAliases("Overall Width", ["Width"])).toContain("Width");
    expect(auctioneerSpecFieldAliases("Width", ["Width", "Overall Width"])).not.toContain("Overall Width");
    expect(auctioneerSpecFieldAliases("Width", [])).not.toContain("Overall Width");
    expect(auctioneerSpecFieldAliases("Internal Width", ["Overall Width"])).not.toContain("Overall Width");
    expect(rows({ ...fixture(), categories: "Unknown custom category" })).toHaveProperty("Width", "20 ft");
  });

  it.each(["Overall Width", "Width"])("a manual %s edit/blank controls both aliases", field => {
    expect(rows({ ...fixture(), condition_report_specs_manual_overrides: { [field]: "18 ft" } })).toMatchObject({ "Overall Width": "18 ft" });
    const empty = rows({ ...fixture(), condition_report_specs_manual_overrides: { [field]: "" } });
    expect(empty).not.toHaveProperty("Width"); expect(empty).not.toHaveProperty("Overall Width");
    expect(empty).toHaveProperty("Internal Width", "17 ft");
  });

  it.each([["Width", "Overall Width"], ["Overall Width", "Width"]])("never aliases custom-category %s to the deleted %s on repeated normalization", (field, deleted) => {
    const lot = reviewed({ categories: "Custom Unregistered Category", condition_report_specs: { [field]: "20 ft" },
      condition_report_specs_deleted: [deleted], condition_report_specs_custom_order: [field] });
    const once = normalizeAuctioneerLotSpecs(lot), twice = normalizeAuctioneerLotSpecs(once);
    expect(once.condition_report_specs).toEqual({ [field]: "20 ft" });
    expect(once.condition_report_specs_deleted).toEqual([deleted]);
    expect(twice).toEqual(once);
  });

  it.each(["condition_report_specs_deleted", "deleted_condition_report_specs", "removed_condition_report_specs", "hidden_condition_report_specs"])(
    "%s suppresses the full dimensional alias family", collection => {
      for (const marker of [["Width"], { "Overall Width": true }]) {
        const result = rows({ ...fixture(), [collection]: marker });
        expect(result).not.toHaveProperty("Width"); expect(result).not.toHaveProperty("Overall Width");
        expect(result).toHaveProperty("Internal Width", "17 ft");
      }
    });

  it("keeps reviewed empty maps empty despite legacy, root, prose and stale manual evidence", () => {
    const source = { ...fixture(), serial_number: "OLD-12345", description: "Overall Width: 20 ft; Serial Number: OLD-12345",
      specifications: fixture().condition_report_specs, condition_report_specs: {},
      condition_report_specs_manual_overrides: { Width: "20 ft", "Serial Number": "OLD-12345" },
      condition_report_selections: { condition: "Starts And Runs", legal: "Clear Title" } };
    const before = JSON.stringify(source), marked = reviewed(source);
    expect(normalizeAuctioneerLotSpecs(marked).condition_report_specs).toEqual({});
    expect(rows(marked)).toEqual({}); expect(deriveAuctioneerSerial(marked)).toBe("");
    expect(JSON.stringify(source)).toBe(before);
    expect(rows(source)).toHaveProperty("Overall Width", "20 ft"); // Legacy ingress remains compatible.
  });

  it("marks only explicit tables, including nested items; absent old-client tables stay unreviewed", () => {
    const source = { lots: [{ condition_report_specs: {}, items: [{ condition_report_specs: [] }, { title: "Old client" }] }, { condition_report_specs: null }] };
    const result = markPreviewDataSpecsReviewed(source);
    expect(result.lots[0]).toMatchObject({ condition_report_specs_reviewed: true, items: [{ condition_report_specs_reviewed: true }, { title: "Old client" }] });
    expect((result.lots[0] as any).items[1].condition_report_specs_reviewed).toBeUndefined();
    expect((result.lots[1] as any).condition_report_specs_reviewed).toBeUndefined();
    expect(source.lots[0]).not.toHaveProperty("condition_report_specs_reviewed");
  });

  it("reconciles stale old-client manual overrides only at the explicit review boundary", () => {
    const lot = { ...fixture(), condition_report_specs: { "Overall Width": "12 ft", "Internal Width": "9 ft" },
      condition_report_specs_manual_overrides: { Width: "10 ft", "Internal Width": "8 ft" } };
    expect(rows(reviewed(lot))).toEqual({ "Overall Width": "12 ft", "Internal Width": "9 ft" });
    const historical = markPreviewDataSpecsReviewed({ lots: [lot] }, { reconcileManualOverrides: false }).lots[0];
    expect(rows(historical)).toEqual({ "Overall Width": "10 ft", "Internal Width": "8 ft" });
    expect(rows(reviewed({ ...lot, condition_report_specs: { "Overall Width": "" } }))).toEqual({});
  });

  it("retains deliberately blank and negative reviewed keys through repeated normalization", () => {
    const lot = reviewed({ ...fixture(), condition_report_specs: { Height: "", "Lighting Installed": "No", "Other Details": "N/A" },
      condition_report_specs_manual_overrides: { Height: "12 ft" } });
    const once = normalizeAuctioneerLotSpecs(lot), twice = normalizeAuctioneerLotSpecs(once);
    expect(once.condition_report_specs).toEqual({ "Overall Height": "", "Lighting Installed": "No", "Other Details": "N/A" });
    expect(twice.condition_report_specs).toEqual(once.condition_report_specs);
    const deleted = normalizeAuctioneerLotSpecs({ ...lot, condition_report_specs_deleted: ["Height"] });
    expect(deleted.condition_report_specs).not.toHaveProperty("Overall Height");
  });

  it("preserves retained reviewed fields, current mapped selections and independent descriptions", () => {
    const lot = reviewed({ categories: "Control Van", description: "Paint faded; dents visible on door",
      condition_report_specs: { "Running Condition": "Untested", "Ownership Type": "No Title", "Other Details": "Paint faded; dents visible on door" },
      condition_report_selections: { condition: "Starts And Runs", legal: "Salvage" } });
    expect(rows(lot)).toMatchObject({ "Running Condition": "Starts and Runs", "Ownership Type": "Salvage", "Other Details": "Paint faded; dents visible on door" });
    expect(normalizeAuctioneerLotSpecs(lot).description).toBe(lot.description);
  });

  it.each(["Paint faded; dents visible on door", "No visible damage", "Serial plate not visible from this angle", "Visible rust on roof"])("does not coerce narrative %s to a boolean", value => {
    expect(normalizeVisiblePresenceValue(value)).toBe("");
    expect(rows(reviewed({ categories: "Portable Structures", condition_report_specs: { "Other Details": value } }))).toEqual({ "Other Details": value });
  });
  it.each([["Visible", "Yes"], ["Visible: true", "Yes"], ["Not Visible", "No"], ["Visible: no", "No"]])("retains standalone presence marker %s", (value, expected) => {
    expect(normalizeVisiblePresenceValue(value)).toBe(expected);
  });
});

describe.each([["Asset", generateAssetXlsxFromReport], ["Lot Listing", generateLotListingXlsxFromReport]] as const)("%s reviewed workbook", (_name, generate) => {
  it("retains descriptive visible text through actual CR cell formatting", async () => {
    const narrative = "Paint faded; minor dents visible on frame.";
    const report = { lots: [reviewed({ ...fixture(), condition_report_specs: { "Construction Material": narrative, "Other Details": "No visible damage" } })] };
    const before = JSON.stringify(report), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate(report));
    const sheet = workbook.getWorksheet("Sheet1")!, headers = sheet.getRow(1).values as string[];
    const html = String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value);
    expect(html.toLowerCase()).toContain(narrative.toLowerCase());
    expect(html.toLowerCase()).toContain("no visible damage");
    expect(JSON.stringify(report)).toBe(before);
  });
  it("round-trips corrected aliases and deletions without changing saved source data", async () => {
    const lot = reviewed({ ...fixture(), condition_report_specs: { ...fixture().condition_report_specs, "Overall Width": "18 ft" }, condition_report_specs_manual_overrides: { Width: "18 ft" }, condition_report_specs_deleted: ["Length"] });
    const report = { lots: [lot] }, before = JSON.stringify(report), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate(report));
    const sheet = workbook.getWorksheet("Sheet1")!, headers = sheet.getRow(1).values as string[];
    const html = String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value);
    expect(html).toContain("<b>Overall Width</b>"); expect(html).toContain("18 Ft");
    expect(html).not.toContain("20 Ft"); expect(html).not.toContain("<b>Width</b>");
    expect(html).not.toContain("<b>Overall Length</b>"); expect(html).not.toContain("<b>Length</b>");
    expect(html).toContain("<b>Internal Width</b>"); expect(JSON.stringify(report)).toBe(before);
  });
  it("does not refill a reviewed empty specification table or serial column", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate({ lots: [reviewed({ ...fixture(), description: "Serial Number: OLD-12345; Overall Width: 20 ft", serial_number: "OLD-12345", condition_report_specs: {} })] }));
    const sheet = workbook.getWorksheet("Sheet1")!, headers = sheet.getRow(1).values as string[];
    expect(sheet.getRow(2).getCell(headers.indexOf("Serial Number")).value || "").toBe("");
    expect(String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value)).not.toContain("Overall Width");
  });
  it("keeps reviewed nested items independent from parent specs, controls and siblings", async () => {
    const report = markPreviewDataSpecsReviewed({ lots: [{ ...fixture(),
      condition_report_specs_manual_overrides: { Width: "20 ft" }, condition_report_specs_deleted: ["Internal Width"],
      items: [{ title: "Empty child", condition_report_specs: {} },
        { title: "Edited child", condition_report_specs: { "Overall Width": "11 ft", "Internal Width": "8 ft" } }] }] });
    const before = JSON.stringify(report), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate(report));
    const sheet = workbook.getWorksheet("Sheet1")!, headers = sheet.getRow(1).values as string[];
    const empty = String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value);
    const edited = String(sheet.getRow(3).getCell(headers.indexOf("Condition Report")).value);
    expect(empty).not.toContain("Overall Width"); expect(empty).not.toContain("20 Ft");
    expect(edited).toContain("11 Ft"); expect(edited).toContain("8 Ft"); expect(edited).not.toContain("20 Ft");
    expect(edited).not.toContain("Overall Length"); expect(JSON.stringify(report)).toBe(before);
  });
  it("does not inherit a parent review marker into an omitted legacy child table", async () => {
    const report = markPreviewDataSpecsReviewed({ lots: [{ ...fixture(), condition_report_specs: { "Serial Number": "PARENT-12345", "Overall Width": "20 ft" },
      items: [{ title: "Legacy child", serial_number: "CHILD-98765" }] }] });
    const before = JSON.stringify(report), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate(report));
    const sheet = workbook.getWorksheet("Sheet1")!, headers = sheet.getRow(1).values as string[];
    expect(sheet.getRow(2).getCell(headers.indexOf("Serial Number")).value).toBe("CHILD-98765");
    expect(JSON.stringify(report)).toBe(before);
  });
});

describe("CR PDF and DOCX parity", () => {
  it("uses the full reviewed Title in the PDF Description row without printing or mutating the independent narrative", async () => {
    renderer.html.length = 0;
    const title = "Reviewed portable structure with galvanized frame and insulated panels — " + "complete operator-edited Title ".repeat(5);
    const report = { lots: [reviewed({ ...fixture(), title: title.trim(), description: "Hidden separate narrative must not replace the Title" })] };
    const before = JSON.stringify(report);
    await generateAuctioneerSpecSheetPdfFromReport(report);
    const html = renderer.html.join("\n");
    expect(html).toContain(`<tr class="description-row"><th>Description</th><td>${title.trim()}</td></tr>`);
    expect(html).not.toContain("Hidden separate narrative must not replace the Title");
    expect(JSON.stringify(report)).toBe(before);
  });
  it.each(["deleted", "blank", "reviewed-empty"])("does not revive a %s serial in PDF metadata", async mode => {
    renderer.html.length = 0;
    const lot = normalizeAuctioneerLotSpecs({ ...fixture(), description: "Serial Number: OLD-12345",
      ...(mode === "deleted" ? { condition_report_specs_deleted: ["Serial Number"] } : mode === "blank" ? { condition_report_specs_manual_overrides: { "Serial Number": "" } } : { condition_report_specs_reviewed: true, condition_report_specs: {} }) });
    await generateAuctioneerSpecSheetPdfFromReport({ lots: [lot] });
    const html = renderer.html.join("\n");
    expect(html).toContain("<tr><th>Serial Number</th><td></td></tr>");
    expect(html).not.toMatch(/<th>Serial Number<\/th>\s*<td>OLD-12345/);
    expect(lot.description).toBe("Serial Number: OLD-12345"); // User-authored prose is independent.
  });
  it("renders the same authoritative dimensions and narratives in PDF and DOCX", async () => {
    renderer.html.length = 0;
    const lot = reviewed({ ...fixture(), condition_report_specs: { ...fixture().condition_report_specs, "Overall Width": "18 ft", "Other Details": "Dents visible on door" },
      condition_report_specs_manual_overrides: { Width: "18 ft" }, condition_report_specs_deleted: ["Length"] });
    const report = { lots: [lot] }, before = JSON.stringify(report);
    await generateAuctioneerSpecSheetPdfFromReport(report);
    const html = renderer.html.join("\n");
    expect(html).toContain("<th>Overall Width</th>"); expect(html).toContain("18 ft");
    expect(html).not.toContain("20 ft"); expect(html).not.toContain("<th>Width</th>"); expect(html).not.toContain("<th>Overall Length</th>");
    const xml = new PizZip(await generateAuctioneerSpecSheetDocxFromReport(report)).file("word/document.xml")!.asText();
    expect(xml).toContain("Overall Width"); expect(xml).toContain("18 ft"); expect(xml).not.toContain("20 ft");
    expect(xml).not.toContain(">Width<"); expect(xml).not.toContain("Overall Length");
    expect(xml).toContain("Dents visible on door"); expect(html).toContain("Dents visible on door");
    expect(JSON.stringify(report)).toBe(before);
  });
});
