/**
 * The Salvage appraisal report as a full MCD Appraisals report (owner,
 * 2026-11-01). The owner supplied three of the company's current appraisal
 * reports (files 71763, 75949, 76047) and asked for their content in the new
 * report, more sections to make it professional, and uploaded documents as
 * appendices. Decisions (2026-11-01): MCD Appraisals branding; the appraiser's
 * signature block and CV come from a profile set once; appendices are PDFs or
 * photos; one report covers several units; every page is A4.
 *
 * Shape, following the company's reports:
 *   - Report Summary: the assignment (insurer, claim, adjuster, insured,
 *     policy, loss), "Our opinion – cause of loss", every unit with its status,
 *     value, recommended reserve and salvage value (with totals), comments,
 *     follow-up and the signed appraiser block.
 *   - One section per unit: unit details (type, year, make, model, VIN, limit
 *     of insurance, coverage, deductible, licence plate), our inspection,
 *     damage (repairable yes / no / to be determined, repair facility), the
 *     repair estimate (parts, less betterment, labour, shop supplies,
 *     miscellaneous, taxes, total), Actual Cash Value or Replacement Cost with
 *     our opinion and references, recommended reserve and salvage value; then,
 *     when the market research ran for that unit, the comparison with
 *     Comparable 1 and the value calculations (service/salvageMarketView.ts).
 *   - Definitions, limiting conditions, the appraiser's certification, the
 *     appraiser's CV and the uploaded appendices (A, B, C ...).
 *
 * Unit 1 is the report's own top-level fields (every existing report has
 * exactly that unit); units 2 onward are report.additional_units, each with
 * the same field names. Nothing here invents a value: anything not supplied
 * prints as "Not established" or is left out.
 */
import { buildSalvageMarketView, type SalvageMarketView } from "./salvageMarketView.js";

type Lang = "en" | "fr" | "es";
type Json = Record<string, any>;

/** The brand on the report (owner, 2026-11-01: "MCD Appraisals"). */
export const SALVAGE_REPORT_BRAND = { name: "MCD Appraisals", website: "mcdappraisals.com", logoFile: "public/mcd-appraisals-logo.png" } as const;

/** Fields that describe one unit; unit 1 reads them from the report itself. */
export const SALVAGE_UNIT_FIELDS = [
  "unit_label", "item_type", "year", "make", "item_model", "vin", "licence_plate", "limit_of_insurance", "coverage", "deductible",
  "item_condition", "hours", "pre_existing_damage", "inspection_comments", "damage_description", "damage_comments", "is_repairable",
  "loss_status", "repair_facility", "repair_facility_comments", "repair_items", "repair_estimate", "repair_summary",
  "repair_estimate_appendix", "value_basis", "actual_cash_value", "replacement_cost", "replacement_cost_references",
  "recommended_reserve", "appraiser_reserve", "salvage_value", "imageUrls", "damage_marks", "cover_image_urls", "assessment", "assessment_inputs",
  "specialty_data", "aiExtractedDetails", "valuation", "comparableItems",
] as const;

export interface Row { label: string; value: string }
export interface AppendixView { id: string; letter: string; anchor: string; title: string; kind: "pdf" | "image"; url: string; pageCount: number; note: string }
export interface UnitView {
  number: number;
  anchor: string;
  heading: string;
  /** The appraiser's name for the unit ("Heavy Truck #807"), or its type. */
  label: string;
  name: string;
  status: string;
  detailsRows: Row[];
  inspectionRows: Row[];
  damageRows: Row[];
  repairable: "yes" | "no" | "tbd";
  repairLines: { label: string; amount: number | null; text?: string; kind?: "minus" | "total" }[];
  repairNote: string;
  valueBasis: "acv" | "replacement";
  valueAmount: number | null;
  valueNote: string;
  references: string;
  reserve: number | null;
  reserveText: string;
  salvage: number | null;
  salvageText: string;
  market: SalvageMarketView;
  /** True when the market research ran for this unit (Comparable 1 and the calculations print). */
  researched: boolean;
  photoCount: number;
}
export interface SalvageAppraisalView {
  brand: typeof SALVAGE_REPORT_BRAND;
  reportNumberText: string;
  title: string;
  subject: string;
  coverLines: string[];
  assignmentRows: Row[];
  opinion: { type: string; comments: string };
  comments: string;
  followUp: string;
  figures: { label: string; amount: number | null; note?: string; accent?: boolean }[];
  units: UnitView[];
  totals: { value: number | null; reserve: number | null; salvage: number | null };
  appraiser: { name: string; designation: string; title: string; phone: string; email: string; company: string };
  definitions: Row[];
  certification: string[];
  limitations: string[];
  appendices: AppendixView[];
  labels: Record<string, string>;
}

const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Salvage Appraisal Report", report: "Report", reportSummary: "Report Summary", assignment: "Assignment",
    opinion: "Our Opinion – Cause of Loss", type: "Type", comments: "Comments", followUp: "Follow-Up", nextReport: "Next report due",
    units: "Units Appraised", unit: "Unit", status: "Status", value: "Value", reserve: "Recommended Reserve", salvage: "Salvage Value",
    total: "Total", lessDeductible: "less the deductible", unitDetails: "Unit Details", inspection: "Our Inspection", damage: "Damage",
    repairEstimate: "Repair Estimate", valuation: "Valuation", acv: "Actual Cash Value", replacement: "Replacement Cost",
    ourOpinion: "Our opinion", references: "References", repairable: "Repairable", yes: "Yes", no: "No", tbd: "To Be Determined",
    marketAnalysis: "Market Analysis", photographs: "Photographs", definitions: "Definitions", limitations: "Limiting Conditions",
    certification: "Appraiser's Certification", cv: "Appraiser Profile", appendices: "Appendices", appendix: "Appendix",
    pages: "pages", page: "page", signed: "Signed", date: "Date", notEstablished: "Not established", preparedFor: "Prepared for",
    preparedBy: "Prepared by", claim: "Claim", file: "Our file", reportDate: "Report date", lossDate: "Date of loss", units_count: "units",
    seeAppendix: "See Appendix", photo: "Photo", noPhotos: "No photographs supplied", vehicle: "Vehicle",
  },
  fr: {
    title: "Rapport d'évaluation de récupération", report: "Rapport", reportSummary: "Sommaire du rapport", assignment: "Mandat",
    opinion: "Notre opinion – cause du sinistre", type: "Type", comments: "Commentaires", followUp: "Suivi", nextReport: "Prochain rapport",
    units: "Unités évaluées", unit: "Unité", status: "Statut", value: "Valeur", reserve: "Réserve recommandée", salvage: "Valeur de récupération",
    total: "Total", lessDeductible: "moins la franchise", unitDetails: "Détails de l'unité", inspection: "Notre inspection", damage: "Dommages",
    repairEstimate: "Estimation des réparations", valuation: "Évaluation", acv: "Valeur au jour du sinistre", replacement: "Coût de remplacement",
    ourOpinion: "Notre opinion", references: "Références", repairable: "Réparable", yes: "Oui", no: "Non", tbd: "À déterminer",
    marketAnalysis: "Analyse du marché", photographs: "Photographies", definitions: "Définitions", limitations: "Conditions limitatives",
    certification: "Attestation de l'évaluateur", cv: "Profil de l'évaluateur", appendices: "Annexes", appendix: "Annexe",
    pages: "pages", page: "page", signed: "Signé", date: "Date", notEstablished: "Non établi", preparedFor: "Préparé pour",
    preparedBy: "Préparé par", claim: "Sinistre", file: "Notre dossier", reportDate: "Date du rapport", lossDate: "Date du sinistre", units_count: "unités",
    seeAppendix: "Voir l'annexe", photo: "Photo", noPhotos: "Aucune photographie fournie", vehicle: "Véhicule",
  },
  es: {
    title: "Informe de tasación de salvamento", report: "Informe", reportSummary: "Resumen del informe", assignment: "Encargo",
    opinion: "Nuestra opinión – causa de la pérdida", type: "Tipo", comments: "Comentarios", followUp: "Seguimiento", nextReport: "Próximo informe",
    units: "Unidades tasadas", unit: "Unidad", status: "Estado", value: "Valor", reserve: "Reserva recomendada", salvage: "Valor de salvamento",
    total: "Total", lessDeductible: "menos el deducible", unitDetails: "Detalles de la unidad", inspection: "Nuestra inspección", damage: "Daños",
    repairEstimate: "Estimación de reparación", valuation: "Valoración", acv: "Valor real en efectivo", replacement: "Costo de reposición",
    ourOpinion: "Nuestra opinión", references: "Referencias", repairable: "Reparable", yes: "Sí", no: "No", tbd: "Por determinar",
    marketAnalysis: "Análisis de mercado", photographs: "Fotografías", definitions: "Definiciones", limitations: "Condiciones limitantes",
    certification: "Certificación del tasador", cv: "Perfil del tasador", appendices: "Anexos", appendix: "Anexo",
    pages: "páginas", page: "página", signed: "Firmado", date: "Fecha", notEstablished: "No establecido", preparedFor: "Preparado para",
    preparedBy: "Preparado por", claim: "Reclamación", file: "Nuestro expediente", reportDate: "Fecha del informe", lossDate: "Fecha de la pérdida", units_count: "unidades",
    seeAppendix: "Ver el anexo", photo: "Foto", noPhotos: "No se aportaron fotografías", vehicle: "Vehículo",
  },
};

const NUMBER_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const text = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value.trim();
  return "";
};
const first = (...values: unknown[]): string => values.map(text).find(Boolean) || "";
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
/** A money value typed as a number or as text such as "$105,000.00"; null when it holds no amount. */
export const money = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = text(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
};
const sum = (values: (number | null)[]): number | null => (values.some((v) => v !== null) ? values.reduce<number>((total, v) => total + (v ?? 0), 0) : null);
const dateText = (value: unknown, lang: Lang): string => {
  const raw = text(value instanceof Date ? value.toISOString() : value);
  if (!raw) return "";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw);
  return Number.isNaN(date.getTime()) ? raw
    : date.toLocaleDateString(lang === "fr" ? "fr-CA" : lang === "es" ? "es" : "en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
};

/** Every unit of a report, each merged over the report's claim-level fields. */
export function salvageReportUnits(report: Json): Json[] {
  const claimLevel = { ...report };
  for (const key of SALVAGE_UNIT_FIELDS) delete claimLevel[key];
  delete claimLevel.additional_units;
  return [report, ...list(report.additional_units).filter((unit) => unit && typeof unit === "object")]
    .map((unit, index) => (index === 0 ? report : { ...claimLevel, ...unit }));
}

function repairableOf(value: unknown): "yes" | "no" | "tbd" {
  const v = text(value).toLowerCase();
  return v === "yes" || v === "true" ? "yes" : v === "no" || v === "false" ? "no" : "tbd";
}

function buildUnit(unit: Json, index: number, lang: Lang, L: Record<string, string>, appendixLetter: (id: unknown) => string): UnitView {
  const market = buildSalvageMarketView(unit, lang);
  const assessment = object(unit.assessment);
  const researched = market.canonical;
  const repairable = repairableOf(unit.is_repairable);
  const name = market.subjectName || [unit.year, unit.make, unit.item_model].map(text).filter(Boolean).join(" ");
  const status = first(unit.loss_status,
    repairable === "yes" ? "Repairable" : repairable === "no" ? "Constructive Total Loss" : "To Be Determined");

  const detailsRows: Row[] = [
    { label: "Type", value: first(unit.item_type) },
    { label: "Year", value: first(unit.year) },
    { label: "Make", value: first(unit.make) },
    { label: "Model", value: first(unit.item_model) },
    { label: "VIN / Serial", value: first(unit.vin) },
    { label: "Licence Plate", value: first(unit.licence_plate) },
    { label: "Limit of Insurance", value: first(unit.limit_of_insurance) },
    { label: "Coverage", value: first(unit.coverage) },
    { label: "Deductible", value: first(unit.deductible) },
  ].map((row) => ({ ...row, value: row.value || "N/A" }));
  const photoCount = list(unit.imageUrls).length;
  const inspectionRows: Row[] = [
    { label: "Condition", value: first(unit.item_condition, L.notEstablished) },
    { label: "Hour / Kilometre Reading", value: first(unit.hours, market.groups.flatMap((g) => g.rows).find((r) => r.label === "Odometer")?.client, "Unable to confirm") },
    { label: "Pre-Existing Damage", value: first(unit.pre_existing_damage, "None reported") },
    { label: "Photos of Unit & Damage", value: photoCount ? `${photoCount} included in this report` : L.noPhotos },
    { label: L.comments, value: first(unit.inspection_comments) },
  ].filter((row) => row.value);
  const damageRows: Row[] = [
    { label: "Description of Damage", value: first(unit.damage_description, L.notEstablished) },
    { label: "Repair Facility", value: first(unit.repair_facility) },
    { label: L.comments, value: first(unit.damage_comments, unit.repair_facility_comments) },
  ].filter((row) => row.value);

  // Repair estimate summary, as the company's form prints it. Parts and labour
  // come from the assessment (or an older report's estimate); betterment, shop
  // supplies, miscellaneous and taxes from the appraiser's own entries.
  const repairs = object(assessment.repairs);
  const legacy = object(unit.repair_estimate);
  const summary = object(unit.repair_summary);
  // A unit without research uses the totals the appraiser typed, else an older
  // report's own estimate (which also kept shop supplies, taxes and betterment).
  const typed = (key: string, legacyKey: string) => money(summary[key]) ?? (researched ? null : money(legacy[legacyKey]));
  const parts = researched ? sum(list(repairs.parts).map((p: any) => money(p.total))) : money(summary.parts) ?? money(legacy.parts_subtotal ?? legacy.parts);
  const labour = researched ? sum(list(repairs.labour).map((l: any) => money(l.total))) : money(summary.labour) ?? money(legacy.labour_total ?? legacy.labour);
  const charges = researched ? sum(list(repairs.charges).map((c: any) => money(c.amount))) : null;
  const betterment = typed("betterment", "less_betterment");
  const shop = typed("shop_supplies", "shop_supplies");
  const misc = sum([typed("miscellaneous", "miscellaneous"), charges]);
  const taxes = typed("taxes", "taxes");
  const repairTotal = sum([parts, betterment === null ? null : -Math.abs(betterment), labour, shop, misc, taxes]);
  const appendix = appendixLetter(unit.repair_estimate_appendix);
  const repairLines = [
    { label: "Parts", amount: parts },
    { label: "Less Betterment", amount: betterment === null ? null : Math.abs(betterment), kind: "minus" as const },
    { label: "Labour", amount: labour },
    { label: "Shop Supplies", amount: shop },
    { label: "Miscellaneous", amount: misc },
    { label: "Taxes", amount: taxes },
    { label: L.total.toUpperCase(), amount: repairTotal, kind: "total" as const },
  ].map((line) => (line.amount === null ? { ...line, text: "—" } : line));
  const repairNote = appendix ? `${L.seeAppendix} ${appendix} for the complete repair estimate.` : "";

  const valueBasis = text(unit.value_basis).toLowerCase().startsWith("rep") ? "replacement" : "acv";
  const preLoss = money(object(object(assessment.valuations).preLoss).amount);
  // The report normaliser stores a missing ACV / replacement cost as 0, so 0
  // means "not entered": the researched pre-loss value is used instead.
  const entered = (value: unknown) => { const amount = money(value); return amount !== null && amount > 0 ? amount : null; };
  const valueAmount = valueBasis === "replacement" ? entered(unit.replacement_cost) : entered(unit.actual_cash_value) ?? preLoss;
  const valueNote = valueAmount === null ? L.notEstablished : "";
  const sources = [...new Set(market.comparables.map((c) => c.source).filter(Boolean))];
  const references = first(unit.replacement_cost_references,
    sources.length ? `Comparable market evidence: ${sources.join(", ")} (see the market analysis for this unit).` : "");
  // The appraiser's reserve has its own field: for researched reports the
  // normaliser blanks recommended_reserve on purpose (an old AI figure is not a
  // reserve). Older reports keep printing their stored reserve; 0 there means
  // it was never entered.
  const reserve = money(unit.appraiser_reserve) ?? entered(unit.recommended_reserve);
  const salvage = money(unit.salvage_value) ?? money(object(object(assessment.valuations).asIs).amount);
  const unitLabel = first(unit.unit_label, text(unit.item_type) ? `${unit.item_type}` : "");

  return {
    number: index + 1,
    anchor: `salvage-unit-${index + 1}`,
    heading: `${L.unit} ${index + 1}${unitLabel ? ` — ${unitLabel}` : ""}`,
    label: unitLabel, name, status, detailsRows, inspectionRows, damageRows, repairable, repairLines, repairNote,
    valueBasis, valueAmount, valueNote, references,
    reserve, reserveText: reserve === null ? L.notEstablished : "",
    salvage, salvageText: salvage === null ? first(unit.salvage_value, "N/A") : "",
    market, researched, photoCount,
  };
}

export function buildSalvageAppraisalView(report: Json, lang: Lang = "en"): SalvageAppraisalView {
  const L = LABELS[lang] || LABELS.en;

  // Appendices in upload order, lettered A, B, C ...
  const appendices: AppendixView[] = list(report.appendices)
    .filter((a: any) => a && text(a.url) && (a.kind === "pdf" || a.kind === "image"))
    .map((a: any, index) => {
      const letter = String.fromCharCode(65 + index);
      const pageCount = a.kind === "image" ? 1 : Math.max(1, Math.floor(Number(a.pageCount) || 1));
      return { id: text(a.id) || letter, letter, anchor: `salvage-appendix-${letter.toLowerCase()}`, title: first(a.title, `${L.appendix} ${letter}`),
        kind: a.kind, url: text(a.url), pageCount, note: first(a.note) };
    });
  const appendixLetter = (id: unknown) => appendices.find((a) => a.id === text(id))?.letter || "";

  const units = salvageReportUnits(report).map((unit, index) => buildUnit(unit, index, lang, L, appendixLetter));
  const totals = {
    value: sum(units.map((u) => u.valueAmount)),
    reserve: sum(units.map((u) => u.reserve)),
    salvage: sum(units.map((u) => u.salvage)),
  };
  const reportNumber = Math.max(1, Math.floor(Number(report.report_number) || 1));
  const profile = object(report.appraiser_profile);
  const appraiser = {
    name: first(profile.name, report.appraiser_name),
    designation: first(profile.designation),
    title: first(profile.title, "Appraiser"),
    phone: first(profile.phone, report.appraiser_phone),
    email: first(profile.email, report.appraiser_email),
    company: SALVAGE_REPORT_BRAND.name,
  };

  const assignmentRows: Row[] = [
    { label: "Insurer", value: first(report.company_name) },
    { label: "Address", value: first(report.company_address) },
    { label: "Date Received", value: dateText(report.date_received, lang) },
    { label: "File / Claim Number", value: first(report.claim_number) },
    { label: "Name of Adjuster", value: first(report.adjuster_name) },
    { label: "Name of Insured", value: first(report.insured_name) },
    { label: "Policy Number", value: first(report.policy_number) },
    { label: "Date of Loss", value: dateText(report.date_of_loss, lang) },
    { label: "Reported Type of Loss", value: first(report.reported_loss_type) },
    { label: "Our File Number", value: first(report.file_number) },
    { label: "Report Date", value: dateText(report.report_date, lang) },
  ].map((row) => ({ ...row, value: row.value || "N/A" }));

  const figures = [
    { label: L.reserve, amount: totals.reserve, note: L.lessDeductible, accent: true },
    { label: units.every((u) => u.valueBasis === "replacement") ? L.replacement : L.acv, amount: totals.value },
    { label: L.salvage, amount: totals.salvage },
    { label: L.units, amount: null, note: units.map((u) => u.status).join(" · ") },
  ];

  const definitions: Row[] = [
    { label: "Actual Cash Value", value: "The value of the property immediately before the loss: what a willing buyer would pay a willing seller for property of the same kind, age and condition, neither being under pressure to act." },
    { label: "Replacement Cost", value: "The cost, on the report date, to replace the property with new property of like kind and quality, without deduction for depreciation." },
    { label: "Constructive Total Loss", value: "A loss where the cost to repair, together with the related costs, would exceed the property's actual cash value less its salvage value, so that repair is not economical." },
    { label: "Salvage Value", value: "The amount the damaged property is expected to bring when sold as is, where is, on the report date, before selling costs unless stated." },
    { label: "Recommended Reserve", value: "The appraiser's estimate of the amount to set aside for the loss, before the deductible is applied." },
    { label: "Betterment", value: "The part of a repair that leaves the property in better condition than it was in before the loss." },
  ];
  const certification = [
    "The statements of fact in this report are true and correct to the best of my knowledge and belief.",
    "The analyses, opinions and conclusions are limited only by the limiting conditions stated in this report, and are my own impartial and unbiased professional opinions.",
    "I have no present or prospective interest in the property appraised and no personal interest in the parties involved.",
    "My engagement and compensation do not depend on the values reported, on any agreed result, or on any later event in the claim.",
    "The inspection described in this report was carried out by me or under my direction, and no one other than those named provided significant assistance.",
  ];
  const marketLimitations = units.flatMap((u) => u.market.notes.general);
  const limitations = [...new Set([
    "This report is prepared for the insurer named in the assignment and for the claim identified; it is not to be used for any other purpose or by any other party without our written consent.",
    "Values are in Canadian dollars, exclude taxes unless stated, and apply on the report date. Market conditions change.",
    "The inspection was visual. It is not a mechanical, structural, title or lien inspection; damage hidden from view or found on teardown may change the repair estimate and the opinions in this report.",
    "Information supplied by the insured, the insurer, repair facilities and dealers is assumed to be accurate.",
    ...marketLimitations,
  ])];

  const coverLines = units.map((u) => [u.label, u.name].filter(Boolean).join(" — "));
  return {
    brand: SALVAGE_REPORT_BRAND,
    reportNumberText: `${L.report} ${NUMBER_WORDS[reportNumber] || reportNumber}`,
    title: L.title,
    subject: units.length === 1 ? units[0].name : `${units.length} ${L.units_count}`,
    coverLines: units.length > 1 ? coverLines : [],
    assignmentRows,
    opinion: { type: first(report.cause_of_loss_summary, L.notEstablished), comments: first(report.cause_of_loss_comments, "None") },
    comments: first(report.appraiser_comments),
    followUp: first(report.follow_up, report.next_report_due ? dateText(report.next_report_due, lang) : "", "Upon Request"),
    figures, units, totals, appraiser, definitions, certification, limitations, appendices,
    labels: L,
  };
}
