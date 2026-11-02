import ExcelJS from "exceljs";
import { buildSalvageAppraisalView, salvageReportUnits } from "../salvageAppraisalView.js";
import { prepareSalvageExportAttachments, type SalvageExportPage } from "../salvageAppraisalExport.js";
import { prepareSalvagePhotos } from "../salvageImagePreparation.js";
import { damageMarksByPhoto } from "../../utils/salvageDamageMarks.js";
import { normalizeSalvageReportData } from "../salvageReportData.js";
import { safeSalvageReportLink, salvageReportSections } from "../salvageReportSections.js";
import { workbookToBuffer } from "../../utils/excel.js";

type Json = Record<string, any>;
/** Every unit and the same saved conclusions as Word/PDF, in native Excel cells. */
export async function generateSalvageAppraisalXlsx(report: Json): Promise<Buffer> {
  const lang = report.language === "fr" || report.language === "es" ? report.language : "en";
  const view = buildSalvageAppraisalView(report, lang), L = view.labels;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Asset Insight"; workbook.calcProperties = { fullCalcOnLoad: true };
  const format = `"${view.currency}" #,##0.00;[Red]-"${view.currency}" #,##0.00`;
  const sheet = (name: string, widths: number[]) => {
    const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
    ws.columns = widths.map((width) => ({ width }));
    ws.pageSetup = { paperSize: 9, orientation: widths.length > 4 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return ws;
  };
  const moneyRow = (ws: ExcelJS.Worksheet, label: string, amount: number | null) => {
    const row = ws.addRow([label, amount]); row.getCell(2).numFmt = format; return row;
  };
  // Excel has a 32,767 character cell limit. Keep long notes in ordered
  // continuation rows rather than silently truncating saved report content.
  const textRow = (ws: ExcelJS.Worksheet, label: string, value: unknown) => {
    const text = String(value ?? "");
    if (!text.length) { ws.addRow([label, ""]); return; }
    for (let offset = 0; offset < text.length; offset += 8000) ws.addRow([offset ? `${label} (${Math.floor(offset / 8000) + 1})` : label, text.slice(offset, offset + 8000)]);
  };
  const heading = (ws: ExcelJS.Worksheet, title: string) => { const row = ws.addRow([title]); row.font = { bold: true }; };
  const source = (ws: ExcelJS.Worksheet, url: string) => {
    const row = ws.addRow(["Source", safeSalvageReportLink(url) ? { text: url, hyperlink: url } : url]);
    row.getCell(2).font = { color: { argb: "FFA91D33" }, underline: true };
  };
  const addPicture = (ws: ExcelJS.Worksheet, page: SalvageExportPage, title: string, maxWidth = 720) => {
    heading(ws, title);
    const scale = Math.min(1, maxWidth / page.width, 900 / page.height);
    const height = Math.round(page.height * scale);
    const row = ws.rowCount;
    const id = workbook.addImage({ buffer: page.buffer as any, extension: page.type === "png" ? "png" : "jpeg" });
    ws.addImage(id, { tl: { col: 0, row }, ext: { width: Math.round(page.width * scale), height }, editAs: "oneCell" });
    for (let index = 0; index < Math.ceil(height / 26) + 2; index++) { const spacer = ws.addRow([""]); spacer.height = 20; }
  };
  const summary = sheet("Appraisal", [9, 48, 28, 24, 24, 24, 24]);
  summary.addRow([view.brand.name, view.title, view.reportNumberText, view.currency]);
  summary.addRow([L.units, view.subject]);
  summary.addRow(["#", L.unit, L.status, "Value basis", view.totalValueLabel, L.reserve, L.salvage]);
  for (const unit of view.units) {
    const row = summary.addRow([unit.number, [unit.label, unit.name].filter(Boolean).join(" — "), unit.status,
      unit.valueBasis === "replacement" ? L.replacement : L.acv, unit.valueAmount, unit.reserve, unit.salvage]);
    for (const column of [5, 6, 7]) row.getCell(column).numFmt = format;
  }
  const last = summary.rowCount;
  const total = summary.addRow([L.total, "", "", "", null, null, null]); total.font = { bold: true };
  for (const [column, value] of [[5, view.totals.value], [6, view.totals.reserve], [7, view.totals.salvage]] as const) {
    total.getCell(column).value = value === null ? null : { formula: `SUM(${String.fromCharCode(64 + column)}4:${String.fromCharCode(64 + column)}${last})`, result: value };
    total.getCell(column).numFmt = format;
  }
  summary.addRow([]); heading(summary, L.assignment);
  for (const row of view.assignmentRows) textRow(summary, row.label, row.value);
  textRow(summary, L.opinion, view.opinion.type); textRow(summary, L.comments, view.opinion.comments);
  textRow(summary, L.nextReport, view.followUp); if (view.comments) textRow(summary, L.comments, view.comments);

  const units = salvageReportUnits(report);
  for (const [index, unit] of view.units.entries()) {
    const ws = sheet(`Unit ${index + 1}`, [38, 64, 38, 28]);
    ws.addRow([unit.heading, unit.name, view.currency]);
    for (const [title, rows] of [[L.unitDetails, unit.detailsRows], [L.inspection, unit.inspectionRows], [L.damage, unit.damageRows]] as const) {
      heading(ws, title); for (const row of rows) textRow(ws, row.label, row.value);
    }
    textRow(ws, L.status, unit.status); heading(ws, L.repairEstimate);
    for (const line of unit.repairLines) moneyRow(ws, line.label, line.amount);
    textRow(ws, L.repairEstimate, unit.repairNote);
    heading(ws, L.valuation); moneyRow(ws, unit.valueBasis === "replacement" ? L.replacement : L.acv, unit.valueAmount);
    moneyRow(ws, L.reserve, unit.reserve); moneyRow(ws, L.salvage, unit.salvage); textRow(ws, L.references, unit.references);
    const market = unit.market;
    heading(ws, L.marketAnalysis);
    for (const group of market.groups) {
      heading(ws, group.heading); ws.addRow([market.labels.description, market.labels.clientVehicle, market.comparableHeading, market.labels.adjustments]);
      for (const row of group.rows) { const added = ws.addRow([row.label, row.client, row.comparable, row.adjustment]); added.getCell(4).numFmt = format; }
    }
    for (const [title, lines] of [[market.labels.ledgerHeading, market.ledger], [market.labels.recoveryHeading, market.recovery]] as const) {
      heading(ws, title); for (const line of lines) { moneyRow(ws, line.label, line.amount); if (line.detail || line.text) textRow(ws, line.label, line.detail || line.text); }
    }
    for (const comp of market.comparables) {
      heading(ws, comp.title); moneyRow(ws, market.labels.price, comp.price); moneyRow(ws, market.labels.adjusted, comp.adjustedPrice);
      textRow(ws, market.labels.location, comp.location); textRow(ws, market.labels.status, comp.verification); if (comp.url) source(ws, comp.url);
    }
    const enrichment = salvageReportSections(normalizeSalvageReportData(units[index]));
    for (const section of [...enrichment.executive, ...enrichment.body, ...enrichment.references]) {
      heading(ws, section.title); for (const paragraph of section.paragraphs) textRow(ws, section.title, paragraph);
      for (const item of section.tables) { ws.addRow(item.headers); for (const row of item.rows) ws.addRow(row); }
    }
    const urls: string[] = units[index].imageUrls || [];
    const photos = await prepareSalvagePhotos(urls, { damageMarks: damageMarksByPhoto(units[index].damage_marks || [], urls.length) });
    for (const [photoIndex, photo] of photos.entries()) { source(ws, urls[photoIndex]); addPicture(ws, photo, `${L.unit} ${index + 1} ${L.photo} ${photoIndex + 1}`); }
  }
  const attachments = await prepareSalvageExportAttachments(report);
  const profile = sheet("Profile", [38, 76]); profile.addRow([L.cv, view.brand.name]);
  for (const [key, value] of Object.entries(view.appraiser)) textRow(profile, key, value);
  if (attachments.signature) addPicture(profile, attachments.signature, "Appraiser signature", 260);
  heading(profile, L.certification); for (const value of view.certification) textRow(profile, L.certification, value);
  heading(profile, L.definitions); for (const row of view.definitions) textRow(profile, row.label, row.value);
  heading(profile, L.limitations); for (const value of view.limitations) textRow(profile, L.limitations, value);
  if (attachments.cv) { source(profile, attachments.cv.url); for (const [index, page] of attachments.cv.pages.entries()) addPicture(profile, page, `${L.cv} — ${L.page} ${index + 1} / ${attachments.cv.pages.length}`); }
  const appendix = sheet("Appendices", [38, 76]); appendix.addRow([L.appendices, view.currency]);
  for (const attachment of attachments.appendices) {
    heading(appendix, attachment.title); textRow(appendix, L.pages, attachment.pages.length); source(appendix, attachment.url);
    if (attachment.note) textRow(appendix, L.comments, attachment.note);
    for (const [index, page] of attachment.pages.entries()) addPicture(appendix, page, `${attachment.title} — ${L.page} ${index + 1} / ${attachment.pages.length}`);
  }
  for (const ws of workbook.worksheets) ws.eachRow((row, index) => {
    row.eachCell((value) => { value.font = { name: "Arial", size: 11, ...value.font };
      value.alignment = { vertical: "top", wrapText: true };
      if (index === 1) { value.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } }; value.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF26364A" } }; }
    });
    const values = Array.isArray(row.values) ? row.values : Object.values(row.values);
    if (!row.height) row.height = Math.min(409, Math.max(26, ...values.map((value) => typeof value === "string" ? Math.ceil(value.length / 65) * 15 + 12 : 26)));
  });
  return workbookToBuffer(workbook);
}
