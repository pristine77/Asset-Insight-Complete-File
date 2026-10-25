import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  ImageRun,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertInchesToTwip,
} from "docx";
import sharp from "sharp";
import { buildScheduleRows } from "../../assetSchedulePdfService.js";
import { resolveAssetValuationCodes } from "../../../utils/assetValuationSelection.js";
import { fetchImageBuffer } from "./utils.js";

/**
 * Creates the landscape Schedule A table from the same canonical rows used by
 * the PDF service. Sharing normalization prevents DOCX/PDF value or ordering
 * drift; this module owns only Word layout and resilient image embedding.
 */
type ScheduleBlock = Paragraph | Table;

const BLACK = "000000";
const WHITE = "FFFFFF";
const LINE = "6B7280";
const LIGHT_LINE = "D1D5DB";
// `docx` font sizes are half-points. The previous value of 12 produced 6 pt
// text, which was too small to read in a full-page Schedule A printout.
const SCHEDULE_HEADER_FONT_SIZE = 16; // 8 pt
const SCHEDULE_BODY_FONT_SIZE = 18; // 9 pt
const SCHEDULE_SERIAL_FONT_SIZE = 16; // 8 pt keeps common VINs legible in their narrow column.

function border(color = LIGHT_LINE, size = 2) {
  return { style: BorderStyle.SINGLE, size, color };
}

function noBorder() {
  return { style: BorderStyle.NONE, size: 0, color: WHITE };
}

function headerText(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({
        text,
        bold: true,
        color: WHITE,
        size: SCHEDULE_HEADER_FONT_SIZE,
        font: "Times New Roman",
      }),
    ],
  });
}

function bodyText(
  text: string,
  opts?: {
    bold?: boolean;
    alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
    size?: number;
  }
): Paragraph {
  return new Paragraph({
    alignment: opts?.alignment,
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({
        text: text || "",
        bold: opts?.bold,
        size: opts?.size ?? SCHEDULE_BODY_FONT_SIZE,
        font: "Times New Roman",
      }),
    ],
  });
}

function makeHeaderCell(text: string, width: number): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: BLACK },
    borders: {
      top: border(BLACK, 4),
      bottom: border(BLACK, 4),
      left: border(BLACK, 2),
      right: border(BLACK, 2),
    },
    margins: { top: 45, bottom: 45, left: 35, right: 35 },
    verticalAlign: VerticalAlign.CENTER,
    children: [headerText(text)],
  });
}

function makeBodyCell(
  children: Array<Paragraph | Table>,
  width: number,
  opts?: { alignCenter?: boolean; strongBottom?: boolean }
): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: {
      top: noBorder(),
      bottom: border(opts?.strongBottom ? LINE : LIGHT_LINE, opts?.strongBottom ? 4 : 2),
      left: noBorder(),
      right: noBorder(),
    },
    margins: { top: 45, bottom: 45, left: 35, right: 35 },
    verticalAlign: VerticalAlign.TOP,
    children: children.length
      ? children
      : [bodyText("", { alignment: opts?.alignCenter ? AlignmentType.CENTER : undefined })],
  });
}

function fitImageInsideBox(
  metadata: sharp.Metadata,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  // Never upscale evidence images. Preserving aspect ratio avoids distortion,
  // while the fixed bounding box keeps every schedule row within its column.
  const sourceWidth = metadata.width || maxWidth;
  const sourceHeight = metadata.height || maxHeight;
  const ratio = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
  return {
    width: Math.max(1, Math.floor(sourceWidth * ratio)),
    height: Math.max(1, Math.floor(sourceHeight * ratio)),
  };
}

async function buildScheduleImageRun(
  buffer: Buffer,
  maxWidth: number,
  maxHeight: number
): Promise<ImageRun> {
  try {
    const metadata = await sharp(buffer).metadata();
    const size = fitImageInsideBox(metadata, maxWidth, maxHeight);
    return new ImageRun({
      data: buffer as any,
      transformation: size,
    } as any);
  } catch {
    return new ImageRun({
      data: buffer as any,
      transformation: { width: maxWidth, height: maxHeight },
    } as any);
  }
}

async function buildPictureGrid(imageUrls: string[], pictureWidth: number): Promise<Table | Paragraph> {
  // Schedule A intentionally budgets at most two unique images per asset. The
  // capture workflow uses the first photo for the complete asset and the final
  // photo for its serial number, so keep those endpoints of the saved order.
  const uniqueUrls = Array.from(new Set(imageUrls.filter(Boolean)));
  const urls = uniqueUrls.length > 1
    ? [uniqueUrls[0], uniqueUrls[uniqueUrls.length - 1]]
    : uniqueUrls;
  if (urls.length === 0) return bodyText("N/A", { alignment: AlignmentType.LEFT });

  const columnWidth = Math.floor(pictureWidth / 2);
  const tableWidth = columnWidth * 2;
  const maxImageWidth = Math.max(70, Math.floor((columnWidth - 120) / 11));
  const maxImageHeight = 112;

  const cells: TableCell[] = [];
  for (const url of urls) {
    const buffer = await fetchImageBuffer(url);
    const imageRun = buffer ? await buildScheduleImageRun(buffer, maxImageWidth, maxImageHeight) : null;
    cells.push(
      new TableCell({
        width: { size: columnWidth, type: WidthType.DXA },
        borders: { top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder() },
        margins: { top: 20, bottom: 20, left: 20, right: 20 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 0 },
            children: buffer
              ? [imageRun as ImageRun]
              : [new TextRun({ text: "N/A", size: 10, font: "Times New Roman" })],
          }),
        ],
      })
    );
  }

  while (cells.length < 2) {
    cells.push(
      new TableCell({
        width: { size: columnWidth, type: WidthType.DXA },
        borders: { top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder() },
        margins: { top: 20, bottom: 20, left: 20, right: 20 },
        children: [new Paragraph("")],
      })
    );
  }

  return new Table({
    width: { size: tableWidth, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [columnWidth, columnWidth],
    rows: [new TableRow({ children: cells })],
  });
}

export async function buildAssetScheduleSection(
  reportData: any,
  contentWidthTw = convertInchesToTwip(10)
): Promise<ScheduleBlock[]> {
  const scheduleRows = buildScheduleRows(reportData);
  const valuationCodes = resolveAssetValuationCodes(reportData);
  const valuationWidth = Math.round(contentWidthTw * 0.06);
  // Percent-like shares are resolved to DXA once. The picture column absorbs
  // the remainder, guaranteeing the declared column widths equal table width.
  const widths = {
    asset: Math.round(contentWidthTw * 0.06),
    year: Math.round(contentWidthTw * 0.04),
    description: Math.round(contentWidthTw * 0.465) - valuationCodes.length * valuationWidth,
    usage: Math.round(contentWidthTw * 0.055),
    // VINs commonly need a full line at 8 pt; borrow a small amount of width
    // from the picture column rather than splitting the final characters.
    serial: Math.round(contentWidthTw * 0.12),
  };
  const usedWidth =
    widths.asset +
    widths.year +
    widths.description +
    widths.usage +
    widths.serial + valuationCodes.length * valuationWidth;
  const pictureWidth = contentWidthTw - usedWidth;

  const blocks: ScheduleBlock[] = [];
  blocks.push(
    new Paragraph({
      text: "Schedule A",
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { before: 220, after: 90 },
    })
  );

  const tableRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        makeHeaderCell("Asset #", widths.asset),
        makeHeaderCell("Year", widths.year),
        makeHeaderCell("Description", widths.description),
        makeHeaderCell("Usage", widths.usage),
        makeHeaderCell("Serial Number", widths.serial),
        ...valuationCodes.map((code) => makeHeaderCell(code, valuationWidth)),
        makeHeaderCell("Pictures", pictureWidth),
      ],
    }),
  ];

  for (const row of scheduleRows) {
    // Fetch sequentially by schedule row to retain deterministic output order;
    // an unavailable image becomes N/A without invalidating the asset record.
    const pictureGrid = await buildPictureGrid(row.image_urls || (row.image_url ? [row.image_url] : []), pictureWidth);
    tableRows.push(
      new TableRow({
        cantSplit: true,
        children: [
          makeBodyCell([bodyText(row.asset_number || row.lot_number_display)], widths.asset, { strongBottom: true }),
          makeBodyCell([bodyText(row.year, { alignment: AlignmentType.CENTER })], widths.year, { strongBottom: true }),
          // Keep the Description heading; its content is the saved Title.
          makeBodyCell(
            [
              bodyText(row.description || row.title, {
                alignment: AlignmentType.LEFT,
              }),
            ],
            widths.description,
            { strongBottom: true }
          ),
          makeBodyCell([bodyText(row.usage, { alignment: AlignmentType.CENTER })], widths.usage, { strongBottom: true }),
          makeBodyCell([bodyText(row.serial_or_vin, {
            alignment: AlignmentType.CENTER,
            size: SCHEDULE_SERIAL_FONT_SIZE,
          })], widths.serial, { strongBottom: true }),
          ...row.valuations.map(({ value }) => makeBodyCell(
            [bodyText(value, { alignment: AlignmentType.CENTER })], valuationWidth, { strongBottom: true })),
          makeBodyCell([pictureGrid], pictureWidth, { strongBottom: true }),
        ],
      })
    );
  }

  blocks.push(
    new Table({
      width: { size: contentWidthTw, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      columnWidths: [
        widths.asset,
        widths.year,
        widths.description,
        widths.usage,
        widths.serial,
        ...valuationCodes.map(() => valuationWidth),
        pictureWidth,
      ],
      rows: tableRows,
    })
  );

  return blocks;
}
