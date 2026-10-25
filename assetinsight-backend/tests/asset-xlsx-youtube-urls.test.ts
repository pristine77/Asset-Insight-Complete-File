import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { generateAssetXlsxFromReport, generateLotListingXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";

const watchUrl = "https://www.youtube.com/watch?v=AbCdEfGhI_1";
const sourceUrl = "https://assetinsight.test/videos/original.mp4";
const scheduleUrl = "https://assetinsight.test/schedule-a.pdf";
const existingHeaders = ["Lot #", "Description", "Serial Number", "Categories", "Bid Increment", "Opening Bid", "Contract #", "Quantity", "Must Take", "Show On Website", "Close Date", "Location", "Latitude", "Longitude", "Item Condition", "Lotted By", "Condition Report"];

describe.each([
  ["Asset", generateAssetXlsxFromReport],
  ["Lot Listing", generateLotListingXlsxFromReport],
] as const)("%s original workbook layout without a YouTube column", (kind, generate) => {
  const headers = [...existingHeaders, ...(kind === "Asset" ? ["Schedule A"] : [])];

  async function workbookFor(lots: any[], extra: Record<string, unknown> = {}) {
    const buffer = await generate({ lots, ...extra });
    // Independently read the actual XLSX, not just the exporter's in-memory rows.
    const independent = XLSX.read(buffer, { type: "buffer" });
    const values = XLSX.utils.sheet_to_json<unknown[]>(independent.Sheets.Sheet1, { header: 1 });
    expect(values[0]).toEqual(headers);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Sheet1")!;
    expect(sheet.columnCount).toBe(headers.length);
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers]);
    // Stored video metadata must not leak into a hidden or appended column.
    sheet.eachRow((row) => row.eachCell((cell) => {
      expect(cell.text).not.toContain("youtube.com");
      expect(cell.text).not.toContain(sourceUrl);
      expect(cell.hyperlink).toBeUndefined();
    }));
    return workbook;
  }

  it("restores the exact original columns, support sheets, formatting and formulas", async () => {
    const workbook = await workbookFor([{ lot_id: "empty", lot_number: "B12", title: "No video" }], { schedule_a_pdf_url: scheduleUrl });
    const sheet = workbook.getWorksheet("Sheet1")!;
    expect(workbook.worksheets.map((item) => item.name)).toEqual(["Sheet1", "Menis", "Instructions"]);
    expect(sheet.getCell("A2").value).toBe("B12");
    expect(sheet.getCell("M2").value).toEqual({ formula: 'IFNA(VLOOKUP(L2,Menis!$I$2:$J$10,2,FALSE),"")' });
    expect(sheet.getCell("N2").value).toEqual({ formula: 'IFNA(VLOOKUP(L2,Menis!$I$2:$K$10,3,FALSE),"")' });
    expect(sheet.getCell("D2").dataValidation.type).toBe("list");
    expect(sheet.getColumn(headers.length).width).toBe(64);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getCell("B2").alignment).toMatchObject({ wrapText: true, vertical: "top" });
    if (kind === "Asset") expect(sheet.getCell("R2").value).toBe(scheduleUrl);
    else expect(sheet.getCell("Q1").value).toBe("Condition Report");
  });

  it("keeps source order and stored media unchanged for sparse video assignments", async () => {
    const lots = [
      { lot_id: "none", lot_number: "90", title: "No clip", video_urls: [] },
      { lot_id: "one", lot_number: "12", title: "One clip", video_urls: [sourceUrl], youtube_video_urls: [watchUrl] },
      { lot_id: "gap", lot_number: "003", title: "Gap", video_urls: [] },
      { lot_id: "many", lot_number: "X8", title: "Several clips", video_urls: [sourceUrl, "https://assetinsight.test/videos/second.mp4"] },
    ];
    const before = structuredClone(lots);
    const workbook = await workbookFor(lots, { youtube_video_urls: [watchUrl], videoUrls: [sourceUrl], youtube_videos_enabled: true });
    const sheet = workbook.getWorksheet("Sheet1")!;
    expect([2, 3, 4, 5].map((row) => sheet.getCell(row, 1).value)).toEqual(["90", "12", "003", "X8"]);
    expect(lots).toEqual(before);
  });

  it("ignores legacy or malformed YouTube metadata without restoring the column", async () => {
    for (const value of [[watchUrl], '=HYPERLINK("https://evil.test","open")', null, { text: watchUrl, hyperlink: watchUrl }]) {
      await workbookFor([{ title: "Saved report", video_urls: [sourceUrl], youtube_video_urls: value, youtube_video_url: value }], { youtube_video_urls: value });
    }
  });

  it("preserves nested item rows without flattening their videos into Excel", async () => {
    const workbook = await workbookFor([
      { title: "Assigned", video_urls: [sourceUrl], items: [
        { lot_number: "7", title: "Inherited" },
        { lot_number: "8", title: "Own clip", video_urls: [sourceUrl], youtube_video_urls: [watchUrl] },
        { lot_number: "9", title: "Explicit empty", video_urls: [] },
      ] },
      { title: "Unassigned", items: [{ lot_number: "10", title: "No inherited clip" }] },
    ], { youtube_video_urls: [watchUrl] });
    const sheet = workbook.getWorksheet("Sheet1")!;
    expect([2, 3, 4, 5].map((row) => sheet.getCell(row, 1).value)).toEqual(["7", "8", "9", "10"]);
    expect([2, 3, 4, 5].map((row) => sheet.getCell(row, 2).value)).toEqual(["Inherited", "Own clip", "Explicit empty", "No inherited clip"]);
  });

  it("preserves complete descriptions and reviewed serials for large reports", async () => {
    const title = "Frac Shack NGC-11, EG-13, EB7 Mobile Diesel Refuelling Station Mounted on 2020 Cincor TriA Step Deck Trailer";
    const lots = Array.from({ length: 200 }, (_, index) => ({ lot_number: String(2043 + index), title, serial_number: "2G9DS63T8L105043", video_urls: [sourceUrl], youtube_video_urls: [watchUrl] }));
    const workbook = await workbookFor(lots);
    const sheet = workbook.getWorksheet("Sheet1")!;
    // Dropdown validation intentionally extends through 1,000 blank rows.
    expect(sheet.getColumn(1).values.filter((value) => value != null)).toHaveLength(201);
    for (let row = 2; row <= 201; row += 1) {
      expect(sheet.getCell(row, 2).value).toBe(title);
      expect(sheet.getCell(row, 3).value).toBe("2G9DS63T8L105043");
    }
  });
});
