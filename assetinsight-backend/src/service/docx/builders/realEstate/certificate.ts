import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  ShadingType,
  ImageRun,
  Bookmark,
} from "docx";
import { goldDivider, formatDateUS } from "../utils.js";
import { generateRealEstateCertificateImage } from "../../../htmlToImage.js";

/**
 * Format currency value with symbol and comma separators
 */
function formatCurrencyValue(value: string | number | undefined, currency: string = "CAD"): string | undefined {
  if (!value) return undefined;
  
  // Parse numeric value
  const numericValue = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]/g, '')) : value;
  
  if (isNaN(numericValue)) return undefined;
  
  // Currency symbols mapping
  const currencySymbols: Record<string, string> = {
    'USD': '$',
    'CAD': 'CA$',
    'EUR': '€',
    'GBP': '£',
    'AUD': 'A$',
    'JPY': '¥',
    'CNY': '¥',
    'INR': '₹',
  };
  
  const symbol = currencySymbols[currency.toUpperCase()] || currency.toUpperCase() + ' ';
  
  // Format with comma separators
  const formattedNumber = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(numericValue);
  
  return `${symbol}${formattedNumber}`;
}

/**
 * Build Real Estate Certificate of Market Value
 * Uses HTML template rendered as image for beautiful formatting
 */
export async function buildRealEstateCertificate(
  reportData: any,
  contentWidthTw: number,
  reportDate: string
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];

  // Page break before certificate
  children.push(
    new Paragraph({
      children: [new Bookmark({ id: "RealEstateCertificate", children: [new TextRun("")] })],
      spacing: { before: 0, after: 0, line: 1 },
    })
  );

  // Extract values
  const marketValue =
    (reportData?.valuation?.fair_market_value as string) ||
    (reportData?.preview_data?.valuation?.fair_market_value as string) ||
    (reportData?.fair_market_value as string) ||
    undefined;

  const currency = reportData?.currency || "CAD";
  const formattedMarketValue = formatCurrencyValue(marketValue, currency);

  const ownerName = reportData?.owner_name || reportData?.preview_data?.owner_name || "";
  const propertyAddress = 
    reportData?.property_details?.address || 
    reportData?.preview_data?.property_details?.address ||
    reportData?.address || "";
  const propertyType = reportData?.property_type || reportData?.preview_data?.property_type || "Real Estate";
  const effectiveDate = formatDateUS(reportData?.effective_date || reportData?.preview_data?.report_dates?.effective_date) || reportDate || "";
  const appraiser = [
    reportData?.inspector_name || reportData?.preview_data?.inspector_name,
    reportData?.inspector_company || reportData?.preview_data?.inspector_company
  ].filter(Boolean).join(", ");

  // Generate beautiful certificate image from HTML
  let certificateImageBuffer: Buffer | null = null;
  try {
    certificateImageBuffer = await generateRealEstateCertificateImage({
      title: "Certificate of Market Value",
      propertyType: propertyType.charAt(0).toUpperCase() + propertyType.slice(1),
      ownerName: ownerName || "—",
      propertyAddress: propertyAddress || "—",
      effectiveDate: effectiveDate || "—",
      appraiser: appraiser || "—",
      marketValue: formattedMarketValue,
      reportDate: reportDate || "",
    });
  } catch (error) {
    console.error("Failed to generate real estate certificate image:", error);
  }

  // If image generation succeeded, use it
  if (certificateImageBuffer) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: certificateImageBuffer as any,
            transformation: {
              width: 595,  // A4 page width in points (8.27" at 72 DPI)
              height: 842, // A4 page height in points (11.69" at 72 DPI)
            },
          } as any),
        ],
        spacing: { before: 0, after: 0 },
      })
    );

    return children;
  }

  // Fallback to text-based certificate if image generation fails
  console.warn("Using fallback text-based real estate certificate");

  const certCellMarginTw = 120;
  const certInnerWidthTw = contentWidthTw - certCellMarginTw * 2;
  const valueBoxWidthTw = Math.round(certInnerWidthTw * 0.75);

  // Certificate border container
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 300 },
      border: {
        top: { style: BorderStyle.DOUBLE, size: 20, color: "DC2626" },
      },
    })
  );

  // Title
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: "CERTIFICATE OF MARKET VALUE",
          bold: true,
          size: 54,
          color: "DC2626",
        }),
      ],
    })
  );

  // Gold underline
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 280 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 12, color: "D4AF37" },
      },
    })
  );

  // Certification statement
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 280, before: 40 },
      children: [
        new TextRun({
          text: "This document certifies that a comprehensive professional real estate appraisal has been conducted in accordance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP).",
          color: "374151",
          size: 24,
        }),
      ],
    })
  );

  // Value box
  if (formattedMarketValue) {
    children.push(
      new Table({
        width: { size: valueBoxWidthTw, type: WidthType.DXA },
        alignment: AlignmentType.CENTER,
        borders: {
          top: { style: BorderStyle.DOUBLE, size: 8, color: "DC2626" },
          bottom: { style: BorderStyle.DOUBLE, size: 8, color: "DC2626" },
          left: { style: BorderStyle.DOUBLE, size: 8, color: "DC2626" },
          right: { style: BorderStyle.DOUBLE, size: 8, color: "DC2626" },
        },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                shading: { type: ShadingType.SOLID, fill: "FEF2F2", color: "auto" },
                margins: { top: 200, bottom: 200, left: 160, right: 160 },
                width: { size: 100, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: "Fair Market Value",
                        size: 22,
                        color: "DC2626",
                        bold: true,
                      }),
                    ],
                    spacing: { after: 120 },
                  }),
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: formattedMarketValue,
                        bold: true,
                        size: 48,
                        color: "DC2626",
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );
  }

  children.push(new Paragraph({ text: "", spacing: { after: 300 } }));

  // Details table
  children.push(
    new Table({
      width: { size: certInnerWidthTw, type: WidthType.DXA },
      alignment: AlignmentType.CENTER,
      layout: TableLayoutType.FIXED,
      columnWidths: [
        Math.round(certInnerWidthTw * 0.35),
        Math.round(certInnerWidthTw * 0.65),
      ],
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" },
        left: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" },
        right: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.SOLID, fill: "FEF2F2", color: "auto" },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Property Owner", bold: true, size: 22, color: "DC2626" })],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: ownerName || "—", size: 22, color: "374151" })],
                }),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.SOLID, fill: "FEF2F2", color: "auto" },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Property Address", bold: true, size: 22, color: "DC2626" })],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: propertyAddress || "—", size: 22, color: "374151" })],
                }),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.SOLID, fill: "FEF2F2", color: "auto" },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Effective Date", bold: true, size: 22, color: "DC2626" })],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: effectiveDate || "—", size: 22, color: "374151" })],
                }),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.SOLID, fill: "FEF2F2", color: "auto" },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Prepared By", bold: true, size: 22, color: "DC2626" })],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: appraiser || "—", size: 22, color: "374151" })],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  children.push(new Paragraph({ text: "", spacing: { after: 300 } }));

  // Signature section
  children.push(
    new Table({
      width: { size: certInnerWidthTw, type: WidthType.DXA },
      alignment: AlignmentType.CENTER,
      layout: TableLayoutType.FIXED,
      columnWidths: [
        Math.round(certInnerWidthTw / 2),
        Math.round(certInnerWidthTw / 2),
      ],
      borders: {
        top: { style: BorderStyle.NONE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE },
        right: { style: BorderStyle.NONE },
        insideHorizontal: { style: BorderStyle.NONE },
        insideVertical: { style: BorderStyle.NONE },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              margins: { top: 160, bottom: 60, left: 100, right: 100 },
              borders: {
                top: { style: BorderStyle.DOUBLE, size: 6, color: "DC2626" },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 100 },
                  children: [
                    new TextRun({
                      text: "Appraiser Signature",
                      color: "6B7280",
                      size: 20,
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 160, bottom: 60, left: 100, right: 100 },
              borders: {
                top: { style: BorderStyle.DOUBLE, size: 6, color: "DC2626" },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 100 },
                  children: [
                    new TextRun({
                      text: `Date: ${reportDate}`,
                      color: "6B7280",
                      size: 20,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  // Bottom border
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 300, after: 0 },
      border: {
        bottom: { style: BorderStyle.DOUBLE, size: 20, color: "DC2626" },
      },
    })
  );

  return children;
}
