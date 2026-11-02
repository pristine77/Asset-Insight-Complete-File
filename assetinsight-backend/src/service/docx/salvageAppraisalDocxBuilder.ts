import { AlignmentType, Bookmark, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun,
  InternalHyperlink, LeaderType, Packer, Paragraph, SimpleField, Table, TableCell, TableLayoutType, TableRow,
  TabStopType, TextRun, WidthType } from "docx";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSalvageAppraisalView, salvageReportUnits } from "../salvageAppraisalView.js";
import { prepareSalvagePhotos } from "../salvageImagePreparation.js";
import { damageMarksByPhoto } from "../../utils/salvageDamageMarks.js";
import { prepareSalvageExportAttachments, type SalvageExportPage } from "../salvageAppraisalExport.js";
import { safeSalvageReportLink, salvageReportSections, salvageReportRowNeedsSplit } from "../salvageReportSections.js";
import { formatSalvageDate, normalizeSalvageReportData } from "../salvageReportData.js";

type Json = Record<string, any>;
type Block = Paragraph | Table;
const width = 9865; // A4, 18 mm margins.
const border = { style: BorderStyle.SINGLE, size: 4, color: "D9DDE3" };
const p = (text: unknown, bold = false) => new Paragraph({ spacing: { after: 90 }, children: String(text ?? "").split(/\r?\n/)
  .flatMap((line, index) => [...(index ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, bold })]) });
const cell = (text: unknown, heading = false) => new TableCell({ margins: { top: 85, bottom: 85, left: 100, right: 100 },
  shading: heading ? { fill: "EEF0F2" } : undefined, children: [p(text, heading)] });
function table(rows: unknown[][], header = false, weights?: number[]): Table {
  const count = Math.max(1, ...rows.map((row) => row.length));
  const columns = weights?.length === count ? weights : Array.from({ length: count }, () => 1);
  const total = columns.reduce((sum, value) => sum + value, 0);
  return new Table({ width: { size: width, type: WidthType.DXA }, layout: TableLayoutType.FIXED,
    columnWidths: columns.map((value, index) => {
      const before = columns.slice(0, index).reduce((sum, column) => sum + column, 0);
      return Math.round((before + value) / total * width) - Math.round(before / total * width);
    }),
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, index) => new TableRow({ tableHeader: header && index === 0,
      cantSplit: !salvageReportRowNeedsSplit(row.map((value) => String(value ?? ""))),
      children: row.map((value) => cell(value, header && index === 0)) })) });
}
function picture(photo: SalvageExportPage, title: string, maxWidth = 645, maxHeight = 600): Paragraph {
  const scale = Math.min(1, maxWidth / photo.width, maxHeight / photo.height);
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new ImageRun({ type: photo.type || "jpg", data: photo.buffer,
    transformation: { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale) },
    altText: { name: title, title, description: title } })] });
}
const link = (url: string) => new Paragraph({ children: safeSalvageReportLink(url)
  ? [new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, color: "A91D33", underline: {} })] })] : [new TextRun(url)] });

/** The full appraisal, with editable body text and separate uploaded page images. */
export async function generateSalvageAppraisalDocx(report: Json): Promise<Buffer> {
  const lang = report.language === "fr" || report.language === "es" ? report.language : "en";
  const view = buildSalvageAppraisalView(report, lang), L = view.labels;
  const currency = view.currency;
  const money = (value: number | null) => value === null ? L.notEstablished
    : new Intl.NumberFormat(lang === "fr" ? "fr-CA" : lang === "es" ? "es-ES" : "en-CA", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const attachments = await prepareSalvageExportAttachments(report);
  const units = salvageReportUnits(report);
  const photos = [];
  for (const [index, unit] of units.entries()) photos.push(await prepareSalvagePhotos(unit.imageUrls || [], {
    damageMarks: damageMarksByPhoto(unit.damage_marks || [], (unit.imageUrls || []).length), cleanCopyIndexes: index === 0 ? [0, 1, 2] : [],
  }));
  const body: Block[] = [], contents: { title: string; anchor: string }[] = [];
  const heading = (title: string, anchor?: string, pageBreakBefore = false) => {
    if (anchor) contents.push({ title, anchor });
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore, keepNext: true, children: anchor
      ? [new Bookmark({ id: anchor, children: [new TextRun(title)] })] : [new TextRun(title)] }));
  };
  const rows = (values: { label: string; value: string }[]) => table(values.map((row) => [row.label, row.value]));
  const profile = () => {
    if (attachments.signature) body.push(picture(attachments.signature, "Appraiser signature", 230, 80));
    body.push(p([view.appraiser.name, view.appraiser.designation].filter(Boolean).join(", "), true),
      p([view.appraiser.title, view.appraiser.company].filter(Boolean).join(" · ")),
      p([view.appraiser.phone, view.appraiser.email].filter(Boolean).join(" · ")),
      p(`${L.signed} · ${formatSalvageDate(report.report_date, lang)}`));
  };
  const assignmentPairs: string[][] = [];
  for (let index = 0; index < view.assignmentRows.length; index += 2) {
    const first = view.assignmentRows[index], second = view.assignmentRows[index + 1];
    assignmentPairs.push([first.label, first.value, second?.label || "", second?.value || ""]);
  }
  heading(L.reportSummary, "salvage-summary");
  body.push(table(view.figures.map((figure) => [figure.label, figure.count !== undefined ? String(figure.count) : money(figure.amount), figure.note || ""])),
    p(L.assignment, true), table(assignmentPairs), p(L.opinion, true), rows([{ label: L.type, value: view.opinion.type }, { label: L.comments, value: view.opinion.comments }]),
    p(L.units, true), table([["#", L.unit, L.status, view.totalValueLabel, L.reserve, L.salvage],
      ...view.units.map((unit) => [unit.number, [unit.label, unit.name].filter(Boolean).join(" — "), unit.status, money(unit.valueAmount), money(unit.reserve), money(unit.salvage)]),
      ["", L.total, "", money(view.totals.value), money(view.totals.reserve), money(view.totals.salvage)]], true, [5, 31, 13, 17, 17, 17]),
    p(`${L.nextReport}: ${view.followUp}`));
  if (view.comments) body.push(p(view.comments));
  profile();
  for (const [index, unit] of view.units.entries()) {
    heading(unit.heading, unit.anchor, true);
    body.push(p(unit.name, true), p(L.unitDetails, true), rows(unit.detailsRows), p(L.inspection, true), rows(unit.inspectionRows), p(L.damage, true), rows(unit.damageRows),
      p(`${L.repairable}: ${unit.repairable === "yes" ? L.yes : unit.repairable === "no" ? L.no : L.tbd}`),
      p(L.repairEstimate, true), table(unit.repairLines.map((line) => [line.label, money(line.amount)])), p(unit.repairNote),
      p(L.valuation, true), rows([{ label: unit.valueBasis === "replacement" ? L.replacement : L.acv, value: money(unit.valueAmount) }, { label: L.references, value: unit.references }, { label: L.reserve, value: money(unit.reserve) }, { label: L.salvage, value: money(unit.salvage) }]));
    const market = unit.market;
    if (unit.researched || market.comparables.length || market.groups.length) {
      body.push(p(L.marketAnalysis, true));
      for (const group of market.groups) body.push(p(group.heading, true), table([[market.labels.description, market.labels.clientVehicle, market.comparableHeading, market.labels.adjustments], ...group.rows.map((row) => [row.label, row.client, row.comparable, row.adjustment === null ? "—" : money(row.adjustment)])], true));
      body.push(p(market.labels.ledgerHeading, true), table(market.ledger.map((line) => [line.label, line.detail || "", line.amount === null ? line.text || L.notEstablished : money(line.amount)])),
        p(market.labels.recoveryHeading, true), table(market.recovery.map((line) => [line.label, line.detail || "", line.amount === null ? line.text || L.notEstablished : money(line.amount)])));
      if (market.comparables.length) body.push(p(market.labels.comparables, true), table([[market.labels.vehicle, market.labels.price, market.labels.adjusted, market.labels.location, market.labels.status], ...market.comparables.map((comp) => [comp.title, money(comp.price), money(comp.adjustedPrice), comp.location, comp.verification])], true));
      for (const comp of market.comparables) if (comp.url) body.push(p(comp.title), link(comp.url));
      for (const [label, paragraphs] of [[market.labels.special, market.notes.special], [market.labels.providedBy, market.notes.providedBy], [market.labels.process, market.notes.process], [market.labels.general, market.notes.general]] as [string, string[]][]) {
        if (paragraphs.length) body.push(p(label, true), ...paragraphs.map((value) => p(value)));
      }
      body.push(p(market.notes.researchArea), p(market.notes.clientComments));
    }
    // Preserve all saved assessment references, repair inputs and scoped notes,
    // including content which is more detailed than the concise PDF market view.
    const enrichment = salvageReportSections(normalizeSalvageReportData(units[index]));
    for (const section of [...enrichment.body, ...enrichment.references]) {
      body.push(p(section.title, true), ...section.paragraphs.map((value) => p(value)));
      for (const item of section.tables) body.push(table([item.headers, ...item.rows], true));
    }
    if (photos[index].length) {
      heading(`${L.photographs} — ${L.unit} ${index + 1}`, undefined, true);
      for (const [photoIndex, photo] of photos[index].entries()) {
        body.push(new Paragraph({ keepNext: true, children: [new TextRun({ text: `${L.photo} ${photoIndex + 1} / ${photos[index].length}`, bold: true })] }),
          picture(photo, `${L.unit} ${index + 1} ${L.photo} ${photoIndex + 1}`, 640, 520));
      }
    }
  }
  heading(L.definitions, "salvage-definitions", true); body.push(rows(view.definitions));
  heading(L.limitations, "salvage-limitations"); body.push(...view.limitations.map((value) => p(value)));
  heading(L.certification, "salvage-certification", true); body.push(...view.certification.map((value, index) => p(`${index + 1}. ${value}`))); profile();
  const attached = [...(attachments.cv ? [attachments.cv] : []), ...attachments.appendices];
  for (const [index, attachment] of attached.entries()) {
    for (const [pageIndex, page] of attachment.pages.entries()) {
      heading(`${attachment.title} — ${L.page} ${pageIndex + 1} / ${attachment.pages.length}`, pageIndex === 0 ? `salvage-attachment-${index}` : undefined, true);
      if (pageIndex === 0) { body.push(link(attachment.url)); if (attachment.note) body.push(p(attachment.note)); }
      body.push(picture(page, `${attachment.title} page ${pageIndex + 1}`, 640, pageIndex === 0 ? 720 : 770));
    }
  }
  const cover: Block[] = [new Paragraph({ text: view.brand.name, heading: HeadingLevel.TITLE }), p(view.reportNumberText),
    new Paragraph({ text: view.title, heading: HeadingLevel.TITLE }), p(view.subject, true), ...view.coverLines.map((value) => p(value)),
    rows([{ label: L.claim, value: String(report.claim_number || "") }, { label: L.file, value: String(report.file_number || "") }, { label: L.reportDate, value: formatSalvageDate(report.report_date, lang) }])];
  for (const [index, photo] of photos[0].slice(0, 3).entries()) cover.push(picture({ ...photo, buffer: photo.cleanBuffer || photo.buffer }, `Cover photo ${index + 1}`, 510, 170));
  const toc = [new Paragraph({ text: lang === "fr" ? "Table des matières" : lang === "es" ? "Índice" : "Contents", heading: HeadingLevel.TITLE }), ...contents.map((entry) => new Paragraph({
    spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: width - 20, leader: LeaderType.DOT }],
    children: [new InternalHyperlink({ anchor: entry.anchor, children: [new TextRun(entry.title)] }), new TextRun("\t"), new SimpleField(`PAGEREF ${entry.anchor} \\h`)],
  }))];
  const footer = new Footer({ children: [new Paragraph({ children: [new TextRun(`${view.brand.name} · ${report.file_number || ""} · `), new SimpleField("PAGE")] })] });
  let logo: Buffer | undefined; try { logo = await fs.readFile(path.resolve(process.cwd(), view.brand.logoFile)); } catch { /* Text branding remains. */ }
  const header = new Header({ children: [logo ? picture({ buffer: logo, width: 1000, height: 250, type: "png" }, view.brand.name, 180, 45) : p(view.brand.name, true)] });
  const properties = { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1020, right: 1020 } } };
  return Packer.toBuffer(new Document({ creator: "Asset Insight", title: view.title, features: { updateFields: true },
    styles: { default: { document: { run: { font: "Arial", size: 20 }, paragraph: { spacing: { after: 100 } } } },
      paragraphStyles: [{ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Arial", size: 26, bold: true, color: "A91D33" }, paragraph: { spacing: { before: 240, after: 140 }, keepNext: true } },
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 38, bold: true, color: "202126" } }] },
    sections: [{ properties, children: cover }, { properties, headers: { default: header }, footers: { default: footer }, children: toc }, { properties, headers: { default: header }, footers: { default: footer }, children: body }] }));
}
