import { randomUUID } from "node:crypto";
import { normalizeSalvageDamageMarks } from "../utils/salvageDamageMarks.js";
import { refreshReviewedSalvageUnitIdentity } from "./salvageUnitResearch.js";

/**
 * Fields of the full MCD Appraisals Salvage report (owner, 2026-11-01): the
 * company's own report content (licence plate, limit of insurance, coverage,
 * deductible, pre-existing damage, repairable status, betterment, shop
 * supplies, taxes, Actual Cash Value or Replacement Cost, recommended reserve,
 * salvage value, follow-up) and several units in one report.
 *
 * Unit 1 is the report's own top-level fields, as every existing report is.
 * Units 2 onward live in `additional_units`, each with the same field names
 * plus server-owned ones: a stable `id`, its `imageUrls` (saved by the report
 * job from the photos uploaded with the report), and its market research
 * (`assessment`, `assessment_inputs`). A browser never supplies server-owned
 * fields: create strips them, and a preview save takes them from the saved
 * unit with the same id. The PDF downloads every photo address a report holds,
 * so an address can only come from the server's own upload.
 */

class SalvageAppraisalFieldError extends Error {}
export { SalvageAppraisalFieldError };

/** At most ten units in one report (unit 1 plus nine more). */
export const SALVAGE_MAX_ADDITIONAL_UNITS = 9;
/** Photos per unit, as for unit 1, and across all additional units. */
export const SALVAGE_MAX_UNIT_PHOTOS = 50;
export const SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS = 150;

/** Report-level (claim) fields. */
export const SALVAGE_REPORT_APPRAISAL_FIELDS = ["report_number", "cause_of_loss_comments", "follow_up"] as const;
/** Unit fields new to the report; unit 1 keeps them at the top level. */
export const SALVAGE_UNIT_APPRAISAL_FIELDS = [
  "unit_label", "licence_plate", "limit_of_insurance", "coverage", "deductible", "hours", "pre_existing_damage",
  "damage_comments", "loss_status", "repair_estimate_appendix", "value_basis", "appraiser_reserve", "salvage_value", "repair_summary",
] as const;

const TEXT_LIMITS: Record<string, number> = {
  // report level
  cause_of_loss_comments: 4000, follow_up: 300,
  // every unit
  unit_label: 120, licence_plate: 40, limit_of_insurance: 60, coverage: 120, deductible: 60, hours: 120,
  pre_existing_damage: 2000, damage_comments: 4000, loss_status: 60, repair_estimate_appendix: 64, salvage_value: 60,
  // additional units only (unit 1 already has these fields)
  item_type: 120, year: 10, make: 120, item_model: 120, vin: 64, item_condition: 2000, inspection_comments: 4000,
  damage_description: 8000, is_repairable: 40, repair_facility: 300, repair_facility_comments: 4000, replacement_cost_references: 2000,
};
export const SALVAGE_LOSS_STATUSES = ["Repairable", "Constructive Total Loss", "To Be Determined", "No Damage", "Not Listed on the Policy"] as const;
const REPAIR_SUMMARY_KEYS = ["parts", "labour", "betterment", "shop_supplies", "miscellaneous", "taxes"] as const;
/** Unit fields an appraiser edits; everything else on a unit is server-owned. */
const UNIT_EDITABLE = [
  ...Object.keys(TEXT_LIMITS).filter((key) => !["cause_of_loss_comments", "follow_up"].includes(key)),
  "appraiser_reserve", "actual_cash_value", "replacement_cost", "value_basis", "repair_summary", "research", "damage_marks",
] as const;

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function salvageAppraisalText(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "boolean"].includes(typeof value)) throw new SalvageAppraisalFieldError(`Invalid ${key}.`);
  const text = String(value).trim();
  const limit = TEXT_LIMITS[key] ?? 2000;
  if (text.length > limit) throw new SalvageAppraisalFieldError(`${key} is too long (at most ${limit} characters).`);
  if (key === "loss_status" && text && !(SALVAGE_LOSS_STATUSES as readonly string[]).includes(text)) {
    throw new SalvageAppraisalFieldError(`Invalid loss_status; use one of: ${SALVAGE_LOSS_STATUSES.join(", ")}.`);
  }
  return text;
}

/** A nonnegative amount, or null when left blank. */
export function salvageAppraisalMoney(key: string, value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new SalvageAppraisalFieldError(`Invalid ${key}: use a nonnegative number.`);
  return Math.round(amount * 100) / 100;
}

export function salvageReportNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 1;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new SalvageAppraisalFieldError("Invalid report_number: use 1 to 20.");
  return number;
}

export function salvageValueBasis(value: unknown): "" | "acv" | "replacement" {
  if (value === null || value === undefined || value === "") return "";
  if (value === "acv" || value === "replacement") return value;
  throw new SalvageAppraisalFieldError("Invalid value_basis: use acv or replacement.");
}

export function salvageRepairSummary(value: unknown): Record<string, number | null> {
  if (value === null || value === undefined) return {};
  if (!isObject(value)) throw new SalvageAppraisalFieldError("Invalid repair_summary.");
  return Object.fromEntries(REPAIR_SUMMARY_KEYS.filter((key) => own(value, key)).map((key) => [key, salvageAppraisalMoney(`repair_summary ${key}`, value[key])]));
}

/** Normalize one report/unit field from SALVAGE_REPORT_APPRAISAL_FIELDS or SALVAGE_UNIT_APPRAISAL_FIELDS. */
export function normalizeSalvageAppraisalField(key: string, value: unknown): unknown {
  if (key === "report_number") return salvageReportNumber(value);
  if (key === "value_basis") return salvageValueBasis(value);
  if (key === "appraiser_reserve") return salvageAppraisalMoney(key, value);
  if (key === "repair_summary") return salvageRepairSummary(value);
  return salvageAppraisalText(key, value);
}

function editableUnitFields(raw: Record<string, any>, photoCount: number): Record<string, any> {
  const unit: Record<string, any> = {};
  for (const key of UNIT_EDITABLE) {
    if (!own(raw, key) || raw[key] === undefined) continue;
    const value = raw[key];
    if (key === "research") unit.research = value === true;
    else if (key === "damage_marks") unit.damage_marks = normalizeSalvageDamageMarks(value, photoCount);
    else if (key === "value_basis") unit.value_basis = salvageValueBasis(value);
    else if (key === "repair_summary") unit.repair_summary = salvageRepairSummary(value);
    else if (["appraiser_reserve", "actual_cash_value", "replacement_cost"].includes(key)) unit[key] = salvageAppraisalMoney(key, value);
    else unit[key] = salvageAppraisalText(key, value);
  }
  return unit;
}

const UNIT_ID = /^u[a-z0-9-]{1,40}$/;

/**
 * Check a stored (server-written) units list: shapes and sizes only. Used for
 * snapshots the server itself built, which may carry photos and research.
 */
export function normalizeStoredSalvageUnits(value: unknown): Record<string, any>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > SALVAGE_MAX_ADDITIONAL_UNITS) {
    throw new SalvageAppraisalFieldError(`A report can have at most ${SALVAGE_MAX_ADDITIONAL_UNITS + 1} units.`);
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!isObject(raw) || typeof raw.id !== "string" || !UNIT_ID.test(raw.id) || ids.has(raw.id)) throw new SalvageAppraisalFieldError("Invalid unit.");
    ids.add(raw.id);
    const imageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : [];
    if (imageUrls.length > SALVAGE_MAX_UNIT_PHOTOS || imageUrls.some((url: unknown) => typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 2000)) {
      throw new SalvageAppraisalFieldError("Invalid unit photos.");
    }
    const declared = Number.isInteger(raw.photo_count) && raw.photo_count >= 0 && raw.photo_count <= SALVAGE_MAX_UNIT_PHOTOS ? raw.photo_count as number : undefined;
    // Until the report job saves a new unit's photos, its loops point at the photos it declared.
    const unit: Record<string, any> = { id: raw.id, ...editableUnitFields(raw, Math.max(imageUrls.length, declared ?? 0)), imageUrls: [...imageUrls] };
    if (declared !== undefined) unit.photo_count = declared;
    for (const key of ["assessment", "assessment_inputs", "aiExtractedDetails"]) if (isObject(raw[key])) unit[key] = raw[key];
    if (typeof raw.analysis_warning === "string") unit.analysis_warning = raw.analysis_warning.slice(0, 4000);
    return unit;
  });
}

/**
 * Units sent with a new report: ids u2, u3 ... (stable, so a retried upload
 * has the same fingerprint), each unit's photo count (its photos follow unit
 * 1's in the upload, in unit order), and loops checked against that count.
 * Photos, research and any other server-owned field are dropped.
 */
export function createSalvageUnitsFromClient(value: unknown): Record<string, any>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > SALVAGE_MAX_ADDITIONAL_UNITS) {
    throw new SalvageAppraisalFieldError(`A report can have at most ${SALVAGE_MAX_ADDITIONAL_UNITS + 1} units.`);
  }
  let total = 0;
  return value.map((raw, index) => {
    if (!isObject(raw)) throw new SalvageAppraisalFieldError("Invalid unit.");
    const photoCount = raw.photo_count === undefined ? 0 : Number(raw.photo_count);
    if (!Number.isInteger(photoCount) || photoCount < 0 || photoCount > SALVAGE_MAX_UNIT_PHOTOS) {
      throw new SalvageAppraisalFieldError(`Each unit can have at most ${SALVAGE_MAX_UNIT_PHOTOS} photos.`);
    }
    total += photoCount;
    if (total > SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS) throw new SalvageAppraisalFieldError(`Units 2 onward can have at most ${SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS} photos together.`);
    const unit: Record<string, any> = { id: `u${index + 2}`, ...editableUnitFields(raw, photoCount), photo_count: photoCount, imageUrls: [] as string[] };
    // Research runs for a unit with photos unless the appraiser turned it off.
    unit.research = photoCount > 0 && raw.research !== false;
    if (unit.damage_marks && !unit.damage_marks.length) delete unit.damage_marks;
    return unit;
  });
}

/**
 * A preview save: the browser's units in its order, each merged over the
 * saved unit with the same id (keeping that unit's photos and research). A
 * unit with no matching id is a new unit without photos (for example "Bin 4 -
 * no damage"); its loops are dropped since it has no photos.
 */
export function mergeSalvageUnitsFromClient(current: unknown, incoming: unknown): Record<string, any>[] {
  if (!Array.isArray(incoming)) throw new SalvageAppraisalFieldError("Invalid additional_units.");
  if (incoming.length > SALVAGE_MAX_ADDITIONAL_UNITS) throw new SalvageAppraisalFieldError(`A report can have at most ${SALVAGE_MAX_ADDITIONAL_UNITS + 1} units.`);
  const saved = new Map(normalizeStoredSalvageUnits(current).map((unit) => [unit.id, unit]));
  const used = new Set<string>();
  return incoming.map((raw) => {
    if (!isObject(raw)) throw new SalvageAppraisalFieldError("Invalid unit.");
    const existing = typeof raw.id === "string" && !used.has(raw.id) ? saved.get(raw.id) : undefined;
    if (existing) {
      used.add(existing.id);
      return refreshReviewedSalvageUnitIdentity({ ...existing, ...editableUnitFields(raw, existing.imageUrls.length) }, raw);
    }
    const { damage_marks: _ignored, ...rest } = raw;
    return { id: `u-${randomUUID().slice(0, 12)}`, ...editableUnitFields(rest, 0), imageUrls: [], research: false };
  });
}
