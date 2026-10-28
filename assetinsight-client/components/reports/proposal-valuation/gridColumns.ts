import { formatMoney } from "./calculations";
import { assetLabel, pictureCount, rowDisplayValues } from "./rowDisplay";
import type { ProposalValuationEvaluator, ProposalValuationRow } from "./types";

export type GridTextField =
  | "asset_category"
  | "year"
  | "make"
  | "model"
  | "serial_number"
  | "condition_score"
  | "location"
  | "cr_details"
  | "notes";

export type GridNumberField = "lien_search" | "video_cost";

export type GridCalcKey =
  | "average"
  | "low"
  | "high"
  | "buyerPremiumPercent"
  | "buyerPremiumAmount"
  | "totalExpectedGross"
  | "allocatedValue"
  | "cleaning"
  | "lottingFee"
  | "advertising";

type ColumnBase = { id: string; label: string; width: number; letter: string };

export type GridColumn = ColumnBase & (
  | { kind: "asset" }
  | { kind: "assetInsight" }
  | { kind: "pictures" }
  | { kind: "text"; field: GridTextField; ariaLabel: (asset: string) => string; placeholder?: string }
  | { kind: "number"; field: GridNumberField; ariaLabel: (asset: string) => string }
  | { kind: "evaluator"; evaluatorId: string; ariaLabel: (asset: string) => string }
  | { kind: "calc"; calc: GridCalcKey }
);

export type GridCellValue = string | number | null;

/** First lot row in the exported workbook; rows 1-7 are its title and headers. */
export const EXPORT_FIRST_DATA_ROW = 8;

export function columnLetter(columnNumber: number) {
  let letter = "";
  for (let value = columnNumber; value > 0; value = Math.floor((value - 1) / 26)) {
    letter = String.fromCharCode(65 + ((value - 1) % 26)) + letter;
  }
  return letter;
}

/**
 * On-screen columns in the order of the exported "Proposal Valuation Detail" sheet
 * (buildDetailColumns in the backend's proposalValuationExcelService.ts), so a cell
 * address such as R8 names the same cell in the downloaded workbook. The export's
 * market-check, risk and projected-cost columns are not on screen; their letters are
 * skipped, as hidden columns are in Excel. Keep both lists in step.
 */
export function buildGridColumns(evaluators: ProposalValuationEvaluator[]): GridColumn[] {
  const n = evaluators.length;
  const at = (exportColumn: number) => columnLetter(exportColumn);
  const text = (
    field: GridTextField,
    label: string,
    width: number,
    exportColumn: number,
    ariaName: string,
    placeholder?: string
  ): GridColumn => ({
    id: field,
    kind: "text",
    field,
    label,
    width,
    letter: at(exportColumn),
    ariaLabel: (asset) => `${ariaName} for ${asset}`,
    placeholder,
  });
  const calc = (calcKey: GridCalcKey, label: string, width: number, exportColumn: number): GridColumn => ({
    id: calcKey,
    kind: "calc",
    calc: calcKey,
    label,
    width,
    letter: at(exportColumn),
  });
  const number = (field: GridNumberField, label: string, width: number, exportColumn: number, ariaName: string): GridColumn => ({
    id: field,
    kind: "number",
    field,
    label,
    width,
    letter: at(exportColumn),
    ariaLabel: (asset) => `${ariaName} for ${asset}`,
  });

  return [
    { id: "asset_id", kind: "asset", label: "Asset ID", width: 84, letter: at(1) },
    text("asset_category", "Asset Category", 168, 2, "Asset category"),
    text("year", "Year", 80, 3, "Year"),
    text("make", "Make", 120, 4, "Make"),
    text("model", "Model", 132, 5, "Model"),
    text("serial_number", "Serial Number", 156, 6, "Serial number"),
    text("condition_score", "Condition (1-5)", 104, 7, "Condition", "1-5"),
    text("location", "Location (City, State/Prov)", 180, 8, "Location", "City, State/Prov"),
    { id: "pictures", kind: "pictures", label: "Pictures", width: 104, letter: at(9) },
    text("cr_details", "CR Details", 280, 10, "CR details"),
    { id: "asset_insight", kind: "assetInsight", label: "Asset Insight", width: 140, letter: at(17) },
    ...evaluators.map((column, index): GridColumn => ({
      id: `evaluator:${column.id}`,
      kind: "evaluator",
      evaluatorId: column.id,
      label: column.name,
      width: 124,
      letter: at(18 + index),
      ariaLabel: (asset) => `${column.name} valuation for ${asset}`,
    })),
    calc("average", "Average", 116, 18 + n),
    calc("low", "Low Est. Sale Value ($)", 132, 19 + n),
    calc("high", "High Est. Sale Value ($)", 132, 20 + n),
    calc("buyerPremiumPercent", "Buyer Premium %", 96, 21 + n),
    calc("buyerPremiumAmount", "Buyer Premium ($)", 120, 22 + n),
    calc("totalExpectedGross", "Total Expected Gross ($)", 140, 23 + n),
    calc("allocatedValue", "Allocated Value ($)", 128, 24 + n),
    text("notes", "Notes", 220, 27 + n, "Notes", "Notes"),
    calc("cleaning", "Cleaning", 104, 28 + n),
    number("lien_search", "Lien Search", 104, 29 + n, "Lien search cost"),
    number("video_cost", "Video Cost", 104, 30 + n, "Video cost"),
    calc("lottingFee", "Lotting Fee", 104, 31 + n),
    calc("advertising", "Advertising", 108, 32 + n),
  ];
}

export function isNumericColumn(column: GridColumn) {
  return column.kind === "number" || column.kind === "evaluator" || column.kind === "calc";
}

/** Money columns feed the status bar's Sum and Average; Buyer Premium % does not. */
export function isMoneyColumn(column: GridColumn) {
  return isNumericColumn(column) && !(column.kind === "calc" && column.calc === "buyerPremiumPercent");
}

export function canEditColumn(
  column: GridColumn,
  canEditAll: boolean,
  editableEvaluatorId: string | null
) {
  if (column.kind === "text" || column.kind === "number") return canEditAll;
  if (column.kind === "evaluator") return canEditAll || editableEvaluatorId === column.evaluatorId;
  return false;
}

/** The value Excel would hold: numbers stay numbers, empty cells are null or "". */
export function cellValue(
  row: ProposalValuationRow,
  column: GridColumn,
  evaluators: ProposalValuationEvaluator[]
): GridCellValue {
  switch (column.kind) {
    case "asset":
      return assetLabel(row);
    case "assetInsight":
      return row.asset_insight || "";
    case "pictures":
      return pictureCount(row);
    case "text":
      return row[column.field] ?? "";
    case "number": {
      const value = row[column.field];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    case "evaluator": {
      const value = row.evaluator_values?.[column.evaluatorId];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    case "calc": {
      const display = rowDisplayValues(row, evaluators);
      const value = display[column.calc];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
  }
}

export function cellText(
  row: ProposalValuationRow,
  column: GridColumn,
  evaluators: ProposalValuationEvaluator[],
  currency: string
) {
  const value = cellValue(row, column, evaluators);
  if (column.kind === "pictures") {
    const count = Number(value) || 0;
    return `${count} picture${count === 1 ? "" : "s"}`;
  }
  if (column.kind === "calc" && column.calc === "buyerPremiumPercent") {
    return value === null ? "" : `${value}%`;
  }
  if (isNumericColumn(column)) return value === null ? "" : formatMoney(Number(value), currency);
  return value === null ? "" : String(value);
}

/** The text a cell starts with when editing: the plain number, never its currency format. */
export function cellEditText(value: GridCellValue) {
  return value === null ? "" : String(value);
}

/** Accepts what people paste from Excel: "$1,200", "CA$1,200.50", " 1200 ". */
export function parseCellNumber(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const match = /^(\()?\s*(-)?\s*(?:[A-Za-z]{0,3}\$)?\s*(-)?\s*(\d[\d,]*(?:\.\d*)?|\.\d+)\s*(\))?$/.exec(trimmed);
  if (!match || Boolean(match[1]) !== Boolean(match[5])) return { ok: false };
  const value = Number.parseFloat(match[4].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value: match[1] || match[2] || match[3] ? -value : value };
}

export function sameCellValue(left: GridCellValue, right: GridCellValue) {
  if (left === null || left === "") return right === null || right === "";
  return left === right;
}

/** The formula the exported workbook writes in this cell, or null for an input cell. */
export function cellFormula(
  column: GridColumn,
  columns: GridColumn[],
  rowNumber: number,
  buyerPremiumPercent: number
) {
  if (column.kind !== "calc") return null;
  const address = (id: GridCalcKey) => {
    const target = columns.find((candidate) => candidate.id === id);
    return `${target?.letter ?? ""}${rowNumber}`;
  };
  const evaluatorColumns = columns.filter((candidate) => candidate.kind === "evaluator");
  const range = evaluatorColumns.length
    ? `${evaluatorColumns[0].letter}${rowNumber}:${evaluatorColumns[evaluatorColumns.length - 1].letter}${rowNumber}`
    : "";
  const whenValued = (formula: string) => (range ? `=IF(COUNT(${range})=0,"",${formula})` : '=""');
  switch (column.calc) {
    case "average":
      return range ? `=IFERROR(AVERAGE(${range}),0)` : "=0";
    case "low":
      return whenValued(`MIN(${range})`);
    case "high":
      return whenValued(`MAX(${range})`);
    case "buyerPremiumPercent":
      return `${buyerPremiumPercent}%`;
    case "buyerPremiumAmount":
      return whenValued(`MIN(${address("average")}*${address("buyerPremiumPercent")},2000)`);
    case "totalExpectedGross":
      return whenValued(`${address("average")}+${address("buyerPremiumAmount")}`);
    case "allocatedValue":
      return whenValued(address("totalExpectedGross"));
    case "cleaning":
    case "lottingFee":
    case "advertising":
      return `=IF(${address("high")}="","",${address("high")}*1%)`;
  }
}

/** Tab-separated text as Excel copies it; cells holding tabs, newlines or quotes are quoted. */
export function toClipboardText(cells: GridCellValue[][]) {
  return cells
    .map((line) =>
      line
        .map((value) => {
          const text = value === null ? "" : typeof value === "number" ? String(Math.round(value * 100) / 100) : value;
          return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join("\t")
    )
    .join("\n");
}

export function parseClipboardText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/\r\n?/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The value shown in a column's filter list; blanks share one entry. */
export const BLANK_FILTER_KEY = "";

export function filterKey(text: string) {
  return text.trim();
}

/** Blank cells sort last in both directions, as in Excel. */
export function compareCellValues(left: GridCellValue, right: GridCellValue, direction: "asc" | "desc") {
  const leftBlank = left === null || left === "";
  const rightBlank = right === null || right === "";
  if (leftBlank || rightBlank) return leftBlank === rightBlank ? 0 : leftBlank ? 1 : -1;
  const order = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? order : -order;
}
