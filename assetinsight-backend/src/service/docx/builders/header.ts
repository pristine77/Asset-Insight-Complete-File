import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

/**
 * Centralizes header/footer geometry for every report builder. Callers supply
 * section-specific printable width; exact DXA columns ensure portrait and
 * landscape sections keep branding, contact details, and page fields aligned.
 */
export interface DocxHeaderFooterOptions {
  monochrome?: boolean;
  compact?: boolean;
  font?: string;
}

function noBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    insideHorizontal: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
    insideVertical: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
  };
}

export function buildHeaderTable(
  logoBuffer: Buffer | null,
  contentWidthTw: number,
  _userEmail?: string | null,
  options: DocxHeaderFooterOptions = {}
): Table {
  const font = options.font || "Times New Roman";

  // Text fallback keeps the document identifiable when the optional logo asset
  // is missing or unreadable; generation should not fail for decoration alone.
  return new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [contentWidthTw],
    borders: noBorders(),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: contentWidthTw, type: WidthType.DXA },
            verticalAlign: VerticalAlign.BOTTOM,
            margins: { top: 0, bottom: 60, left: 0, right: 40 },
            borders: noBorders(),
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { before: 0, after: 0 },
                children: logoBuffer
                  ? [
                      new ImageRun({
                        data: logoBuffer as any,
                        transformation: { width: 120, height: 30 },
                      } as any),
                    ]
                  : [
                      new TextRun({
                        text: "McDougall Auctioneers",
                        font,
                        bold: true,
                        size: 20,
                        color: "000000",
                      }),
                    ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function footerText(
  text: string,
  options: {
    bold?: boolean;
    underline?: boolean;
    font?: string;
  } = {}
): TextRun {
  return new TextRun({
    text,
    font: options.font || "Times New Roman",
    size: 14,
    bold: options.bold,
    underline: options.underline ? {} : undefined,
    color: "111111",
  });
}

function buildFooter(
  contentWidthTw: number,
  _appraiserName?: string | null,
  _appraiserEmail?: string | null,
  options: DocxHeaderFooterOptions = {},
  includePageNumber = true
): Table {
  const font = options.font || "Times New Roman";
  // Reserve a stable page-number column and assign all remaining printable
  // width to contact details. The two widths must always sum to contentWidthTw.
  const pageWidth = 1_120;
  const contactWidth = contentWidthTw - pageWidth;

  return new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [contactWidth, pageWidth],
    borders: noBorders(),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: contactWidth, type: WidthType.DXA },
            verticalAlign: VerticalAlign.BOTTOM,
            margins: { top: 0, bottom: 0, left: 100, right: 20 },
            borders: noBorders(),
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 8, line: 180 },
                children: [
                  footerText(
                    "301 - 15 Great Plains Rd Emerald Park, SK S4L 1C6",
                    { font }
                  ),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0, line: 180 },
                children: [
                  footerText("www.mcdougallauction.com", {
                    font,
                    underline: true,
                  }),
                  footerText(" | ", { font }),
                  footerText("(306) 757-1747", { font }),
                  footerText(" | ", { font }),
                  footerText("remarketing@mcdauction.com", { font }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: pageWidth, type: WidthType.DXA },
            verticalAlign: VerticalAlign.BOTTOM,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            borders: noBorders(),
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { before: 0, after: 0, line: 180 },
                children: includePageNumber
                  ? [
                      footerText("Page ", { font }),
                      new TextRun({
                        children: [PageNumber.CURRENT],
                        font,
                        size: 16,
                        color: "111111",
                      }),
                    ]
                  : [footerText("", { font })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

export function buildFooterTable(
  contentWidthTw: number,
  appraiserName?: string | null,
  appraiserEmail?: string | null,
  options: DocxHeaderFooterOptions = {}
): Table {
  return buildFooter(
    contentWidthTw,
    appraiserName,
    appraiserEmail,
    options,
    true
  );
}

export function buildFooterTableWithoutPageNumber(
  contentWidthTw: number,
  appraiserName?: string | null,
  appraiserEmail?: string | null,
  options: DocxHeaderFooterOptions = {}
): Table {
  // TOC/front-matter sections reuse identical geometry but suppress the visible
  // field so the main report's page-number contract can start independently.
  return buildFooter(
    contentWidthTw,
    appraiserName,
    appraiserEmail,
    options,
    false
  );
}
