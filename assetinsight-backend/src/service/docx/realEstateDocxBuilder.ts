import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
  SectionType,
  BorderStyle,
  TableLayoutType,
} from "docx";
import fs from "fs/promises";
import path from "path";
import {
  buildKeyValueTable,
  goldDivider,
  formatDateUS,
  formatMonthYear,
} from "./builders/utils.js";
import { buildHeaderTable, buildFooterTable, buildFooterTableWithoutPageNumber } from "./builders/header.js";
import { buildRealEstateCover } from "./builders/realEstate/cover.js";
import { buildRealEstateComparisonTables } from "./builders/realEstate/comparisonTables.js";
import { finalizeRealEstateDocxLayout, REAL_ESTATE_TOC_MARKER } from "./realEstateDocxLayout.js";
import { buildAppendixPhotoGallery } from "./builders/appendix.js";
import { buildMarketOverview } from "./builders/marketOverview.js";
// Import comprehensive real estate section builders
import {
  buildMarketValueConclusion,
  buildCertificationSection,
  buildAssumptionsSection,
  buildScopeOfAppraisal,
  buildBasisOfAppraisal,
  buildFactualInformation,
  buildSiteDescription,
  buildHighestBestUse,
  buildValuationAnalysis,
  buildMarketContext,
  buildConclusions,
  buildAddenda,
  buildRealEstateCertificate,
} from "./builders/realEstate/index.js";

/**
 * Production real-estate report orchestrator. It normalizes legacy field shapes,
 * localizes fixed copy, delegates domain chapters, and assembles front matter and
 * the numbered report at explicit Word section/merge boundaries.
 */
function pageBreak(): Paragraph {
  return new Paragraph({
    children: [new TextRun("")],
    pageBreakBefore: true,
  });
}

function safe(val?: any): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

function getCompVal(obj: any, key: string, alt?: string): string {
  if (!obj) return "";
  if (obj[key] !== undefined && obj[key] !== null) return String(obj[key]);
  if (alt && obj[alt] !== undefined && obj[alt] !== null)
    return String(obj[alt]);
  // Try case-insensitive fallback
  const lowerKey = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lowerKey) return String(obj[k]);
  }
  return "";
}

function buildRealEstateTransmittal(
  tt: any,
  owner: string,
  addr: string,
  inspectorName: string,
  inspectorCompany: string,
  reportDate: string
): Paragraph[] {
  const children: Paragraph[] = [];
  children.push(
    new Paragraph({
      text: tt.transmittalHeading,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: reportDate })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 140 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: owner || "—", bold: true })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: `${tt.dear} ${owner || "—"},` })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: tt.transmittalP1(addr || "—") })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 110 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: tt.transmittalP2 })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 110 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: tt.transmittalP3 })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 110 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: tt.transmittalP4 })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: tt.sincerely + "," })],
      keepLines: true,
      keepNext: true,
      spacing: { before: 60, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: inspectorName })],
      keepLines: true,
      keepNext: true,
      spacing: { after: 60 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: inspectorCompany, bold: true })],
    })
  );
  return children;
}

export async function generateRealEstateDocx(reportData: any): Promise<Buffer> {
  // Some chapter builders predate the nested preview schema. Supply display
  // aliases without changing the caller's saved snapshot or overriding edits.
  const property = reportData?.property_details || {};
  reportData = {
    ...reportData,
    address: reportData?.address || property.address,
    legal_description: reportData?.legal_description || property.legal_description || property.land_description,
    municipality: reportData?.municipality || property.municipality,
    zoning: reportData?.zoning || property.zoning,
    assessed_value: reportData?.assessed_value ?? property.assessed_value,
    annual_taxes: reportData?.annual_taxes ?? property.annual_taxes,
    inspection_date: reportData?.inspection_date || reportData?.report_dates?.inspection_date,
    report_date: reportData?.report_date || reportData?.report_dates?.report_date,
    effective_date: reportData?.effective_date || reportData?.report_dates?.effective_date,
  };
  // Normalize locale once; all chapter builders and fixed labels must use the
  // same language to avoid partially translated appraisal output.
  const lang: "en" | "fr" | "es" = ((): any => {
    const l = String((reportData as any)?.language || "").toLowerCase();
    return l === "fr" || l === "es" ? l : "en";
  })();

  const t = {
    en: {
      title: "Real Estate Valuation Report",
      reportSummary: "Report Summary",
      preparedFor: "Prepared for",
      reportDate: "Report Date",
      page: "Page ",
      valuationSummary: "Valuation Summary",
      methodology: "Methodology",
      valueSource: "Value Source",
      comparableListPrice: "Comparable List Price",
      comparableUsed: "Comparable Used",
      finalEstimateSummary: "Final Estimate Summary",
      finalEstimateValue: "Final Estimate (Words)",
      transmittalHeading: "Transmittal Letter",
      dear: "Dear",
      transmittalP1: (addr: string) => `Re: Evaluation of ${addr}`,
      transmittalP2:
        "At your request, we have prepared a real estate report of certain real estate owned by you, a copy of which is enclosed. This report is intended for your exclusive use along with your chosen agent and is intended only for establishing values of the subject property.",
      transmittalP3:
        "The subject property was evaluated under the premise of Fair Market Value for internal consideration. The cost and market approaches to value have been considered for this report and have either been utilized where necessary or deemed inappropriate for the value conclusions found therein.",
      transmittalP4:
        "After a thorough analysis of the property and information made available to us, it is our opinion that as of the Effective Date, this property has a Fair Market Value as shown on the certificate included.",
      sincerely: "Sincerely",
      certificateHeading: "Certificate of Value",
      totalValue: "Fair Market Value",
      scheduleA: 'Schedule "A" - Property Details',
      comparablesHeading: "Comparable Properties",
      feature: "Feature",
      subject: "Subject Property",
      features: {
        address: "Address",
        listPrice: "List Price",
        squareFootage: "Square Footage",
        lotSize: "Lot Size",
        rooms: "Rooms/Bedrooms",
        bathrooms: "Bathrooms",
        adjustedValue: "Adjusted Value",
      },
    },
    fr: {
      title: "Rapport d'évaluation immobilière",
      reportSummary: "Résumé du rapport",
      preparedFor: "Préparé pour",
      reportDate: "Date du rapport",
      page: "Page ",
      valuationSummary: "Résumé de l’évaluation",
      methodology: "Méthodologie",
      valueSource: "Source de la valeur",
      comparableListPrice: "Prix affiché du comparable",
      comparableUsed: "Comparable utilisé",
      finalEstimateSummary: "Résumé de l’estimation finale",
      finalEstimateValue: "Estimation finale (en toutes lettres)",
      transmittalHeading: "Lettre d’envoi",
      dear: "Madame, Monsieur",
      transmittalP1: (addr: string) => `Objet : Évaluation de ${addr}`,
      transmittalP2:
        "À votre demande, nous avons préparé un rapport immobilier concernant un bien vous appartenant, dont copie est jointe. Ce rapport est destiné à votre usage exclusif ainsi qu’à celui de votre mandataire et uniquement à l’établissement de la valeur du bien évalué.",
      transmittalP3:
        "Le bien a été évalué selon l’hypothèse de la Juste Valeur Marchande, à des fins internes. Les approches par le coût et par le marché ont été prises en compte et utilisées lorsque cela était nécessaire pour les conclusions de valeur présentées.",
      transmittalP4:
        "Après une analyse approfondie du bien et des informations mises à notre disposition, nous estimons qu’à la date d’effet, ce bien a la valeur marchande indiquée dans le certificat inclus.",
      sincerely: "Cordialement",
      certificateHeading: "Certificat de valeur",
      totalValue: "Valeur marchande",
      scheduleA: 'Annexe "A" - Détails du bien',
      comparablesHeading: "Biens comparables",
      feature: "Caractéristique",
      subject: "Bien sujet",
      features: {
        address: "Adresse",
        listPrice: "Prix affiché",
        squareFootage: "Superficie (pi²)",
        lotSize: "Superficie du lot",
        rooms: "Pièces/Chambres",
        bathrooms: "Salles de bain",
        adjustedValue: "Valeur ajustée",
      },
    },
    es: {
      title: "Informe de valoración inmobiliaria",
      reportSummary: "Resumen del informe",
      preparedFor: "Preparado para",
      reportDate: "Fecha del informe",
      page: "Página ",
      valuationSummary: "Resumen de la valoración",
      methodology: "Metodología",
      valueSource: "Fuente del valor",
      comparableListPrice: "Precio de lista del comparable",
      comparableUsed: "Comparable utilizado",
      finalEstimateSummary: "Resumen de la estimación final",
      finalEstimateValue: "Valor estimado final (en palabras)",
      transmittalHeading: "Carta de presentación",
      dear: "Estimado/a",
      transmittalP1: (addr: string) => `Asunto: Valoración de ${addr}`,
      transmittalP2:
        "A su solicitud, hemos preparado un informe inmobiliario de un bien de su propiedad, cuya copia se adjunta. Este informe es para su uso exclusivo y el de su agente designado y solo para establecer el valor del inmueble objeto.",
      transmittalP3:
        "El inmueble fue evaluado bajo el supuesto de Valor de Mercado, para consideración interna. Se han considerado los enfoques de costo y de mercado y se han utilizado cuando correspondía para las conclusiones de valor presentadas.",
      transmittalP4:
        "Tras un análisis exhaustivo de la propiedad y la información disponible, a nuestro juicio a la fecha de vigencia, esta propiedad tiene el Valor de Mercado indicado en el certificado adjunto.",
      sincerely: "Atentamente",
      certificateHeading: "Certificado de valor",
      totalValue: "Valor de mercado",
      scheduleA: 'Anexo "A" - Detalles de la propiedad',
      comparablesHeading: "Propiedades comparables",
      feature: "Característica",
      subject: "Propiedad sujeta",
      features: {
        address: "Dirección",
        listPrice: "Precio de lista",
        squareFootage: "Superficie (ft²)",
        lotSize: "Tamaño del lote",
        rooms: "Habitaciones/Dormitorios",
        bathrooms: "Baños",
        adjustedValue: "Valor ajustado",
      },
    },
  } as const;

  const tt = (t as any)[lang] as typeof t.en;

  const owner = safe(
    reportData?.owner_name || reportData?.property_details?.owner_name
  );
  const addr = safe(reportData?.property_details?.address);
  const reportDate = safe(reportData?.report_dates?.report_date);
  const inspectorName = safe(reportData?.inspector_info?.inspector_name || reportData?.inspector_name);
  const inspectorCompany = safe(reportData?.inspector_info?.company_name || reportData?.inspector_company);
  const inspectorEmail = safe(reportData?.inspector_info?.contact_email) || safe((reportData as any)?.user_email);
  const fmv = safe(
    reportData?.valuation?.fair_market_value ||
      reportData?.valuation?.final_estimate_value
  );
  const valuation = (reportData as any)?.valuation || {};

  // Shared visuals and layout
  const contentWidthTw = convertInchesToTwip(6.5);

  // Normalize comparables to an array of [name, obj]
  const compsEntries: Array<[string, any]> = (() => {
    const cp = reportData?.comparableProperties;
    if (!cp) return [];
    if (Array.isArray(cp)) {
      return cp.map((c: any, idx: number) => [c?.name || `Comp ${idx + 1}`, c]);
    }
    if (cp instanceof Map) return Array.from(cp.entries());
    if (typeof cp === "object") return Object.entries(cp);
    return [];
  })();

  // Build comparables table - Professional layout matching perItemTable.ts
  const numComps = compsEntries.length;
  
  // Calculate column widths proportionally
  const featureColWidth = Math.round(contentWidthTw * 0.18);
  const subjectColWidth = Math.round(contentWidthTw * 0.22);
  const remainingWidth = contentWidthTw - featureColWidth - subjectColWidth;
  const compColWidth = numComps > 0 ? Math.round(remainingWidth / numComps) : 0;
  const columnWidths = [featureColWidth, subjectColWidth, ...Array(numComps).fill(compColWidth)];
  
  const cellMargins = { top: 80, bottom: 80, left: 100, right: 100 };
  const headerShading = { type: "clear" as any, fill: "FEE2E2", color: "auto" };
  
  // Helper to create header cell
  const headerCell = (text: string, width: number) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    verticalAlign: AlignmentType.CENTER as any,
    shading: headerShading,
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: "991B1B", size: 20 })],
    })],
  });
  
  // Helper to create body cell
  const bodyCell = (text: string, width: number, isZebra: boolean, isFeature: boolean = false) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    verticalAlign: AlignmentType.CENTER as any,
    shading: isZebra ? { type: "clear" as any, fill: "FEF2F2", color: "auto" } : undefined,
    children: [new Paragraph({
      alignment: isFeature ? AlignmentType.LEFT : AlignmentType.CENTER,
      children: [new TextRun({ text: text || "—", bold: isFeature, size: 20 })],
    })],
  });

  // Build header row
  const headerRow = new TableRow({
    cantSplit: true,
    tableHeader: true,
    children: [
      headerCell(tt.feature, featureColWidth),
      headerCell(tt.subject, subjectColWidth),
      ...compsEntries.map(([name]) => headerCell(String(name), compColWidth)),
    ],
  });

  // Define feature rows data
  const featureRows = [
    { label: tt.features.address, subject: addr, getComp: (c: any) => getCompVal(c, "address", "Address / Location") },
    { label: tt.features.listPrice, subject: "N/A", getComp: (c: any) => getCompVal(c, "listPrice", "List Price") },
    { label: tt.features.squareFootage, subject: safe(reportData?.house_details?.square_footage), getComp: (c: any) => getCompVal(c, "squareFootage", "Square Footage") },
    { label: tt.features.lotSize, subject: safe(reportData?.house_details?.lot_size_sqft), getComp: (c: any) => getCompVal(c, "lotSize", "Lot Size") },
    { label: tt.features.rooms, subject: safe(reportData?.house_details?.number_of_rooms), getComp: (c: any) => getCompVal(c, "bedrooms", "Bedrooms") },
    { label: tt.features.bathrooms, subject: `${safe(reportData?.house_details?.number_of_full_bathrooms) || "0"} Full, ${safe(reportData?.house_details?.number_of_half_bathrooms) || "0"} Half`, getComp: (c: any) => getCompVal(c, "bathrooms", "Bathrooms") },
    { label: tt.features.adjustedValue, subject: "N/A", getComp: (c: any) => getCompVal(c, "adjustedValue", "Adjusted Value") },
  ];

  // Build body rows with zebra striping
  const bodyRows = featureRows.map((row, idx) => {
    const isZebra = idx % 2 === 1;
    return new TableRow({
      cantSplit: true,
      children: [
        bodyCell(row.label, featureColWidth, isZebra, true),
        bodyCell(row.subject, subjectColWidth, isZebra),
        ...compsEntries.map(([, c]) => bodyCell(row.getComp(c), compColWidth, isZebra)),
      ],
    });
  });

  const compTable = new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: columnWidths,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      left: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      right: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 3, color: "E5E7EB" },
      insideVertical: { style: BorderStyle.SINGLE, size: 3, color: "F3F4F6" },
    },
    rows: [headerRow, ...bodyRows],
  });

  // Load logo
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }
  // Header table and report date
  const headerTable = buildHeaderTable(
    logoBuffer,
    contentWidthTw,
    (reportData?.inspector_info?.contact_email as string) ||
      (reportData as any)?.user_email ||
      ""
  );
  const reportDateStr = formatDateUS(
    (reportData as any)?.report_dates?.report_date || new Date().toISOString()
  );

  // Normalize fields for builders
  const docData = {
    ...reportData,
    appraiser: inspectorName,
    appraisal_company: inspectorCompany,
    client_name: owner || (reportData as any)?.client_name || "",
  };
  const coverData = {
    ...docData,
    inspector_name: inspectorName,
  };
  const rootImageUrls: string[] = Array.isArray((reportData as any)?.imageUrls)
    ? (reportData as any).imageUrls
    : [];

  // Main content children
  // Chapter builders append to one ordered list because report reading order also
  // determines headings, TOC expectations, and page-break behavior.
  const children: Array<Paragraph | Table> = [];
  children.push(
    new Paragraph({
      text: tt.reportSummary,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      { label: tt.preparedFor, value: owner },
      { label: tt.reportDate, value: reportDateStr },
      { label: tt.features.address, value: addr },
      { label: tt.totalValue, value: fmv || "—" },
    ])
  );

  // Schedule A
  children.push(
    new Paragraph({
      text: tt.scheduleA,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 140, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      { label: tt.features.address, value: addr },
      {
        label: tt.features.squareFootage,
        value: safe(reportData?.house_details?.square_footage),
      },
      {
        label: tt.features.lotSize,
        value: safe(reportData?.house_details?.lot_size_sqft),
      },
      {
        label: tt.features.rooms,
        value: safe(reportData?.house_details?.number_of_rooms),
      },
      {
        label: tt.features.bathrooms,
        value: `${safe(reportData?.house_details?.number_of_full_bathrooms) || "0"} Full, ${safe(reportData?.house_details?.number_of_half_bathrooms) || "0"} Half`,
      },
    ])
  );

  // Comparables
  children.push(
    new Paragraph({
      text: tt.comparablesHeading,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 140, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(compTable);

  // Valuation Summary
  children.push(
    new Paragraph({
      text: tt.valuationSummary,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      {
        label: tt.totalValue,
        value: fmv || safe(valuation?.fair_market_value) || "—",
      },
      { label: tt.valueSource, value: safe(valuation?.value_source) },
      { label: tt.comparableUsed, value: safe(valuation?.comparable_used) },
      {
        label: tt.comparableListPrice,
        value: safe(valuation?.comparable_list_price),
      },
      {
        label: tt.finalEstimateValue,
        value: safe(valuation?.final_estimate_value),
      },
    ])
  );
  children.push(
    new Paragraph({
      text: tt.finalEstimateSummary,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 140, after: 80 },
    })
  );
  children.push(
    new Paragraph({ 
      style: "BodyLarge",
      text: safe(valuation?.final_estimate_summary) || "Based on comparable sales analysis.",
      spacing: { after: 160 },
    })
  );

  // Methodology section
  children.push(
    new Paragraph({
      text: tt.methodology,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(new Paragraph({ 
    style: "BodyLarge",
    text: safe(valuation?.details) || "Sales Comparison Approach methodology applied.", 
    spacing: { after: 160 },
  }));

  // ============================================================
  // FARMLAND VALUATION SECTION (for agricultural properties)
  // ============================================================
  const farmlandValuation = (reportData as any)?.farmland_valuation;
  const propertyType = (reportData as any)?.property_type || (reportData as any)?.property_details?.property_type;
  const approachesUsed = farmlandValuation?.approaches_used || {};
  const showDirectComparable = approachesUsed.direct_comparable !== false; // Default to true if not specified
  const showIncomeApproach = approachesUsed.income_capitalization === true;
  const showCostApproach = approachesUsed.cost_approach === true;
  
  if (propertyType === "agricultural" && farmlandValuation) {
    children.push(pageBreak());
    
    // Farmland Valuation Header
    children.push(new Paragraph({
      text: "Farmland Valuation Analysis",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    
    // Subject Property Summary
    children.push(new Paragraph({
      text: "Subject Property Details",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 100 },
    }));
    children.push(buildKeyValueTable([
      { label: "Subject Name", value: safe(farmlandValuation.subject_name) },
      { label: "Valuation Date", value: farmlandValuation.valuation_date ? formatDateUS(farmlandValuation.valuation_date) : "—" },
      { label: "Total Title Acres", value: farmlandValuation.total_title_acres ? `${farmlandValuation.total_title_acres} acres` : "—" },
      { label: "Cultivated Acres", value: farmlandValuation.cultivated_acres ? `${farmlandValuation.cultivated_acres} acres` : "—" },
      { label: "RM / Area", value: safe(farmlandValuation.rm_area) },
      { label: "Notes", value: safe(farmlandValuation.notes) || "—" },
    ]));
    
    // Direct Comparables Table (only if Direct Comparable approach selected)
    const comps = farmlandValuation.comparables || [];
    if (showDirectComparable && comps.length > 0) {
      children.push(new Paragraph({
        text: "Farmland – Direct Comparables",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
      
      children.push(...buildRealEstateComparisonTables(comps.map((c: any) => ({
        name: safe(c.comp_id),
        values: [
          c.sale_date ? formatDateUS(c.sale_date) : "—", safe(c.rm_area),
          c.distance_to_subject_km?.toFixed(1) || "—", c.title_acres?.toString() || "—",
          c.cultivated_acres?.toString() || "—", c.sale_price ? `$${c.sale_price.toLocaleString()}` : "—",
          c.price_per_cultivated_acre ? `$${c.price_per_cultivated_acre.toLocaleString()}` : "—", safe(c.data_source),
        ],
      })), ["Sale Date", "RM / Area", "Distance (km)", "Title Acres", "Cultivated Acres", "Sale Price", "Price per Cultivated Acre", "Source"], contentWidthTw));

      const adjRates = farmlandValuation.adjustment_rates;
      if (adjRates) {
        children.push(new Paragraph({ text: "Adjustment Rates Applied", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
        children.push(buildKeyValueTable([
          { label: "Time Adjustment", value: `${adjRates.time_percent_per_year || 5}% per year` },
          { label: "Size Adjustment", value: `$${adjRates.size_per_10ac || -25} per 10 acres` },
          { label: "Location Adjustment", value: `$${adjRates.location_per_km || -15} per km from subject` },
          { label: "Soil Quality Adjustment", value: `$${adjRates.soil_quality_per_step || 50} per quality step` },
          { label: "Access/Services Adjustment", value: `$${adjRates.access_lump_sum || 75} lump sum` },
        ]));
      }
      children.push(new Paragraph({ text: "Subject & Adjustment Grid", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
      const formatAdj = (value: number) => value >= 0 ? `+$${value}` : `-$${Math.abs(value)}`;
      children.push(...buildRealEstateComparisonTables(comps.map((c: any) => ({
        name: safe(c.comp_id),
        values: [
          `$${c.unadjusted_rate?.toLocaleString() || "—"}`, formatAdj(c.time_adj || 0),
          formatAdj(c.size_adj || 0), formatAdj(c.location_adj || 0), formatAdj(c.soil_quality_adj || 0),
          formatAdj(c.other_adj || 0), formatAdj(c.total_adj || 0),
          `$${c.adjusted_rate?.toLocaleString() || "—"}`, `${c.weight_percent || 0}%`,
          `$${c.weighted_rate?.toLocaleString() || "—"}`,
        ],
      })), ["Unadjusted Rate", "Time Adjustment", "Size Adjustment", "Location Adjustment", "Soil Adjustment", "Other Adjustment", "Total Adjustment", "Adjusted Rate", "Weight", "Weighted Rate"], contentWidthTw));
      children.push(buildKeyValueTable([{ label: "Weighted Average Rate ($/ac)", value: `$${farmlandValuation.weighted_average_rate?.toLocaleString() || "—"}` }]));
    }
    
    // Income Capitalization Approach (only if Income approach selected)
    const incomeData = farmlandValuation.income_capitalization;
    if (showIncomeApproach && incomeData && incomeData.indicated_value > 0) {
      children.push(new Paragraph({
        text: "Income Capitalization Approach",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
      children.push(buildKeyValueTable([
        { label: "Cultivated Acres", value: `${incomeData.cultivated_acres} acres` },
        { label: "Market Rent per Acre", value: `$${incomeData.market_rent_per_acre}/acre` },
        { label: "Potential Gross Income", value: `$${incomeData.potential_gross_income?.toLocaleString() ?? "—"}` },
        { label: "Vacancy Loss", value: `${incomeData.vacancy_loss_percent}%` },
        { label: "Effective Gross Income", value: `$${incomeData.effective_gross_income?.toLocaleString() ?? "—"}` },
        { label: "Operating Expense Ratio", value: `${incomeData.operating_expense_ratio}%` },
        { label: "Net Operating Income", value: `$${incomeData.net_operating_income?.toLocaleString() ?? "—"}` },
        { label: "Capitalization Rate", value: `${incomeData.cap_rate}%` },
        { label: "Indicated Value", value: `$${incomeData.indicated_value?.toLocaleString() ?? "—"}` },
        { label: "Indicated Value per Acre", value: `$${incomeData.indicated_value_per_acre?.toLocaleString() ?? "—"}/acre` },
      ]));
    }
    
    // Cost Approach (only if Cost approach selected)
    const costData = farmlandValuation.cost_approach;
    if (showCostApproach && costData && costData.indicated_value > 0) {
      children.push(new Paragraph({
        text: "Cost Approach (Software-Calculated)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
      children.push(buildKeyValueTable([
        { label: "Land Value", value: `$${costData.land_value?.toLocaleString() ?? "—"}` },
        { label: "Replacement Cost New", value: `$${costData.replacement_cost_new?.toLocaleString() ?? "—"}` },
        { label: "Physical Depreciation", value: `$${costData.physical_depreciation?.toLocaleString() ?? "—"}` },
        { label: "Functional Obsolescence", value: `$${costData.functional_obsolescence?.toLocaleString() ?? "—"}` },
        { label: "External Obsolescence", value: `$${costData.external_obsolescence?.toLocaleString() ?? "—"}` },
        { label: "Total Depreciation", value: `$${costData.total_depreciation?.toLocaleString() ?? "—"}` },
        { label: "Depreciated Cost of Improvements", value: `$${costData.depreciated_cost_of_improvements?.toLocaleString() ?? "—"}` },
        { label: "Indicated Value (Cost Approach)", value: `$${costData.indicated_value?.toLocaleString() ?? "—"}` },
      ]));
    }
    
    // Reconciliation (only when multiple approaches are selected)
    const reconciliation = farmlandValuation.reconciliation;
    const approachCount = (showDirectComparable ? 1 : 0) + (showIncomeApproach ? 1 : 0) + (showCostApproach ? 1 : 0);
    if (approachCount >= 2 && reconciliation) {
      children.push(new Paragraph({
        text: "Valuation Reconciliation",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
      const reconciliationRows: { label: string; value: string }[] = [];
      if (showDirectComparable) {
        reconciliationRows.push({ label: "Direct Comparison Value", value: `$${reconciliation.direct_comparison_value?.toLocaleString() ?? "—"}` });
        reconciliationRows.push({ label: "Direct Comparison Weight", value: `${reconciliation.direct_comparison_weight}%` });
        reconciliationRows.push({ label: "Direct Comparison Weighted", value: `$${reconciliation.direct_comparison_weighted?.toLocaleString() ?? "—"}` });
      }
      if (showIncomeApproach) {
        reconciliationRows.push({ label: "Income Value", value: `$${reconciliation.income_value?.toLocaleString() ?? "—"}` });
        reconciliationRows.push({ label: "Income Weight", value: `${reconciliation.income_weight}%` });
        reconciliationRows.push({ label: "Income Weighted", value: `$${reconciliation.income_weighted?.toLocaleString() ?? "—"}` });
      }
      if (showCostApproach && reconciliation.cost_value) {
        reconciliationRows.push({ label: "Cost Approach Value", value: `$${reconciliation.cost_value?.toLocaleString() ?? "—"}` });
        reconciliationRows.push({ label: "Cost Approach Weight", value: `${reconciliation.cost_weight}%` });
        reconciliationRows.push({ label: "Cost Approach Weighted", value: `$${reconciliation.cost_weighted?.toLocaleString() ?? "—"}` });
      }
      reconciliationRows.push({ label: "Final Reconciled Value", value: `$${reconciliation.final_reconciled_value?.toLocaleString() ?? "—"}` });
      children.push(buildKeyValueTable(reconciliationRows));
    }
    
    // Final Market Value
    children.push(new Paragraph({
      text: "Fair Market Value Conclusion",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    }));
    
    // Dynamic conclusion text based on approaches used
    let conclusionText = "Based on ";
    const approachNames: string[] = [];
    if (showDirectComparable) approachNames.push("Direct Comparison Approach");
    if (showIncomeApproach) approachNames.push("Income Capitalization Approach");
    if (showCostApproach) approachNames.push("Cost Approach");
    
    if (approachNames.length === 3) {
      conclusionText += "the reconciliation of all three valuation approaches (Direct Comparison, Income Capitalization, and Cost)";
    } else if (approachNames.length === 2) {
      conclusionText += `the ${approachNames[0]} and ${approachNames[1]} with weighted reconciliation`;
    } else if (approachNames.length === 1) {
      conclusionText += `the ${approachNames[0]}`;
    } else {
      conclusionText += "the valuation analysis";
    }
    
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: conclusionText + ", the ", size: 24 }),
        new TextRun({ text: "Fair Market Value", bold: true, size: 24 }),
        new TextRun({ text: " of the subject farmland property is estimated at:", size: 24 }),
      ],
      spacing: { after: 120 },
    }));
    children.push(new Paragraph({
      children: [
        new TextRun({ 
          text: farmlandValuation.fair_market_value_formatted || `$${farmlandValuation.fair_market_value?.toLocaleString() || "—"}`, 
          bold: true, 
          size: 40, 
          color: "DC2626" 
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 200 },
    }));
  }
  // END FARMLAND VALUATION SECTION

  // Add extensive AI-generated narrative content
  // Preview content is authoritative over raw AI output: it may contain reviewed
  // edits and therefore defines the merge boundary for supplemental narratives.
  const aiSections = (reportData as any)?.preview_data?.ai_sections || (reportData as any)?.ai_sections || {};
  
  // Executive Summary
  if (aiSections.exec_summary) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Executive Summary",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.exec_summary })],
      spacing: { after: 160 },
    }));
  }

  // Property Description
  if (aiSections.factual) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Property Description",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.factual })],
      spacing: { after: 160 },
    }));
  }

  // Site Description
  if (aiSections.site_desc) {
    children.push(new Paragraph({
      text: "Site Description",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 100 },
    }));
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.site_desc })],
      spacing: { after: 160 },
    }));
  }

  // Scope of Work
  if (aiSections.scope) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Scope of Work",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.scope })],
      spacing: { after: 160 },
    }));
  }

  // Basis of Value
  if (aiSections.basis) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Basis of Value",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.basis })],
      spacing: { after: 160 },
    }));
  }

  // Assumptions and Limiting Conditions
  if (aiSections.assumptions) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Assumptions and Limiting Conditions",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.assumptions })],
      spacing: { after: 160 },
    }));
  }

  // Highest and Best Use Analysis
  if (aiSections.hbu) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Highest and Best Use Analysis",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.hbu })],
      spacing: { after: 160 },
    }));
  }

  // Valuation Methodology
  if (aiSections.valuation) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Valuation Methodology and Conclusion",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.valuation })],
      spacing: { after: 160 },
    }));
  }

  // Market Conditions
  if (aiSections.market) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Market Conditions Analysis",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.market })],
      spacing: { after: 160 },
    }));
  }

  // Certification
  if (aiSections.certification) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Appraiser Certification",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.certification })],
      spacing: { after: 160 },
    }));
  }

  // Final Conclusions
  if (aiSections.conclusions) {
    children.push(pageBreak());
    children.push(new Paragraph({
      text: "Final Conclusions",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 120 },
    }));
    children.push(goldDivider());
    children.push(new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: aiSections.conclusions })],
      spacing: { after: 160 },
    }));
  }

  // ============================================================
  // COMPREHENSIVE CUSPAP-COMPLIANT SECTIONS (60+ pages)
  // ============================================================

  // 1.9 Market Value Conclusion
  children.push(...buildMarketValueConclusion(reportData, contentWidthTw));

  // 2.0 Certification
  children.push(...buildCertificationSection(reportData, contentWidthTw));

  // 3.0 Assumptions, Limiting Conditions, and Liability
  children.push(...buildAssumptionsSection(reportData, contentWidthTw));

  // 4.0 Scope of the Appraisal Assignment
  children.push(...buildScopeOfAppraisal(reportData, contentWidthTw));

  // 5.0 Basis of the Appraisal
  children.push(...buildBasisOfAppraisal(reportData, contentWidthTw));

  // 6.0 Factual Information
  children.push(...buildFactualInformation(reportData, contentWidthTw));

  // 7.0 Site Description (with property photos)
  children.push(...(await buildSiteDescription(reportData, contentWidthTw, rootImageUrls)));

  // 8.0 Highest and Best Use Analysis
  children.push(...buildHighestBestUse(reportData, contentWidthTw));

  // 9.0 Valuation Analysis
  children.push(...buildValuationAnalysis(reportData, contentWidthTw));

  // 10.0 Market Context and Risk Analysis
  children.push(...buildMarketContext(reportData, contentWidthTw));

  // 11.0 Conclusions and Recommendations
  children.push(...buildConclusions(reportData, contentWidthTw));

  // 12.0 Addenda and Supporting Documentation
  children.push(...buildAddenda(reportData, contentWidthTw));

  // Market overview and appendix
  children.push(
    ...(await buildMarketOverview({
      ...reportData,
      industry: (reportData as any)?.industry || "Real Estate",
    }))
  );
  const appendixImageUrls = [...rootImageUrls, ...(Array.isArray(reportData.extraImageUrls) ? reportData.extraImageUrls : [])];
  if (appendixImageUrls.length) {
    const appendixChildren = await buildAppendixPhotoGallery(
      reportData,
      appendixImageUrls,
      contentWidthTw
    );
    children.push(...appendixChildren);
  }

  // Build header and footer tables (same as mixedDocxBuilder - using email instead of company)
  const footerTable = buildFooterTable(contentWidthTw, inspectorName, inspectorEmail);
  const footerTableTOC = buildFooterTableWithoutPageNumber(contentWidthTw, inspectorName, inspectorEmail);

  // Construct only after asynchronous market/appendix work completes so the
  // final child graph is deterministic before Word calculates pagination.
  const doc = new Document({
    creator: inspectorName || "Asset Insight",
    title: `${tt.title}${addr ? ` - ${addr}` : ""}`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "1F2937" },
          paragraph: { spacing: { line: 276, before: 0, after: 120 } },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          basedOn: "",
          next: "Normal",
          run: { font: "Calibri", size: 22, color: "1F2937" },
          paragraph: { spacing: { line: 276, after: 120 } },
        },
        {
          id: "BodyLarge",
          name: "Body Large",
          basedOn: "Normal",
          next: "BodyLarge",
          quickFormat: true,
          run: { font: "Calibri", size: 22, color: "1F2937" },
          paragraph: { spacing: { line: 276, before: 0, after: 120 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 30, bold: true, color: "000000" },
          paragraph: { spacing: { before: 260, after: 140 }, outlineLevel: 0, keepNext: true, keepLines: true },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 25, bold: true, color: "000000" },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1, keepNext: true, keepLines: true },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 23, bold: true, color: "000000" },
          paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2, keepNext: true, keepLines: true },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 48, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 160, after: 120 },
            alignment: AlignmentType.CENTER,
          },
        },
      ],
    },
    // Cover omission is an external merge contract for custom-cover workflows;
    // remaining sections retain their original order and main-body numbering.
    sections: [
      // Cover (no header/footer) - Skip if custom_cover is true (merged externally)
      ...((reportData as any).custom_cover ? [] : [{
        properties: {
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(0.8),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: await buildRealEstateCover(coverData, logoBuffer, tt.title),
      }]),
      // Table of Contents (has header, footer without page numbers)
      {
        properties: {
          type: (reportData as any).custom_cover ? undefined : SectionType.NEXT_PAGE,
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(1.2),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: { default: new Footer({ children: [footerTableTOC] }) },
        children: [new Paragraph({ text: REAL_ESTATE_TOC_MARKER })],
      },
      // Transmittal Letter (has header/footer with page numbers, starts at 1)
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(1.2),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(1),
            },
            pageNumbers: { start: 1 },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: { default: new Footer({ children: [footerTable] }) },
        children: buildRealEstateTransmittal(
          tt,
          owner,
          addr,
          inspectorName,
          inspectorCompany,
          reportDateStr
        ),
      },
      // Certificate (no header/footer - full page image)
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(0),
              right: convertInchesToTwip(0),
              bottom: convertInchesToTwip(0),
              left: convertInchesToTwip(0),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: (await buildRealEstateCertificate(
          docData,
          contentWidthTw,
          reportDateStr
        )) as any,
      },
      // Main content with header/footer and page numbers
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
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
        children,
      },
    ],
  });

  // Return the packed DOCX as the controller/worker output contract.
  const buffer = await Packer.toBuffer(doc);
  return finalizeRealEstateDocxLayout(Buffer.from(buffer), lang);
}
