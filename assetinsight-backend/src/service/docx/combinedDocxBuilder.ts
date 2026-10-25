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
} from "docx";
import { buildHeaderTable } from "./builders/header.js";
import { buildAppendixPhotoGallery } from "./builders/appendix.js";
import { buildCover } from "./builders/cover.js";
import { buildTOC } from "./builders/toc.js";
import { buildTransmittalLetter } from "./builders/transmittal.js";
import { buildCertificateOfAppraisal } from "./builders/certificate.js";
import { buildPerItemTable } from "./builders/perItemTable.js";
import { buildPerPhotoTable } from "./builders/perPhotoTable.js";
import { buildAssetLots } from "./builders/assetLots.js";
import {
  formatDateUS,
  goldDivider,
  buildKeyValueTable,
} from "./builders/utils.js";
import { getLang, t } from "./builders/i18n.js";

/**
 * Combines multiple grouping projections into one report without merging their
 * data semantics. Canonical mode order and section order keep regenerated files,
 * TOC entries, and review workflows deterministic regardless of request order.
 */
export async function generateCombinedDocx(reportData: any): Promise<Buffer> {
  const perItemLots: any[] = Array.isArray(reportData?.combined?.per_item)
    ? reportData.combined.per_item
    : Array.isArray(reportData?.lots)
    ? reportData.lots
    : [];
  const perPhotoLots: any[] = Array.isArray(reportData?.combined?.per_photo)
    ? reportData.combined.per_photo
    : [];
  const singleLotLots: any[] = Array.isArray(reportData?.combined?.single_lot)
    ? reportData.combined.single_lot
    : perItemLots;

  const rootImageUrls: string[] = Array.isArray(reportData?.imageUrls)
    ? reportData.imageUrls
    : [];
  const rawModes: string[] = Array.isArray(reportData?.combined_modes)
    ? reportData.combined_modes
    : ["single_lot", "per_item", "per_photo"];
  // Filter the requested set through canonical presentation order; this matches
  // `buildTOC` and prevents callers from producing a mismatched results sequence.
  const modes = ["single_lot", "per_item", "per_photo"].filter((mode) =>
    rawModes.includes(mode)
  );
  const contentWidthTw = convertInchesToTwip(6.5);

  // Load logo from public
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }

  const headerTable = buildHeaderTable(
    logoBuffer,
    contentWidthTw,
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
        label: tr.mode,
        value:
          "Combined (" +
          [
            modes.includes("single_lot") ? tr.singleLot : null,
            modes.includes("per_item") ? tr.perItem : null,
            modes.includes("per_photo") ? tr.perPhoto : null,
          ]
            .filter(Boolean)
            .join(" + ") +
          ")",
      },
      { label: tr.perItemRows, value: String(perItemLots.length) },
      { label: tr.perPhotoRows, value: String(perPhotoLots.length) },
      { label: tr.singleLotRows, value: String(singleLotLots.length) },
      {
        label: tr.totalImages,
        value: String(rootImageUrls.length),
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
      text: totalAppraised
        ? tr.valueBody(String(totalAppraised))
        : tr.noValueBody,
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
      { label: tr.effectiveDate, value: formatDateUS(reportData?.effective_date) || reportDate || "" },
      { label: tr.appraisalPurpose, value: String(reportData?.appraisal_purpose || "") },
      { label: tr.ownerName, value: String(reportData?.owner_name || "") },
      { label: tr.appraiser, value: String(reportData?.appraiser || "") },
      { label: tr.appraisalCompany, value: String(reportData?.appraisal_company || "") },
      { label: tr.industry, value: String(reportData?.industry || "") },
      { label: tr.inspectionDate, value: formatDateUS(reportData?.inspection_date) || "" },
      ...(reportData?.contract_no ? [{ label: tr.contractNo, value: String(reportData.contract_no) }] : []),
    ])
  );

  // Each projection gets a shallow report wrapper containing only its lot view.
  // This is the grouping boundary: shared metadata is retained, but rows from
  // separate modes must never be flattened into a single builder input.
  const singleLotReport = { ...reportData, lots: singleLotLots };
  if (modes.includes("single_lot")) {
    children.push(
      ...(await buildAssetLots(
        singleLotReport,
        rootImageUrls,
        contentWidthTw,
        tr.singleLotResults
      ))
    );
  }

  const perItemReport = { ...reportData, lots: perItemLots };
  if (modes.includes("per_item")) {
    children.push(
      ...(await buildPerItemTable(
        perItemReport,
        rootImageUrls,
        contentWidthTw,
        tr.perItemResults
      ))
    );
  }

  if (modes.includes("per_photo")) {
    children.push(
      ...(await buildPerPhotoTable(
        perPhotoLots,
        rootImageUrls,
        contentWidthTw,
        tr.perPhotoResults,
        (reportData as any)?.currency
      ))
    );
  }

  // Valuation Comparison Table (if enabled)
  if (reportData?.include_valuation_table && reportData?.valuation_data) {
    const { buildValuationTable } = await import("./builders/valuationTable.js");
    children.push(...(await buildValuationTable(reportData, lang)));
  }

  // Market Overview + References
  // Reuse builder that consumes reportData
  // Note: market builder already tolerates errors
  // and derives industry context from the report contents
  const { buildMarketOverview } = await import("./builders/marketOverview.js");
  children.push(...(await buildMarketOverview(reportData)));

  // Appendix is deliberately assembled once from the original report after all
  // result modes, avoiding duplicate evidence across grouping projections.
  const appendixChildren = await buildAppendixPhotoGallery(
    reportData,
    rootImageUrls,
    contentWidthTw
  );
  children.push(...appendixChildren);

  // Async content is complete before document construction, preserving one
  // deterministic child order for heading discovery and pagination.
  const doc = new Document({
    creator:
      (reportData?.appraiser as string) ||
      (reportData?.inspector_name as string) ||
      "Asset Insight",
    title:
      (reportData?.title as string) || `Asset Report - Combined (${perItemLots.length} Items)`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 26,
            color: "111827",
          },
          paragraph: {
            spacing: { line: 276, before: 0, after: 80 },
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
          run: { size: 44, bold: true, color: "111827" },
          paragraph: { spacing: { before: 180, after: 100 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 36, bold: true, color: "111827" },
          paragraph: { spacing: { before: 140, after: 80 } },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 52, bold: true, color: "111827" },
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
    // Keep front matter in dedicated sections; the final section owns the page
    // numbering used by the visible report body.
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
        children: [await buildCover(reportData, logoBuffer, contentWidthTw, tr.assetReport)],
      },
      // Table of Contents (no header/footer)
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
        children: buildTOC({ ...reportData, grouping_mode: "combined" }),
      },
      // Transmittal Letter (no header/footer)
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
        children: buildTransmittalLetter(reportData, reportDate),
      },
      // Certificate of Appraisal (no header/footer)
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
        children: buildCertificateOfAppraisal(reportData, contentWidthTw, reportDate) as any,
      },
      // Main content (with header/footer). Restart page numbers at 1.
      {
        properties: {
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
        headers: {
          default: new Header({ children: [headerTable] }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: tr.page }),
                  PageNumber.CURRENT as any,
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  // Return the packed document as the complete controller/worker payload.
  const buf = await Packer.toBuffer(doc);
  return buf;
}
