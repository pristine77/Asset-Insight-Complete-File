import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { parse as createCsvParser } from "csv-parse";
import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";

export type ExcelRow = Record<string, unknown>;
export type ParsedWorksheet = {
  sheetName: string;
  rows: ExcelRow[];
};

export type SpreadsheetInput = {
  buffer: Buffer;
  originalName?: string;
  mimeType?: string;
};

export type SpreadsheetFileType = "xlsx" | "xls" | "csv";
export type StreamWorksheetResult = {
  sheetName: string;
  rowCount: number;
};

export type SpreadsheetImportErrorCode =
  | "INVALID_FILE_TYPE"
  | "FILE_SIGNATURE_MISMATCH"
  | "CORRUPT_WORKBOOK"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_ROWS"
  | "EMPTY_WORKBOOK"
  | "MALFORMED_CSV";

const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;
const MAX_SPREADSHEET_ROWS = 50_000;
const XLS_COMPOUND_FILE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

export class SpreadsheetImportError extends Error {
  readonly code: SpreadsheetImportErrorCode;
  readonly statusCode = 400;

  constructor(code: SpreadsheetImportErrorCode, message: string) {
    super(message);
    this.name = "SpreadsheetImportError";
    this.code = code;
  }
}

export function isSpreadsheetImportError(
  error: unknown
): error is SpreadsheetImportError {
  return error instanceof SpreadsheetImportError;
}

export function getSpreadsheetFileType(fileName: string): SpreadsheetFileType {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".xls") return "xls";
  if (extension === ".csv") return "csv";
  throw new SpreadsheetImportError(
    "INVALID_FILE_TYPE",
    "Only XLSX, XLS, and CSV files are supported."
  );
}

/** Validate a disk-backed upload without loading the workbook into memory. */
export async function validateSpreadsheetFile(
  filePath: string,
  originalName: string
): Promise<SpreadsheetFileType> {
  const type = getSpreadsheetFileType(originalName);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const sample = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (!bytes.length) {
      throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The uploaded spreadsheet is empty.");
    }
    if (type === "xlsx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      throw new SpreadsheetImportError(
        "FILE_SIGNATURE_MISMATCH",
        "This file is not a valid XLSX workbook. Export it from Excel and try again."
      );
    }
    if (
      type === "xls" &&
      !XLS_COMPOUND_FILE_SIGNATURE.equals(bytes.subarray(0, XLS_COMPOUND_FILE_SIGNATURE.length))
    ) {
      throw new SpreadsheetImportError(
        "FILE_SIGNATURE_MISMATCH",
        "This file is not a valid legacy XLS workbook. Export it again and retry."
      );
    }
    if (type === "csv") {
      const text = bytes.toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
      if (bytes.includes(0) || /^<!doctype\s+html|^<html\b|^<head\b|^<body\b/.test(text)) {
        throw new SpreadsheetImportError(
          "FILE_SIGNATURE_MISMATCH",
          "This file is not a valid CSV export."
        );
      }
    }
    return type;
  } finally {
    await handle.close();
  }
}

export function excelSerialToDate(value: number): Date | undefined {
  if (!Number.isFinite(value)) return undefined;

  const excelEpochUtc = Date.UTC(1899, 11, 30);
  const millis = Math.round(value * 24 * 60 * 60 * 1000);
  const dt = new Date(excelEpochUtc + millis);

  return Number.isFinite(dt.getTime()) ? dt : undefined;
}

function normalizeExcelCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeExcelCellValue(entry)).join("");
  }
  if (typeof value === "object") {
    if ("result" in value) {
      return normalizeExcelCellValue((value as any).result);
    }
    if ("text" in value && typeof (value as any).text === "string") {
      return (value as any).text;
    }
    if ("hyperlink" in value && typeof (value as any).hyperlink === "string") {
      return (value as any).text || (value as any).hyperlink;
    }
    if ("richText" in value && Array.isArray((value as any).richText)) {
      return (value as any).richText.map((part: any) => part?.text || "").join("");
    }
    if ("formula" in value && "result" in value) {
      return normalizeExcelCellValue((value as any).result);
    }
    if ("error" in value) {
      return "";
    }
  }

  return String(value);
}

/**
 * Stream the first worksheet with backpressure. The callback is awaited before
 * another row is consumed, keeping memory bounded for six-figure imports.
 */
export async function streamFirstWorksheetRowsFromFile(
  filePath: string,
  originalName: string,
  onRow: (row: ExcelRow, rowNumber: number) => Promise<void> | void
): Promise<StreamWorksheetResult> {
  const type = await validateSpreadsheetFile(filePath, originalName);
  try {
    if (type === "csv") {
      const parser = fs.createReadStream(filePath).pipe(
        createCsvParser({
          bom: true,
          columns: true,
          relax_column_count: true,
          skip_empty_lines: true,
          trim: false,
        })
      );
      let rowCount = 0;
      for await (const raw of parser) {
        rowCount += 1;
        await onRow(raw as ExcelRow, rowCount + 1);
      }
      if (!rowCount) {
        throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The CSV file has no data rows.");
      }
      return { sheetName: "CSV", rowCount };
    }

    // Legacy XLS is not streamable with the available parser. Bound its size
    // and direct large exports to XLSX/CSV, which use constant-memory readers.
    if (type === "xls") {
      const maxLegacyBytes = Number(
        process.env.CRM_IMPORT_MAX_LEGACY_XLS_BYTES || 25 * 1024 * 1024
      );
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxLegacyBytes) {
        throw new SpreadsheetImportError(
          "FILE_TOO_LARGE",
          "This legacy XLS file is too large. Save it as XLSX or CSV and upload it again."
        );
      }
      const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The workbook has no worksheets.");
      }
      const rows = XLSX.utils.sheet_to_json<ExcelRow>(workbook.Sheets[sheetName], {
        defval: "",
        raw: true,
      });
      for (let index = 0; index < rows.length; index += 1) {
        await onRow(rows[index], index + 2);
      }
      if (!rows.length) {
        throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The workbook has no data rows.");
      }
      return { sheetName, rowCount: rows.length };
    }

    // ExcelJS ships the streaming reader at runtime but omits it from the
    // typings in the version used by this service.
    const WorkbookReader = (ExcelJS as any).stream.xlsx.WorkbookReader;
    const reader = new WorkbookReader(filePath, {
      entries: "emit",
      sharedStrings: "cache",
      hyperlinks: "ignore",
      styles: "ignore",
      worksheets: "emit",
    });
    let sheetName = "Sheet 1";
    let rowCount = 0;
    let foundWorksheet = false;
    for await (const worksheet of reader) {
      foundWorksheet = true;
      sheetName = String((worksheet as any).name || sheetName);
      let headers: string[] = [];
      for await (const row of worksheet) {
        if (!headers.length) {
          const cellCount = Math.max(
            row.cellCount,
            Array.isArray(row.values) ? row.values.length - 1 : 0
          );
          headers = Array.from({ length: cellCount }, (_, index) =>
            String(normalizeExcelCellValue(row.getCell(index + 1).value)).trim()
          );
          continue;
        }
        const item: ExcelRow = {};
        let hasData = false;
        for (let column = 1; column <= headers.length; column += 1) {
          const key = headers[column - 1] || `Column ${column}`;
          const value = normalizeExcelCellValue(row.getCell(column).value);
          item[key] = value;
          if (value !== "" && value !== null && value !== undefined) hasData = true;
        }
        if (!hasData) continue;
        rowCount += 1;
        await onRow(item, Number(row.number || rowCount + 1));
      }
      break;
    }
    if (!foundWorksheet || !rowCount) {
      throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The workbook has no data rows.");
    }
    return { sheetName, rowCount };
  } catch (error) {
    if (isSpreadsheetImportError(error)) throw error;
    throw new SpreadsheetImportError(
      "CORRUPT_WORKBOOK",
      "This file is not a valid spreadsheet or is corrupted."
    );
  }
}

async function readXlsxRows(buffer: Buffer): Promise<ParsedWorksheet | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return null;

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  for (let col = 1; col <= headerRow.cellCount; col += 1) {
    headers.push(String(normalizeExcelCellValue(headerRow.getCell(col).value)).trim());
  }

  const rows: ExcelRow[] = [];
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const item: ExcelRow = {};
    let hasData = false;

    for (let col = 1; col <= headers.length; col += 1) {
      const key = headers[col - 1] || `Column ${col}`;
      const value = normalizeExcelCellValue(row.getCell(col).value);
      item[key] = value;
      if (value !== "" && value !== null && value !== undefined) {
        hasData = true;
      }
    }

    if (hasData) rows.push(item);
  }

  return {
    sheetName: worksheet.name,
    rows,
  };
}

function sheetJsCellValue(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return String(value);
}

function rowsFromMatrix(matrix: unknown[][], sheetName: string): ParsedWorksheet | null {
  if (!matrix.length) return null;
  const headers = (matrix[0] || []).map((value, index) => {
    const header = String(sheetJsCellValue(value)).trim();
    return header || `Column ${index + 1}`;
  });
  if (!headers.length) return null;

  const rows: ExcelRow[] = [];
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const source = matrix[rowIndex] || [];
    const item: ExcelRow = {};
    let hasData = false;
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const value = sheetJsCellValue(source[columnIndex]);
      item[headers[columnIndex]] = value;
      if (value !== "" && value !== null && value !== undefined) hasData = true;
    }
    if (hasData) rows.push(item);
  }
  return { sheetName, rows };
}

function readXlsRows(buffer: Buffer): ParsedWorksheet | null {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return null;
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  return rowsFromMatrix(matrix, sheetName);
}

function readCsvRows(buffer: Buffer): ParsedWorksheet | null {
  let matrix: unknown[][];
  try {
    matrix = parseCsv(buffer.toString("utf8"), {
      bom: true,
      columns: false,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[][];
  } catch {
    throw new SpreadsheetImportError(
      "MALFORMED_CSV",
      "This CSV file is malformed. Check that every row has the same number of columns."
    );
  }
  return rowsFromMatrix(matrix, "CSV Import");
}

function spreadsheetExtension(originalName?: string): ".xlsx" | ".xls" | ".csv" {
  const match = String(originalName || "").toLowerCase().match(/\.(xlsx|xls|csv)$/);
  if (!match) {
    throw new SpreadsheetImportError(
      "INVALID_FILE_TYPE",
      "Choose a valid XLSX, XLS, or CSV file."
    );
  }
  return `.${match[1]}` as ".xlsx" | ".xls" | ".csv";
}

function validateSpreadsheetMime(
  mimeType: string | undefined,
  extension: ".xlsx" | ".xls" | ".csv"
): void {
  const mime = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") return;

  const allowedByExtension: Record<typeof extension, Set<string>> = {
    ".xlsx": new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/x-zip-compressed",
    ]),
    ".xls": new Set([
      "application/vnd.ms-excel",
      "application/x-ole-storage",
    ]),
    // Some browsers report CSV exports as the legacy Excel MIME.
    ".csv": new Set([
      "text/csv",
      "text/plain",
      "application/csv",
      "application/vnd.ms-excel",
    ]),
  };

  if (!allowedByExtension[extension].has(mime)) {
    throw new SpreadsheetImportError(
      "INVALID_FILE_TYPE",
      `The selected file type does not match its ${extension.toUpperCase()} extension.`
    );
  }
}

function validateSpreadsheetSignature(
  buffer: Buffer,
  extension: ".xlsx" | ".xls" | ".csv"
): void {
  if (extension === ".xlsx") {
    const isZip =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(buffer[2]) &&
      [0x04, 0x06, 0x08].includes(buffer[3]);
    if (!isZip) {
      throw new SpreadsheetImportError(
        "FILE_SIGNATURE_MISMATCH",
        "This file is not a valid XLSX workbook. Export it from Excel and try again."
      );
    }
    return;
  }

  if (extension === ".xls") {
    if (
      buffer.length < XLS_COMPOUND_FILE_SIGNATURE.length ||
      !buffer.subarray(0, XLS_COMPOUND_FILE_SIGNATURE.length).equals(XLS_COMPOUND_FILE_SIGNATURE)
    ) {
      throw new SpreadsheetImportError(
        "FILE_SIGNATURE_MISMATCH",
        "This file is not a valid legacy XLS workbook. Export it again and retry."
      );
    }
    return;
  }

  const sample = buffer.subarray(0, 4096);
  const text = sample.toString("utf8").trimStart().toLowerCase();
  if (sample.includes(0) || /^<!doctype\s+html|^<html\b|^<head\b|^<body\b/.test(text)) {
    throw new SpreadsheetImportError(
      "FILE_SIGNATURE_MISMATCH",
      "This file is not a valid CSV export."
    );
  }
}

/**
 * Reads the first sheet through a format-specific parser. Buffer-only calls are
 * retained for internal XLSX compatibility; uploaded files must provide their
 * original name so extension and file signatures can be checked together.
 */
export async function readFirstWorksheetRows(
  input: Buffer | SpreadsheetInput
): Promise<ParsedWorksheet | null> {
  const normalized: SpreadsheetInput = Buffer.isBuffer(input)
    ? { buffer: input, originalName: "workbook.xlsx" }
    : input;
  const { buffer } = normalized;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new SpreadsheetImportError("EMPTY_WORKBOOK", "The selected file is empty.");
  }
  if (buffer.length > MAX_SPREADSHEET_BYTES) {
    throw new SpreadsheetImportError(
      "FILE_TOO_LARGE",
      "The spreadsheet exceeds the 25 MB upload limit."
    );
  }

  const extension = spreadsheetExtension(normalized.originalName);
  validateSpreadsheetMime(normalized.mimeType, extension);
  validateSpreadsheetSignature(buffer, extension);

  let parsed: ParsedWorksheet | null;
  try {
    parsed =
      extension === ".xlsx"
        ? await readXlsxRows(buffer)
        : extension === ".xls"
          ? readXlsRows(buffer)
          : readCsvRows(buffer);
  } catch (error) {
    if (isSpreadsheetImportError(error)) throw error;
    throw new SpreadsheetImportError(
      "CORRUPT_WORKBOOK",
      extension === ".csv"
        ? "This CSV file could not be read."
        : "This file is not a valid Excel workbook. Export it again and retry."
    );
  }

  if (!parsed || parsed.rows.length === 0) {
    throw new SpreadsheetImportError(
      "EMPTY_WORKBOOK",
      "The spreadsheet does not contain any importable data rows."
    );
  }
  if (parsed.rows.length > MAX_SPREADSHEET_ROWS) {
    throw new SpreadsheetImportError(
      "TOO_MANY_ROWS",
      `The spreadsheet contains more than ${MAX_SPREADSHEET_ROWS.toLocaleString("en-US")} rows.`
    );
  }
  return parsed;
}

export function setWorksheetColumnWidths(
  worksheet: ExcelJS.Worksheet,
  widths: number[]
) {
  worksheet.columns = widths.map((width) => ({ width }));
}

export function addWorksheetFromRows(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: unknown[][]
) {
  const worksheet = workbook.addWorksheet(name);
  for (const row of rows) {
    worksheet.addRow(row);
  }
  return worksheet;
}

export function getWorksheetColumnWidthsFromRows(
  rows: unknown[][],
  minWidth: number = 12,
  maxWidth: number = 48,
  padding: number = 4
): number[] {
  const maxColumns = rows.reduce(
    (count, row) => Math.max(count, Array.isArray(row) ? row.length : 0),
    0
  );

  return Array.from({ length: maxColumns }, (_, columnIndex) => {
    const longest = rows.reduce((maxLen, row) => {
      const value =
        Array.isArray(row) && columnIndex < row.length ? row[columnIndex] : "";
      return Math.max(maxLen, String(value ?? "").length);
    }, 0);

    return Math.max(minWidth, Math.min(maxWidth, longest + padding));
  });
}

export function applyListValidationToColumn(
  worksheet: ExcelJS.Worksheet,
  columnNumber: number,
  formulaRange: string,
  rowCount: number
) {
  for (let row = 2; row <= rowCount; row += 1) {
    worksheet.getCell(row, columnNumber).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [formulaRange],
    };
  }
}

export async function workbookToBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}
