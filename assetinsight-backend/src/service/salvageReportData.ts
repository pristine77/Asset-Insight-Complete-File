import { isSalvageAssessmentV2, projectSalvageAssessmentLegacyFields } from "./salvageAssessment.js";
import { buildSalvageReportEnrichment, normalizeSalvageReportContext } from "./salvageReportEnrichment.js";

/** Canonical, side-effect-free snapshot shared by Salvage review and all exports. */
type Data = Record<string, any>;

const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const own = (data: Data, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key);
const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
export function salvageNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = value.trim().replace(/(?:CAD|USD|EUR|GBP|CA\$|US\$|[$€£,\s])/gi, "");
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}
const nonnegative = (value: unknown): number | undefined => {
  const result = salvageNumber(value);
  return result !== undefined && result >= 0 ? result : undefined;
};
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function normalizeSalvageReportData(input: unknown): Data {
  const source = record(input);
  const ai = record(source.aiExtractedDetails);
  const result: Data = { ...source };
  const fields = [
    "item_type", "year", "make", "item_model", "vin", "item_condition", "damage_description",
    "inspection_comments", "is_repairable", "repair_facility", "repair_facility_comments",
    "replacement_cost_references", "procurement_notes", "assumptions", "safety_concerns", "priority_level",
  ];
  for (const key of fields) result[key] = text(own(source, key) ? source[key] : ai[key]);
  for (const key of ["actual_cash_value", "replacement_cost", "recommended_reserve"]) {
    result[key] = nonnegative(own(source, key) ? source[key] : ai[key]) ?? 0;
  }
  result.language = ["fr", "es"].includes(source.language) ? source.language : "en";
  const currency = text(source.currency).trim().toUpperCase();
  result.currency = /^[A-Z]{3}$/.test(currency) ? currency : "CAD";
  result.imageUrls = Array.isArray(source.imageUrls) ? [...source.imageUrls] : [];
  result.comparableItems = Array.isArray(source.comparableItems) ? source.comparableItems.map((item: unknown) => ({ ...record(item) })) : [];
  result.valuation = { ...record(source.valuation) };
  const specialty = record(own(source, "specialty_data") ? source.specialty_data : ai.specialty_data);
  result.specialty_data = {
    client_vehicle: { ...record(specialty.client_vehicle) },
    comparable_1: { ...record(specialty.comparable_1) },
    adjustments: { ...record(specialty.adjustments) },
  };

  const estimate = { ...record(ai.repair_estimate), ...record(source.repair_estimate) };
  const partsInput = own(source, "repair_items") ? source.repair_items : estimate.parts_items;
  const labourInput = own(source, "labour_breakdown") ? source.labour_breakdown : estimate.labour_breakdown;
  // Preserve legacy summary-only estimates across repeated normalize/save/render
  // passes. An explicit empty array still clears an itemized estimate.
  const partsItemized = Array.isArray(partsInput) && (partsInput.length > 0 || estimate.parts_itemized !== false);
  const labourItemized = Array.isArray(labourInput) && (labourInput.length > 0 || estimate.labour_itemized !== false);
  const defaultRate = nonnegative(own(source, "labour_rate_default") ? source.labour_rate_default : estimate.labour_rate_default) ?? 0;
  const parts = (Array.isArray(partsInput) ? partsInput : []).map((value: unknown) => {
    const item = record(value);
    const quantity = nonnegative(item.quantity);
    const unitPrice = nonnegative(item.unit_price);
    return {
      ...item, name: text(item.name), quantity, unit_price: unitPrice,
      // Edited quantity/price win over a stale model-generated line total.
      line_total: money(quantity !== undefined && unitPrice !== undefined ? quantity * unitPrice : nonnegative(item.line_total) ?? 0),
    };
  });
  const labour = (Array.isArray(labourInput) ? labourInput : []).map((value: unknown) => {
    const task = record(value);
    const hours = nonnegative(task.hours);
    const rate = nonnegative(task.rate_per_hour) ?? defaultRate;
    return { ...task, task: text(task.task), hours, rate_per_hour: rate,
      line_total: money(hours !== undefined ? hours * rate : nonnegative(task.line_total) ?? 0) };
  });
  const partsTotal = money(partsItemized
    ? parts.reduce((sum, item) => sum + item.line_total, 0)
    : nonnegative(estimate.parts ?? estimate.parts_subtotal ?? source.parts_subtotal) ?? 0);
  const labourTotal = money(labourItemized
    ? labour.reduce((sum, task) => sum + task.line_total, 0)
    : nonnegative(estimate.labour ?? estimate.labour_total ?? source.labour_total) ?? 0);
  const normalizedEstimate: Data = { ...estimate, parts: partsTotal, labour: labourTotal,
    parts_itemized: partsItemized, labour_itemized: labourItemized,
    parts_subtotal: partsTotal, labour_total: labourTotal, parts_items: parts, labour_breakdown: labour,
    labour_rate_default: defaultRate };
  for (const key of ["shop_supplies", "miscellaneous", "taxes", "less_betterment"]) normalizedEstimate[key] = nonnegative(estimate[key]) ?? 0;
  normalizedEstimate.total = money(partsTotal + labourTotal + normalizedEstimate.shop_supplies + normalizedEstimate.miscellaneous + normalizedEstimate.taxes - normalizedEstimate.less_betterment);
  result.repair_estimate = normalizedEstimate;
  result.repair_items = parts;
  result.labour_breakdown = labour;
  result.labour_rate_default = defaultRate;
  result.parts_subtotal = partsTotal;
  result.labour_total = labourTotal;
  result.estimate_warning = text(source.estimate_warning) || ({
    en: "Repair costs are estimates, not supplier quotations. Verify parts, labour, hidden damage and taxes before authorizing repairs.",
    fr: "Les coûts de réparation sont des estimations, pas des devis. Vérifiez les pièces, la main-d'œuvre, les dommages cachés et les taxes avant d'autoriser les réparations.",
    es: "Los costos de reparación son estimaciones, no cotizaciones. Verifique piezas, mano de obra, daños ocultos e impuestos antes de autorizar las reparaciones.",
  } as Record<string, string>)[result.language];
  // Renderers historically read both aliases. Mirror the canonical snapshot in
  // this returned copy only; never mutate the stored AI evidence passed by callers.
  result.aiExtractedDetails = { ...ai, ...Object.fromEntries(fields.map((key) => [key, result[key]])),
    repair_estimate: normalizedEstimate, specialty_data: result.specialty_data,
    actual_cash_value: result.actual_cash_value, replacement_cost: result.replacement_cost,
    recommended_reserve: result.recommended_reserve };
  // Enterprise calculations are already deterministic and evidence-checked.
  // Apply them last on every normalization pass so legacy defaults cannot turn
  // unavailable values into zero or resurrect stale model-generated totals.
  if (isSalvageAssessmentV2(source.assessment)) {
    const projection = projectSalvageAssessmentLegacyFields(source.assessment);
    Object.assign(result, projection);
    result.aiExtractedDetails = { ...result.aiExtractedDetails, ...projection };
  }
  result.report_context = normalizeSalvageReportContext(source.report_context);
  // Always derive this view; stale or client-supplied enriched sections are not evidence.
  result.report_enrichment = buildSalvageReportEnrichment(result);
  return result;
}

export function formatSalvageDate(value: unknown, language: string = "en"): string {
  if (value === undefined || value === null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "fr" ? "fr-CA" : language === "es" ? "es-ES" : "en-CA", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  }).format(date);
}

export const buildSalvageReportData = normalizeSalvageReportData;
