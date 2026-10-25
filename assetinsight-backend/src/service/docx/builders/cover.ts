import sharp from "sharp";
import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  WidthType,
  convertInchesToTwip,
} from "docx";
import {
  buildCoverCollage,
  hasExplicitCoverPhotoSelection,
  loadCoverPhotoBuffers,
} from "./coverPhotos.js";
import { formatDateUS } from "./utils.js";

/**
 * Composes the complete cover as one raster image and embeds it in a borderless
 * table. A single image prevents Word from independently reflowing decorative
 * vectors, labels, and photographs across clients or conversion pipelines.
 */
const COVER_WIDTH_PX = 816;
// Leave enough room for Word's mandatory paragraph after the full-width table.
// This prevents the cover collage from being pushed onto an accidental page 2.
const COVER_HEIGHT_PX = 1_028;
const COVER_WIDTH_TW = convertInchesToTwip(8.5);

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

function firstLine(value: unknown, fallback: string): string {
  return (
    String(value ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) || fallback
  );
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitTitle(titleText: string): [string, string] {
  const words = String(titleText || "Appraisal Report")
    .trim()
    .toUpperCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length <= 1) return [words[0] || "APPRAISAL", "REPORT"];
  return [words.slice(0, -1).join(" "), words[words.length - 1]];
}

async function buildFullCoverImage(
  reportData: any,
  logoBuffer: Buffer | null,
  titleText: string,
  heroImageBuffer: Buffer | null
): Promise<Buffer> {
  // Resolve display fallbacks before creating SVG. Escaping below is required
  // because these report fields are injected into XML markup, not plain text.
  const reportDate = formatDateUS(
    reportData?.createdAt || reportData?.report_date
  );
  const effectiveDate =
    formatDateUS(reportData?.effective_date) || reportDate || "Not provided";
  const companyName = firstLine(
    reportData?.client_name ||
      reportData?.prepared_for ||
      reportData?.owner_name,
    "Client"
  );
  const preparedBy = firstLine(
    reportData?.prepared_by ||
      reportData?.preparedBy ||
      reportData?.appraisal_company,
    "McDougall Auctioneers"
  );
  const [titleLineOne, titleLineTwo] = splitTitle(titleText);
  const hasExplicitCoverPhotos = hasExplicitCoverPhotoSelection(reportData);
  const photoBuffers = await loadCoverPhotoBuffers(reportData);
  // A caller-supplied hero is only a fallback; persisted lot/report selections
  // remain authoritative so regenerated covers retain the reviewed imagery.
  if (!hasExplicitCoverPhotos && photoBuffers.length === 0 && heroImageBuffer) {
    photoBuffers.push(heroImageBuffer);
  }
  const collageTop = 482;
  const collage = await buildCoverCollage(
    photoBuffers,
    COVER_WIDTH_PX,
    COVER_HEIGHT_PX - collageTop,
    { repeatPhotos: !hasExplicitCoverPhotos }
  );
  const safeCompany = escapeSvgText(companyName);
  const safePreparedBy = escapeSvgText(preparedBy);
  const safeEffectiveDate = escapeSvgText(effectiveDate);
  const safeTitleLineOne = escapeSvgText(titleLineOne);
  const safeTitleLineTwo = escapeSvgText(titleLineTwo);
  const artwork = Buffer.from(`
    <svg width="${COVER_WIDTH_PX}" height="${COVER_HEIGHT_PX}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${COVER_WIDTH_PX}" height="${COVER_HEIGHT_PX}" fill="#ffffff"/>
      <rect x="0" y="193" width="408" height="13" fill="#ed1c24"/>
      <polygon points="408,193 816,132 816,257 408,199" fill="#ed1c24"/>
      <polygon points="408,199 816,257 816,338 408,402" fill="#9f9699"/>
      <polygon points="408,402 816,338 816,460" fill="#a7a9ac"/>
      <text x="49" y="289" font-family="Times New Roman, serif" font-size="48" font-weight="700" fill="#000000">${safeTitleLineOne}</text>
      <text x="49" y="342" font-family="Times New Roman, serif" font-size="48" font-weight="700" fill="#000000">${safeTitleLineTwo}</text>
      <text x="49" y="414" font-family="Times New Roman, serif" font-size="24" fill="#000000">Effective Date: ${safeEffectiveDate}</text>
      <text x="443" y="285" font-family="Times New Roman, serif" font-size="23" fill="#ffffff">Prepared for ${safeCompany}</text>
      <text x="443" y="320" font-family="Times New Roman, serif" font-size="23" fill="#ffffff">By ${safePreparedBy}</text>
    </svg>
  `);
  const transition = Buffer.from(`
    <svg width="${COVER_WIDTH_PX}" height="${COVER_HEIGHT_PX}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="0,505 816,452 816,477 0,531" fill="#ffffff"/>
    </svg>
  `);
  const composites: sharp.OverlayOptions[] = [
    { input: collage, top: collageTop, left: 0 },
    { input: transition, top: 0, left: 0 },
  ];

  if (logoBuffer) {
    // Fit rather than crop corporate artwork; its aspect ratio is part of the
    // brand contract even when source logo dimensions vary.
    const preparedLogo = await sharp(logoBuffer)
      .resize({ width: 320, height: 96, fit: "inside" })
      .png()
      .toBuffer();
    composites.push({ input: preparedLogo, top: 66, left: 58 });
  } else {
    composites.push({
      input: Buffer.from(`
        <svg width="${COVER_WIDTH_PX}" height="${COVER_HEIGHT_PX}" xmlns="http://www.w3.org/2000/svg">
          <text x="58" y="125" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#111111">McDougall Auctioneers</text>
        </svg>
      `),
      top: 0,
      left: 0,
    });
  }

  return sharp(artwork)
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function buildCover(
  reportData: any,
  logoBuffer: Buffer | null,
  _contentWidthTw: number,
  titleText = "Appraisal Report",
  heroImageBuffer: Buffer | null = null
): Promise<Table> {
  const coverImage = await buildFullCoverImage(
    reportData,
    logoBuffer,
    titleText,
    heroImageBuffer
  );

  // Exact page-size geometry is intentional. Word always appends a paragraph
  // after a table, so COVER_HEIGHT_PX leaves the small budget documented above.
  return new Table({
    width: { size: COVER_WIDTH_TW, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [COVER_WIDTH_TW],
    borders: noBorders(),
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: COVER_WIDTH_TW, type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            borders: noBorders(),
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0, line: 20 },
                children: [
                  new ImageRun({
                    data: coverImage as any,
                    transformation: {
                      width: COVER_WIDTH_PX,
                      height: COVER_HEIGHT_PX,
                    },
                  } as any),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}
