/**
 * Shapes salvage report data and renders the production PDF in an isolated browser page.
 * Compatibility aliases are resolved before templating, and browser cleanup runs for
 * both success and failure so durable worker retries do not accumulate renderer state.
 */
import puppeteer from "puppeteer";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";
import handlebars from "handlebars";
import fs from "fs/promises";
import path from "path";
import { normalizeSalvageReportData, formatSalvageDate } from "./salvageReportData.js";
import { presentSalvageSnapshot } from "./salvagePresentation.js";
import { salvageReportSections, safeSalvageReportLink, salvageReportRowNeedsSplit } from "./salvageReportSections.js";
import { prepareSalvagePhotos } from "./salvageImagePreparation.js";
import { renderSalvagePdfWithContents, salvagePdfPrintOptions } from "./salvagePdfLayout.js";

// Helper to format dates using the current context language (en/fr/es)
handlebars.registerHelper("formatDate", function (this: any, dateString: any, options: any) {
  return formatSalvageDate(dateString, options?.data?.root?.language || this?.language || "en");
});

// Helper: coalesce - returns first non-empty arg
handlebars.registerHelper("coalesce", function (...args: any[]) {
  const opts = args.pop();
  for (const v of args) {
    if (v === 0) return 0;
    if (v !== null && v !== undefined) {
      const s = typeof v === "string" ? v.trim() : v;
      if (s !== "") return v;
    }
  }
  return "";
});

// Saved comparable/vendor evidence remains visible, but only web links become
// clickable PDF annotations. Never activate script, file or data URLs.
handlebars.registerHelper("safeReportUrl", function (value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
});

// Joined evidence cells keep each source URL clickable without interpreting
// the surrounding appraiser text, excerpts or markup as trusted HTML.
handlebars.registerHelper("reportEvidenceLines", function (value: unknown) {
  return String(value ?? '').split(/\r?\n/).map(text => ({ text, url: safeSalvageReportLink(text) }));
});
handlebars.registerHelper("reportRowNeedsSplit", function (row: string[]) { return salvageReportRowNeedsSplit(row); });

// Numeric formatting helper with locale based on language
handlebars.registerHelper("numberFormat", function (this: any, value: any, options: any) {
  if (value == null || value === "") return "";
  const lang = options?.data?.root?.language || this?.language || "en";
  const locale = lang === "fr" ? "fr-CA" : lang === "es" ? "es-ES" : "en-US";
  let num: number;
  if (typeof value === "number") num = value;
  else {
    const cleaned = String(value).replace(/[^0-9.-]/g, "");
    num = parseFloat(cleaned);
  }
  if (!isFinite(num)) return String(value);
  return num.toLocaleString(locale);
});

// Currency formatting helper using selected currency
handlebars.registerHelper("currencyFormat", function (this: any, value: any, options: any) {
  if (value == null || value === "") return "";
  const root = options?.data?.root || this;
  const lang = root?.language || "en";
  const locale = lang === "fr" ? "fr-CA" : lang === "es" ? "es-ES" : "en-US";
  const currency = (root?.currency || "CAD").toString().toUpperCase();
  let num: number;
  if (typeof value === "number") num = value;
  else {
    const cleaned = String(value).replace(/[^0-9.-]/g, "");
    num = parseFloat(cleaned);
  }
  if (!isFinite(num)) return String(value);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return num.toLocaleString(locale);
  }
});

// An adjustment can be a saved explanation, not a monetary amount. Stripping
// prose from “Minus $350” reverses its meaning, so only explicit numbers format
// as currency; unknowns and appraiser rationales stay verbatim and escaped.
handlebars.registerHelper("adjustmentFormat", function (this: any, value: unknown, options: any) {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null;
  return numeric !== null && Number.isFinite(numeric)
    ? handlebars.helpers.currencyFormat!.call(this, numeric, options) : value == null ? "" : String(value);
});

export async function generateSalvagePdfFromReport(reportData: any): Promise<Buffer> {
  return renderSalvageReport(reportData);
}

// Word cannot reproduce CSS refraction/shadows. Embed only the designed cover
// as a high-resolution plate from the exact PDF template; body text stays native.
export async function renderSalvageDocxCover(
  reportData: any,
  photos: Awaited<ReturnType<typeof prepareSalvagePhotos>>,
): Promise<Buffer> {
  return renderSalvageReport(reportData, photos);
}

async function renderSalvageReport(
  reportData: any,
  coverPhotos?: Awaited<ReturnType<typeof prepareSalvagePhotos>>,
): Promise<Buffer> {
  reportData = presentSalvageSnapshot(normalizeSalvageReportData(reportData));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const templatePath = path.resolve(
      process.cwd(),
      "src/templates/salvage.html"
    );
    const htmlTemplate = await fs.readFile(templatePath, "utf-8");

    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    const logoImage = await fs.readFile(logoPath);
    const logoBase64 = logoImage.toString("base64");
    const logoUrl = `data:image/jpeg;base64,${logoBase64}`;

    // Trusted, versioned decorative art only. Never read report-supplied paths or
    // URLs for stationery, and never blend this layer into stored evidence photos.
    const glassArtwork = await fs.readFile(path.resolve(process.cwd(), "public/report-artwork/salvage-ruby-glass.png"));
    const glassArtworkUrl = `data:image/png;base64,${glassArtwork.toString("base64")}`;

    const template = handlebars.compile(htmlTemplate);

    const sanitizedData = JSON.parse(JSON.stringify(reportData));
    // Embed bounded copies rather than asking Chromium to fetch remote photos or
    // rely on HEIC browser support. All originals remain linked to the report.
    const preparedPhotos = coverPhotos ?? await prepareSalvagePhotos(reportData.imageUrls);
    sanitizedData.imageUrls = preparedPhotos.map((photo) => `data:image/jpeg;base64,${photo.buffer.toString("base64")}`);
    const reportPhotos = preparedPhotos.map((photo, index) => ({
      src: sanitizedData.imageUrls[index] as string,
      index: index + 1,
      portrait: photo.height > photo.width,
    }));
    // Chunk the complete ordered appendix, not the cover selection. Explicit
    // pages guarantee five distinct placements per full sheet in Chromium.
    const photoPages = Array.from({ length: Math.ceil(reportPhotos.length / 5) }, (_, pageIndex) => {
      const photos = reportPhotos.slice(pageIndex * 5, pageIndex * 5 + 5);
      return { photos, first: photos[0]!.index, last: photos[photos.length - 1]!.index, total: reportPhotos.length };
    });
    const preferredCoverIndexes: number[] = Array.isArray(reportData.cover_image_urls)
      ? reportData.cover_image_urls.map((url: string) => reportData.imageUrls.indexOf(url)).filter((index: number) => index >= 0)
      : [];
    const coverIndexes = [...new Set([...preferredCoverIndexes, ...reportPhotos.map((_photo: unknown, index: number) => index)])].slice(0, 3);

    // Basic i18n dictionary for PDF template labels
    const lang: "en" | "fr" | "es" = ((): any => {
      const l = String((reportData as any)?.language || "").toLowerCase();
      return l === "fr" || l === "es" ? l : "en";
    })();
    const t = {
      en: {
        title: "Salvage Report",
        coverTitleLead: "Salvage",
        coverTitleAccent: "Report",
        by: "by",
        cover: "Cover",
        contents: "Table of Contents",
        photo: "Photo",
        page: "Page",
        of: "of",
        preparedBy: "Prepared by",
        noPhotos: "No photographs supplied",
        photoUnavailable: "Photograph unavailable",
        summary: "Summary",
        reportSummary: "Report Summary",
        assetDetails: "Asset Details",
        repairEstimate: "Repair Estimate",
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
        comparables: "Comparable Salvage Listings",
        comparableDetails: "Comparable Details",
        valuationSummary: "Valuation Summary",
        confidence: "Confidence Level",
        preparedFor: "Prepared for",
        appraiser: "Appraiser",
        reportDate: "Report Date",
        fileNumber: "File Number",
        claimNumber: "Claim Number",
        policyNumber: "Policy Number",
        dateOfLoss: "Date of Loss",
        causeOfLoss: "Cause of Loss",
        totalValue: "Fair Market Value",
        reportDetails: "Report Details",
        dateReceived: "Date Received",
        nextReportDue: "Next Report Due",
        lossType: "Loss Type",
        itemType: "Item Type",
        year: "Year",
        make: "Make",
        model: "Model",
        vin: "VIN",
        damageRepairAnalysis: "Damage & Repair Analysis",
        itemCondition: "Item Condition",
        damageDescription: "Damage Description",
        inspectionComments: "Inspection Comments",
        repairable: "Repairable",
        repairFacility: "Repair Facility",
        repairFacilityComments: "Repair Facility Comments",
        parts: "Parts",
        labour: "Labour",
        shopSupplies: "Shop Supplies",
        miscellaneous: "Miscellaneous",
        taxes: "Taxes",
        lessBetterment: "Less Betterment",
        totalEstimate: "Total Estimate",
        valuation: "Valuation",
        actualCashValue: "Actual Cash Value",
        replacementCost: "Replacement Cost",
        replacementCostReferences: "Replacement Cost References",
        recommendedReserve: "Recommended Reserve",
        lossSummaryComments: "Loss Summary & Comments",
        appraiserComments: "Appraiser Comments",
        contactInformation: "Contact Information",
        insured: "Insured",
        adjuster: "Adjuster",
        phone: "Phone",
        email: "Email",
        comparableSales: "Comparable Sales",
        viewListing: "View Listing",
        images: "Images",
        confidential: "Confidential",
        compsColumnsTitle: "Title",
        compsColumnsPrice: "Price",
        compsColumnsLocation: "Location",
        compsColumnsLink: "Link",
        specValuationHeader: "Specialty Valuation Data",
        specField: "Field",
        specClient: "Client Vehicle",
        specComp1: "Comparable 1",
        specAdj: "Adjustments",
        notFound: "Not Found",
      },
      fr: {
        title: "Rapport de récupération",
        coverTitleLead: "Rapport de",
        coverTitleAccent: "récupération",
        by: "par",
        cover: "Couverture",
        contents: "Table des matières",
        photo: "Photo",
        page: "Page",
        of: "sur",
        preparedBy: "Préparé par",
        noPhotos: "Aucune photographie fournie",
        photoUnavailable: "Photographie indisponible",
        summary: "Résumé",
        reportSummary: "Résumé du rapport",
        assetDetails: "Détails de l'actif",
        repairEstimate: "Estimation des réparations",
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
        comparables: "Annonces de récupération comparables",
        comparableDetails: "Détails comparables",
        valuationSummary: "Résumé de l’évaluation",
        confidence: "Niveau de confiance",
        preparedFor: "Préparé pour",
        appraiser: "Évaluateur",
        reportDate: "Date du rapport",
        fileNumber: "Numéro de dossier",
        claimNumber: "Numéro de sinistre",
        policyNumber: "Numéro de police",
        dateOfLoss: "Date du sinistre",
        causeOfLoss: "Cause du sinistre",
        totalValue: "Valeur marchande",
        reportDetails: "Détails du rapport",
        dateReceived: "Date de réception",
        nextReportDue: "Prochain rapport dû",
        lossType: "Type de sinistre",
        itemType: "Type d'article",
        year: "Année",
        make: "Marque",
        model: "Modèle",
        vin: "VIN",
        damageRepairAnalysis: "Analyse des dommages et réparations",
        itemCondition: "État de l'article",
        damageDescription: "Description des dommages",
        inspectionComments: "Commentaires d'inspection",
        repairable: "Réparable",
        repairFacility: "Atelier de réparation",
        repairFacilityComments: "Commentaires de l'atelier",
        parts: "Pièces",
        labour: "Main-d'œuvre",
        shopSupplies: "Fournitures d'atelier",
        miscellaneous: "Divers",
        taxes: "Taxes",
        lessBetterment: "Moins plus-value",
        totalEstimate: "Estimation totale",
        valuation: "Évaluation",
        actualCashValue: "Valeur au comptant réelle",
        replacementCost: "Coût de remplacement",
        replacementCostReferences: "Références du coût de remplacement",
        recommendedReserve: "Réserve recommandée",
        lossSummaryComments: "Résumé des pertes et commentaires",
        appraiserComments: "Commentaires de l'évaluateur",
        contactInformation: "Coordonnées",
        insured: "Assuré",
        adjuster: "Expert en sinistres",
        phone: "Téléphone",
        email: "Courriel",
        comparableSales: "Ventes comparables",
        viewListing: "Voir l'annonce",
        images: "Images",
        confidential: "Confidentiel",
        compsColumnsTitle: "Titre",
        compsColumnsPrice: "Prix",
        compsColumnsLocation: "Emplacement",
        compsColumnsLink: "Lien",
        specValuationHeader: "Données d'évaluation spécialisées",
        specField: "Champ",
        specClient: "Véhicule du client",
        specComp1: "Comparable 1",
        specAdj: "Ajustements",
        notFound: "Introuvable",
      },
      es: {
        title: "Informe de salvamento",
        coverTitleLead: "Informe de",
        coverTitleAccent: "salvamento",
        by: "por",
        cover: "Portada",
        contents: "Índice",
        photo: "Foto",
        page: "Página",
        of: "de",
        preparedBy: "Preparado por",
        noPhotos: "No se proporcionaron fotografías",
        photoUnavailable: "Fotografía no disponible",
        summary: "Resumen",
        reportSummary: "Resumen del informe",
        assetDetails: "Detalles del activo",
        repairEstimate: "Estimación de reparación",
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
        comparables: "Anuncios de salvamento comparables",
        comparableDetails: "Detalles comparables",
        valuationSummary: "Resumen de la valoración",
        confidence: "Nivel de confianza",
        preparedFor: "Preparado para",
        appraiser: "Tasador",
        reportDate: "Fecha del informe",
        fileNumber: "Número de expediente",
        claimNumber: "Número de reclamación",
        policyNumber: "Número de póliza",
        dateOfLoss: "Fecha del siniestro",
        causeOfLoss: "Causa del siniestro",
        totalValue: "Valor de mercado",
        reportDetails: "Detalles del informe",
        dateReceived: "Fecha de recepción",
        nextReportDue: "Próximo informe",
        lossType: "Tipo de pérdida",
        itemType: "Tipo de artículo",
        year: "Año",
        make: "Marca",
        model: "Modelo",
        vin: "VIN",
        damageRepairAnalysis: "Análisis de daños y reparación",
        itemCondition: "Condición del artículo",
        damageDescription: "Descripción del daño",
        inspectionComments: "Comentarios de inspección",
        repairable: "Reparable",
        repairFacility: "Taller de reparación",
        repairFacilityComments: "Comentarios del taller",
        parts: "Piezas",
        labour: "Mano de obra",
        shopSupplies: "Suministros de taller",
        miscellaneous: "Misceláneos",
        taxes: "Impuestos",
        lessBetterment: "Menos mejoramiento",
        totalEstimate: "Estimación total",
        valuation: "Valoración",
        actualCashValue: "Valor en efectivo real",
        replacementCost: "Costo de reemplazo",
        replacementCostReferences: "Referencias del costo de reemplazo",
        recommendedReserve: "Reserva recomendada",
        lossSummaryComments: "Resumen de pérdidas y comentarios",
        appraiserComments: "Comentarios del tasador",
        contactInformation: "Información de contacto",
        insured: "Asegurado",
        adjuster: "Perito",
        phone: "Teléfono",
        email: "Correo electrónico",
        comparableSales: "Ventas comparables",
        viewListing: "Ver anuncio",
        images: "Imágenes",
        confidential: "Confidencial",
        compsColumnsTitle: "Título",
        compsColumnsPrice: "Precio",
        compsColumnsLocation: "Ubicación",
        compsColumnsLink: "Enlace",
        specValuationHeader: "Datos de valoración especializada",
        specField: "Campo",
        specClient: "Vehículo del cliente",
        specComp1: "Comparable 1",
        specAdj: "Ajustes",
        notFound: "No encontrado",
      },
    } as const;

    // Precompute dynamic label sets for template tables
    const sd: any = (reportData as any)?.specialty_data || (reportData as any)?.aiExtractedDetails?.specialty_data || {};
    const clientMap: Record<string, any> = (sd && typeof sd.client_vehicle === 'object' && sd.client_vehicle) || {};
    const compMap: Record<string, any> = (sd && typeof sd.comparable_1 === 'object' && sd.comparable_1) || {};
    const adjMap: Record<string, any> = (sd && typeof sd.adjustments === 'object' && sd.adjustments) || {};
    const specLabels = Array.from(new Set<string>([...Object.keys(clientMap), ...Object.keys(compMap), ...Object.keys(adjMap)]));
    // Each comparable owns its evidence fields. A union across all listings
    // created empty "Not Found" rows for fields belonging to other vehicles.
    // Pair short fields; give long evidence a full-width value for readability.
    const comparableDetailItems = (sanitizedData.comparableItems || []).flatMap((item: any) => {
      const entries = Object.entries(item?.details && typeof item.details === "object" ? item.details : {})
        .map(([label, value]) => ({ label, value }));
      const rows: { fields: typeof entries; wide: boolean }[] = [];
      for (const field of entries) {
        const wide = field.label.length > 35 || String(field.value ?? "").length > 100;
        const last = rows[rows.length - 1];
        if (!wide && last && !last.wide && last.fields.length === 1) last.fields.push(field);
        else rows.push({ fields: [field], wide });
      }
      return rows.length ? [{ title: item.title, rows }] : [];
    });

    // Derive itemized parts/labour and composition values for the template
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
    const re = ((reportData as any)?.aiExtractedDetails?.repair_estimate || (reportData as any)?.repair_estimate || {}) as any;
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
    const procurementNotes = (reportData as any)?.procurement_notes || (reportData as any)?.aiExtractedDetails?.procurement_notes || "";
    const safetyConcerns = (reportData as any)?.safety_concerns || (reportData as any)?.aiExtractedDetails?.safety_concerns || "";
    const assumptions = (reportData as any)?.assumptions || (reportData as any)?.aiExtractedDetails?.assumptions || "";
    const priorityLevel = (reportData as any)?.priority_level || (reportData as any)?.aiExtractedDetails?.priority_level || "";
    const hasManagerNotes = Boolean(procurementNotes || safetyConcerns || assumptions || priorityLevel);

    // Build computed rows for template rendering
    const partsRows = partsItems.map((it: any) => {
      const _qty = toNum(it?.quantity);
      const _unit = toNum(it?.unit_price);
      const _line = toNum(it?.line_total ?? _qty * _unit);
      return { ...it, _qty, _unit, _line };
    });
    const labourRows = labourBreakdown.map((it: any) => {
      const _hours = toNum(it?.hours);
      const _rate = toNum(it?.rate_per_hour ?? labourRateDefault);
      const _line = toNum(it?.line_total ?? _hours * _rate);
      return { ...it, _hours, _rate, _line };
    });

    const dataForPdf = {
      ...sanitizedData,
      enrichment: salvageReportSections(sanitizedData),
      coverPhotos: coverIndexes.map((index) => reportPhotos[index]),
      reportPhotos,
      photoPages,
      logo_url: logoUrl,
      glass_artwork_url: glassArtworkUrl,
      language: lang,
      tt: (t as any)[lang],
      currency: (reportData as any)?.currency || 'CAD',
      specLabels,
      comparableDetailItems,
      partsItems,
      labourBreakdown,
      partsRows,
      labourRows,
      labourRateDefault,
      partsSubtotal,
      labourTotal,
      totalHours: totalHoursCalc,
      lessBetterment,
      shopSupplies,
      miscellaneous,
      taxes,
      grandTotal,
      procurementNotes,
      safetyConcerns,
      assumptions,
      priorityLevel,
      hasManagerNotes,
    };

    const finalHtml = template(dataForPdf);

    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 120000, // 2 minutes
    });
    const page = await browser.newPage();
    configurePuppeteerPageTimeouts(page);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      // Every report image and the logo are embedded. Rendering must not fetch
      // user-supplied links, fonts or other remote resources.
      void (request.url().startsWith("data:") || request.url() === "about:blank"
        ? request.continue() : request.abort()).catch(() => undefined);
    });
    await page.emulateMediaType("print");
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2.5 });
    await page.setContent(finalHtml, {
      waitUntil: "networkidle0",
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
    });

    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(async (image) => {
        await image.decode();
        if (!image.naturalWidth) throw new Error("Cover image failed to render");
      }));
    });
    const cover = await page.$(".cover");
    if (!cover) throw new Error("Salvage cover is missing");
    const coverPlate = Buffer.from(await cover.screenshot({ type: "png", omitBackground: false }));
    if (coverPhotos) return coverPlate;

    // Apple CoreGraphics renders Chromium's soft-masked glass shadows as solid
    // rectangles, hiding the photos. Composite ONLY the cover in Chromium and
    // print its opaque plate, just as Word does. Keep its original section box
    // and anchor so body pagination, destinations and all appendix media survive.
    await page.evaluate(async (source) => {
      const element = document.getElementById("cover-page");
      if (!element) throw new Error("Salvage cover is missing");
      const image = document.createElement("img");
      image.className = "cover-plate";
      image.alt = element.getAttribute("aria-label") || "Salvage report cover";
      image.src = source;
      await image.decode();
      if (!image.naturalWidth) throw new Error("Salvage cover plate failed to render");
      element.replaceChildren(image);
      element.classList.add("cover-flattened");
    }, `data:image/png;base64,${coverPlate.toString("base64")}`);

    const labels = t[lang];
    return await renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), {
      logoUrl,
      title: labels.title,
      fileLabel: labels.fileNumber,
      fileNumber: String(reportData.file_number || "-"),
      confidential: labels.confidential,
      pageLabel: labels.page,
      ofLabel: labels.of,
      coverLabel: labels.cover,
      contentsLabel: labels.contents,
      language: lang,
    });
  } catch (error) {
    throw Object.assign(new Error(coverPhotos ? "Failed to generate Salvage DOCX cover." : "Failed to generate PDF report."), { cause: error });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
