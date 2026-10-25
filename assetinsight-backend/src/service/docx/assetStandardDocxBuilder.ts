import fs from "fs/promises";
import path from "path";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  AlignmentType,
  TextRun,
  Table,
  TableOfContents,
  convertInchesToTwip,
  Header,
  Footer,
  PageNumber,
  SectionType,
} from "docx";
import { buildHeaderTable, buildFooterTable, buildFooterTableWithoutPageNumber } from "./builders/header.js";
import { buildAppendixPhotoGallery } from "./builders/appendix.js";
import { buildCover } from "./builders/cover.js";
import { buildTOC } from "./builders/toc.js";
import { buildTransmittalLetter } from "./builders/transmittal.js";
import { buildCertificateOfAppraisal } from "./builders/certificate.js";
import { buildMarketOverview } from "./builders/marketOverview.js";
import { buildAssetLots } from "./builders/assetLots.js";
import { buildPerItemTable } from "./builders/perItemTable.js";
import {
  formatDateUS,
  goldDivider,
  buildKeyValueTable,
} from "./builders/utils.js";
import { getLang, t } from "./builders/i18n.js";

/**
 * Orchestrates the two standard asset-report variants. Shared front matter and
 * document styles are assembled once, while mode selects the primary results
 * builder and also affects labels, title metadata, and TOC entries. Section order,
 * page-number restarts, and the returned Buffer are public output contracts.
 */
export async function generateAssetLotsDocx(reportData: any): Promise<Buffer> {
  return generateStandardDocx(reportData, "asset");
}

export async function generatePerItemDocx(reportData: any): Promise<Buffer> {
  return generateStandardDocx(reportData, "per_item");
}

async function generateStandardDocx(
  reportData: any,
  mode: "asset" | "per_item"
): Promise<Buffer> {
  // Normalize collection inputs at the boundary so every downstream builder sees
  // stable arrays and can preserve the user's reviewed lot/image order.
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const rootImageUrls: string[] = Array.isArray(reportData?.imageUrls)
    ? reportData.imageUrls
    : [];
  const contentWidthTw = convertInchesToTwip(6.5);

  // Branding is optional enrichment. Missing local artwork falls back inside the
  // header/cover builders and must not fail an otherwise valid report.
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }

  // Header table via builder
  const headerTable = buildHeaderTable(
    logoBuffer,
    contentWidthTw,
    (reportData as any)?.user_email
  );
  const footerTable = buildFooterTable(
    contentWidthTw,
    reportData?.appraiser || (reportData as any)?.inspector_name,
    (reportData as any)?.user_email
  );
  const footerTableTOC = buildFooterTableWithoutPageNumber(
    contentWidthTw,
    reportData?.appraiser || (reportData as any)?.inspector_name,
    (reportData as any)?.user_email
  );

  const children: Array<Paragraph | Table | TableOfContents> = [];
  const reportDate = formatDateUS(
    reportData?.createdAt || new Date().toISOString()
  );
  const lang = getLang(reportData);
  const tr = t(lang);

  // Report Summary
  children.push(
    new Paragraph({
      text: tr.reportSummary,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      {
        label: tr.groupingMode,
        value: "Schedule A",
      },
      {
        label: mode === "per_item" ? tr.totalItems : tr.totalLots,
        value: String(lots.length),
      },
      {
        label: tr.totalImages,
        value: String(
          Array.isArray(reportData?.imageUrls) ? reportData.imageUrls.length : 0
        ),
      },
    ])
  );

  // Optional summary text/value
  const totalAppraised =
    (reportData?.total_appraised_value as string) ||
    (reportData?.total_value as string) ||
    (reportData?.analysis?.total_value as string) ||
    undefined;
  children.push(
    new Paragraph({
      text: tr.summaryOfValue,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: totalAppraised ? tr.valueBody(String(totalAppraised)) : tr.noValueBody,
      spacing: { after: 160 },
    })
  );

  // Report Details
  children.push(
    new Paragraph({
      text: tr.reportDetails,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 120, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      { label: tr.clientName, value: String(reportData?.client_name || "") },
      {
        label: tr.effectiveDate,
        value: formatDateUS(reportData?.effective_date) || reportDate || "",
      },
      {
        label: tr.appraisalPurpose,
        value: String(reportData?.appraisal_purpose || ""),
      },
      { label: tr.ownerName, value: String(reportData?.owner_name || "") },
      { label: tr.appraiser, value: String(reportData?.appraiser || "") },
      {
        label: tr.appraisalCompany,
        value: String(reportData?.appraisal_company || ""),
      },
      { label: tr.industry, value: String(reportData?.industry || "") },
      {
        label: tr.inspectionDate,
        value: formatDateUS(reportData?.inspection_date) || "",
      },
      ...(reportData?.contract_no
        ? [{ label: tr.contractNo, value: String(reportData.contract_no) }]
        : []),
    ])
  );

  // This is the primary content-builder branch. Mode also controls result labels,
  // title metadata, and TOC entries assembled elsewhere in this orchestrator.
  if (mode === "per_item") {
    children.push(
      ...(await buildPerItemTable(reportData, rootImageUrls, contentWidthTw))
    );
  } else {
    children.push(
      ...(await buildAssetLots(reportData, rootImageUrls, contentWidthTw))
    );
  }

  // Market Overview + References
  children.push(...(await buildMarketOverview(reportData)));

  // Appendix
  const appendixChildren = await buildAppendixPhotoGallery(
    reportData,
    rootImageUrls,
    contentWidthTw
  );
  children.push(...appendixChildren);

  // Finalize only after async builders have resolved so the children array is in
  // exact reading order before Word computes headings and pagination.
  const doc = new Document({
    creator:
      (reportData?.appraiser as string) ||
      (reportData?.inspector_name as string) ||
      "Asset Insight",
    title:
      (reportData?.title as string) ||
      `Asset Report - ${lots.length} ${mode === "per_item" ? "Items" : "Lots"}`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 26, // ~13pt base body size
            color: "111827", // gray-900
          },
          paragraph: {
            spacing: { line: 276, before: 0, after: 80 }, // slightly tighter
          },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          basedOn: "",
          next: "Normal",
          run: { font: "Calibri", size: 26, color: "111827" },
          paragraph: { spacing: { line: 276, after: 120 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 44, bold: true, color: "111827" }, // ~22pt
          paragraph: { spacing: { before: 180, after: 100 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 36, bold: true, color: "111827" }, // ~18pt
          paragraph: { spacing: { before: 140, after: 80 } },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 52, bold: true, color: "111827" }, // ~26pt
          paragraph: {
            spacing: { before: 160, after: 120 },
            alignment: AlignmentType.CENTER,
          },
        },
        {
          id: "BodyLarge",
          name: "Body Large",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 26, color: "111827" },
          paragraph: {
            spacing: { line: 276, before: 0, after: 80 },
          },
        },
      ],
    },
    // Front-matter sections remain isolated from the numbered main body. Their
    // order is cover -> transmittal -> TOC -> certificate -> report content.
    sections: [
      // Cover (no header/footer)
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: [
          await buildCover(reportData, logoBuffer, contentWidthTw, tr.assetReport),
        ],
      },
      // Transmittal Letter (page numbering starts here)
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
            pageNumbers: { start: 1 },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: { default: new Footer({ children: [footerTable] }) },
        children: buildTransmittalLetter(reportData, reportDate),
      },
      // Table of Contents
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: { default: new Footer({ children: [footerTableTOC] }) },
        children: buildTOC({ ...reportData, grouping_mode: mode }, true, contentWidthTw),
      },
      // Certificate of Appraisal
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            margin: {
              top: convertInchesToTwip(1.2),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: { default: new Footer({ children: [footerTable] }) },
        children: await buildCertificateOfAppraisal(
          reportData,
          contentWidthTw,
          reportDate
        ),
      },
      // Main content (with header/footer)
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: {
          default: new Header({ children: [headerTable] }),
        },
        footers: {
          default: new Footer({ children: [footerTable] }),
        },
        children,
      },
    ],
  });

  // Packing is the service boundary; controllers/workers receive a complete DOCX.
  const buf = await Packer.toBuffer(doc);
  return buf;
}
