import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  ExternalHyperlink,
  SimpleField,
  TabStopType,
  LeaderType,
  HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom,
  Packer,
  Paragraph,
  Table as DocxTable,
  TableCell as DocxTableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  VerticalAlignTable,
  type ITableOptions,
  type ITableCellOptions,
} from "docx";
import fs from "fs/promises";
import path from "path";
import { renderSalvageDocxCover } from "../salvagePdfService.js";
import { normalizeSalvageReportData, formatSalvageDate } from "../salvageReportData.js";
import { presentSalvageSnapshot } from "../salvagePresentation.js";
import { salvageReportSections, safeSalvageReportLink, salvageReportRowNeedsSplit, type SalvageReportSection } from "../salvageReportSections.js";
import { prepareSalvagePhotos } from "../salvageImagePreparation.js";

// Report-local layout defaults: do not change Asset or Real Estate templates.
const mm = (value: number) => Math.round(value * 1440 / 25.4);
const contentWidth = mm(174);
const tableBorder = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
class Table extends DocxTable {
  constructor(options: ITableOptions) {
    super({
      layout: TableLayoutType.FIXED,
      borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder, insideHorizontal: tableBorder, insideVertical: tableBorder },
      ...options,
      // Older grids were Letter-sized. Normalize every grid to the A4 PDF's
      // printable width, retaining each table's deliberate column proportions.
      columnWidths: (options.columnWidths || [3000, 7080]).map((width, index, widths) => {
        const total = widths.reduce((sum, value) => sum + value, 0);
        const before = widths.slice(0, index).reduce((sum, value) => sum + value, 0);
        return Math.round((before + width) / total * contentWidth) - Math.round(before / total * contentWidth);
      }),
    });
  }
}
class TableCell extends DocxTableCell {
  constructor(options: ITableCellOptions) {
    super({
      margins: { top: 90, bottom: 90, left: 140, right: 140 },
      verticalAlign: VerticalAlignTable.CENTER,
      ...options,
    });
  }
}
const numericParagraph = (text: string) => new Paragraph({ text, alignment: AlignmentType.RIGHT });
const headerCell = (text: string, numeric = false) => new TableCell({
  shading: { fill: "EEF0F2" },
  children: [new Paragraph({ alignment: numeric ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: [new TextRun({ text, bold: true, color: "000000" })] })],
});

/**
 * Orchestrates the salvage appraisal from tolerant input normalization through
 * fixed narrative/table phases and final DOCX packing. Section order, comparable
 * order, localization fallback, and optional-image behavior are output contracts.
 */
function safe(val?: any): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

function formatMoneyStrict(input: any, ccy: string): string {
  try {
    let n: number | null = null;
    if (typeof input === "number" && Number.isFinite(input)) n = input;
    else if (typeof input === "string") {
      const cleaned = input.replace(/[^0-9.\-]/g, "");
      if (cleaned) {
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) n = parsed;
      }
    }
    if (n === null) return String(input || "—");
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: ccy || "CAD",
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return String(input || "—");
  }
}

export async function generateSalvageDocx(reportData: any): Promise<Buffer> {
  reportData = presentSalvageSnapshot(normalizeSalvageReportData(reportData));
  // Select one complete dictionary at the boundary. Unsupported locale values
  // fall back to English so a report never contains undefined or mixed labels.
  const lang: "en" | "fr" | "es" = ((): any => {
    const l = String((reportData as any)?.language || "").toLowerCase();
    return l === "fr" || l === "es" ? l : "en";
  })();
  const t = {
    en: {
      title: "Salvage Report",
      reportSummary: "Report Summary",
      preparedFor: "Prepared for",
      appraiser: "Appraiser",
      reportDate: "Report Date",
      fileNumber: "File Number",
      totalValue: "Fair Market Value",
      assetDetails: "Asset Details",
      repairEstimate: "Repair Estimate",
      comparablesHeading: "Comparable Salvage Listings",
      valuationSummary: "Valuation Summary",
      confidence: "Confidence Level",
      recommendedReserve: "Recommended Reserve",
      actualCashValue: "Actual Cash Value",
      replacementCost: "Replacement Cost",
      references: "References",
      summary: "Summary",
      page: "Page ",
      compsColumns: {
        title: "Title",
        price: "Price",
        location: "Location",
        link: "Link",
      },
      fields: {
        itemType: "Item Type",
        year: "Year",
        make: "Make",
        model: "Model",
        vin: "VIN",
        condition: "Condition",
        damageDescription: "Damage Description",
        inspectionComments: "Inspection Comments",
      },
      repair: {
        parts: "Parts",
        lessBetterment: "Less Betterment",
        labour: "Labour",
        shopSupplies: "Shop Supplies",
        miscellaneous: "Miscellaneous",
        taxes: "Taxes",
        total: "Total",
      },
      itemizedPartsHeading: "Itemized Parts",
      labourBreakdownHeading: "Labour Breakdown",
      estimateComposition: "Estimate Composition",
      managerNotesHeading: "Manager Notes",
      procurementNotes: "Procurement Notes",
      safetyConcerns: "Safety Concerns",
      assumptions: "Assumptions",
      priorityLevel: "Priority Level",
      partsColumns: {
        item: "Item",
        sku: "SKU",
        oem: "OEM/Aftermarket",
        qty: "Qty",
        unitPrice: "Unit Price",
        lineTotal: "Line Total",
        vendor: "Vendor",
        link: "Link",
        leadTime: "Lead Time (days)",
        notes: "Notes",
      },
      labourColumns: {
        task: "Task",
        hours: "Hours",
        rate: "Rate/hour",
        lineTotal: "Line Total",
        notes: "Notes",
      },
      compositionRows: {
        partsSubtotal: "Parts Subtotal",
        labourTotal: "Labour Total",
        totalHours: "Total Labour Hours",
        lessBetterment: "Less Betterment",
        shopSupplies: "Shop Supplies",
        miscellaneous: "Miscellaneous",
        taxes: "Taxes",
        grandTotal: "Grand Total",
      },
    },
    fr: {
      title: "Rapport de récupération",
      reportSummary: "Résumé du rapport",
      preparedFor: "Préparé pour",
      appraiser: "Évaluateur",
      reportDate: "Date du rapport",
      fileNumber: "Numéro de dossier",
      totalValue: "Valeur marchande",
      assetDetails: "Détails de l'actif",
      repairEstimate: "Estimation des réparations",
      comparablesHeading: "Annonces de récupération comparables",
      valuationSummary: "Résumé de l’évaluation",
      confidence: "Niveau de confiance",
      recommendedReserve: "Réserve recommandée",
      actualCashValue: "Valeur au comptant réelle",
      replacementCost: "Coût de remplacement",
      references: "Références",
      summary: "Résumé",
      page: "Page ",
      compsColumns: {
        title: "Titre",
        price: "Prix",
        location: "Emplacement",
        link: "Lien",
      },
      fields: {
        itemType: "Type d'article",
        year: "Année",
        make: "Marque",
        model: "Modèle",
        vin: "VIN",
        condition: "État",
        damageDescription: "Description des dommages",
        inspectionComments: "Commentaires d'inspection",
      },
      repair: {
        parts: "Pièces",
        lessBetterment: "Moins plus-value",
        labour: "Main-d'œuvre",
        shopSupplies: "Fournitures d'atelier",
        miscellaneous: "Divers",
        taxes: "Taxes",
        total: "Total",
      },
      itemizedPartsHeading: "Pièces détaillées",
      labourBreakdownHeading: "Répartition de la main-d'œuvre",
      estimateComposition: "Composition de l'estimation",
      managerNotesHeading: "Notes du gestionnaire",
      procurementNotes: "Notes d'approvisionnement",
      safetyConcerns: "Préoccupations de sécurité",
      assumptions: "Hypothèses",
      priorityLevel: "Niveau de priorité",
      partsColumns: {
        item: "Article",
        sku: "SKU",
        oem: "OEM/Après-vente",
        qty: "Qté",
        unitPrice: "Prix unitaire",
        lineTotal: "Total de ligne",
        vendor: "Fournisseur",
        link: "Lien",
        leadTime: "Délai (jours)",
        notes: "Notes",
      },
      labourColumns: {
        task: "Tâche",
        hours: "Heures",
        rate: "Taux/heure",
        lineTotal: "Total de ligne",
        notes: "Notes",
      },
      compositionRows: {
        partsSubtotal: "Sous-total pièces",
        labourTotal: "Total main-d'œuvre",
        totalHours: "Total d'heures",
        lessBetterment: "Moins plus-value",
        shopSupplies: "Fournitures d'atelier",
        miscellaneous: "Divers",
        taxes: "Taxes",
        grandTotal: "Total général",
      },
    },
    es: {
      title: "Informe de salvamento",
      reportSummary: "Resumen del informe",
      preparedFor: "Preparado para",
      appraiser: "Tasador",
      reportDate: "Fecha del informe",
      fileNumber: "Número de expediente",
      totalValue: "Valor de mercado",
      assetDetails: "Detalles del activo",
      repairEstimate: "Estimación de reparación",
      comparablesHeading: "Anuncios de salvamento comparables",
      valuationSummary: "Resumen de la valoración",
      confidence: "Nivel de confianza",
      recommendedReserve: "Reserva recomendada",
      actualCashValue: "Valor en efectivo real",
      replacementCost: "Costo de reemplazo",
      references: "Referencias",
      summary: "Resumen",
      page: "Página ",
      compsColumns: {
        title: "Título",
        price: "Precio",
        location: "Ubicación",
        link: "Enlace",
      },
      fields: {
        itemType: "Tipo de artículo",
        year: "Año",
        make: "Marca",
        model: "Modelo",
        vin: "VIN",
        condition: "Condición",
        damageDescription: "Descripción del daño",
        inspectionComments: "Comentarios de inspección",
      },
      repair: {
        parts: "Piezas",
        lessBetterment: "Menos mejoramiento",
        labour: "Mano de obra",
        shopSupplies: "Suministros de taller",
        miscellaneous: "Misceláneos",
        taxes: "Impuestos",
        total: "Total",
      },
      itemizedPartsHeading: "Piezas detalladas",
      labourBreakdownHeading: "Desglose de mano de obra",
      estimateComposition: "Composición de la estimación",
      managerNotesHeading: "Notas del gerente",
      procurementNotes: "Notas de compras",
      safetyConcerns: "Preocupaciones de seguridad",
      assumptions: "Suposiciones",
      priorityLevel: "Nivel de prioridad",
      partsColumns: {
        item: "Artículo",
        sku: "SKU",
        oem: "OEM/Posventa",
        qty: "Cant.",
        unitPrice: "Precio unitario",
        lineTotal: "Total de línea",
        vendor: "Proveedor",
        link: "Enlace",
        leadTime: "Plazo (días)",
        notes: "Notas",
      },
      labourColumns: {
        task: "Tarea",
        hours: "Horas",
        rate: "Tarifa/hora",
        lineTotal: "Total de línea",
        notes: "Notas",
      },
      compositionRows: {
        partsSubtotal: "Subtotal de piezas",
        labourTotal: "Total de mano de obra",
        totalHours: "Horas totales",
        lessBetterment: "Menos mejoramiento",
        shopSupplies: "Suministros de taller",
        miscellaneous: "Misceláneos",
        taxes: "Impuestos",
        grandTotal: "Total general",
      },
    },
  } as const;
  const tt = (t as any)[lang] as typeof t.en;
  const detailLabels = {
    en: { reportDetails: "Report Details", claim_number: "Claim Number", policy_number: "Policy Number", date_received: "Date Received", date_of_loss: "Date of Loss", reported_loss_type: "Reported Loss Type", next_report_due: "Next Report Due", insured_name: "Insured", adjuster_name: "Adjuster", appraiser_phone: "Appraiser Phone", appraiser_email: "Appraiser Email", company_address: "Company Address", is_repairable: "Repairable", repair_facility: "Repair Facility", repair_facility_comments: "Repair Facility Comments", cause_of_loss_summary: "Cause of Loss", appraiser_comments: "Appraiser Comments" },
    fr: { reportDetails: "Détails du rapport", claim_number: "Numéro de sinistre", policy_number: "Numéro de police", date_received: "Date de réception", date_of_loss: "Date du sinistre", reported_loss_type: "Type de sinistre déclaré", next_report_due: "Prochain rapport prévu", insured_name: "Assuré", adjuster_name: "Expert en sinistres", appraiser_phone: "Téléphone de l’évaluateur", appraiser_email: "Courriel de l’évaluateur", company_address: "Adresse de l’entreprise", is_repairable: "Réparable", repair_facility: "Atelier de réparation", repair_facility_comments: "Commentaires de l’atelier", cause_of_loss_summary: "Cause du sinistre", appraiser_comments: "Commentaires de l’évaluateur" },
    es: { reportDetails: "Detalles del informe", claim_number: "Número de reclamación", policy_number: "Número de póliza", date_received: "Fecha de recepción", date_of_loss: "Fecha del siniestro", reported_loss_type: "Tipo de siniestro informado", next_report_due: "Próximo informe", insured_name: "Asegurado", adjuster_name: "Ajustador", appraiser_phone: "Teléfono del tasador", appraiser_email: "Correo del tasador", company_address: "Dirección de la empresa", is_repairable: "Reparable", repair_facility: "Taller de reparación", repair_facility_comments: "Comentarios del taller", cause_of_loss_summary: "Causa del siniestro", appraiser_comments: "Comentarios del tasador" },
  }[lang];
  const textParagraph = (value: unknown) => new Paragraph({ children: safe(value).split(/\r?\n/).map((text, index) => new TextRun({ text, ...(index ? { break: 1 } : {}) })) });
  const contentsLabels = {
    en: { title: "Table of Contents", instruction: "Select a section to go directly to it." },
    fr: { title: "Table des matières", instruction: "Sélectionnez une section pour y accéder directement." },
    es: { title: "Tabla de contenido", instruction: "Seleccione una sección para ir directamente a ella." },
  }[lang];
  const contentsEntries: Array<{ text: string; level: 1 | 2; anchor: string }> = [];
  const sectionHeading = (text: string, level: 1 | 2 = 1, pageBreakBefore = false) => {
    const anchor = `salvage_section_${contentsEntries.length + 1}`;
    contentsEntries.push({ text, level, anchor });
    return new Paragraph({
      heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
      pageBreakBefore, keepNext: true,
      children: [new Bookmark({ id: anchor, children: [new TextRun(text)] })],
    });
  };

  // Match the PDF's A4 printable width, with report-local Word styles.
  const contentWidthTw = contentWidth;

  // Load logo (optional)
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }

  const title = tt.title;
  const ccy = String((reportData as any)?.currency || "CAD");
  const fmv = safe(reportData?.valuation?.fairMarketValue);
  const fmvFormatted = fmv ? formatMoneyStrict(fmv, ccy) : "";
  const reportDate = formatSalvageDate(reportData?.report_date, lang);
  const fileNo = safe(reportData?.file_number);
  const appraiser = safe(reportData?.appraiser_name);
  const company = safe(reportData?.company_name);

  const imageUrls: string[] = Array.isArray((reportData as any)?.imageUrls)
    ? (reportData as any).imageUrls
    : [];
  const photos = await prepareSalvagePhotos(imageUrls);

  // Comparables table
  const comps = Array.isArray(reportData?.comparableItems)
    ? (reportData?.comparableItems as any[])
    : [];
  // Preserve comparable source order; the valuation discussion and visible table
  // use row position as the common evidence sequence.
  const compsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [42, 17, 24, 17],
    rows: [
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: [
          headerCell(tt.compsColumns.title), headerCell(tt.compsColumns.price, true),
          headerCell(tt.compsColumns.location), headerCell(tt.compsColumns.link),
        ],
      }),
      ...comps.map(
        (c) =>
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph(safe(c?.title) || "—")],
              }),
              new TableCell({
                children: [numericParagraph(safe(c?.price) || "—")],
              }),
              new TableCell({
                children: [new Paragraph(safe(c?.location) || "—")],
              }),
              new TableCell({
                children: [new Paragraph({ children: /^https?:\/\//i.test(safe(c?.link)) ? [new ExternalHyperlink({
                  link: c.link, children: [new TextRun({ text: lang === "fr" ? "Voir l’annonce" : lang === "es" ? "Ver anuncio" : "View listing", color: "C8102E", underline: {} })],
                })] : [new TextRun("—")] })],
              }),
            ],
          })
      ),
    ],
  });

  // Main document content
  // Children are appended in deterministic legal reading order before Word applies
  // client- and font-dependent pagination during rendering.
  const children: Array<Paragraph | Table> = [];
  const enrichment = salvageReportSections(reportData);
  const appendEnrichment = (sections: SalvageReportSection[]) => {
    const evidenceParagraph = (text: string) => {
      const runs = text.split(/\r?\n/).flatMap((line, index) => {
        const link = safeSalvageReportLink(line);
        return [...(index ? [new TextRun({ text: '', break: 1 })] : []), link
          ? new ExternalHyperlink({ link, children: [new TextRun({ text: line, color: "C8102E", underline: {} })] })
          : new TextRun(line)];
      });
      return new Paragraph({ children: runs });
    };
    for (const section of sections) {
      children.push(sectionHeading(section.title));
      children.push(...section.paragraphs.map(textParagraph));
      for (const table of section.tables) {
        if (!table.headers.length) continue;
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: table.headers.map(() => 1),
          rows: [new TableRow({ tableHeader: true, cantSplit: true,
            children: table.headers.map(label => headerCell(label)) }),
          ...table.rows.map(row => new TableRow({ cantSplit: !salvageReportRowNeedsSplit(row), children: table.headers.map((_, index) =>
            new TableCell({ children: [evidenceParagraph(row[index] ?? "")] })) }))],
        }));
        // A paragraph separates adjacent tables so Word does not merge headers.
        children.push(new Paragraph({ spacing: { before: 0, after: 70, line: 70 } }));
      }
    }
  };

  // Report Summary
  children.push(sectionHeading(tt.reportSummary));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.preparedFor)] }),
            new TableCell({ children: [new Paragraph(company || "—")] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.appraiser)] }),
            new TableCell({ children: [new Paragraph(appraiser || "—")] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.reportDate)] }),
            new TableCell({ children: [new Paragraph(reportDate || "—")] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fileNumber)] }),
            new TableCell({ children: [new Paragraph(fileNo || "—")] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.totalValue)] }),
            new TableCell({ children: [numericParagraph(fmvFormatted || "—")] }),
          ],
        }),
      ],
    })
  );

  appendEnrichment(enrichment.executive);

  // Required claim/contact fields belong in every generated format, not only PDF.
  children.push(sectionHeading(detailLabels.reportDetails));
  const metadataFields = ["claim_number", "policy_number", "date_received", "date_of_loss", "reported_loss_type", "next_report_due", "insured_name", "adjuster_name", "appraiser_phone", "appraiser_email", "company_address"] as const;
  const metadataRows: TableRow[] = [];
  for (let index = 0; index < metadataFields.length; index += 2) {
    metadataRows.push(new TableRow({ cantSplit: true, children: [0, 1].flatMap(offset => {
      const key = metadataFields[index + offset];
      const value = key && ["date_received", "date_of_loss", "next_report_due"].includes(key) ? formatSalvageDate(reportData[key], lang) : key ? safe(reportData[key]) : "";
      if (!key) return [];
      const unpaired = offset === 0 && !metadataFields[index + 1];
      return [new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: detailLabels[key], bold: true })] })] }), new TableCell({ columnSpan: unpaired ? 3 : 1, children: [textParagraph(value || "—")] })];
    }) }));
  }
  children.push(new Table({ width: { size: contentWidthTw, type: WidthType.DXA }, columnWidths: [1800, 3240, 1800, 3240], rows: metadataRows }));

  // Asset Details
  children.push(sectionHeading(tt.assetDetails));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.itemType)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.item_type) ||
                    safe(reportData?.aiExtractedDetails?.item_type) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.year)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.year) ||
                    safe(reportData?.aiExtractedDetails?.year) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.make)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.make) ||
                    safe(reportData?.aiExtractedDetails?.make) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.model)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.item_model) ||
                    safe(reportData?.aiExtractedDetails?.item_model) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.vin)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.vin) ||
                    safe(reportData?.aiExtractedDetails?.vin) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.fields.condition)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.item_condition) ||
                    safe(reportData?.aiExtractedDetails?.item_condition) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph(tt.fields.damageDescription)],
            }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.damage_description) ||
                    safe(reportData?.aiExtractedDetails?.damage_description) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph(tt.fields.inspectionComments)],
            }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.inspection_comments) ||
                    safe(reportData?.aiExtractedDetails?.inspection_comments) ||
                    "—"
                ),
              ],
            }),
          ],
        }),
      ],
    })
  );

  children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: (["is_repairable", "repair_facility", "repair_facility_comments"] as const).map(key =>
    new TableRow({ children: [new TableCell({ children: [new Paragraph(detailLabels[key])] }), new TableCell({ children: [textParagraph(reportData[key] || "—")] })] })) }));
  for (const key of ["cause_of_loss_summary", "appraiser_comments"] as const) if (safe(reportData[key])) {
    children.push(sectionHeading(detailLabels[key], 2), textParagraph(reportData[key]));
  }

  // Repair Estimate
  if (!enrichment.canonicalRepair) {
  const re = (reportData?.aiExtractedDetails?.repair_estimate ||
    reportData?.repair_estimate ||
    {}) as any;
  children.push(sectionHeading(tt.repairEstimate));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.repair.parts)] }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.parts, ccy) || "—"),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph(tt.repair.lessBetterment)],
            }),
            new TableCell({
              children: [
                numericParagraph(
                  re?.less_betterment != null && re?.less_betterment !== ""
                    ? `- ${formatMoneyStrict(re?.less_betterment, ccy)}`
                    : "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.repair.labour)] }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.labour, ccy) || "—"),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph(tt.repair.shopSupplies)],
            }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.shop_supplies, ccy) || "—"),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph(tt.repair.miscellaneous)],
            }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.miscellaneous, ccy) || "—"),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.repair.taxes)] }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.taxes, ccy) || "—"),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.repair.total)] }),
            new TableCell({
              children: [
                numericParagraph(formatMoneyStrict(re?.total, ccy) || "—"),
              ],
            }),
          ],
        }),
      ],
    })
  );

  // Itemized details (Parts & Labour) and composition
  const toNum = (v: any): number => {
    try {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const p = Number(v.replace(/[^0-9.\-]/g, ""));
        return Number.isFinite(p) ? p : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  };
  const partsItems: any[] = Array.isArray((reportData as any)?.repair_items)
    ? ((reportData as any)?.repair_items as any[])
    : (Array.isArray((re as any)?.parts_items) ? (re as any)?.parts_items : []);
  const labourBreakdown: any[] = Array.isArray((reportData as any)?.labour_breakdown)
    ? ((reportData as any)?.labour_breakdown as any[])
    : (Array.isArray((re as any)?.labour_breakdown) ? (re as any)?.labour_breakdown : []);
  const labourRateDefault = toNum((reportData as any)?.labour_rate_default ?? (re as any)?.labour_rate_default);

  const partsSubtotalCalc = partsItems.reduce((sum, it: any) => sum + toNum(it?.line_total ?? (toNum(it?.quantity) * toNum(it?.unit_price))), 0);
  const labourTotalCalc = labourBreakdown.reduce((sum, it: any) => {
    const rate = toNum(it?.rate_per_hour ?? labourRateDefault);
    const hours = toNum(it?.hours);
    const line = toNum(it?.line_total ?? hours * rate);
    return sum + line;
  }, 0);
  const totalHoursCalc = labourBreakdown.reduce((sum, it: any) => sum + toNum(it?.hours), 0);

  const partsSubtotal = toNum((reportData as any)?.parts_subtotal ?? (re as any)?.parts_subtotal ?? partsSubtotalCalc);
  const labourTotal = toNum((reportData as any)?.labour_total ?? (re as any)?.labour_total ?? labourTotalCalc);
  const lessBetterment = toNum((re as any)?.less_betterment);
  const shopSupplies = toNum((re as any)?.shop_supplies);
  const miscellaneous = toNum((re as any)?.miscellaneous);
  const taxes = toNum((re as any)?.taxes);
  const grandTotal = toNum((re as any)?.total ?? (partsSubtotal + labourTotal + shopSupplies + miscellaneous + taxes - lessBetterment));

  // Itemized Parts
  children.push(sectionHeading(tt.itemizedPartsHeading, 2));
  children.push(new Paragraph({ text: reportData.estimate_warning, spacing: { after: 100 } }));
  if (partsItems.length > 0) {
    const partRows: TableRow[] = [];
    // Header
    partRows.push(
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: [
          headerCell(tt.partsColumns.item), headerCell(tt.partsColumns.qty, true),
          headerCell(tt.partsColumns.unitPrice, true), headerCell(tt.partsColumns.lineTotal, true),
          headerCell(tt.partsColumns.vendor),
        ],
      })
    );
    for (const it of partsItems) {
      const qty = toNum(it?.quantity);
      const unit = toNum(it?.unit_price);
      const line = toNum(it?.line_total ?? qty * unit);
      partRows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({ children: [new Paragraph(safe(it?.name) || "—"), new Paragraph(`${tt.partsColumns.sku}: ${safe(it?.sku) || "—"}`), new Paragraph(safe(it?.oem_or_aftermarket) || "—")] }),
            new TableCell({ children: [numericParagraph(String(qty || 0))] }),
            new TableCell({ children: [numericParagraph(formatMoneyStrict(unit, ccy) || "—")] }),
            new TableCell({ children: [numericParagraph(formatMoneyStrict(line, ccy) || "—")] }),
            new TableCell({ children: [new Paragraph(safe(it?.vendor) || "—"),
              new Paragraph({ children: /^https?:\/\//i.test(safe(it?.vendor_link)) ? [new ExternalHyperlink({ link: it.vendor_link,
                children: [new TextRun({ text: lang === "fr" ? "Voir l’annonce" : lang === "es" ? "Ver anuncio" : "View listing", color: "C8102E" })] })] : [] }),
              new Paragraph(`${tt.partsColumns.leadTime}: ${safe(it?.lead_time_days) || "—"}`)] }),
          ],
        })
      );
      if (safe(it?.notes)) partRows.push(new TableRow({ children: [new TableCell({ columnSpan: 5,
        children: [textParagraph(tt.partsColumns.notes + ": " + safe(it.notes))],
      })] }));
    }
    children.push(
      new Table({ width: { size: contentWidthTw, type: WidthType.DXA }, columnWidths: [32, 8, 17, 18, 25], rows: partRows })
    );
  } else {
    children.push(new Paragraph({ text: "—" }));
  }

  // Labour Breakdown
  children.push(sectionHeading(tt.labourBreakdownHeading, 2));
  if (labourBreakdown.length > 0) {
    const labRows: TableRow[] = [];
    labRows.push(
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: [
          headerCell(tt.labourColumns.task), headerCell(tt.labourColumns.hours, true),
          headerCell(tt.labourColumns.rate, true), headerCell(tt.labourColumns.lineTotal, true),
          headerCell(tt.labourColumns.notes),
        ],
      })
    );
    for (const it of labourBreakdown) {
      const hours = toNum(it?.hours);
      const rate = toNum(it?.rate_per_hour ?? labourRateDefault);
      const line = toNum(it?.line_total ?? hours * rate);
      labRows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({ children: [new Paragraph(safe(it?.task) || "—")] }),
            new TableCell({ children: [numericParagraph(String(hours || 0))] }),
            new TableCell({ children: [numericParagraph(formatMoneyStrict(rate, ccy) || "—")] }),
            new TableCell({ children: [numericParagraph(formatMoneyStrict(line, ccy) || "—")] }),
            new TableCell({ children: [new Paragraph(safe(it?.notes) || "")] }),
          ],
        })
      );
    }
    children.push(
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [3100, 900, 1500, 1500, 3080], rows: labRows })
    );
  } else {
    children.push(new Paragraph({ text: "—" }));
  }

  // Estimate Composition Summary
  children.push(sectionHeading(tt.estimateComposition, 2));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.partsSubtotal)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(partsSubtotal, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.labourTotal)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(labourTotal, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.totalHours)] }), new TableCell({ children: [numericParagraph(String(totalHoursCalc))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.lessBetterment)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(lessBetterment, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.shopSupplies)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(shopSupplies, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.miscellaneous)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(miscellaneous, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.taxes)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(taxes, ccy))] }) ] }),
        new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.compositionRows.grandTotal)] }), new TableCell({ children: [numericParagraph(formatMoneyStrict(grandTotal, ccy))] }) ] }),
      ],
    })
  );

  }
  // Manager Notes
  const procurementNotes = safe((reportData as any)?.procurement_notes) || safe((reportData as any)?.aiExtractedDetails?.procurement_notes);
  const safetyConcerns = safe((reportData as any)?.safety_concerns) || safe((reportData as any)?.aiExtractedDetails?.safety_concerns);
  const assumptions = safe((reportData as any)?.assumptions) || safe((reportData as any)?.aiExtractedDetails?.assumptions);
  const priorityLevel = safe((reportData as any)?.priority_level) || safe((reportData as any)?.aiExtractedDetails?.priority_level);
  if (procurementNotes || safetyConcerns || assumptions || priorityLevel) {
    children.push(sectionHeading(tt.managerNotesHeading, 2));
    const notesRows: TableRow[] = [];
    if (procurementNotes) notesRows.push(new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.procurementNotes)] }), new TableCell({ children: [ new Paragraph(String(procurementNotes)) ] }) ] }));
    if (safetyConcerns) notesRows.push(new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.safetyConcerns)] }), new TableCell({ children: [ new Paragraph(String(safetyConcerns)) ] }) ] }));
    if (assumptions) notesRows.push(new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.assumptions)] }), new TableCell({ children: [ new Paragraph(String(assumptions)) ] }) ] }));
    if (priorityLevel) notesRows.push(new TableRow({ children: [ new TableCell({ children: [new Paragraph(tt.priorityLevel)] }), new TableCell({ children: [ new Paragraph(String(priorityLevel)) ] }) ] }));
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: notesRows }));
  }

  // Comparables
  if (!enrichment.canonicalComparables) {
  children.push(sectionHeading(tt.comparablesHeading));
  children.push(compsTable);

  // Each comparable retains only its own evidence. Pair short fields and let
  // lengthy observations span the row instead of creating empty union columns.
  for (const comp of comps) {
    const entries = Object.entries(comp?.details && typeof comp.details === "object" ? comp.details : {});
    if (!entries.length) continue;
    const rows: TableRow[] = [new TableRow({ tableHeader: true, cantSplit: true, children: [
      new TableCell({ columnSpan: 4, shading: { fill: "EEF0F2" },
        children: [new Paragraph({ children: [new TextRun({ text: safe(comp.title), bold: true, color: "202126" })] })] }),
    ] })];
    for (let index = 0; index < entries.length;) {
      const [label, value] = entries[index++]!;
      const wide = label.length > 35 || safe(value).length > 100;
      const next = entries[index];
      const paired = !wide && next && next[0].length <= 35 && safe(next[1]).length <= 100;
      const fieldCells = (key: string, val: unknown, span = 1) => [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: key, bold: true, color: "64666D" })] })] }),
        new TableCell({ columnSpan: span, children: [textParagraph(safe(val) || (lang === "fr" ? "Introuvable" : lang === "es" ? "No encontrado" : "Not Found"))] }),
      ];
      rows.push(new TableRow({ children: [
        ...fieldCells(label, value, paired ? 1 : 3),
        ...(paired ? fieldCells(next[0], next[1]) : []),
      ] }));
      if (paired) index++;
    }
    children.push(new Paragraph({ spacing: { before: 0, after: 60 } }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [20, 30, 20, 30], rows }));
  }

  }
  // Valuation Summary
  if (!enrichment.canonicalValuation) {
  children.push(sectionHeading(tt.valuationSummary));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.totalValue)] }),
            new TableCell({ children: [numericParagraph(fmvFormatted || "—")] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.confidence)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(reportData?.valuation?.confidence_level) || "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.recommendedReserve)] }),
            new TableCell({
              children: [
                numericParagraph(
                  formatMoneyStrict(
                    reportData?.aiExtractedDetails?.recommended_reserve,
                    ccy
                  ) || "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.actualCashValue)] }),
            new TableCell({
              children: [
                numericParagraph(
                  formatMoneyStrict(
                    reportData?.aiExtractedDetails?.actual_cash_value,
                    ccy
                  ) || "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.replacementCost)] }),
            new TableCell({
              children: [
                numericParagraph(
                  formatMoneyStrict(
                    reportData?.aiExtractedDetails?.replacement_cost,
                    ccy
                  ) || "—"
                ),
              ],
            }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(tt.references)] }),
            new TableCell({
              children: [
                new Paragraph(
                  safe(
                    reportData?.aiExtractedDetails?.replacement_cost_references
                  ) || "—"
                ),
              ],
            }),
          ],
        }),
      ],
    })
  );
  if (safe(reportData?.valuation?.summary)) {
    children.push(sectionHeading(tt.summary, 2));
    children.push(
      new Paragraph({ text: safe(reportData?.valuation?.summary) })
    );
  }

  // Specialty Valuation Data (Client vs Comparable 1 vs Adjustments)
  const specI18n = {
    en: { header: "Specialty Valuation Data", field: "Field", client: "Client Vehicle", comp1: "Comparable 1", adj: "Adjustments", notFound: "Not Found" },
    fr: { header: "Données d'évaluation spécialisées", field: "Champ", client: "Véhicule du client", comp1: "Comparable 1", adj: "Ajustements", notFound: "Introuvable" },
    es: { header: "Datos de valoración especializada", field: "Campo", client: "Vehículo del cliente", comp1: "Comparable 1", adj: "Ajustes", notFound: "No encontrado" },
  } as const;
  const spec = (specI18n as any)[lang] as typeof specI18n.en;

  children.push(sectionHeading(spec.header));
  const sd: any = (reportData as any)?.specialty_data || (reportData as any)?.aiExtractedDetails?.specialty_data || {};
  const clientMap: Record<string, any> = (sd && typeof sd.client_vehicle === 'object' && sd.client_vehicle) || {};
  const compMap: Record<string, any> = (sd && typeof sd.comparable_1 === 'object' && sd.comparable_1) || {};
  const adjMap: Record<string, any> = (sd && typeof sd.adjustments === 'object' && sd.adjustments) || {};
  const labelSet = new Set<string>([...Object.keys(clientMap), ...Object.keys(compMap), ...Object.keys(adjMap)]);
  const labels = Array.from(labelSet);
  if (labels.length === 0) {
    // Fallback single row
    labels.push("YEAR");
  }
  const specRows: TableRow[] = [];
  // Header row
  specRows.push(
    new TableRow({
      tableHeader: true, cantSplit: true,
      children: [
        headerCell(spec.field), headerCell(spec.client), headerCell(spec.comp1), headerCell(spec.adj, true),
      ],
    })
  );
  for (const key of labels) {
    const cv = safe(clientMap?.[key]) || spec.notFound;
    const cp = safe(compMap?.[key]) || spec.notFound;
    const adjRaw = (adjMap as any)?.[key];
    const adjTxt = Number.isFinite(adjRaw)
      ? formatMoneyStrict(adjRaw, ccy)
      : (typeof adjRaw === 'string' && adjRaw.trim()) ? adjRaw : '0';
    specRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(String(key))] }),
          new TableCell({ children: [new Paragraph(String(cv))] }),
          new TableCell({ children: [new Paragraph(String(cp))] }),
          new TableCell({ children: [numericParagraph(String(adjTxt))] }),
        ],
      })
    );
  }
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [2400, 2840, 2840, 2000],
      rows: specRows,
    })
  );

  }
  appendEnrichment(enrichment.body);

  // Explicit page groups preserve all originals in order. A fifth photo spans
  // both columns; partial groups contain no fabricated/empty image cells.
  const galleryLabel = lang === "es" ? "Imágenes" : "Images";
  for (let offset = 0; offset < photos.length; offset += 5) {
    const group = photos.slice(offset, offset + 5);
    children.push(offset === 0 ? sectionHeading(galleryLabel, 1, true)
      : new Paragraph({ text: galleryLabel, style: "GalleryTitle", pageBreakBefore: true }));
    children.push(new Paragraph({ text: (offset + 1) + "-" + (offset + group.length) + " / " + photos.length,
      spacing: { before: 0, after: 100 } }));
    const rows: TableRow[] = [];
    const maxImageHeight = (group.length === 1 ? 190 : group.length === 2 ? 115 : group.length <= 4 ? 87 : 57) * 96 / 25.4;
    for (let index = 0; index < group.length;) {
      const span = group.length - index === 1 ? 2 : 1;
      const count = span === 2 ? 1 : 2;
      const cells = group.slice(index, index + count).map((photo, col) => {
        const number = offset + index + col + 1;
        const maxWidth = (span === 2 ? 164 : 77) * 96 / 25.4;
        const scale = Math.min(maxWidth / photo.width, maxImageHeight / photo.height);
        return new TableCell({
          columnSpan: span,
          margins: { top: 110, bottom: 110, left: 110, right: 110 },
          children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 50 },
              children: [new ImageRun({ type: "jpg", data: photo.buffer,
                transformation: { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale) },
                altText: { title: "Photo " + number, description: "Salvage report photo " + number, name: "Photo " + number },
              })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
              children: [new TextRun({ text: number + " / " + photos.length, size: 16, color: "64666D" })] }),
          ],
        });
      });
      rows.push(new TableRow({ cantSplit: true, children: cells }));
      index += count;
    }
    children.push(new Table({ width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: [1, 1], rows }));
  }

  appendEnrichment(enrichment.references);

  // A final-page reference works in Word and LibreOffice (SECTIONPAGES is not
  // implemented by every viewer). This tiny trailing bookmark has no visible ink.
  children.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20 },
    children: [new Bookmark({ id: "salvage_report_end", children: [new TextRun({ text: "", size: 2 })] })] }));

  // Only the cover is a flattened design plate. Every value also appears in
  // editable body text. Reuse prepared bytes: no second photo fetch/conversion.
  const coverPlate = await renderSalvageDocxCover(reportData, photos);
  const pageArt = (buffer: Buffer, description: string) => new ImageRun({
    type: "png", data: buffer,
    transformation: { width: 210 * 96 / 25.4, height: 297 * 96 / 25.4 },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
      behindDocument: true, allowOverlap: true, layoutInCell: false,
    },
    altText: { title: description, description, name: description },
  });
  const cover = [new Paragraph({ spacing: { before: 0, after: 0 },
    children: [pageArt(coverPlate, title + " — Salvage cover photo composition")] })];
  const pageHeader = () => new Header({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 },
    children: [
      ...(logoBuffer ? [new ImageRun({ type: "jpg", data: logoBuffer,
        transformation: { width: 132, height: 33 },
        altText: { title: "McDougall Auctioneers", description: "Company logo", name: "Company logo" },
      })] : [new TextRun({ text: "McDougall Auctioneers", bold: true })]),
    ],
  })] });
  const confidential = lang === "fr" ? "Confidentiel" : lang === "es" ? "Confidencial" : "Confidential";
  const pageFooter = (numbered: boolean) => {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    return new Footer({ children: [new Table({
      width: { size: contentWidth, type: WidthType.DXA }, columnWidths: [76, 24],
      borders: { top: tableBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
      rows: [new TableRow({ cantSplit: true, children: [
        new TableCell({ margins: { top: 120, bottom: 0, left: 0, right: 0 }, children: [
          new Paragraph({ style: "FooterText", text: title + "  |  " + (fileNo || "—") + "  ·  " + confidential }),
        ] }),
        new TableCell({ margins: { top: 120, bottom: 0, left: 0, right: 0 }, children: [
          new Paragraph({ style: "FooterText", alignment: AlignmentType.RIGHT, children: numbered ? [
            new TextRun(tt.page), new SimpleField("PAGE"),
            new TextRun(lang === "en" ? " of " : " / "), new SimpleField("PAGEREF salvage_report_end"),
          ] : [] }),
        ] }),
      ] })],
    })] });
  };

  // Live page references, not PDF numbers copied into a differently paginated
  // document. Word refreshes these on open; links remain usable in mobile viewers.
  const contents: Paragraph[] = [
    new Paragraph({ text: contentsLabels.title, style: "ContentsTitle" }),
    ...contentsEntries.map(({ text, level, anchor }, index) => new Paragraph({
      style: level === 1 ? "Contents1" : "Contents2",
      tabStops: [{ type: TabStopType.RIGHT, position: contentWidth - 20, leader: LeaderType.DOT }],
      children: [
        new InternalHyperlink({ anchor, children: [
          new TextRun({ text: String(index + 1).padStart(2, "0") + "  ", color: "64666D", size: 17 }),
          new TextRun({ text, color: "202126", size: 21 }),
        ] }),
        new TextRun("\t"),
        new SimpleField("PAGEREF " + anchor + " \\h"),
      ],
    })),
  ];
  const page = {
    size: { width: mm(210), height: mm(297) },
    margin: { top: mm(28), bottom: mm(22), left: mm(18), right: mm(18), header: mm(10), footer: mm(10) },
  };
  const doc = new Document({
    title, creator: appraiser || "Asset Insight",
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 19, color: "202126" },
          paragraph: { spacing: { line: 260, before: 0, after: 60 } },
        },
        // Configure the built-in styles directly, avoiding duplicate Heading
        // IDs whose winning colour/spacing differs between Word readers.
        heading1: { basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 27, bold: true, color: "202126" },
          paragraph: { keepNext: true, spacing: { before: 230, after: 140 } } },
        heading2: { basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 23, bold: true, color: "202126" },
          paragraph: { keepNext: true, spacing: { before: 170, after: 100 } } },
      },
      paragraphStyles: [
        { id: "FooterText", name: "Footer Text", basedOn: "Normal", next: "Normal",
          run: { size: 15, color: "64666D" }, paragraph: { spacing: { before: 0, after: 0, line: 220 } } },
        { id: "Normal", name: "Normal", next: "Normal",
          run: { font: "Arial", size: 19, color: "202126" },
          paragraph: { spacing: { line: 260, after: 60 } } },
        { id: "ContentsTitle", name: "Contents Title", basedOn: "Normal", next: "Normal",
          run: { size: 42, bold: true, color: "202126" },
          paragraph: { keepNext: true, spacing: { before: 100, after: 340 } } },
        { id: "Contents1", name: "Contents Level 1", basedOn: "Normal", next: "Normal",
          paragraph: { spacing: { before: 70, after: 110 } } },
        { id: "Contents2", name: "Contents Level 2", basedOn: "Contents1", next: "Normal" },
        { id: "GalleryTitle", name: "Gallery Title", basedOn: "Heading1", next: "Normal",
          paragraph: { outlineLevel: 9 } },
      ],
    },
    sections: [
      { properties: { page: { ...page, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
        headers: { default: new Header({ children: [] }) }, footers: { default: new Footer({ children: [] }) },
        children: cover },
      { properties: { page },
        headers: { default: pageHeader() }, footers: { default: pageFooter(false) },
        children: contents },
      { properties: { page: { ...page, pageNumbers: { start: 1 } } },
        headers: { default: pageHeader() }, footers: { default: pageFooter(true) },
        children },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
