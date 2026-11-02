/**
 * The market-driven layout of the Salvage PDF (owner, 2026-11-01: "I thought i
 * shared this style in the past for Salvage report. Why has it change?" ...
 * "yes bring it back"). The reference is a market-driven valuation the owner
 * supplied (a 2018 Peterbilt 389): administrative data, a VIN block, the
 * client vehicle set beside Comparable 1 with an adjustment on each line, an
 * adjustment ledger down to the adjusted market value, then valuation notes.
 * This was the report's shape from 16 Sep until the 25 Oct export replaced it.
 *
 * This module turns a report into that view. The canonical (v2) assessment is
 * used when present: its vehicle details, its selected pre-loss comparables
 * and their adjustments, its value conclusions, repairs and net recovery.
 * Older reports fall back to their saved specialty data and listings. Nothing
 * here invents a value: anything not established prints as not established.
 * Only McDougall branding is used; no third-party marks or wording. The owner
 * asked for the same method in McDougall's own look and words (2026-11-01:
 * "change a little from the style so it doesnt look like we copy"), so the
 * section names, ledger lines and the figures summary are our own.
 */

import { salvageCurrencyName, salvageReportCurrency } from "./salvageReportCurrency.js";

type Lang = "en" | "fr" | "es";
type Json = Record<string, any>;

export interface MarketRow { label: string; client: string; comparable: string; adjustment: number | null }
export interface MarketGroup { heading: string; rows: MarketRow[] }
export interface LedgerLine { label: string; detail?: string; amount: number | null; text?: string; kind?: "total" | "net" | "minus" }
export interface SummaryFigure { label: string; amount: number | null; note?: string; accent?: boolean }
export interface MarketComparable {
  number: number; title: string; basket: string; location: string; date: string; basis: string;
  price: number | null; adjustedPrice: number | null; verification: string; source: string; url: string | null; selected: boolean;
}
export interface SalvageMarketView {
  canonical: boolean;
  subjectLine: string;
  /** The same vehicle in its own case, for the cover. */
  subjectName: string;
  contactLines: string[];
  claimRows: { label: string; value: string }[];
  inspectionRows: { label: string; value: string }[];
  vinRows: { label: string; value: string }[];
  comparableHeading: string;
  groups: MarketGroup[];
  summary: SummaryFigure[];
  /** How the pre-loss value was reached, for the report summary. */
  valueBasis: string;
  ledger: LedgerLine[];
  recovery: LedgerLine[];
  repairRows: { description: string; quantity: string; amount: number | null }[];
  repairTotal: number | null;
  comparables: MarketComparable[];
  notes: { special: string[]; providedBy: string[]; process: string[]; researchArea: string; clientComments: string;
    comparable: { label: string; value: string }[]; general: string[] };
  labels: Record<string, string>;
}

const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Salvage Valuation Report", admin: "Claim and Inspection", vinAnalysis: "VIN Check",
    specialty: "Vehicle Comparison", clientVehicle: "Subject Vehicle", adjustments: "Adjustments",
    ledgerHeading: "Pre-Loss Market Value", recoveryHeading: "Salvage Recovery", damage: "Damage and Repair",
    comparables: "Market Evidence", notes: "Appraiser Notes", about: "About This Report", photos: "Photographs",
    special: "Notable adjustments", providedBy: "Information received", process: "How the value was reached",
    researchArea: "Market searched", clientComments: "Appraiser comments", comparable: "Comparable 1 details", general: "Limitations",
    preparedFor: "Prepared for", preparedBy: "Prepared by McDougall Auctioneers", inspection: "Inspection",
    compAfter: "Comparable 1 after adjustments", preLossValue: "Pre-loss market value", asIsValue: "As-is salvage value",
    netRecovery: "Net recovery", repairShare: "Repair estimate as a share of pre-loss value", ofPreLoss: "of pre-loss value",
    valuation: "Valuation", basisOfValue: "Basis of value",
    less: "Less", fees: "Selling fees", transportCost: "Transport", storage: "Storage", disposal: "Disposal",
    claim: "Claim", lossDate: "Loss Date", lossType: "Loss Type", policy: "Policy", file: "File", reportDate: "Report Date",
    inspectionType: "Inspection Type", repairable: "Repairable", brand: "Documented Brand", photosSupplied: "Photographs Supplied",
    vin: "VIN", vinSource: "Source", vinHistory: "History", description: "Description", qty: "Qty / Hours", amount: "Amount",
    vehicle: "Vehicle", location: "Location", date: "Date", basis: "Price Basis", price: "Price", adjusted: "Adjusted",
    status: "Status", notEstablished: "Not established", none: "None", page: "Page", photo: "Photo",
    vehicleDescription: "Vehicle Description", engine: "Engine", transmission: "Transmission", specifications: "Specifications",
    condition: "Condition", priceHeading: "Price", totalRepair: "Total repair estimate",
  },
  fr: {
    title: "Rapport d'évaluation de récupération", admin: "Sinistre et inspection", vinAnalysis: "Vérification du NIV",
    specialty: "Comparaison du véhicule", clientVehicle: "Véhicule évalué", adjustments: "Ajustements",
    ledgerHeading: "Valeur marchande avant sinistre", recoveryHeading: "Récupération", damage: "Dommages et réparations",
    comparables: "Données du marché", notes: "Notes de l'évaluateur", about: "À propos de ce rapport", photos: "Photographies",
    special: "Ajustements notables", providedBy: "Renseignements reçus", process: "Méthode d'évaluation",
    researchArea: "Marché consulté", clientComments: "Commentaires de l'évaluateur", comparable: "Détails du comparable 1", general: "Limites",
    preparedFor: "Préparé pour", preparedBy: "Préparé par McDougall Auctioneers", inspection: "Inspection",
    compAfter: "Comparable 1 après ajustements", preLossValue: "Valeur marchande avant sinistre", asIsValue: "Valeur de récupération en l'état",
    netRecovery: "Récupération nette", repairShare: "Réparations en % de la valeur avant sinistre", ofPreLoss: "de la valeur avant sinistre",
    valuation: "Évaluation", basisOfValue: "Fondement de la valeur",
    less: "Moins", fees: "Frais de vente", transportCost: "Transport", storage: "Entreposage", disposal: "Élimination",
    claim: "Sinistre", lossDate: "Date du sinistre", lossType: "Type de sinistre", policy: "Police", file: "Dossier", reportDate: "Date du rapport",
    inspectionType: "Type d'inspection", repairable: "Réparable", brand: "Marque documentée", photosSupplied: "Photographies fournies",
    vin: "NIV", vinSource: "Source", vinHistory: "Historique", description: "Description", qty: "Qté / heures", amount: "Montant",
    vehicle: "Véhicule", location: "Lieu", date: "Date", basis: "Base du prix", price: "Prix", adjusted: "Ajusté",
    status: "Statut", notEstablished: "Non établi", none: "Aucun", page: "Page", photo: "Photo",
    vehicleDescription: "Description du véhicule", engine: "Moteur", transmission: "Transmission", specifications: "Spécifications",
    condition: "État", priceHeading: "Prix", totalRepair: "Estimation totale des réparations",
  },
  es: {
    title: "Informe de valoración de salvamento", admin: "Siniestro e inspección", vinAnalysis: "Verificación del VIN",
    specialty: "Comparación del vehículo", clientVehicle: "Vehículo evaluado", adjustments: "Ajustes",
    ledgerHeading: "Valor de mercado previo al siniestro", recoveryHeading: "Recuperación", damage: "Daños y reparación",
    comparables: "Evidencia de mercado", notes: "Notas del tasador", about: "Acerca de este informe", photos: "Fotografías",
    special: "Ajustes destacados", providedBy: "Información recibida", process: "Cómo se obtuvo el valor",
    researchArea: "Mercado consultado", clientComments: "Comentarios del tasador", comparable: "Detalles del comparable 1", general: "Limitaciones",
    preparedFor: "Preparado para", preparedBy: "Preparado por McDougall Auctioneers", inspection: "Inspección",
    compAfter: "Comparable 1 tras ajustes", preLossValue: "Valor de mercado previo al siniestro", asIsValue: "Valor de salvamento en su estado",
    netRecovery: "Recuperación neta", repairShare: "Reparación como % del valor previo", ofPreLoss: "del valor previo al siniestro",
    valuation: "Valoración", basisOfValue: "Base del valor",
    less: "Menos", fees: "Gastos de venta", transportCost: "Transporte", storage: "Almacenamiento", disposal: "Eliminación",
    claim: "Reclamación", lossDate: "Fecha del siniestro", lossType: "Tipo de pérdida", policy: "Póliza", file: "Expediente", reportDate: "Fecha del informe",
    inspectionType: "Tipo de inspección", repairable: "Reparable", brand: "Marca documentada", photosSupplied: "Fotografías aportadas",
    vin: "VIN", vinSource: "Origen", vinHistory: "Historial", description: "Descripción", qty: "Cant. / horas", amount: "Importe",
    vehicle: "Vehículo", location: "Ubicación", date: "Fecha", basis: "Base del precio", price: "Precio", adjusted: "Ajustado",
    status: "Estado", notEstablished: "No establecido", none: "Ninguno", page: "Página", photo: "Foto",
    vehicleDescription: "Descripción del vehículo", engine: "Motor", transmission: "Transmisión", specifications: "Especificaciones",
    condition: "Condición", priceHeading: "Precio", totalRepair: "Estimación total de reparación",
  },
};

const text = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value.trim();
  return "";
};
const first = (...values: unknown[]): string => values.map(text).find(Boolean) || "";
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const odometerText = (value: unknown, unit: unknown) => {
  const n = num(value);
  return n === null ? "" : `${n.toLocaleString("en-CA")} ${text(unit) || "km"}`.trim();
};

/** Which table row an adjustment belongs to, from its description. */
function adjustmentRow(description: string): string | null {
  const d = description.toLowerCase();
  if (/odometer|mileage|kilomet|\bkm\b|\bmiles?\b|hours? meter/.test(d)) return "odometer";
  if (/engine|horsepower|\bhp\b|displacement/.test(d)) return "engineModel";
  if (/transmission|gearbox|gear/.test(d)) return "transmission";
  if (/brand|title|salvage|rebuilt|branding/.test(d)) return "brand";
  if (/condition|damage|wear|tire|tyre/.test(d)) return "condition";
  if (/\byear\b|model year|\bage\b/.test(d)) return "year";
  if (/location|region|freight|transport|province|market/.test(d)) return "location";
  if (/trim|equipment|option|accessor|sleeper|cab|body|package|feature/.test(d)) return "trim";
  return null;
}

const BASIS: Record<string, string> = { sold: "Sold", asking: "Asking", reserve: "Reserve", current_bid: "Current bid", unknown: "Unknown" };

export function buildSalvageMarketView(report: Json, lang: Lang = "en"): SalvageMarketView {
  const L = LABELS[lang] || LABELS.en;
  const assessment = object(report.assessment);
  const canonical = assessment.schemaVersion === 2;
  const inputs = object(canonical ? assessment.inputs : report.assessment_inputs);
  const details = new Map<string, any>(list(object(assessment.vehicleDetails).fields).map((field: any) => [field.key, field]));
  const fieldValue = (key: string) => text(details.get(key)?.value);
  const odometerField = fieldValue("odometer");
  const observedOdometer = odometerField ? num(Number(odometerField)) : null;
  const year = first(fieldValue("year"), inputs.year, report.year);
  const make = first(fieldValue("make"), inputs.make, report.make);
  const model = first(fieldValue("model"), inputs.model, report.item_model);
  const trim = first(fieldValue("trim"), inputs.trim);
  const bodyType = first(fieldValue("bodyType"), report.item_type);
  // A part already contained in another (trim "Wrecker", body "Wrecker / tow truck") is said once.
  const subjectParts = [year, make, model, trim, bodyType].filter(Boolean);
  const subjectName = subjectParts.filter((part, index) => !subjectParts.some((other, j) => j !== index && other.length > part.length
    && other.toLowerCase().includes(part.toLowerCase()))).join(" ");
  const subjectLine = subjectName.toUpperCase();

  const contactLines = [report.adjuster_name, report.insured_name, report.company_name, report.company_address].map(text).filter(Boolean);
  const claimRows = [
    { label: L.claim, value: text(report.claim_number) },
    { label: L.lossDate, value: text(report.date_of_loss).slice(0, 10) },
    { label: L.lossType, value: first(inputs.lossType, report.reported_loss_type) },
    { label: L.policy, value: text(report.policy_number) },
    { label: L.file, value: text(report.file_number) },
  ];
  const photoCount = list(report.imageUrls).length;
  const inspectionRows = [
    { label: L.inspectionType, value: photoCount ? "Photographic" : L.notEstablished },
    { label: L.photosSupplied, value: String(photoCount) },
    { label: L.repairable, value: first(report.is_repairable, "To Be Determined") },
    { label: L.brand, value: first(inputs.documentedBrand, L.notEstablished) },
  ];
  const vinValue = first(fieldValue("vin"), inputs.vin, report.vin);
  const vinField = details.get("vin");
  const vinRows = [
    { label: L.vin, value: vinValue && !/^not\s*(visible|found)$/i.test(vinValue) ? vinValue : L.notEstablished },
    { label: L.vinSource, value: vinField?.status === "manual" ? "Entered by the appraiser"
      : vinField?.status === "observed" ? "Read from the photographs" : vinValue ? "Supplied" : "Not readable in the photographs" },
    { label: L.vinHistory, value: "Not checked in this report" },
  ];

  // Comparable 1: the first selected pre-loss comparable, else the first one found.
  const pool = list(canonical ? assessment.comparables : []).concat(list(canonical ? assessment.candidates : []));
  const preLoss = pool.filter((c: any) => c?.basket === "pre_loss");
  const comp: Json | null = preLoss.find((c: any) => c.selected) || preLoss.find((c: any) => c.eligible) || preLoss[0] || null;

  const rowAdjust = new Map<string, number>();
  const unmatched: { description: string; amount: number | null }[] = [];
  for (const adjustment of list(comp?.adjustments)) {
    const description = text(adjustment?.description);
    const amount = num(adjustment?.amount);
    const row = adjustmentRow(description);
    if (row && amount !== null) rowAdjust.set(row, (rowAdjust.get(row) || 0) + amount);
    else unmatched.push({ description, amount });
  }
  const row = (key: string, label: string, client: string, comparable = ""): MarketRow =>
    ({ label, client, comparable, adjustment: rowAdjust.get(key) ?? null });

  let groups: MarketGroup[];
  if (canonical) {
    const specs = [...details.values()].filter((field: any) => String(field.key).startsWith("spec:") && text(field.value))
      .map((field: any) => row(field.key, field.label, text(field.value)));
    groups = [
      { heading: L.vehicleDescription, rows: [
        row("year", "Year", year, text(comp?.year)),
        row("make", "Make", make, text(comp?.make)),
        row("model", "Model", model, text(comp?.model)),
        row("trim", "Trim", trim, text(comp?.trim)),
        row("category", "Category", fieldValue("category")),
        row("bodyType", "Body Type", bodyType),
        row("driveType", "Drive Type", fieldValue("driveType")),
        row("odometer", "Odometer", odometerText(observedOdometer ?? inputs.odometer, fieldValue("odometerUnit") || inputs.odometerUnit),
          odometerText(comp?.odometer, comp?.odometerUnit)),
        row("brand", "Brand / Title", first(inputs.documentedBrand, L.notEstablished), text(comp?.brand)),
        row("location", "Location", [inputs.market, inputs.province].map(text).filter(Boolean).join(", "),
          [comp?.location, comp?.province].map(text).filter(Boolean).join(", ")),
      ] },
      { heading: L.engine, rows: [
        row("engineMake", "Engine Make", fieldValue("engineMake")),
        row("engineModel", "Engine Model", fieldValue("engineModel"), text(comp?.powertrain)),
        row("engineDisplacement", "Engine Size", fieldValue("engineDisplacement")),
        row("engineCylinders", "Cylinders", fieldValue("engineCylinders")),
        row("fuelType", "Fuel Type", fieldValue("fuelType")),
      ] },
      { heading: L.transmission, rows: [row("transmission", "Transmission", fieldValue("transmission"))] },
      ...(specs.length ? [{ heading: L.specifications, rows: specs }] : []),
      { heading: L.condition, rows: [
        row("condition", "Condition", first(inputs.condition, report.item_condition), text(comp?.condition)),
        row("damage", "Damage", first(inputs.damageDescription, report.damage_description)),
      ] },
      { heading: L.priceHeading, rows: [
        row("basis", "Price Basis", "", comp ? BASIS[comp.priceBasis] || "Unknown" : ""),
        row("eventDate", "Sale / Listing Date", "", text(comp?.eventDate)),
      ] },
    ];
    // Rows with nothing on either side are left out, as the reference does.
    groups = groups.map((group) => ({ ...group, rows: group.rows.filter((r) => r.client || r.comparable || r.adjustment !== null) }))
      .filter((group) => group.rows.length);
  } else {
    const sd = object(report.specialty_data || object(report.aiExtractedDetails).specialty_data);
    const client = object(sd.client_vehicle), compMap = object(sd.comparable_1), adj = object(sd.adjustments);
    const labels = [...new Set([...Object.keys(client), ...Object.keys(compMap), ...Object.keys(adj)])];
    groups = labels.length ? [{ heading: L.vehicleDescription, rows: labels.map((label) => ({
      label, client: text(client[label]), comparable: text(compMap[label]), adjustment: num(adj[label]),
    })) }] : [];
  }

  const valuations = object(assessment.valuations);
  const pre = object(valuations.preLoss), asIs = object(valuations.asIs);
  const ledger: LedgerLine[] = [];
  const recovery: LedgerLine[] = [];
  // The figures printed in the summary strip under the masthead.
  const summary: SummaryFigure[] = [];
  if (canonical) {
    if (comp) {
      ledger.push({ label: `${BASIS[comp.priceBasis] || "Listed"} price, Comparable 1`, amount: num(comp.price) });
      for (const adjustment of list(comp.adjustments)) {
        ledger.push({ label: text(adjustment.description) || "Adjustment", detail: text(adjustment.appraiserReason) || undefined, amount: num(adjustment.amount) });
      }
      ledger.push({ label: L.compAfter, amount: num(comp.adjustedPrice) ?? num(comp.price), kind: "total" });
    }
    const range = num(pre.low) !== null && num(pre.high) !== null ? `Range ${pre.low.toLocaleString("en-CA")}–${pre.high.toLocaleString("en-CA")} from ${list(pre.comparableIds).length} comparable(s)` : undefined;
    ledger.push({ label: L.preLossValue, detail: range || text(pre.method) || undefined,
      amount: num(pre.amount), text: num(pre.amount) === null ? L.notEstablished : undefined, kind: "net" });

    const net = object(assessment.netRecovery);
    const deductions = object(net.deductions);
    recovery.push({ label: L.asIsValue, detail: text(asIs.method) || undefined, amount: num(asIs.amount), text: num(asIs.amount) === null ? L.notEstablished : undefined });
    for (const [key, label] of [["fees", L.fees], ["transport", L.transportCost], ["storage", L.storage], ["disposal", L.disposal]] as const) {
      const cost = object(deductions[key]);
      if (num(cost.amount) !== null) recovery.push({ label, detail: text(cost.description) || undefined, amount: num(cost.amount), kind: "minus" });
    }
    recovery.push({ label: L.netRecovery, amount: num(net.total), text: num(net.total) === null ? L.notEstablished : undefined, kind: "net" });
    const repairs = object(assessment.repairs);
    const share = num(repairs.total) !== null && num(pre.amount) ? Math.round(repairs.total / pre.amount * 100) : null;
    if (share !== null) recovery.push({ label: L.repairShare, amount: null, text: `${share}%` });
    summary.push(
      { label: L.preLossValue, amount: num(pre.amount), accent: true },
      { label: L.asIsValue, amount: num(asIs.amount) },
      { label: L.netRecovery, amount: num(net.total) },
      { label: L.totalRepair, amount: num(repairs.total), note: share === null ? undefined : `${share}% ${L.ofPreLoss}` },
    );
  } else {
    const valuation = object(report.valuation);
    ledger.push({ label: "Fair Market Value", amount: num(Number(String(valuation.fairMarketValue || "").replace(/[^0-9.-]/g, ""))) });
    for (const [key, label] of [["actual_cash_value", "Actual Cash Value"], ["replacement_cost", "Replacement Cost"], ["recommended_reserve", "Recommended Reserve"]] as const) {
      if (num(report[key]) !== null) ledger.push({ label, amount: num(report[key]) });
    }
    summary.push(...ledger.filter((line) => line.amount !== null).map((line, index) => ({ label: line.label, amount: line.amount, accent: index === 0 })));
  }

  // Repairs: the assessment's parts, labour and charges; older reports' rows.
  const repairs = object(assessment.repairs);
  const repairRows = canonical
    ? [
      ...list(repairs.parts).map((p: any) => ({ description: text(p.description), quantity: num(p.quantity) === null ? "" : String(p.quantity), amount: num(p.total) })),
      ...list(repairs.labour).map((l: any) => ({ description: text(l.description), quantity: num(l.hours) === null ? "" : `${l.hours} h`, amount: num(l.total) })),
      ...list(repairs.charges).map((c: any) => ({ description: text(c.description), quantity: "", amount: num(c.amount) })),
    ].filter((r) => r.description)
    : list(report.repair_items).map((p: any) => ({ description: text(p.name), quantity: text(p.quantity), amount: num(p.line_total) }));
  const repairTotal = canonical ? num(repairs.total) : num(object(report.repair_estimate).total);

  const comparables: MarketComparable[] = canonical
    ? [...new Map(pool.map((c: any) => [c.id, c])).values()].filter((c: any) => c.verification !== "unverified" || c.selected)
      .sort((a: any, b: any) => Number(b.selected) - Number(a.selected) || String(a.basket).localeCompare(String(b.basket)))
      .map((c: any, index) => ({
        number: index + 1, title: text(c.title), basket: c.basket === "pre_loss" ? "Pre-loss" : "As-is salvage",
        location: [c.location, c.province].map(text).filter(Boolean).join(", "), date: text(c.eventDate),
        basis: BASIS[c.priceBasis] || "Unknown", price: num(c.price), adjustedPrice: num(c.adjustedPrice),
        verification: c.verification === "appraiser_supplied" ? "Appraiser supplied" : c.verification === "verified" ? "Source checked" : "Not verified",
        source: text(c.sourceName), url: text(c.url) || null, selected: Boolean(c.selected),
      }))
    : list(report.comparableItems).map((c: any, index) => ({
      number: index + 1, title: text(c.title), basket: "Market", location: text(c.location), date: "", basis: "",
      price: num(c.price_numeric), adjustedPrice: null, verification: "", source: "", url: text(c.link) || null, selected: false,
    }));

  const special = [
    ...list(comp?.adjustments).filter((a: any) => text(a.appraiserReason)).map((a: any) => `${text(a.description)}: ${text(a.appraiserReason)}`),
    ...(["preLoss", "asIs"] as const).flatMap((key) => {
      const override = object(object(inputs.overrides)[key]);
      return num(override.amount) !== null ? [`Appraiser ${key === "preLoss" ? "pre-loss" : "as-is"} value: ${text(override.description)} ${text(override.appraiserReason)}`.trim()] : [];
    }),
  ];
  const providedBy = [
    `Loss vehicle information was provided by ${first(report.adjuster_name, report.insured_name, "the client")}${report.company_name ? ` for ${text(report.company_name)}` : ""}`.replace(/\.?$/, "."),
    `All values are in ${salvageCurrencyName(salvageReportCurrency(report))}.`,
  ];
  const process = canonical ? [
    "Public Canadian market listings were researched for comparable vehicles, in the subject's market first and nationally where needed.",
    "Each comparable's price and details were checked against the listing it came from; unchecked listings are not used as valuation evidence.",
    // Pre-loss and as-is often share one method sentence; say it once.
    ...new Set([text(pre.method), text(asIs.method)]),
  ].filter(Boolean) : ["The valuation is based on the subject data and comparable listings available when the report was generated."];
  const areas = [...new Set(comparables.map((c) => c.location).filter(Boolean))];
  const researchArea = [inputs.market, inputs.province].map(text).filter(Boolean).join(", ")
    ? `Subject market: ${[inputs.market, inputs.province].map(text).filter(Boolean).join(", ")}.${areas.length ? ` Comparables were found in ${areas.join("; ")}.` : ""}`
    : areas.length ? `Comparables were found in ${areas.join("; ")}.` : L.notEstablished;
  const comparableDetails = comp ? [
    { label: "Vehicle", value: text(comp.title) },
    { label: "Source", value: text(comp.sourceName) },
    { label: "Listing", value: text(comp.listingId) },
    { label: "Location", value: [comp.location, comp.province].map(text).filter(Boolean).join(", ") },
    { label: "Date", value: text(comp.eventDate) },
    { label: "Price", value: num(comp.price) === null ? "" : `${BASIS[comp.priceBasis] || ""} CAD ${comp.price.toLocaleString("en-CA")}`.trim() },
    { label: "Checked", value: comp.verification === "verified" ? "Price and details checked against the listing" : comp.verification === "appraiser_supplied" ? "Supplied by the appraiser" : "Not verified" },
  ].filter((entry) => entry.value) : [];
  const general = [
    ...list(assessment.limitations).map((limit: any) => text(limit.message)).filter(Boolean),
    "Repair costs are shown separately and are provisional unless supported by a quotation.",
  ];

  return {
    canonical, subjectLine, subjectName, contactLines, claimRows, inspectionRows, vinRows,
    comparableHeading: comp ? "Comparable 1" : "Comparable",
    groups, summary, valueBasis: canonical ? text(pre.method) : "", ledger, recovery, repairRows, repairTotal, comparables,
    notes: { special, providedBy, process, researchArea, clientComments: first(report.appraiser_comments, "No additional comments were reported."),
      comparable: comparableDetails, general },
    labels: L,
  };
}
