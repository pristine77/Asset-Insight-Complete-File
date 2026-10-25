/**
 * Builds the Auctioneer condition-report DOCX from normalized report data and template
 * assets. The builder preserves established field aliases and layout conventions so
 * regenerated documents remain compatible with historical reports and downstream
 * office tooling.
 */
import fs from "fs/promises";
import path from "path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import {
  buildAuctioneerSpecRows,
  deriveAuctioneerSerial,
  stripRedundantSerialLabel,
  shouldDisplayAuctioneerSpecRow,
} from "../utils/auctioneerSpecRows.js";
import {
  isLotDamageAnalysisEligible,
  resolveDamageAnalysisEnabled,
} from "../utils/lotDamagePolicy.js";
import { buildCrDisclaimersHtmlForLot } from "../utils/crDisclaimers.js";
import { resolveCrLotDescription } from "../utils/crLotDescription.js";
import { stripLeadingDescriptionMarker } from "../utils/previewLotNormalization.js";
import {
  DAMAGE_ANALYSIS_LABEL,
  formatDamageAnalysisLines,
} from "../utils/assetDamageAnalysis.js";
import { selectCrSummaryImages } from "../utils/crLotImageOrder.js";
import { fetchImageBuffer, prefetchImages, clearImageCache } from "./docx/builders/utils.js";
import sharp from "sharp";

const CONTENT_WIDTH = 9360;
const EMPTY_BORDER = { style: BorderStyle.SINGLE, size: 1, color: "FFFFFF" };
const LIGHT_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D7DDE8" };
const DARK = "111827";
const SOFT = "F3F6FB";
const RED = "B91C1C";
const DOCX_PAGE_WIDTH_DXA = 12240;
const DOCX_PAGE_HEIGHT_DXA = 15840;
const DOCX_PAGE_MARGIN_DXA = 520;
const BANK_PHOTO_PAGE_WIDTH_DXA = DOCX_PAGE_WIDTH_DXA - DOCX_PAGE_MARGIN_DXA * 2;
const BANK_PHOTO_PAGE_HEIGHT_DXA = DOCX_PAGE_HEIGHT_DXA - DOCX_PAGE_MARGIN_DXA * 2;
const BANK_PHOTO_COLUMNS = 2;
const BANK_PHOTOS_PER_PAGE = 8;
const BANK_PHOTO_COLUMN_WIDTH_DXA = Math.floor(BANK_PHOTO_PAGE_WIDTH_DXA / BANK_PHOTO_COLUMNS);
const BANK_PHOTO_CELL_MARGINS = { top: 4, bottom: 4, left: 4, right: 4 };

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function cleanDisplayText(value: unknown): string {
  const text = stripLeadingDescriptionMarker(value);
  if (!text) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !/title clearance clarification fee|applied to your invoice|over and above the purchase price|applicable taxes|following the close of the sale/i.test(
          part
        )
    )
    .join(" ");
}

function asDate(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function resolveLotNumber(lot: any, index: number): string {
  return cleanText(lot?.lot_number || lot?.lot_id || lot?.lot || lot?.id) || String(index + 1);
}

function titleFromLot(lot: any, fallback: string): string {
  const explicit = cleanText(lot?.title || lot?.asset_title || lot?.name);
  if (explicit) return explicit;
  const firstDescription = cleanDisplayText(lot?.description).split(",")[0]?.trim();
  return firstDescription || fallback;
}

function resolveCategory(lot: any): string {
  return cleanText(lot?.categories || lot?.category || lot?.child_category || lot?.asset_category);
}

function resolveLotImages(reportData: any, lot: any): string[] {
  const imageUrls = Array.isArray(reportData?.imageUrls) ? reportData.imageUrls : [];
  const indexes = [
    ...(Array.isArray(lot?.image_indexes) ? lot.image_indexes : []),
    ...(Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []),
  ];
  const fromIndexes = indexes
    .map((index) => {
      const numeric = Number(index);
      return Number.isInteger(numeric) && numeric >= 0 ? imageUrls[numeric] : "";
    })
    .filter(Boolean);
  const direct = [
    lot?.image_url,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ].filter(Boolean);
  return Array.from(new Set([...direct, ...fromIndexes].map(cleanText).filter(Boolean)));
}

function hasBankPhotoPages(reportData: any, lot: any): boolean {
  return reportData?.bank_photos_enabled === true || lot?.bank_photos_enabled === true;
}

function resolveRenderedLotImages(reportData: any, lot: any): string[] {
  const images = resolveLotImages(reportData, lot);
  // The summary table embeds one hero and four thumbnails. Fetching the rest
  // only adds memory and latency unless bank-photo pages are enabled.
  return hasBankPhotoPages(reportData, lot)
    ? images
    : selectCrSummaryImages(images);
}

function buildFieldRows(lot: any): Array<{ field: string; value: string }> {
  return buildAuctioneerSpecRows(lot, {
    conditionText: [lot?.description, lot?.details].filter(Boolean).join(", "),
    category: lot?.categories,
    includeMissing: false,
  })
    .filter((row) => !!cleanText(row.value) && shouldDisplayAuctioneerSpecRow(row))
    .map((row) => ({ field: row.field, value: row.value || "" }));
}

function splitColumns<T>(items: T[]): [T[], T[]] {
  const midpoint = Math.ceil(items.length / 2);
  return [items.slice(0, midpoint), items.slice(midpoint)];
}

function para(text = "", options: any = {}): Paragraph {
  const lines = String(text).split(/\r?\n/);
  return new Paragraph({
    children: lines.map(
      (line, index) => new TextRun({
        text: line,
        break: index > 0 ? 1 : undefined,
        size: options.size ?? 19,
        bold: options.bold,
        color: options.color,
      })
    ),
    alignment: options.alignment,
    heading: options.heading,
    spacing: options.spacing ?? { after: 80 },
  });
}

function cell(children: any[], options: any = {}): TableCell {
  return new TableCell({
    width: options.width,
    shading: options.shading,
    verticalAlign: options.verticalAlign,
    columnSpan: options.columnSpan,
    margins: options.margins || { top: 80, bottom: 80, left: 100, right: 100 },
    borders: {
      top: options.border || LIGHT_BORDER,
      bottom: options.border || LIGHT_BORDER,
      left: options.border || LIGHT_BORDER,
      right: options.border || LIGHT_BORDER,
    },
    children,
  });
}

function noBorderCell(children: any[], options: any = {}): TableCell {
  return cell(children, {
    ...options,
    border: EMPTY_BORDER,
  });
}

function keyValueTable(rows: Array<{ label: string; value?: string }>, width = CONTENT_WIDTH): Table {
  return new Table({
    width: { size: width, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [Math.round(width * 0.26), Math.round(width * 0.74)],
    borders: {
      top: LIGHT_BORDER,
      bottom: LIGHT_BORDER,
      left: LIGHT_BORDER,
      right: LIGHT_BORDER,
      insideHorizontal: LIGHT_BORDER,
      insideVertical: LIGHT_BORDER,
    },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: [
            cell([para(row.label, { bold: true, size: 17, color: "172033", spacing: { after: 0 } })], {
              width: { size: Math.round(width * 0.26), type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: SOFT },
            }),
            cell([para(row.value || "", { size: 17, spacing: { after: 0 } })], {
              width: { size: Math.round(width * 0.74), type: WidthType.DXA },
            }),
          ],
        })
    ),
  });
}

function specGridTable(rows: Array<{ field: string; value: string }>, category: string): Table {
  const [leftRows, rightRows] = splitColumns(rows);
  const maxRows = Math.max(leftRows.length, rightRows.length, 1);
  const tableRows: TableRow[] = [
    new TableRow({
      children: [
        cell([para("CATEGORY DETAILS", { bold: true, color: "FFFFFF", size: 19, spacing: { after: 0 } })], {
          columnSpan: 2,
          shading: { type: ShadingType.CLEAR, fill: DARK },
          border: { style: BorderStyle.SINGLE, size: 6, color: DARK },
        }),
        cell([para(category, { color: "FFFFFF", size: 16, alignment: AlignmentType.RIGHT, spacing: { after: 0 } })], {
          columnSpan: 2,
          shading: { type: ShadingType.CLEAR, fill: DARK },
          border: { style: BorderStyle.SINGLE, size: 6, color: DARK },
        }),
      ],
    }),
  ];

  for (let index = 0; index < maxRows; index += 1) {
    const left = leftRows[index];
    const right = rightRows[index];
    tableRows.push(
      new TableRow({
        children: [
          cell([para(left?.field || "", { bold: true, size: 15, spacing: { after: 0 } })], {
            width: { size: 2250, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: "FBFCFE" },
          }),
          cell([para(left?.value || "", { size: 15, spacing: { after: 0 } })], {
            width: { size: 2430, type: WidthType.DXA },
          }),
          cell([para(right?.field || "", { bold: true, size: 15, spacing: { after: 0 } })], {
            width: { size: 2250, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: "FBFCFE" },
          }),
          cell([para(right?.value || "", { size: 15, spacing: { after: 0 } })], {
            width: { size: 2430, type: WidthType.DXA },
          }),
        ],
      })
    );
  }

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [2250, 2430, 2250, 2430],
    borders: {
      top: LIGHT_BORDER,
      bottom: LIGHT_BORDER,
      left: LIGHT_BORDER,
      right: LIGHT_BORDER,
      insideHorizontal: LIGHT_BORDER,
      insideVertical: LIGHT_BORDER,
    },
    rows:
      rows.length > 0
        ? tableRows
        : [
            new TableRow({
              children: [
                cell([para("CATEGORY DETAILS", { bold: true, color: "FFFFFF", size: 19, spacing: { after: 0 } })], {
                  columnSpan: 4,
                  shading: { type: ShadingType.CLEAR, fill: DARK },
                  border: { style: BorderStyle.SINGLE, size: 6, color: DARK },
                }),
              ],
            }),
            new TableRow({
              children: [
                cell([para("No category details available", { size: 16, spacing: { after: 0 } })], {
                  columnSpan: 4,
                }),
              ],
            }),
          ],
  });
}

async function loadLogoBuffer(): Promise<Buffer | null> {
  const candidates = [
    path.resolve(process.cwd(), "public/logoNobg.png"),
    path.resolve(process.cwd(), "public/logo.jpg"),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate);
    } catch {}
  }
  return null;
}

async function imageParagraph(
  url: string,
  maxWidth: number,
  maxHeight: number,
  fallback: string,
  options: any = {}
): Promise<Paragraph> {
  const buffer = await fetchImageBuffer(url);
  if (!buffer) return para(fallback, { size: 16, color: "64748B" });
  const image = await containImageForDocx(buffer, maxWidth, maxHeight);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: options.spacing || { after: 80 },
    children: [
      new ImageRun({
        data: image.data as any,
        transformation: { width: image.width, height: image.height },
      } as any),
    ],
  });
}

async function containImageForDocx(
  buffer: Buffer,
  maxWidth: number,
  maxHeight: number
): Promise<{ data: Buffer; width: number; height: number }> {
  const boxWidth = Math.max(1, Math.round(maxWidth));
  const boxHeight = Math.max(1, Math.round(maxHeight));

  try {
    const fitted = await fitImageInside(buffer, boxWidth, boxHeight);
    const data = await sharp(buffer)
      .rotate()
      .resize({
        width: fitted.width * 2,
        height: fitted.height * 2,
        fit: "inside",
        withoutEnlargement: false,
      })
      .jpeg({ quality: 88 })
      .toBuffer();

    return { data, width: fitted.width, height: fitted.height };
  } catch {
    const fitted = await fitImageInside(buffer, boxWidth, boxHeight);
    return { data: buffer, width: fitted.width, height: fitted.height };
  }
}

async function fitImageInside(
  buffer: Buffer,
  maxWidth: number,
  maxHeight: number
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(buffer).metadata();
    const rotated = [5, 6, 7, 8].includes(Number(metadata.orientation || 0));
    const sourceWidth = Number(rotated ? metadata.height : metadata.width) || maxWidth;
    const sourceHeight = Number(rotated ? metadata.width : metadata.height) || maxHeight;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
    if (!Number.isFinite(scale) || scale <= 0) return { width: maxWidth, height: maxHeight };
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  } catch {
    return { width: maxWidth, height: maxHeight };
  }
}

const SUMMARY_WIDTH = 6100;
const PHOTO_PANEL_WIDTH = CONTENT_WIDTH - SUMMARY_WIDTH;

function dxaToImagePx(widthDxa: number, horizontalMarginsDxa = 0): number {
  return Math.max(1, Math.floor((widthDxa - horizontalMarginsDxa) / 15));
}

async function buildPhotoPanel(images: string[], panelWidth = PHOTO_PANEL_WIDTH): Promise<Table> {
  const thumbnailColumns = 4;
  const thumbColumnWidth = Math.floor(panelWidth / thumbnailColumns);
  const mainCellMargins = { top: 45, bottom: 45, left: 45, right: 45 };
  const thumbCellMargins = { top: 24, bottom: 24, left: 24, right: 24 };
  const mainMaxWidth = dxaToImagePx(panelWidth, mainCellMargins.left + mainCellMargins.right + 80);
  const thumbMaxWidth = dxaToImagePx(thumbColumnWidth, thumbCellMargins.left + thumbCellMargins.right + 20);

  const main = images[0]
    ? await imageParagraph(images[0], mainMaxWidth, 190, "Primary image unavailable", { spacing: { after: 0 } })
    : para("No lot images available", { size: 16, color: "64748B", alignment: AlignmentType.CENTER });
  const thumbs = images.slice(1, 5);
  const thumbCells: TableCell[] = [];

  for (let index = 0; index < 4; index += 1) {
    const url = thumbs[index];
    thumbCells.push(
      cell(
        [
          url
            ? await imageParagraph(url, thumbMaxWidth, 46, "", { spacing: { after: 0 } })
            : para("", { spacing: { after: 0 } }),
        ],
        {
          width: { size: thumbColumnWidth, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "F8FAFC" },
          margins: thumbCellMargins,
        }
      )
    );
  }

  return new Table({
    width: { size: panelWidth, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [thumbColumnWidth, thumbColumnWidth, thumbColumnWidth, thumbColumnWidth],
    borders: {
      top: LIGHT_BORDER,
      bottom: LIGHT_BORDER,
      left: LIGHT_BORDER,
      right: LIGHT_BORDER,
      insideHorizontal: LIGHT_BORDER,
      insideVertical: LIGHT_BORDER,
    },
    rows: [
      new TableRow({
        children: [
          cell([main], {
            columnSpan: 4,
            shading: { type: ShadingType.CLEAR, fill: "F8FAFC" },
            verticalAlign: VerticalAlign.CENTER,
            margins: mainCellMargins,
          }),
        ],
      }),
      new TableRow({ children: thumbCells }),
    ],
  });
}

async function buildSummaryAndPhotosTable(rows: Array<{ label: string; value?: string }>, images: string[]): Promise<Table> {
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [SUMMARY_WIDTH, PHOTO_PANEL_WIDTH],
    borders: {
      top: EMPTY_BORDER,
      bottom: EMPTY_BORDER,
      left: EMPTY_BORDER,
      right: EMPTY_BORDER,
      insideHorizontal: EMPTY_BORDER,
      insideVertical: EMPTY_BORDER,
    },
    rows: [
      new TableRow({
        children: [
          noBorderCell([keyValueTable(rows, SUMMARY_WIDTH - 100) as any], {
            width: { size: SUMMARY_WIDTH, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
          }),
          noBorderCell([await buildPhotoPanel(images, PHOTO_PANEL_WIDTH) as any], {
            width: { size: PHOTO_PANEL_WIDTH, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
          }),
        ],
      }),
    ],
  });
}

type CrDocxBlock =
  | { type: "rule" }
  | { type: "paragraph"; html: string; alignment?: (typeof AlignmentType)[keyof typeof AlignmentType] }
  | { type: "heading"; html: string; level: 1 | 2 | 3; alignment?: (typeof AlignmentType)[keyof typeof AlignmentType] }
  | { type: "bullet"; html: string }
  | { type: "numbered"; html: string };

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function inlineRunsFromHtml(html: string): TextRun[] {
  const runs: TextRun[] = [];
  const stack: Array<"bold" | "italic" | "underline" | "strike"> = [];
  const tokens = html.split(/(<\/?(?:b|strong|i|em|u|s|strike|br)\b[^>]*>)/gi);

  const pushText = (value: string) => {
    const text = decodeHtmlEntities(value.replace(/<[^>]*>/g, ""));
    if (!text) return;
    runs.push(
      new TextRun({
        text,
        size: 16,
        bold: stack.includes("bold"),
        italics: stack.includes("italic"),
        underline: stack.includes("underline") ? {} : undefined,
        strike: stack.includes("strike"),
      })
    );
  };

  for (const token of tokens) {
    if (!token) continue;
    const tag = token.match(/^<\s*(\/?)\s*(b|strong|i|em|u|s|strike|br)\b/i);
    if (!tag) {
      pushText(token);
      continue;
    }
    const closing = Boolean(tag[1]);
    const name = tag[2].toLowerCase();
    if (name === "br") {
      runs.push(new TextRun({ break: 1 }));
      continue;
    }
    const mark =
      name === "b" || name === "strong"
        ? "bold"
        : name === "i" || name === "em"
          ? "italic"
          : name === "u"
            ? "underline"
            : "strike";
    if (closing) {
      const index = stack.lastIndexOf(mark);
      if (index >= 0) stack.splice(index, 1);
    } else {
      stack.push(mark);
    }
  }

  return runs.length ? runs : [new TextRun({ text: "", size: 16 })];
}

function stripContainerTags(html: string): string {
  return html
    .replace(/^<h[1-3]\b[^>]*>/i, "")
    .replace(/<\/h[1-3]>$/i, "")
    .replace(/^<p\b[^>]*>/i, "")
    .replace(/<\/p>$/i, "")
    .replace(/^<li\b[^>]*>/i, "")
    .replace(/<\/li>$/i, "")
    .replace(/^<p\b[^>]*>/i, "")
    .replace(/<\/p>$/i, "")
    .trim();
}

function paragraphAlignmentFromHtml(html: string): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const match =
    html.match(/text-align\s*:\s*(left|center|right|justify)\b/i) ||
    html.match(/\balign\s*=\s*["']?(left|center|right|justify)\b/i);
  const value = match?.[1]?.toLowerCase();
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  if (value === "left") return AlignmentType.LEFT;
  return undefined;
}

function disclaimerDocxBlocks(html: string): CrDocxBlock[] {
  const out: CrDocxBlock[] = [];
  if (!html) return out;

  const tokens = html.match(/<hr\s*\/?>|<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>|<p\b[^>]*>[\s\S]*?<\/p>|<ul\b[^>]*>[\s\S]*?<\/ul>|<ol\b[^>]*>[\s\S]*?<\/ol>/gi) || [];
  for (const item of tokens) {
    if (/^<hr/i.test(item)) {
      out.push({ type: "rule" });
      continue;
    }
    if (/^<ul/i.test(item) || /^<ol/i.test(item)) {
      const type = /^<ol/i.test(item) ? "numbered" : "bullet";
      const items = item.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
      for (const listItem of items) {
        const content = stripContainerTags(listItem);
        if (decodeHtmlEntities(content.replace(/<[^>]*>/g, "")).trim()) {
          out.push({ type, html: content } as CrDocxBlock);
        }
      }
      continue;
    }
    if (/^<h[1-3]/i.test(item)) {
      const level = Number(item.match(/^<h([1-3])/i)?.[1] || 2) as 1 | 2 | 3;
      const content = stripContainerTags(item);
      if (decodeHtmlEntities(content.replace(/<[^>]*>/g, "")).trim()) {
        out.push({ type: "heading", level, html: content, alignment: paragraphAlignmentFromHtml(item) });
      }
      continue;
    }
    const content = stripContainerTags(item);
    if (decodeHtmlEntities(content.replace(/<[^>]*>/g, "")).trim()) {
      out.push({ type: "paragraph", html: content, alignment: paragraphAlignmentFromHtml(item) });
    }
  }
  return out;
}

async function buildHeader(logoBuffer: Buffer | null, lotNumber: string): Promise<Table> {
  const logoPara = new Paragraph({
    spacing: { after: 80 },
    children: logoBuffer
      ? [
          new ImageRun({
            data: logoBuffer as any,
            transformation: { width: 275, height: 82 },
          } as any),
        ]
      : [new TextRun({ text: "McDougall Auctioneers", bold: true, size: 34 })],
  });

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [6200, 3160],
    borders: {
      top: EMPTY_BORDER,
      bottom: { style: BorderStyle.SINGLE, size: 18, color: "172033" },
      left: EMPTY_BORDER,
      right: EMPTY_BORDER,
      insideHorizontal: EMPTY_BORDER,
      insideVertical: EMPTY_BORDER,
    },
    rows: [
      new TableRow({
        children: [
          noBorderCell([
            logoPara,
            para(`Lot # ${lotNumber}`, { bold: true, size: 32, color: "0F172A", spacing: { after: 120 } }),
          ]),
          cell(
            [
              para("1-800-263-4193", { size: 17, spacing: { after: 40 } }),
              para("Remarketing@mcdauction.com", { size: 17, spacing: { after: 40 } }),
              para("www.McDougallAuction.com", { size: 17, spacing: { after: 0 } }),
            ],
            { width: { size: 3160, type: WidthType.DXA } }
          ),
        ],
      }),
    ],
  });
}

async function buildLotChildren(reportData: any, lot: any, index: number, logoBuffer: Buffer | null): Promise<any[]> {
  const lotNumber = resolveLotNumber(lot, index);
  const title = titleFromLot(lot, `Lot ${lotNumber}`);
  const category = resolveCategory(lot);
  const serial = stripRedundantSerialLabel("Serial Number", deriveAuctioneerSerial(lot));
  const contractNo = cleanText(reportData?.contract_no || reportData?.contract_number);
  const customer = cleanText(reportData?.prepared_for || reportData?.client_name || reportData?.owner_name);
  const contractDate = asDate(reportData?.sales_date || reportData?.effective_date || reportData?.inspection_date);
  const description = resolveCrLotDescription(lot, title);
  const damageLines =
    !resolveDamageAnalysisEnabled(reportData?.include_damage_analysis, true) ||
    !isLotDamageAnalysisEligible(lotNumber)
      ? []
      : formatDamageAnalysisLines(lot?.damage_analysis);
  const allImages = resolveLotImages(reportData, lot);
  const summaryImages = selectCrSummaryImages(allImages);
  const rows = buildFieldRows(lot);
  const bankPhotosEnabled = hasBankPhotoPages(reportData, lot);
  const disclaimersHtml = buildCrDisclaimersHtmlForLot(reportData, lot, index);

  const children: any[] = [
    await buildHeader(logoBuffer, lotNumber),
    para("", { spacing: { after: 120 } }),
    await buildSummaryAndPhotosTable([
      { label: "Contract", value: contractNo },
      { label: "Contract Date", value: contractDate },
      { label: "Customer", value: customer },
      { label: "Category", value: category },
      { label: "Serial Number", value: serial },
      { label: "Description", value: description },
    ], summaryImages),
    para("", { spacing: { after: 120 } }),
  ];

  children.push(specGridTable(rows, category));

  if (damageLines.length > 0) {
    children.push(
      para("", { spacing: { after: 100 } }),
      new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
          left: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
          right: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
          insideVertical: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
        },
        rows: [
          new TableRow({
            children: [
              cell(
                [
                  para(DAMAGE_ANALYSIS_LABEL, { bold: true, color: RED, size: 18, spacing: { after: 50 } }),
                  ...damageLines.map((line, lineIndex) =>
                    para(line, { size: 17, spacing: { after: lineIndex === damageLines.length - 1 ? 0 : 50 } })
                  ),
                ],
                {
                  shading: { type: ShadingType.CLEAR, fill: "FFF7F7" },
                  border: { style: BorderStyle.SINGLE, size: 6, color: "FCA5A5" },
                }
              ),
            ],
          }),
        ],
      })
    );
  }

  const disclaimerBlocks = disclaimerDocxBlocks(disclaimersHtml);
  if (disclaimerBlocks.length > 0) {
    children.push(para("CR NOTES", { bold: true, size: 18, spacing: { before: 160, after: 60 } }));
    for (const block of disclaimerBlocks) {
      if (block.type === "rule") {
        children.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: "CBD5E1" } },
            spacing: { before: 80, after: 80 },
          })
        );
      } else if (block.type === "heading") {
        children.push(
          new Paragraph({
            children: inlineRunsFromHtml(block.html).map((run) => run),
            alignment: block.alignment,
            spacing: { before: block.level === 1 ? 140 : 90, after: 70 },
            heading: block.level === 1 ? HeadingLevel.HEADING_2 : block.level === 2 ? HeadingLevel.HEADING_3 : undefined,
          })
        );
      } else {
        children.push(
          new Paragraph({
            children: inlineRunsFromHtml(block.html),
            alignment: block.type === "paragraph" ? block.alignment : undefined,
            bullet: block.type === "bullet" ? { level: 0 } : undefined,
            numbering: block.type === "numbered" ? { reference: "cr-notes-numbering", level: 0 } : undefined,
            spacing: { after: 80 },
          })
        );
      }
    }
  }

  if (bankPhotosEnabled && allImages.length > 0) {
    const bankPhotoCell = (content: any[]) =>
      noBorderCell(content, {
        margins: BANK_PHOTO_CELL_MARGINS,
        verticalAlign: VerticalAlign.CENTER,
      });
    const emptyBankPhoto = () =>
      new Paragraph({
        children: [],
        spacing: { before: 0, after: 0 },
      });
    const addBankPhotoPageBreak = () => {
      children.push(new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }));
    };

    for (let pageStart = 0; pageStart < allImages.length; pageStart += BANK_PHOTOS_PER_PAGE) {
      addBankPhotoPageBreak();
      const pageImages = allImages.slice(pageStart, pageStart + BANK_PHOTOS_PER_PAGE);
      const rows: TableRow[] = [];
      const pageRowCount = Math.max(1, Math.ceil(pageImages.length / BANK_PHOTO_COLUMNS));
      const bankPhotoRowHeightDxa = Math.floor(BANK_PHOTO_PAGE_HEIGHT_DXA / pageRowCount);
      const bankPhotoMaxWidth = dxaToImagePx(
        BANK_PHOTO_COLUMN_WIDTH_DXA,
        BANK_PHOTO_CELL_MARGINS.left + BANK_PHOTO_CELL_MARGINS.right + 120
      );
      const bankPhotoMaxHeight = dxaToImagePx(
        bankPhotoRowHeightDxa,
        BANK_PHOTO_CELL_MARGINS.top + BANK_PHOTO_CELL_MARGINS.bottom + 90
      );

      for (let rowStart = 0; rowStart < pageImages.length; rowStart += 2) {
        const leftUrl = pageImages[rowStart];
        const rightUrl = pageImages[rowStart + 1];
        const left = leftUrl
          ? await imageParagraph(
              leftUrl,
              bankPhotoMaxWidth,
              bankPhotoMaxHeight,
              "Image unavailable",
              { spacing: { before: 0, after: 0 } }
            )
          : emptyBankPhoto();
        const right = rightUrl
          ? await imageParagraph(
              rightUrl,
              bankPhotoMaxWidth,
              bankPhotoMaxHeight,
              "Image unavailable",
              { spacing: { before: 0, after: 0 } }
            )
          : emptyBankPhoto();
        rows.push(
          new TableRow({
            cantSplit: true,
            height: { value: bankPhotoRowHeightDxa, rule: HeightRule.EXACT },
            children: [bankPhotoCell([left]), bankPhotoCell([right])],
          })
        );
      }

      children.push(
        new Table({
          width: { size: BANK_PHOTO_PAGE_WIDTH_DXA, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: [BANK_PHOTO_COLUMN_WIDTH_DXA, BANK_PHOTO_COLUMN_WIDTH_DXA],
          borders: {
            top: EMPTY_BORDER,
            bottom: EMPTY_BORDER,
            left: EMPTY_BORDER,
            right: EMPTY_BORDER,
            insideHorizontal: EMPTY_BORDER,
            insideVertical: EMPTY_BORDER,
          },
          rows,
        })
      );
    }
  }

  return children;
}

export async function generateAuctioneerSpecSheetDocxFromReport(reportData: any): Promise<Buffer> {
  const lots = Array.isArray(reportData?.lots) && reportData.lots.length > 0 ? reportData.lots : [{}];
  const allImageUrls = lots.flatMap((lot: any) => resolveRenderedLotImages(reportData, lot));
  const logoBuffer = await loadLogoBuffer();

  await prefetchImages(allImageUrls);

  try {
    const children: any[] = [];
    for (let index = 0; index < lots.length; index += 1) {
      if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(...(await buildLotChildren(reportData, lots[index], index, logoBuffer)));
    }

    const doc = new Document({
      creator: "Asset Insight",
      title: "CR DOCX",
      description: "Editable CR generated from approved preview data",
      numbering: {
        config: [
          {
            reference: "cr-notes-numbering",
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.LEFT,
                style: {
                  paragraph: {
                    indent: { left: 420, hanging: 240 },
                  },
                },
              },
            ],
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              margin: { top: 520, right: 520, bottom: 520, left: 520 },
            },
          },
          children,
        },
      ],
    });

    return await Packer.toBuffer(doc);
  } finally {
    clearImageCache();
  }
}
