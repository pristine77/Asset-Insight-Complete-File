/** Only use on system-generated labels/warnings. Never rewrite appraiser text or quoted evidence. */
export function salvageSystemText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\bAI-assisted\s*/gi, "")
    .replace(/\b(?:OpenAI|GPT-\d[\w.-]*)\b/gi, "assessment service")
    .replace(/\bAI\s+(?=research|search|quality)/gi, "")
    .replace(/\bAI\b/gi, "automated assessment");
}

/** A display-only copy; saved evidence, provider diagnostics and audit history stay unchanged. */
export function presentSalvageSnapshot<T extends Record<string, any>>(snapshot: T): T {
  const result = { ...snapshot };
  for (const key of ["analysis_warning", "estimate_warning"] as const) {
    if (typeof snapshot[key] === "string") (result as Record<string, any>)[key] = salvageSystemText(snapshot[key]);
  }
  delete result.analysis_model;
  if (snapshot.assessment?.schemaVersion === 2) {
    const assessment = { ...snapshot.assessment };
    assessment.limitations = snapshot.assessment.limitations.map((item: any) => ({ ...item, message: salvageSystemText(item.message) }));
    if (assessment.research) {
      const { model: _model, searchModel: _searchModel, calls: _calls, ...research } = assessment.research;
      for (const key of ["plan", "preLossSearch", "asIsSearch", "repairSearch", "qualityReview"]) {
        if (research[key]?.label) research[key] = { ...research[key], label: salvageSystemText(research[key].label) };
      }
      assessment.research = research;
    }
    (result as Record<string, any>).assessment = assessment;
    if (snapshot.valuation?.limitations) (result as Record<string, any>).valuation = {
      ...snapshot.valuation, limitations: snapshot.valuation.limitations.map(salvageSystemText),
    };
  }
  return result;
}
