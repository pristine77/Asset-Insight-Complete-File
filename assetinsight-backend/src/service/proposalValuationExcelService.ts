import ExcelJS from "exceljs";
import type {
  AssetAdminScheduleRow,
  AssetAdminScheduleSheet,
  AssetScheduleCalculation,
  AssetScheduleDerivedSummary,
} from "./assetAdminScheduleSheetService.js";
import { getAssetScheduleRowRiskScore } from "./assetAdminScheduleSheetService.js";
import { workbookToBuffer } from "../utils/excel.js";

export const PROPOSAL_VALUATION_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type ProposalValuationExcelData = {
  reportId: string;
  title: string;
  meta: Array<{ label: string; value: string }>;
  currencyCode: string;
  assetScheduleSheet: AssetAdminScheduleSheet;
  revision: number;
  summary: AssetScheduleDerivedSummary;
  calculationVersion: string;
  calculations: AssetScheduleCalculation[];
};

type DetailColumnKey =
  | "assetId"
  | "category"
  | "year"
  | "make"
  | "model"
  | "serial"
  | "condition"
  | "location"
  | "pictures"
  | "crDetails"
  | "comparableCount"
  | "averageRetail"
  | "marketSaturation"
  | "marketVelocity"
  | "regionalDemand"
  | "marketNotes"
  | "assetInsight"
  | `evaluator:${string}`
  | "appraiserAverage"
  | "lowEstimate"
  | "highEstimate"
  | "buyerPremiumPercent"
  | "buyerPremiumAmount"
  | "totalExpectedGross"
  | "allocatedValue"
  | "riskScore"
  | "riskBucket"
  | "notes"
  | "cleaning"
  | "lienSearch"
  | "videoCost"
  | "lottingFee"
  | "advertising"
  | "totalProjectedCosts";

type DetailColumn = {
  key: DetailColumnKey;
  label: string;
  width: number;
  currency?: boolean;
  percent?: boolean;
  integer?: boolean;
};

type DetailLayout = {
  headerRow: number;
  firstDataRow: number;
  lastDataRow: number;
  columns: DetailColumn[];
  columnIndex: Map<DetailColumnKey, number>;
};

const COLORS = {
  ink: "102A43",
  blue: "1557ED",
  blueSoft: "EAF1FF",
  teal: "0F766E",
  tealSoft: "E7F6F2",
  amber: "B45309",
  amberSoft: "FFF4DB",
  surface: "F7F9FC",
  border: "D7E0EA",
  muted: "5F6F82",
  white: "FFFFFF",
  stripe: "F9FBFD",
};

const BODY_FONT = "Aptos";
const DETAIL_SHEET = "Valuation Detail";
const SUMMARY_SHEET = "PV Summary";
const FORMULA_SHEET = "Formula Reference";

function asText(value: unknown, maxLength = 1_000): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeCurrencyCode(value: unknown): string {
  const normalized = asText(value, 12).toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.slice(0, 5) || "CAD";
}

function currencyFormat(currencyCode: string, decimalPlaces: 0 | 2 = 0): string {
  const numberFormat = decimalPlaces === 2 ? "#,##0.00" : "#,##0";
  return `"${safeCurrencyCode(currencyCode)}" ${numberFormat};[Red]-"${safeCurrencyCode(
    currencyCode
  )}" ${numberFormat}`;
}

function columnLetter(columnNumber: number): string {
  let value = columnNumber;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function excelFormula(
  cell: ExcelJS.Cell,
  formula: string,
  result: number | string | null | undefined
) {
  cell.value = {
    formula,
    result:
      typeof result === "number" && Number.isFinite(result)
        ? result
        : typeof result === "string"
          ? result
          : "",
  } as ExcelJS.CellFormulaValue;
}

function thinBottomBorder(color = COLORS.border): Partial<ExcelJS.Borders> {
  return {
    bottom: { style: "thin", color: { argb: color } },
  };
}

function styleSectionBand(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  startColumn: number,
  endColumn: number,
  title: string,
  fill = COLORS.ink
) {
  worksheet.mergeCells(rowNumber, startColumn, rowNumber, endColumn);
  const cell = worksheet.getCell(rowNumber, startColumn);
  cell.value = title;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.font = { name: BODY_FONT, bold: true, color: { argb: COLORS.white }, size: 11 };
  cell.alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(rowNumber).height = 24;
}

function setKpiPair(
  worksheet: ExcelJS.Worksheet,
  labelCell: string,
  valueCell: string,
  label: string,
  value: number | string,
  options: { formula?: string; numFmt?: string; accent?: "blue" | "teal" | "amber" } = {}
) {
  const labelTarget = worksheet.getCell(labelCell);
  const valueTarget = worksheet.getCell(valueCell);
  const accent = options.accent || "blue";
  const fill =
    accent === "teal"
      ? COLORS.tealSoft
      : accent === "amber"
        ? COLORS.amberSoft
        : COLORS.blueSoft;
  const fontColor =
    accent === "teal" ? COLORS.teal : accent === "amber" ? COLORS.amber : COLORS.blue;

  labelTarget.value = label.toUpperCase();
  labelTarget.font = { name: BODY_FONT, bold: true, size: 8, color: { argb: COLORS.muted } };
  labelTarget.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  labelTarget.alignment = { vertical: "middle", horizontal: "left" };
  labelTarget.border = thinBottomBorder();

  if (options.formula) excelFormula(valueTarget, options.formula, value);
  else valueTarget.value = value;
  valueTarget.font = { name: BODY_FONT, bold: true, size: 14, color: { argb: fontColor } };
  valueTarget.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  valueTarget.alignment = { vertical: "middle", horizontal: "right" };
  valueTarget.border = thinBottomBorder();
  if (options.numFmt) valueTarget.numFmt = options.numFmt;
}

function buildDetailColumns(sheet: AssetAdminScheduleSheet): DetailColumn[] {
  return [
    { key: "assetId", label: "Asset ID", width: 13 },
    { key: "category", label: "Asset Category", width: 24 },
    { key: "year", label: "Year", width: 10 },
    { key: "make", label: "Make", width: 16 },
    { key: "model", label: "Model", width: 20 },
    { key: "serial", label: "Serial Number", width: 21 },
    { key: "condition", label: "Condition (1-5)", width: 16 },
    { key: "location", label: "Location", width: 24 },
    { key: "pictures", label: "Pictures", width: 11, integer: true },
    { key: "crDetails", label: "Condition Report Details", width: 42 },
    { key: "comparableCount", label: "Comparable Count", width: 18 },
    { key: "averageRetail", label: "Avg Retail Asking Price", width: 22 },
    { key: "marketSaturation", label: "Market Saturation", width: 18 },
    { key: "marketVelocity", label: "Market Velocity", width: 17 },
    { key: "regionalDemand", label: "Regional Demand", width: 17 },
    { key: "marketNotes", label: "Market Notes", width: 28 },
    { key: "assetInsight", label: "Asset Insight", width: 18 },
    ...sheet.evaluator_columns.map((column) => ({
      key: `evaluator:${column.id}` as const,
      label: asText(column.name, 120) || "Evaluator",
      width: 18,
      currency: true,
    })),
    { key: "appraiserAverage", label: "Appraiser Average", width: 19, currency: true },
    { key: "lowEstimate", label: "Low Estimate", width: 17, currency: true },
    { key: "highEstimate", label: "High Estimate", width: 17, currency: true },
    { key: "buyerPremiumPercent", label: "Buyer Premium", width: 15, percent: true },
    { key: "buyerPremiumAmount", label: "Capped Buyer Premium", width: 22, currency: true },
    { key: "totalExpectedGross", label: "Total Expected Gross", width: 21, currency: true },
    { key: "allocatedValue", label: "Allocated Value", width: 18, currency: true },
    { key: "riskScore", label: "Risk Score", width: 13 },
    { key: "riskBucket", label: "Risk Rating", width: 14 },
    { key: "notes", label: "Valuation Notes", width: 30 },
    { key: "cleaning", label: "Cleaning", width: 15, currency: true },
    { key: "lienSearch", label: "Lien Search", width: 15, currency: true },
    { key: "videoCost", label: "Video", width: 15, currency: true },
    { key: "lottingFee", label: "Lotting", width: 15, currency: true },
    { key: "advertising", label: "Advertising", width: 15, currency: true },
    { key: "totalProjectedCosts", label: "Projected Costs", width: 18, currency: true },
  ];
}

function setDetailRawValues(
  row: ExcelJS.Row,
  source: AssetAdminScheduleRow,
  columns: DetailColumn[]
) {
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const cell = row.getCell(index + 1);
    switch (column.key) {
      case "assetId": cell.value = source.asset_id; break;
      case "category": cell.value = source.asset_category; break;
      case "year": cell.value = source.year; break;
      case "make": cell.value = source.make; break;
      case "model": cell.value = source.model; break;
      case "serial": cell.value = source.serial_number; break;
      case "condition": cell.value = source.condition_score; break;
      case "location": cell.value = source.location; break;
      case "pictures": cell.value = source.pictures; break;
      case "crDetails": cell.value = source.cr_details; break;
      case "comparableCount": cell.value = source.market_check.comparable_count; break;
      case "averageRetail": cell.value = source.market_check.avg_retail_asking_price; break;
      case "marketSaturation": cell.value = source.market_check.market_saturation; break;
      case "marketVelocity": cell.value = source.market_check.market_velocity; break;
      case "regionalDemand": cell.value = source.market_check.regional_demand; break;
      case "marketNotes": cell.value = source.market_check.notes; break;
      case "assetInsight": cell.value = source.asset_insight; break;
      case "notes": cell.value = source.notes; break;
      case "lienSearch": cell.value = source.lien_search; break;
      case "videoCost": cell.value = source.video_cost; break;
      default:
        if (column.key.startsWith("evaluator:")) {
          const evaluatorId = column.key.slice("evaluator:".length);
          cell.value = source.evaluator_values[evaluatorId];
        }
    }
  }
}

function riskScoreFormula(layout: DetailLayout, rowNumber: number): string {
  const cell = (key: DetailColumnKey) =>
    `${columnLetter(layout.columnIndex.get(key)!)}${rowNumber}`;
  const comparable = cell("comparableCount");
  const retail = cell("averageRetail");
  const saturation = cell("marketSaturation");
  const velocity = cell("marketVelocity");
  const demand = cell("regionalDemand");
  return [
    "IFERROR(AVERAGE(",
    `IF(${comparable}="High",1,IF(${comparable}="Moderate",2,IF(${comparable}="Low",3,""))),`,
    `IF(${retail}="High",1,IF(${retail}="Moderate",2,IF(${retail}="Low",3,""))),`,
    `IF(${saturation}="Low",1,IF(${saturation}="Moderate",2,IF(${saturation}="High",3,""))),`,
    `IF(${velocity}="Fast",1,IF(${velocity}="Normal",2,IF(${velocity}="Slow",3,""))),`,
    `IF(${demand}="Strong",1,IF(${demand}="Average",2,IF(${demand}="Weak",3,"")))`,
    "),2)",
  ].join("");
}

function buildValuationDetailSheet(
  worksheet: ExcelJS.Worksheet,
  data: ProposalValuationExcelData
): DetailLayout {
  const sheet = data.assetScheduleSheet;
  const columns = buildDetailColumns(sheet);
  const columnIndex = new Map(
    columns.map((column, index) => [column.key, index + 1])
  );
  const headerRow = 7;
  const firstDataRow = headerRow + 1;
  const lastDataRow = firstDataRow + sheet.rows.length - 1;
  const lastColumn = columns.length;
  const currency = currencyFormat(data.currencyCode);

  worksheet.mergeCells(1, 1, 1, lastColumn);
  const title = worksheet.getCell(1, 1);
  title.value = `${data.title} — Proposal Valuation Detail`;
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
  title.font = { name: BODY_FONT, bold: true, size: 17, color: { argb: COLORS.white } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(1).height = 34;

  worksheet.mergeCells(2, 1, 2, lastColumn);
  const subtitle = worksheet.getCell(2, 1);
  subtitle.value = `Currency: ${safeCurrencyCode(data.currencyCode)}  •  Revision ${data.revision}  •  ${sheet.rows.length} assets`;
  subtitle.font = { name: BODY_FONT, color: { argb: COLORS.muted }, size: 10 };
  subtitle.alignment = { vertical: "middle" };
  worksheet.getRow(2).height = 21;

  worksheet.mergeCells(4, 1, 4, lastColumn);
  const guidance = worksheet.getCell(4, 1);
  guidance.value =
    "Blue columns are evaluator inputs. Derived valuation and cost columns contain auditable Excel formulas.";
  guidance.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blueSoft } };
  guidance.font = { name: BODY_FONT, italic: true, color: { argb: COLORS.blue }, size: 9 };
  guidance.alignment = { vertical: "middle", wrapText: true };
  worksheet.getRow(4).height = 24;

  const header = worksheet.getRow(headerRow);
  header.values = columns.map((column) => column.label);
  header.height = 34;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
    cell.font = { name: BODY_FONT, bold: true, color: { argb: COLORS.white }, size: 9 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBottomBorder(COLORS.blue);
  });

  for (let index = 0; index < columns.length; index += 1) {
    worksheet.getColumn(index + 1).width = columns[index].width;
  }

  const layout: DetailLayout = {
    headerRow,
    firstDataRow,
    lastDataRow,
    columns,
    columnIndex,
  };
  const evaluatorIndexes = columns
    .map((column, index) => column.key.startsWith("evaluator:") ? index + 1 : 0)
    .filter(Boolean);
  const evaluatorStart = evaluatorIndexes[0];
  const evaluatorEnd = evaluatorIndexes[evaluatorIndexes.length - 1];

  sheet.rows.forEach((source, rowIndex) => {
    const rowNumber = firstDataRow + rowIndex;
    const row = worksheet.getRow(rowNumber);
    row.height = 36;
    setDetailRawValues(row, source, columns);

    const address = (key: DetailColumnKey) =>
      `${columnLetter(columnIndex.get(key)!)}${rowNumber}`;
    const cell = (key: DetailColumnKey) => row.getCell(columnIndex.get(key)!);
    const evaluatorRange =
      evaluatorStart && evaluatorEnd
        ? `${columnLetter(evaluatorStart)}${rowNumber}:${columnLetter(evaluatorEnd)}${rowNumber}`
        : "";
    const averageFormula = evaluatorRange
      ? `IFERROR(AVERAGE(${evaluatorRange}),0)`
      : "0";
    const lowFormula = evaluatorRange
      ? `IF(COUNT(${evaluatorRange})=0,"",MIN(${evaluatorRange}))`
      : '""';
    const highFormula = evaluatorRange
      ? `IF(COUNT(${evaluatorRange})=0,"",MAX(${evaluatorRange}))`
      : '""';

    excelFormula(
      cell("appraiserAverage"),
      averageFormula,
      data.summary.row_appraiser_averages[source.lot_id] || 0
    );
    excelFormula(cell("lowEstimate"), lowFormula, source.low_est_sale_value);
    excelFormula(cell("highEstimate"), highFormula, source.high_est_sale_value);
    cell("buyerPremiumPercent").value = 0.15;
    excelFormula(
      cell("buyerPremiumAmount"),
      evaluatorRange
        ? `IF(COUNT(${evaluatorRange})=0,"",MIN(${address("appraiserAverage")}*${address("buyerPremiumPercent")},2000))`
        : '""',
      source.buyer_premium_amount
    );
    excelFormula(
      cell("totalExpectedGross"),
      evaluatorRange
        ? `IF(COUNT(${evaluatorRange})=0,"",${address("appraiserAverage")}+${address("buyerPremiumAmount")})`
        : '""',
      source.total_expected_gross
    );
    excelFormula(
      cell("allocatedValue"),
      evaluatorRange
        ? `IF(COUNT(${evaluatorRange})=0,"",${address("totalExpectedGross")})`
        : '""',
      source.allocated_value
    );

    const scoreFormula = riskScoreFormula(layout, rowNumber);
    const riskScore = getAssetScheduleRowRiskScore(source.market_check);
    excelFormula(cell("riskScore"), scoreFormula, riskScore);
    const riskBucket = riskScore < 1.67 ? "Low" : riskScore < 2.34 ? "Medium" : "High";
    excelFormula(
      cell("riskBucket"),
      `IF(${address("riskScore")}<1.67,"Low",IF(${address("riskScore")}<2.34,"Medium","High"))`,
      riskBucket
    );

    for (const key of ["cleaning", "lottingFee", "advertising"] as const) {
      const cached =
        key === "cleaning"
          ? source.cleaning
          : key === "lottingFee"
            ? source.lotting_fee
            : source.advertising;
      excelFormula(
        cell(key),
        `IF(${address("highEstimate")}="","",${address("highEstimate")}*1%)`,
        cached
      );
    }
    excelFormula(
      cell("totalProjectedCosts"),
      `SUM(${address("cleaning")},${address("lienSearch")},${address("videoCost")},${address("lottingFee")},${address("advertising")})`,
      (source.cleaning || 0) +
        (source.lien_search || 0) +
        (source.video_cost || 0) +
        (source.lotting_fee || 0) +
        (source.advertising || 0)
    );

    row.eachCell({ includeEmpty: true }, (target, columnNumber) => {
      const definition = columns[columnNumber - 1];
      target.font = { name: BODY_FONT, size: 9, color: { argb: COLORS.ink } };
      target.alignment = {
        vertical: "top",
        horizontal:
          definition.currency || definition.percent || definition.integer
            ? "right"
            : "left",
        wrapText: [
          "crDetails",
          "marketNotes",
          "notes",
        ].includes(definition.key),
      };
      target.border = thinBottomBorder();
      if (rowIndex % 2 === 1) {
        target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.stripe } };
      }
      if (definition.key.startsWith("evaluator:")) {
        target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blueSoft } };
      }
      if (definition.currency) target.numFmt = currency;
      if (definition.percent) target.numFmt = "0.0%";
      if (definition.integer) target.numFmt = "#,##0";
      if (definition.key === "riskScore") target.numFmt = "0.00";
    });
  });

  // Keep lastDataRow bound to lots only: summary/risk formulas must exclude this footer.
  const totalRowNumber = lastDataRow + 1;
  const totalRow = worksheet.getRow(totalRowNumber);
  const totalCurrency = currencyFormat(data.currencyCode, 2);
  worksheet.mergeCells(totalRowNumber, 1, totalRowNumber, 2);
  totalRow.getCell(1).value = "Total (all lots)";
  totalRow.height = 28;
  columns.forEach((column, index) => {
    const columnNumber = index + 1;
    const cell = totalRow.getCell(columnNumber);
    if (column.currency) {
      let cachedTotal = 0;
      for (let rowNumber = firstDataRow; rowNumber <= lastDataRow; rowNumber += 1) {
        const detailCell = worksheet.getRow(rowNumber).getCell(columnNumber);
        const value = detailCell.type === ExcelJS.ValueType.Formula
          ? detailCell.result
          : detailCell.value;
        if (typeof value === "number" && Number.isFinite(value)) cachedTotal += value;
      }
      const letter = columnLetter(columnNumber);
      // Sum each row's existing average/capped premium, never recalculate on the grand total.
      excelFormula(
        cell,
        lastDataRow >= firstDataRow ? `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` : "0",
        cachedTotal
      );
      cell.numFmt = totalCurrency;
    }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
    cell.font = { name: BODY_FONT, bold: true, size: 10, color: { argb: COLORS.white } };
    cell.alignment = {
      vertical: "middle",
      horizontal: column.currency ? "right" : "left",
    };
    cell.border = { top: { style: "thin", color: { argb: COLORS.blue } } };
  });

  worksheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: lastColumn },
  };
  worksheet.views = [
    {
      state: "frozen",
      xSplit: 2,
      ySplit: headerRow,
      topLeftCell: `C${firstDataRow}`,
      activeCell: `C${firstDataRow}`,
      showGridLines: false,
      zoomScale: 85,
    },
  ];
  worksheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `${headerRow}:${headerRow}`,
    horizontalCentered: false,
  };
  worksheet.headerFooter.oddFooter =
    "&LAsset Insight — Proposal Valuation&CPage &P of &N&RConfidential";
  worksheet.properties.defaultRowHeight = 18;
  worksheet.properties.outlineLevelCol = 0;
  return layout;
}

function detailRange(
  layout: DetailLayout,
  key: DetailColumnKey
): string | null {
  if (layout.lastDataRow < layout.firstDataRow) return null;
  const column = columnLetter(layout.columnIndex.get(key)!);
  return `'${DETAIL_SHEET}'!${column}${layout.firstDataRow}:${column}${layout.lastDataRow}`;
}

function sumDetail(layout: DetailLayout, key: DetailColumnKey): string {
  const range = detailRange(layout, key);
  return range ? `SUM(${range})` : "0";
}

function buildSummarySheet(
  worksheet: ExcelJS.Worksheet,
  data: ProposalValuationExcelData,
  layout: DetailLayout
) {
  const currency = currencyFormat(data.currencyCode);
  worksheet.mergeCells("A1:H1");
  const title = worksheet.getCell("A1");
  title.value = `${data.title} — Proposal Valuation`;
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
  title.font = { name: BODY_FONT, bold: true, size: 20, color: { argb: COLORS.white } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(1).height = 38;

  const meta = new Map(data.meta.map((item) => [item.label, item.value]));
  const metaPairs: Array<[string, string, string, string]> = [
    ["A3", "B3", "Contract", meta.get("Contract") || "—"],
    ["C3", "D3", "Client", meta.get("Client") || "—"],
    ["E3", "F3", "Prepared For", meta.get("Prepared For") || "—"],
    ["G3", "H3", "Status", meta.get("Status") || "—"],
  ];
  for (const [labelCell, valueCell, label, value] of metaPairs) {
    const labelTarget = worksheet.getCell(labelCell);
    const valueTarget = worksheet.getCell(valueCell);
    labelTarget.value = label.toUpperCase();
    labelTarget.font = { name: BODY_FONT, bold: true, size: 8, color: { argb: COLORS.muted } };
    valueTarget.value = value;
    valueTarget.font = { name: BODY_FONT, size: 10, color: { argb: COLORS.ink } };
    valueTarget.alignment = { wrapText: true, vertical: "middle" };
  }
  worksheet.getRow(3).height = 30;

  styleSectionBand(worksheet, 5, 1, 8, "Portfolio snapshot", COLORS.blue);
  const assetRange = detailRange(layout, "assetId");
  setKpiPair(worksheet, "A7", "B7", "Assets", data.assetScheduleSheet.rows.length, {
    formula: assetRange ? `COUNTA(${assetRange})` : "0",
  });
  setKpiPair(worksheet, "C7", "D7", "Total Asset Value", data.summary.total_asset_value, {
    formula: sumDetail(layout, "appraiserAverage"),
    numFmt: currency,
  });
  setKpiPair(worksheet, "E7", "F7", "Estimated Low", data.summary.total_low_est_value, {
    formula: sumDetail(layout, "lowEstimate"),
    numFmt: currency,
    accent: "teal",
  });
  setKpiPair(worksheet, "G7", "H7", "Estimated High", data.summary.total_high_est_value, {
    formula: sumDetail(layout, "highEstimate"),
    numFmt: currency,
    accent: "teal",
  });
  setKpiPair(worksheet, "A9", "B9", "Projected Costs", data.summary.total_projected_costs, {
    formula: sumDetail(layout, "totalProjectedCosts"),
    numFmt: currency,
    accent: "amber",
  });
  setKpiPair(worksheet, "C9", "D9", "Capped Buyer Premium", data.summary.total_capped_bp, {
    formula: sumDetail(layout, "buyerPremiumAmount"),
    numFmt: currency,
  });
  // F9 is populated after the weighted score formula at H17 is available.
  setKpiPair(worksheet, "E9", "F9", "Overall Risk", data.summary.overall_file_risk_rating, {
    formula: 'IF(H17<1.67,"Low",IF(H17<2.34,"Medium","High"))',
    accent: "amber",
  });
  setKpiPair(worksheet, "G9", "H9", "PV Revision", data.revision);
  worksheet.getRow(7).height = 28;
  worksheet.getRow(9).height = 28;

  styleSectionBand(worksheet, 11, 1, 8, "Selected commercial outcome", COLORS.teal);
  worksheet.getCell("A13").value = "BUYER PREMIUM BASIS";
  worksheet.getCell("B13").value =
    data.assetScheduleSheet.file_summary.buyers_premium_basis === "capped"
      ? "Capped"
      : "Uncapped";
  worksheet.getCell("A14").value = "OFFER #2 NMG %";
  worksheet.getCell("B14").value = data.assetScheduleSheet.file_summary.offer2_nmg_percent;
  worksheet.getCell("B14").numFmt = "0.0%";
  worksheet.getCell("C14").value = "CAPPED THRESHOLD %";
  worksheet.getCell("D14").value = data.assetScheduleSheet.file_summary.capped_threshold_percent;
  worksheet.getCell("D14").numFmt = "0.0%";
  for (const address of ["A13", "A14", "C14"]) {
    worksheet.getCell(address).font = { name: BODY_FONT, bold: true, size: 8, color: { argb: COLORS.muted } };
  }
  worksheet.getCell("B13").font = { name: BODY_FONT, bold: true, size: 11, color: { argb: COLORS.teal } };
  worksheet.getCell("B14").font = { name: BODY_FONT, bold: true, size: 10, color: { argb: COLORS.ink } };
  worksheet.getCell("D14").font = { name: BODY_FONT, bold: true, size: 10, color: { argb: COLORS.ink } };

  styleSectionBand(worksheet, 16, 1, 8, "Risk profile", COLORS.ink);
  const riskRange = detailRange(layout, "riskBucket");
  const averageRange = detailRange(layout, "appraiserAverage");
  const scoreRange = detailRange(layout, "riskScore");
  const riskFormula = (bucket: string) =>
    riskRange && averageRange
      ? `IFERROR(SUMIF(${riskRange},"${bucket}",${averageRange})/$D$7,0)`
      : "0";
  setKpiPair(worksheet, "A17", "B17", "Low Risk Value", data.summary.low_risk_percent || 0, {
    formula: riskFormula("Low"),
    numFmt: "0.0%",
    accent: "teal",
  });
  setKpiPair(worksheet, "C17", "D17", "Medium Risk Value", data.summary.medium_risk_percent || 0, {
    formula: riskFormula("Medium"),
    numFmt: "0.0%",
    accent: "amber",
  });
  setKpiPair(worksheet, "E17", "F17", "High Risk Value", data.summary.high_risk_percent || 0, {
    formula: riskFormula("High"),
    numFmt: "0.0%",
    accent: "amber",
  });
  setKpiPair(worksheet, "G17", "H17", "Weighted Risk Score", data.summary.weighted_average_risk_score, {
    formula:
      averageRange && scoreRange
        ? `IFERROR(SUMPRODUCT(${averageRange},${scoreRange})/$D$7,2)`
        : "2",
    numFmt: "0.00",
  });

  const calculationDescriptions = new Map(
    data.calculations.map((calculation) => [calculation.key, calculation.formula])
  );
  const uncappedStart = 23;
  const cappedStart = 23;
  const uncappedKeys = [
    "uncapped.get",
    "uncapped.costs",
    "uncapped.get_after_costs",
    "uncapped.adjusted_get",
    "uncapped.bp_15",
    "uncapped.potential_get",
    "uncapped.adjusted_potential_get",
    "uncapped.potential_bp_15",
    "uncapped.offer1_cash_offer",
    "uncapped.offer1_total_costs",
    "uncapped.offer1_mcd_take",
    "uncapped.offer1_roi",
    "uncapped.offer1_risk",
    "uncapped.offer2_nmg",
    "uncapped.offer2_threshold",
    "uncapped.offer2_upper_value",
    "uncapped.offer2_total_costs",
    "uncapped.offer2_aquajets_take",
    "uncapped.offer2_overage",
    "uncapped.offer2_mcd_take",
    "uncapped.offer2_roi",
    "uncapped.offer2_risk",
    "uncapped.aquajets_potential_take",
    "uncapped.mcd_potential_take",
    "uncapped.potential_roi",
    "uncapped.offer3_mcd_take",
  ] as const;
  const cappedKeys = [
    "capped.avg",
    "capped.high",
    "capped.low",
    "capped.bp",
    "capped.sale_total_inc_bp",
    "capped.ads",
    "capped.svr",
    "capped.refurb",
    "capped.total_cost",
    "capped.nmg",
    "capped.threshold",
    "capped.risk",
  ] as const;
  const calculationMap = new Map(data.calculations.map((item) => [item.key, item]));
  const uncappedCell = new Map(
    uncappedKeys.map((key, index) => [key, `D${uncappedStart + index}`])
  );
  const cappedCell = new Map(
    cappedKeys.map((key, index) => [key, `H${cappedStart + index}`])
  );
  const u = (key: (typeof uncappedKeys)[number]) => uncappedCell.get(key)!;
  const c = (key: (typeof cappedKeys)[number]) => cappedCell.get(key)!;
  const uncappedFormulas: Record<(typeof uncappedKeys)[number], string> = {
    "uncapped.get": "$D$7+$D$9",
    "uncapped.costs": "$B$9",
    "uncapped.get_after_costs": `${u("uncapped.get")}-${u("uncapped.costs")}`,
    "uncapped.adjusted_get": `${u("uncapped.get_after_costs")}/1.15`,
    "uncapped.bp_15": `${u("uncapped.get")}-${u("uncapped.adjusted_get")}`,
    "uncapped.potential_get": "$H$7+$D$9",
    "uncapped.adjusted_potential_get": `${u("uncapped.potential_get")}/1.15`,
    "uncapped.potential_bp_15": `${u("uncapped.potential_get")}-${u("uncapped.adjusted_potential_get")}`,
    "uncapped.offer1_cash_offer": `${u("uncapped.get")}*90%`,
    "uncapped.offer1_total_costs": `${u("uncapped.offer1_cash_offer")}+${u("uncapped.costs")}`,
    "uncapped.offer1_mcd_take": `${u("uncapped.get")}-${u("uncapped.offer1_total_costs")}`,
    "uncapped.offer1_roi": `IFERROR(${u("uncapped.offer1_mcd_take")}/${u("uncapped.offer1_total_costs")},"")`,
    "uncapped.offer1_risk": `$F$7+$D$9-${u("uncapped.offer1_total_costs")}`,
    "uncapped.offer2_nmg": `${u("uncapped.get")}*$B$14`,
    "uncapped.offer2_threshold": `${u("uncapped.offer2_nmg")}*15%`,
    "uncapped.offer2_upper_value": `${u("uncapped.offer2_nmg")}+${u("uncapped.offer2_threshold")}`,
    "uncapped.offer2_total_costs": `${u("uncapped.offer2_nmg")}+${u("uncapped.costs")}`,
    "uncapped.offer2_aquajets_take": u("uncapped.offer2_nmg"),
    "uncapped.offer2_overage": `${u("uncapped.adjusted_get")}-${u("uncapped.offer2_nmg")}`,
    "uncapped.offer2_mcd_take": `${u("uncapped.bp_15")}-${u("uncapped.costs")}`,
    "uncapped.offer2_roi": `IFERROR(${u("uncapped.offer2_mcd_take")}/${u("uncapped.offer2_total_costs")},"")`,
    "uncapped.offer2_risk": `$F$7+$D$9-${u("uncapped.offer2_total_costs")}`,
    "uncapped.aquajets_potential_take": `${u("uncapped.offer2_nmg")}+(${u("uncapped.adjusted_potential_get")}-${u("uncapped.offer2_upper_value")})*98%`,
    "uncapped.mcd_potential_take": `${u("uncapped.potential_bp_15")}-${u("uncapped.costs")}+${u("uncapped.offer2_threshold")}+(${u("uncapped.adjusted_potential_get")}-${u("uncapped.offer2_upper_value")})*2%`,
    "uncapped.potential_roi": `IFERROR(${u("uncapped.mcd_potential_take")}/${u("uncapped.offer2_total_costs")},"")`,
    "uncapped.offer3_mcd_take": u("uncapped.bp_15"),
  };
  const cappedFormulas: Record<(typeof cappedKeys)[number], string> = {
    "capped.avg": "$D$7",
    "capped.high": "$H$7",
    "capped.low": "$F$7",
    "capped.bp": "$D$9",
    "capped.sale_total_inc_bp": `${c("capped.avg")}+${c("capped.bp")}`,
    "capped.ads": `${c("capped.avg")}*1%`,
    "capped.svr": `${c("capped.avg")}*1%`,
    "capped.refurb": `${c("capped.avg")}*1%`,
    "capped.total_cost": `${c("capped.ads")}+${c("capped.svr")}+${c("capped.refurb")}`,
    "capped.nmg": `${c("capped.avg")}-${c("capped.total_cost")}-${c("capped.threshold")}`,
    "capped.threshold": `${c("capped.avg")}*$D$14`,
    "capped.risk": `IFERROR(1-((${c("capped.total_cost")}+${c("capped.nmg")}-${c("capped.bp")})/${c("capped.avg")}),"")`,
  };

  styleSectionBand(worksheet, 21, 1, 4, "Uncapped scenario", COLORS.blue);
  styleSectionBand(worksheet, 21, 5, 8, "Capped scenario", COLORS.teal);
  for (let index = 0; index < Math.max(uncappedKeys.length, cappedKeys.length); index += 1) {
    const rowNumber = uncappedStart + index;
    const row = worksheet.getRow(rowNumber);
    row.height = 21;
    if (index < uncappedKeys.length) {
      const key = uncappedKeys[index];
      const calculation = calculationMap.get(key)!;
      worksheet.mergeCells(rowNumber, 1, rowNumber, 3);
      worksheet.getCell(rowNumber, 1).value = calculation.label;
      excelFormula(worksheet.getCell(rowNumber, 4), uncappedFormulas[key], calculation.value);
      worksheet.getCell(rowNumber, 4).numFmt = key.endsWith("roi") ? "0.0%" : currency;
      worksheet.getCell(rowNumber, 1).note = calculationDescriptions.get(key) || "";
    }
    if (index < cappedKeys.length) {
      const key = cappedKeys[index];
      const calculation = calculationMap.get(key)!;
      worksheet.mergeCells(rowNumber, 5, rowNumber, 7);
      worksheet.getCell(rowNumber, 5).value = calculation.label;
      excelFormula(worksheet.getCell(rowNumber, 8), cappedFormulas[key], calculation.value);
      worksheet.getCell(rowNumber, 8).numFmt = key === "capped.risk" ? "0.0%" : currency;
      worksheet.getCell(rowNumber, 5).note = calculationDescriptions.get(key) || "";
    }
    for (const start of [1, 5]) {
      const label = worksheet.getCell(rowNumber, start);
      const value = worksheet.getCell(rowNumber, start + 3);
      label.font = { name: BODY_FONT, size: 9, color: { argb: COLORS.ink } };
      label.alignment = { vertical: "middle" };
      label.border = thinBottomBorder();
      value.font = { name: BODY_FONT, bold: true, size: 9, color: { argb: COLORS.ink } };
      value.alignment = { vertical: "middle", horizontal: "right" };
      value.border = thinBottomBorder();
    }
  }

  // Selected outcome formulas reference the detailed scenario schedules above.
  setKpiPair(worksheet, "C13", "D13", "Selected NMG", data.summary.selected_nmg, {
    formula: `IF($B$13="Capped",${c("capped.nmg")},${u("uncapped.offer2_nmg")})`,
    numFmt: currency,
    accent: "teal",
  });
  setKpiPair(worksheet, "E13", "F13", "Cash Purchase Price", data.summary.selected_cash_purchase_price, {
    formula: `IF($B$13="Capped",${c("capped.avg")},${u("uncapped.offer1_cash_offer")})`,
    numFmt: currency,
    accent: "teal",
  });
  setKpiPair(worksheet, "G13", "H13", "Commission Basis", data.summary.selected_commission_basis_value, {
    formula: `IF($B$13="Capped",${c("capped.bp")},${u("uncapped.bp_15")})`,
    numFmt: currency,
    accent: "teal",
  });

  for (let index = 1; index <= 8; index += 1) {
    worksheet.getColumn(index).width = index % 2 === 1 ? 23 : 18;
  }
  worksheet.views = [
    { state: "frozen", ySplit: 5, topLeftCell: "A6", activeCell: "A6", showGridLines: false, zoomScale: 95 },
  ];
  worksheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    paperSize: 9,
    margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  worksheet.headerFooter.oddFooter =
    "&LAsset Insight — Proposal Valuation&CPage &P of &N&RConfidential";
  worksheet.properties.defaultRowHeight = 18;
}

function calculationSection(key: string): string {
  if (key.startsWith("uncapped.")) return "Uncapped scenario";
  if (key.startsWith("capped.")) return "Capped scenario";
  return "Portfolio summary";
}

function formatCalculationInput(value: number | string | null): string {
  if (value === null) return "—";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  return value.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
  });
}

function calculationNumberFormat(key: string, currency: string): string {
  if (
    key.endsWith("_percent") ||
    key.endsWith("_roi") ||
    key === "capped.risk"
  ) {
    return "0.0%";
  }
  if (key === "weighted_average_risk_score") return "0.00";
  return currency;
}

function buildFormulaReferenceSheet(
  worksheet: ExcelJS.Worksheet,
  data: ProposalValuationExcelData
) {
  const currency = currencyFormat(data.currencyCode);
  worksheet.mergeCells("A1:E1");
  const title = worksheet.getCell("A1");
  title.value = "Proposal Valuation — Calculation Reference";
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
  title.font = { name: BODY_FONT, bold: true, size: 17, color: { argb: COLORS.white } };
  title.alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 34;

  worksheet.mergeCells("A3:E3");
  const note = worksheet.getCell("A3");
  note.value = `Calculation contract ${data.calculationVersion}. Current values match the exported PV revision; formulas on the Summary and Detail sheets remain editable and auditable.`;
  note.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blueSoft } };
  note.font = { name: BODY_FONT, italic: true, size: 9, color: { argb: COLORS.blue } };
  note.alignment = { wrapText: true, vertical: "middle" };
  worksheet.getRow(3).height = 28;

  const headerRow = 5;
  const headers = ["Section", "Metric", "Current Value", "Canonical Calculation", "Inputs"];
  worksheet.getRow(headerRow).values = headers;
  worksheet.getRow(headerRow).height = 28;
  worksheet.getRow(headerRow).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.ink } };
    cell.font = { name: BODY_FONT, bold: true, size: 9, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });

  data.calculations.forEach((calculation, index) => {
    const row = worksheet.getRow(headerRow + 1 + index);
    row.values = [
      calculationSection(calculation.key),
      calculation.label,
      calculation.value,
      calculation.formula,
      Object.entries(calculation.inputs)
        .map(([key, value]) => `${key}: ${formatCalculationInput(value)}`)
        .join(" • "),
    ];
    row.height = 30;
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = { name: BODY_FONT, size: 9, color: { argb: COLORS.ink } };
      cell.alignment = {
        vertical: "top",
        horizontal: columnNumber === 3 ? "right" : "left",
        wrapText: columnNumber >= 4,
      };
      cell.border = thinBottomBorder();
      if (index % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.stripe } };
      }
    });
    if (typeof calculation.value === "number") {
      row.getCell(3).numFmt = calculationNumberFormat(calculation.key, currency);
    }
  });

  worksheet.getColumn(1).width = 22;
  worksheet.getColumn(2).width = 30;
  worksheet.getColumn(3).width = 19;
  worksheet.getColumn(4).width = 55;
  worksheet.getColumn(5).width = 55;
  worksheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: 5 },
  };
  worksheet.views = [
    { state: "frozen", ySplit: headerRow, topLeftCell: `A${headerRow + 1}`, activeCell: `A${headerRow + 1}`, showGridLines: false, zoomScale: 90 },
  ];
  worksheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  worksheet.headerFooter.oddFooter =
    "&LAsset Insight — Formula Reference&CPage &P of &N&RConfidential";
}

export function buildProposalValuationWorkbook(
  data: ProposalValuationExcelData
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Asset Insight";
  workbook.company = "Asset Insight";
  workbook.subject = "Proposal Valuation";
  workbook.title = `${data.title} — Proposal Valuation`;
  workbook.description =
    "Server-authoritative Proposal Valuation export with linked evaluator inputs and auditable formulas.";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const summary = workbook.addWorksheet(SUMMARY_SHEET);
  const detail = workbook.addWorksheet(DETAIL_SHEET);
  const formulaReference = workbook.addWorksheet(FORMULA_SHEET);
  const detailLayout = buildValuationDetailSheet(detail, data);
  buildSummarySheet(summary, data, detailLayout);
  buildFormulaReferenceSheet(formulaReference, data);
  workbook.views = [
    {
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
      firstSheet: 0,
      activeTab: 0,
      visibility: "visible",
    },
  ];
  return workbook;
}

function safeFilenamePart(value: unknown): string {
  return asText(value, 160)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
}

export function proposalValuationExcelFilename(
  data: Pick<ProposalValuationExcelData, "reportId" | "title" | "meta">
): string {
  const contract = data.meta.find((item) => item.label === "Contract")?.value;
  const stem =
    safeFilenamePart(contract) ||
    safeFilenamePart(data.title) ||
    safeFilenamePart(data.reportId).slice(-24) ||
    "report";
  return `proposal-valuation-${stem}.xlsx`;
}

export async function createProposalValuationExcelExport(
  data: ProposalValuationExcelData
): Promise<{ buffer: Buffer; filename: string }> {
  const workbook = buildProposalValuationWorkbook(data);
  return {
    buffer: await workbookToBuffer(workbook),
    filename: proposalValuationExcelFilename(data),
  };
}
