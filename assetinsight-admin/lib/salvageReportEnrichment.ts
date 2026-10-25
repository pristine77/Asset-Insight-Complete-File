/** Backend-owned presentation of saved evidence. Never include in mutation payloads. */
export interface SalvageReportEnrichment {
  schemaVersion: 1;
  sections: Array<{ id: string; title: string; paragraphs: string[];
    tables: Array<{ headers: string[]; rows: string[][] }> }>;
}
export const SALVAGE_REPORT_CONTEXT_FIELDS = [
  "intended_use", "scope_of_work", "valuation_premise", "pre_loss_condition", "inspection_basis",
  "repair_estimate_status", "repair_estimate_date", "lead_time_notes", "market_context",
  "reconciliation_notes", "appraiser_conclusion", "client_comments",
] as const;
export type SalvageReportContext = Partial<Record<typeof SALVAGE_REPORT_CONTEXT_FIELDS[number], string | null>>;

export function isSalvageReportEnrichment(value: unknown): value is SalvageReportEnrichment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
  return row.schemaVersion === 1 && Array.isArray(row.sections) && row.sections.every(section =>
    section && typeof section === "object" && typeof section.id === "string" && typeof section.title === "string"
    && strings(section.paragraphs) && Array.isArray(section.tables) && section.tables.every((table: unknown) => {
      if (!table || typeof table !== "object") return false;
      const entry = table as Record<string, unknown>;
      return strings(entry.headers) && Array.isArray(entry.rows) && entry.rows.every(strings);
    }));
}

/** Omitted keys retain server values; explicit blank/null clears only that note. */
export function editableSalvageReportContext(value: unknown): SalvageReportContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return Object.fromEntries(SALVAGE_REPORT_CONTEXT_FIELDS.filter(key =>
    Object.hasOwn(row, key) && (typeof row[key] === "string" || row[key] === null)).map(key => [key, row[key]]));
}

