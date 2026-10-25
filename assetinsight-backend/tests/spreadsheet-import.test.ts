import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  readFirstWorksheetRows,
  SpreadsheetImportError,
} from "../src/utils/excel.js";

async function xlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.addRow(["Name", "Phone"]);
  sheet.addRow(["Brad Inge", "204-857-4151"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("format-aware spreadsheet imports", () => {
  it("parses a valid XLSX workbook through ExcelJS", async () => {
    const parsed = await readFirstWorksheetRows({
      buffer: await xlsxFixture(),
      originalName: "leads.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(parsed?.sheetName).toBe("Leads");
    expect(parsed?.rows).toEqual([{ Name: "Brad Inge", Phone: "204-857-4151" }]);
  });

  it("parses a valid legacy XLS workbook through SheetJS", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Company"],
        ["Brad Inge", "Ingean Construction Inc."],
      ]),
      "Leads"
    );
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xls" });
    const parsed = await readFirstWorksheetRows({
      buffer,
      originalName: "leads.xls",
      mimeType: "application/vnd.ms-excel",
    });

    expect(parsed?.rows).toEqual([
      { Name: "Brad Inge", Company: "Ingean Construction Inc." },
    ]);
  });

  it("parses strict CSV data", async () => {
    const parsed = await readFirstWorksheetRows({
      buffer: Buffer.from('Name,Phone\n"Brad Inge","204-857-4151"\n'),
      originalName: "leads.csv",
      mimeType: "text/csv",
    });

    expect(parsed?.rows).toEqual([{ Name: "Brad Inge", Phone: "204-857-4151" }]);
  });

  it.each([
    ["renamed.xlsx", "text/csv", Buffer.from("Name,Phone\nBrad,2048574151")],
    ["response.csv", "text/html", Buffer.from("<!doctype html><html>Error</html>")],
  ])("rejects mislabeled or unsafe uploads without leaking parser errors", async (name, mime, buffer) => {
    await expect(
      readFirstWorksheetRows({ buffer, originalName: name, mimeType: mime })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("maps corrupt ZIP workbooks to a stable friendly error", async () => {
    const corruptZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    await expect(
      readFirstWorksheetRows({
        buffer: corruptZip,
        originalName: "corrupt.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<SpreadsheetImportError>>({
        code: "CORRUPT_WORKBOOK",
        statusCode: 400,
      })
    );
  });

  it("rejects malformed CSV rows with a stable code", async () => {
    await expect(
      readFirstWorksheetRows({
        buffer: Buffer.from("Name,Phone\nBrad,2048574151,unexpected\n"),
        originalName: "leads.csv",
        mimeType: "text/csv",
      })
    ).rejects.toMatchObject({ code: "MALFORMED_CSV", statusCode: 400 });
  });
});
