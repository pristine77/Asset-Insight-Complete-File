import { isSalvageAssessmentV2, projectSalvageAssessmentLegacyFields } from "./salvageAssessment.js";

/**
 * Units 2 onward in the Salvage report job (owner, 2026-11-01: one report
 * covers several units, each with its own research). Each researched unit
 * runs the same Canadian market research as unit 1, on its own photos and
 * loops, in the claim's market (province, city, date and loss type come from
 * the report).
 */

type Json = Record<string, any>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/** The claim's market context, shared by every unit. */
const SHARED_CONTEXT = ["province", "market", "effectiveDate", "lossType", "brandProvince"] as const;

/** What the research pipeline reads for one unit. */
export function salvageUnitResearchSnapshot(facts: Json, unit: Json): Json {
  const reportInputs = isObject(facts.assessment_inputs) ? facts.assessment_inputs : {};
  const context = Object.fromEntries(SHARED_CONTEXT.filter((key) => reportInputs[key] !== undefined).map((key) => [key, reportInputs[key]]));
  // A unit already researched keeps its own saved inputs (and appraiser edits).
  const canonical = isSalvageAssessmentV2(unit.assessment);
  return {
    year: unit.year, make: unit.make, item_model: unit.item_model, vin: unit.vin, item_type: unit.item_type,
    item_condition: unit.item_condition, damage_description: unit.damage_description,
    reported_loss_type: facts.reported_loss_type, language: facts.language, currency: "CAD",
    ...(canonical ? { assessment: unit.assessment } : {}),
    assessment_inputs: canonical
      ? { ...(isObject(unit.assessment_inputs) ? unit.assessment_inputs : unit.assessment.inputs), ...context }
      : { ...context, condition: text(unit.item_condition) || null, damageDescription: text(unit.damage_description) || null },
  };
}

/**
 * A unit after its research: the assessment and its inputs are saved on the
 * unit; identity the appraiser left blank is filled from what the research
 * read in the photos. The appraiser's own entries are never replaced.
 */
export function mergeSalvageUnitResearch(unit: Json, result: Json): Json {
  const merged: Json = { ...unit };
  if (isSalvageAssessmentV2(result.assessment)) {
    merged.assessment = result.assessment;
    merged.assessment_inputs = isObject(result.assessment_inputs) ? result.assessment_inputs : result.assessment.inputs;
    const projected = projectSalvageAssessmentLegacyFields(result.assessment) as Json;
    for (const key of ["year", "make", "item_model", "vin", "item_condition", "damage_description"]) {
      if (!text(merged[key]) && text(projected[key])) merged[key] = text(projected[key]);
    }
  }
  if (typeof result.analysis_warning === "string" && result.analysis_warning) merged.analysis_warning = result.analysis_warning.slice(0, 4000);
  return merged;
}

const same = (a: unknown, b: unknown) => Boolean(text(a)) && text(a).toLowerCase() === text(b).toLowerCase();

/**
 * The appraiser profile printed in a report (owner, 2026-11-01: signature
 * block and CV from a profile set once). The report owner's signature and CV
 * are attached only when the report names that person as its appraiser (by
 * email or name), so a report written for someone else is never signed with
 * the owner's signature. Name and contact details always come from the report.
 */
export function salvageAppraiserProfileFor(report: Json, owner: Json | null): Json {
  const profile = isObject(owner?.appraiserProfile) ? owner!.appraiserProfile : {};
  const isOwner = Boolean(owner) && (
    [owner!.email, owner!.contactEmail].some((email) => same(email, report.appraiser_email))
    || [owner!.name, owner!.username].some((name) => same(name, report.appraiser_name)));
  return {
    name: text(report.appraiser_name) || (isOwner ? text(owner!.name) || text(owner!.username) : ""),
    phone: text(report.appraiser_phone) || (isOwner ? text(owner!.contactPhone) : ""),
    email: text(report.appraiser_email) || (isOwner ? text(owner!.contactEmail) || text(owner!.email) : ""),
    ...(isOwner ? {
      designation: text(profile.designation), title: text(profile.title),
      ...(text(profile.signatureUrl) ? { signatureUrl: text(profile.signatureUrl) } : {}),
      ...(text(profile.cvPdfUrl) ? { cvUrl: text(profile.cvPdfUrl) } : {}),
    } : {}),
  };
}
