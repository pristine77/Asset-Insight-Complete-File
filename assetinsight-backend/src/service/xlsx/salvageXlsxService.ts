import ExcelJS from "exceljs";
import {
  addWorksheetFromRows,
  setWorksheetColumnWidths,
  workbookToBuffer,
} from "../../utils/excel.js";
import { normalizeSalvageReportData, salvageNumber } from "../salvageReportData.js";
import { presentSalvageSnapshot } from "../salvagePresentation.js";
import { salvageReportSections, safeSalvageReportLink, type SalvageReportSection } from "../salvageReportSections.js";

/**
 * Builds a portable Salvage workbook with the six established data sheets,
 * shared Assessment sections, and a final References register. Legacy repair
 * formulas remain compatible; enterprise totals use saved canonical values.
 */
function safe(val?: any): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

export async function generateSalvageXlsx(reportData: any): Promise<Buffer> {
  reportData = presentSalvageSnapshot(normalizeSalvageReportData(reportData));
  const enterprise = reportData?.assessment?.schemaVersion === 2;
  const enrichment = salvageReportSections(reportData);
  // Only shipped dictionaries are selectable. Unknown or legacy locale values
  // deliberately fall back to English so sheet labels are never undefined.
  const lang: 'en' | 'fr' | 'es' = ((): any => {
    const l = String((reportData as any)?.language || '').toLowerCase();
    return (l === 'fr' || l === 'es') ? l : 'en';
  })();
  const t = {
    en: {
      sheetDetails: 'Details',
      sheetComparables: 'Comparables',
      field: 'Field',
      value: 'Value',
      reportDate: 'Report Date',
      fileNumber: 'File Number',
      claimNumber: 'Claim Number',
      policyNumber: 'Policy Number',
      appraiser: 'Appraiser',
      company: 'Company',
      currency: 'Currency',
      adjuster: 'Adjuster',
      insured: 'Insured',
      companyAddress: 'Company Address',
      itemType: 'Item Type',
      year: 'Year',
      make: 'Make',
      model: 'Model',
      vin: 'VIN',
      condition: 'Condition',
      damageDescription: 'Damage Description',
      inspectionComments: 'Inspection Comments',
      totalValue: 'Fair Market Value',
      confidence: 'Confidence',
      summary: 'Summary',
      title: 'Title',
      price: 'Price',
      location: 'Location',
      link: 'Link',
    },
    fr: {
      sheetDetails: 'Détails',
      sheetComparables: 'Comparables',
      field: 'Champ',
      value: 'Valeur',
      reportDate: 'Date du rapport',
      fileNumber: 'Numéro de dossier',
      claimNumber: 'Numéro de réclamation',
      policyNumber: 'Numéro de police',
      appraiser: 'Évaluateur',
      company: 'Société',
      currency: 'Devise',
      adjuster: 'Expert en sinistres',
      insured: 'Assuré',
      companyAddress: 'Adresse de la société',
      itemType: "Type d'article",
      year: 'Année',
      make: 'Marque',
      model: 'Modèle',
      vin: 'VIN',
      condition: 'État',
      damageDescription: 'Description des dommages',
      inspectionComments: "Commentaires d'inspection",
      totalValue: 'Valeur marchande',
      confidence: 'Confiance',
      summary: 'Résumé',
      title: 'Titre',
      price: 'Prix',
      location: 'Emplacement',
      link: 'Lien',
    },
    es: {
      sheetDetails: 'Detalles',
      sheetComparables: 'Comparables',
      field: 'Campo',
      value: 'Valor',
      reportDate: 'Fecha del informe',
      fileNumber: 'Número de expediente',
      claimNumber: 'Número de reclamación',
      policyNumber: 'Número de póliza',
      appraiser: 'Tasador',
      company: 'Empresa',
      currency: 'Moneda',
      adjuster: 'Perito',
      insured: 'Asegurado',
      companyAddress: 'Dirección de la empresa',
      itemType: 'Tipo de artículo',
      year: 'Año',
      make: 'Marca',
      model: 'Modelo',
      vin: 'VIN',
      condition: 'Condición',
      damageDescription: 'Descripción del daño',
      inspectionComments: 'Comentarios de inspección',
      totalValue: 'Valor de mercado',
      confidence: 'Confianza',
      summary: 'Resumen',
      title: 'Título',
      price: 'Precio',
      location: 'Ubicación',
      link: 'Enlace',
    },
  } as const;
  const tt = (t as any)[lang] as typeof t.en;

  // Keep field order stable: the workbook is human-readable, but downstream
  // consumers also rely on these rows appearing in the established sequence.
  const rows: any[][] = [];
  const push = (k: string, v?: any) => rows.push([k, safe(v)]);
  push(tt.reportDate, reportData?.report_date);
  push(tt.fileNumber, reportData?.file_number);
  push(tt.claimNumber, reportData?.claim_number);
  push(tt.policyNumber, reportData?.policy_number);
  push(tt.appraiser, reportData?.appraiser_name);
  push(tt.company, reportData?.company_name);
  push(tt.currency, reportData?.currency || 'CAD');
  push(tt.adjuster, reportData?.adjuster_name);
  push(tt.insured, reportData?.insured_name);
  push(tt.companyAddress, reportData?.company_address);
  push(tt.itemType, reportData?.item_type || reportData?.aiExtractedDetails?.item_type);
  push(tt.year, reportData?.year || reportData?.aiExtractedDetails?.year);
  push(tt.make, reportData?.make || reportData?.aiExtractedDetails?.make);
  push(tt.model, reportData?.item_model || reportData?.aiExtractedDetails?.item_model);
  push(tt.vin, reportData?.vin || reportData?.aiExtractedDetails?.vin);
  push(tt.condition, reportData?.item_condition || reportData?.aiExtractedDetails?.item_condition);
  push(tt.damageDescription, reportData?.damage_description || reportData?.aiExtractedDetails?.damage_description);
  push(tt.inspectionComments, reportData?.inspection_comments || reportData?.aiExtractedDetails?.inspection_comments);
  push(tt.totalValue, reportData?.valuation?.fairMarketValue);
  push(tt.confidence, reportData?.valuation?.confidence_level);
  push(tt.summary, reportData?.valuation?.summary);

  const workbook = new ExcelJS.Workbook();
  const wsDetails = addWorksheetFromRows(workbook, tt.sheetDetails, [[tt.field, tt.value], ...rows]);
  setWorksheetColumnWidths(wsDetails, [28, 60]);
  const enrichmentSheets = new Map<ExcelJS.Worksheet, Map<number, 'title' | 'header' | 'paragraph'>>();
  const enrichmentCellWidths = new Map<string, number>();
  const addEnrichmentSheet = (name: string, sections: SalvageReportSection[]) => {
    if (!sections.length) return;
    const sheet = workbook.addWorksheet(name);
    const roles = new Map<number, 'title' | 'header' | 'paragraph'>();
    enrichmentSheets.set(sheet, roles);
    const width = Math.max(2, ...sections.flatMap(section => section.tables.map(table => table.headers.length)));
    setWorksheetColumnWidths(sheet, Array.from({ length: width }, () => 150 / width));
    for (const section of sections) {
      if (sheet.rowCount) sheet.addRow([]);
      const title = sheet.addRow([section.title]);
      sheet.mergeCells(title.number, 1, title.number, width);
      roles.set(title.number, 'title');
      for (const paragraph of section.paragraphs) {
        // Split very long paragraphs into readable continuation rows, preserving
        // every character instead of exceeding Excel's maximum row height.
        const pieces = paragraph.match(/[\s\S]{1,2000}/g) ?? [''];
        for (const piece of pieces) {
          const row = sheet.addRow([piece]);
          sheet.mergeCells(row.number, 1, row.number, width);
          roles.set(row.number, 'paragraph');
        }
      }
      for (const table of section.tables) {
        if (!table.headers.length) continue;
        const starts = table.headers.map((_, index) => Math.floor(index * width / table.headers.length));
        const spans = starts.map((start, index) => (starts[index + 1] ?? width) - start);
        const appendTableRow = (cells: string[]) => {
          const values: Array<string | null> = Array.from({ length: width }, () => null);
          cells.forEach((value, index) => { values[starts[index]!] = value; });
          const row = sheet.addRow(values);
          spans.forEach((span, index) => {
            const column = starts[index]! + 1;
            if (span > 1) sheet.mergeCells(row.number, column, row.number, column + span - 1);
            const cell = row.getCell(column);
            enrichmentCellWidths.set(`${sheet.id}:${cell.address}`, 150 * span / width);
            const text = String(cell.value ?? '');
            const hyperlink = text.split(/\r?\n/).map(safeSalvageReportLink).find(Boolean);
            if (hyperlink) cell.value = { text, hyperlink };
          });
          return row;
        };
        const header = appendTableRow(table.headers);
        roles.set(header.number, 'header');
        for (const cells of table.rows) {
          const chunks = cells.map((text, index) => {
            const limit = Math.max(160, Math.floor(150 * spans[index]! / width * 15));
            return text.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) ?? [''];
          });
          for (let index = 0; index < Math.max(...chunks.map(parts => parts.length)); index++) {
            appendTableRow(chunks.map(parts => parts[index] ?? ''));
          }
        }
        sheet.addRow([]);
      }
    }
  };
  addEnrichmentSheet(lang === 'fr' ? 'Évaluation' : lang === 'es' ? 'Evaluación' : 'Assessment', [...enrichment.executive, ...enrichment.body]);

  // Comparables are isolated on their own sheet so zero or many records do not
  // affect the fixed metadata layout. Missing values serialize as empty strings.
  const comps = Array.isArray(reportData?.comparableItems) ? reportData.comparableItems : [];
  const compsData = [
    [tt.title, tt.price, tt.location, tt.link],
    ...comps.map((c: any) => [safe(c?.title), safe(c?.price), safe(c?.location), safe(c?.link)]),
  ];
  const wsComps = addWorksheetFromRows(workbook, tt.sheetComparables, compsData);
  setWorksheetColumnWidths(wsComps, [48, 16, 20, 64]);

  const labels = {
    en: { estimate: 'Repair estimate', parts: 'Parts', labour: 'Labour', photos: 'Photos', item: 'Item', qty: 'Quantity', unit: 'Unit price', line: 'Line total', vendor: 'Vendor', days: 'Lead time (days)', notes: 'Notes', task: 'Task', hours: 'Hours', rate: 'Rate/hour', betterment: 'Less betterment', supplies: 'Shop supplies', misc: 'Miscellaneous', taxes: 'Taxes', total: 'Total estimate', warning: 'Estimate limitations', reserve: 'Recommended reserve', acv: 'Actual cash value', replacement: 'Replacement cost', repairable: 'Repairable', facility: 'Repair facility', loss: 'Cause of loss', comments: 'Appraiser comments', procurement: 'Procurement notes', safety: 'Safety concerns', assumptions: 'Assumptions' },
    fr: { estimate: 'Estimation', parts: 'Pièces', labour: "Main-d'œuvre", photos: 'Photos', item: 'Article', qty: 'Quantité', unit: 'Prix unitaire', line: 'Total de ligne', vendor: 'Fournisseur', days: 'Délai (jours)', notes: 'Notes', task: 'Tâche', hours: 'Heures', rate: 'Taux/heure', betterment: 'Moins plus-value', supplies: "Fournitures d'atelier", misc: 'Divers', taxes: 'Taxes', total: 'Estimation totale', warning: "Limites de l'estimation", reserve: 'Réserve recommandée', acv: 'Valeur au comptant réelle', replacement: 'Coût de remplacement', repairable: 'Réparable', facility: 'Atelier de réparation', loss: 'Cause du sinistre', comments: "Commentaires de l'évaluateur", procurement: "Notes d'approvisionnement", safety: 'Préoccupations de sécurité', assumptions: 'Hypothèses' },
    es: { estimate: 'Estimación', parts: 'Piezas', labour: 'Mano de obra', photos: 'Fotos', item: 'Artículo', qty: 'Cantidad', unit: 'Precio unitario', line: 'Total de línea', vendor: 'Proveedor', days: 'Plazo (días)', notes: 'Notas', task: 'Tarea', hours: 'Horas', rate: 'Tarifa/hora', betterment: 'Menos mejoramiento', supplies: 'Suministros de taller', misc: 'Misceláneos', taxes: 'Impuestos', total: 'Estimación total', warning: 'Limitaciones', reserve: 'Reserva recomendada', acv: 'Valor en efectivo real', replacement: 'Costo de reemplazo', repairable: 'Reparable', facility: 'Taller de reparación', loss: 'Causa de pérdida', comments: 'Comentarios del tasador', procurement: 'Notas de compras', safety: 'Preocupaciones de seguridad', assumptions: 'Suposiciones' },
  }[lang];
  for (const [label, value] of [
    [labels.repairable, reportData.is_repairable], [labels.facility, reportData.repair_facility],
    [labels.loss, reportData.cause_of_loss_summary], [labels.comments, reportData.appraiser_comments],
    [labels.procurement, reportData.procurement_notes], [labels.safety, reportData.safety_concerns],
    [labels.assumptions, reportData.assumptions], [labels.warning, reportData.estimate_warning],
  ]) wsDetails.addRow([label, safe(value)]);
  const moneyFormat = `"${reportData.currency}" #,##0.00;[Red]("${reportData.currency}" #,##0.00)`;
  for (const [label, value] of [[labels.reserve, reportData.recommended_reserve], [labels.acv, reportData.actual_cash_value], [labels.replacement, reportData.replacement_cost]]) {
    const row = wsDetails.addRow([label, value]); row.getCell(2).numFmt = moneyFormat;
  }
  const reportDate = new Date(reportData.report_date);
  if (Number.isFinite(reportDate.getTime())) { wsDetails.getCell('B2').value = reportDate; wsDetails.getCell('B2').numFmt = 'yyyy-mm-dd'; }
  const extraLabels = {
    en: ['Date received', 'Date of loss', 'Next report due', 'Reported loss type', 'Appraiser phone', 'Appraiser email', 'Repair facility comments', 'Replacement cost references', 'Priority level'],
    fr: ['Date de réception', 'Date du sinistre', 'Prochain rapport prévu', 'Type de sinistre déclaré', 'Téléphone de l’évaluateur', 'Courriel de l’évaluateur', 'Commentaires de l’atelier', 'Références du coût de remplacement', 'Niveau de priorité'],
    es: ['Fecha de recepción', 'Fecha del siniestro', 'Próximo informe', 'Tipo de siniestro informado', 'Teléfono del tasador', 'Correo del tasador', 'Comentarios del taller', 'Referencias del costo de reemplazo', 'Nivel de prioridad'],
  }[lang];
  ['date_received', 'date_of_loss', 'next_report_due', 'reported_loss_type', 'appraiser_phone', 'appraiser_email', 'repair_facility_comments', 'replacement_cost_references', 'priority_level'].forEach((key, index) => {
    const value = reportData[key];
    const date = index < 3 && value ? new Date(value) : undefined;
    const validDate = date && Number.isFinite(date.getTime());
    const row = wsDetails.addRow([extraLabels[index], validDate ? date : safe(value)]);
    if (validDate) row.getCell(2).numFmt = 'yyyy-mm-dd';
  });

  const parts = reportData.repair_items as any[];
  const labour = reportData.labour_breakdown as any[];
  const wsEstimate = addWorksheetFromRows(workbook, labels.estimate, [[tt.field, tt.value]]);
  setWorksheetColumnWidths(wsEstimate, [32, 32]);
  const wsParts = addWorksheetFromRows(workbook, labels.parts, [[labels.item, 'SKU', 'OEM/Aftermarket', labels.qty, labels.unit, labels.line, labels.vendor, tt.link, labels.days, labels.notes],
    ...parts.map((part) => [safe(part.name), safe(part.sku), safe(part.oem_or_aftermarket), part.quantity ?? null, part.unit_price ?? null, part.line_total, safe(part.vendor), safe(part.vendor_link), part.lead_time_days ?? null, safe(part.notes)])]);
  setWorksheetColumnWidths(wsParts, [32, 20, 20, 12, 19, 19, 25, 48, 18, 44]);
  const wsLabour = addWorksheetFromRows(workbook, labels.labour, [[labels.task, labels.hours, labels.rate, labels.line, labels.notes],
    ...labour.map((task) => [safe(task.task), task.hours ?? null, task.rate_per_hour, task.line_total, safe(task.notes)])]);
  setWorksheetColumnWidths(wsLabour, [44, 14, 19, 19, 60]);
  parts.forEach((part, index) => {
    const row = index + 2;
    if (!enterprise && salvageNumber(part.quantity) !== undefined && salvageNumber(part.unit_price) !== undefined) wsParts.getCell(`F${row}`).value = { formula: `ROUND(D${row}*E${row},2)`, result: part.line_total };
    for (const column of ['E', 'F']) wsParts.getCell(`${column}${row}`).numFmt = moneyFormat;
  });
  labour.forEach((task, index) => {
    const row = index + 2;
    if (!enterprise && salvageNumber(task.hours) !== undefined) wsLabour.getCell(`D${row}`).value = { formula: `ROUND(B${row}*C${row},2)`, result: task.line_total };
    for (const column of ['C', 'D']) wsLabour.getCell(`${column}${row}`).numFmt = moneyFormat;
  });
  const estimate = reportData.repair_estimate;
  const quote = (name: string) => `'${name.replace(/'/g, "''")}'`;
  wsEstimate.addRows([
    [labels.parts, !enterprise && parts.length ? { formula: `SUM(${quote(labels.parts)}!F2:F${parts.length + 1})`, result: estimate.parts } : estimate.parts],
    [labels.labour, !enterprise && labour.length ? { formula: `SUM(${quote(labels.labour)}!D2:D${labour.length + 1})`, result: estimate.labour } : estimate.labour],
    [labels.supplies, estimate.shop_supplies], [labels.misc, estimate.miscellaneous], [labels.taxes, estimate.taxes],
    [labels.betterment, estimate.less_betterment], [labels.total, enterprise ? estimate.total : { formula: 'ROUND(SUM(B2:B6)-B7,2)', result: estimate.total }],
  ]);
  if (enterprise) {
    // Authoritative saved conclusions include independently documented charges.
    // Never recalculate unsupported/null lines or omit these charges on open.
    for (const charge of estimate.charges ?? []) {
      const row = wsEstimate.addRow([safe(charge.description), charge.amount ?? null]);
      row.getCell(2).numFmt = moneyFormat;
    }
  }
  for (let row = 2; row <= 8; row++) wsEstimate.getCell(`B${row}`).numFmt = moneyFormat;
  wsEstimate.getRow(8).font = { bold: true };
  const wsPhotos = addWorksheetFromRows(workbook, labels.photos, [[labels.photos, tt.link], ...reportData.imageUrls.map((url: string, index: number) => [index + 1, url])]);
  setWorksheetColumnWidths(wsPhotos, [12, 110]);
  addEnrichmentSheet(lang === 'es' ? 'Referencias' : lang === 'fr' ? 'Références' : 'References', enrichment.references);
  workbook.creator = 'Asset Insight';
  workbook.calcProperties = { fullCalcOnLoad: true };
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
    sheet.pageSetup = { paperSize: 9, orientation: sheet.columnCount > 5 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    sheet.eachRow((row, rowNumber) => {
      let rowHeight = 26;
      row.eachCell((cell, column) => {
        if (enterprise && cell.value === '') cell.value = null;
        cell.font = { name: 'Arial', size: 11, ...(rowNumber === 1 ? { bold: true, color: { argb: 'FFFFFFFF' } } : {}) };
        cell.alignment = { vertical: 'top', wrapText: true };
        if (rowNumber === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF26364A' } };
        else if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
        if (!cell.isMerged || cell.address === cell.master.address) {
          const charsPerLine = Math.max(12, (enrichmentCellWidths.get(`${sheet.id}:${cell.address}`) ?? Number(sheet.getColumn(column).width || 25)) - 3);
          const lines = cell.text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
          rowHeight = Math.max(rowHeight, lines * 15 + 12);
        }
      });
      row.height = Math.min(409, rowHeight);
    });
    if (sheet !== wsDetails && sheet !== wsEstimate && !enrichmentSheets.has(sheet)) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
    const roles = enrichmentSheets.get(sheet);
    if (roles) {
      sheet.eachRow((row, rowNumber) => {
        const role = roles.get(rowNumber);
        if (role === 'title') {
          row.height = 30;
          row.eachCell(cell => { cell.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF26364A' } }; });
        } else if (role === 'header') {
          row.eachCell(cell => { cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF202126' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0F2' } }; });
        } else if (role === 'paragraph') {
          row.height = Math.min(409, 14 * Math.ceil(String(row.getCell(1).value ?? '').length / 130) + 16);
        }
      });
    }
  }
  wsEstimate.getRow(8).eachCell((cell) => { cell.font = { ...cell.font, bold: true }; });

  // Serialization is the service boundary; callers receive a ready-to-send XLSX.
  return workbookToBuffer(workbook);
}
