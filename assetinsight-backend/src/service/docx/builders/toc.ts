import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  Table,
  TextRun,
  TabStopType,
} from "docx";
import { getLang, t } from "./i18n.js";

/**
 * Creates the visible, deterministic TOC used by current templates. Entry order
 * must mirror section assembly in the orchestrators; optional entries use grouping
 * metadata, root-image presence, and the CV URL as lightweight inclusion heuristics.
 */
export function buildTOC(
  reportData: any,
  skipPageBreak = false,
  contentWidthTw = 9360,
  options: { monochrome?: boolean; compact?: boolean; font?: string } = {}
): Array<Paragraph | Table> {
  const font = options.font || "Times New Roman";
  const lang = getLang(reportData);
  const tr = t(lang);
  const entries: { label: string }[] = [];
  const tocTabStop = Math.max(6600, contentWidthTw - 620);
  const pageColumnGap = 180;
  const rowLeftIndent = 96;
  const rowRightIndent = 48;
  
  // Page numbers are estimates rather than Word fields. Keep entry construction
  // and section construction aligned whenever either sequence changes.
  
  // Core document sections
  entries.push({ label: tr.transmittalLetter });
  entries.push({ label: tr.certificateOfAppraisal });
  entries.push({
    label:
      lang === "fr"
        ? "Aperçu de l’entreprise et coordonnées"
        : lang === "es"
          ? "Descripción general de la empresa e información de contacto"
          : "Company Overview and Contact Information",
  });
  
  // Appraisal methodology sections
  entries.push({ label: tr.conditionsHeading });
  entries.push({ label: tr.purposeHeading });
  entries.push({ label: tr.scopeHeading });
  entries.push({ label: "Factors Affecting Value" });
  entries.push({ label: tr.valueTermHeading });
  entries.push({ label: tr.limitingHeading });
  entries.push({ label: tr.approachesHeading });
  entries.push({ label: tr.valProcessHeading });
  entries.push({ label: tr.codeEthicsHeading });
  
  // Results section (varies by grouping mode)
  const groupingMode = String(reportData?.grouping_mode || "");
  const hasLots = Array.isArray(reportData?.lots) && reportData.lots.length > 0;
  
  if (groupingMode === "combined") {
    // Filter through canonical mode order; caller-provided order must not make
    // the TOC disagree with the combined report's fixed results sequence.
    const rawModes: string[] = Array.isArray(reportData?.combined_modes)
      ? reportData.combined_modes
      : ["single_lot", "per_item", "per_photo"];
    const modes = ["single_lot", "per_item", "per_photo"].filter((mode) =>
      rawModes.includes(mode)
    );
    
    if (modes.includes("single_lot")) entries.push({ label: tr.singleLotResults });
    if (modes.includes("per_item")) entries.push({ label: tr.perItemResults });
    if (modes.includes("per_photo")) entries.push({ label: tr.perPhotoResults });
  } else if (hasLots) {
    if (groupingMode === "catalogue") {
      entries.push({ label: tr.assetCatalogue });
    } else if (groupingMode === "per_item") {
      entries.push({ label: tr.perItemResults });
    } else {
      entries.push({ label: tr.results });
    }
  }
  
  // Supporting sections
  entries.push({ label: tr.marketOverview });
  
  // Optional sections based on content
  const hasImages = Array.isArray(reportData?.imageUrls) && reportData.imageUrls.length > 0;
  if (hasImages) {
    entries.push({ label: tr.appendix });
  }
  
  const hasCv = !!(reportData?.user_cv_url);
  if (hasCv) {
    entries.push({ label: "Appraiser CV" });
  }

  const tocChildren: Paragraph[] = [
    new Paragraph({
      pageBreakBefore: !skipPageBreak,
      spacing: { before: 40, after: 40 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 180, after: 140 },
      children: [
        new TextRun({
          text: tr.tableOfContents,
          bold: true,
          underline: {},
          size: 22,
          color: "111111",
          font,
        }),
      ],
    }),
    new Paragraph({
      indent: { left: rowLeftIndent, right: rowRightIndent },
      tabStops: [
        {
          type: TabStopType.RIGHT,
          position: tocTabStop,
        },
      ],
      spacing: { before: 40, after: 70 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 3,
          color: "D1D5DB",
        },
      },
      children: [
        new TextRun({
          text: tr.section,
          bold: true,
          size: 20,
          color: "1F2937",
          font,
        }),
        new TextRun({ text: "\t" }),
        new TextRun({
          text: tr.page.trim(),
          bold: true,
          size: 20,
          color: "1F2937",
          font,
        }),
      ],
    }),
  ];

  let pageNumber = 1;
  
  // Tab stops create the dotted leader/page column without a nested table, which
  // keeps the front matter compact and stable across printable widths.
  for (const entry of entries) {
    tocChildren.push(
      new Paragraph({
        indent: { left: rowLeftIndent, right: rowRightIndent },
        tabStops: [
          {
            type: TabStopType.RIGHT,
            position: tocTabStop - pageColumnGap,
            leader: "dot",
          },
          {
            type: TabStopType.RIGHT,
            position: tocTabStop,
          },
        ],
        spacing: options.compact
          ? { before: 32, after: 32 }
          : { before: 60, after: 60 },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: 2,
            color: "D1D5DB",
          },
        },
        children: [
          new TextRun({
            text: entry.label,
            size: 20,
            color: options.monochrome ? "000000" : "374151",
            font,
          }),
          new TextRun({ text: "\t" }),
          new TextRun({ text: "\t" }),
          new TextRun({
            text: pageNumber.toString(),
            size: 20,
            color: options.monochrome ? "000000" : "374151",
            font,
          }),
        ],
      })
    );
    pageNumber++;
  }

  return tocChildren;
}
