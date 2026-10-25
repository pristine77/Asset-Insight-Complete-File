/** Display-only section contract produced by the canonical report normalizer. */
export interface SalvageReportSection {
  id: string;
  title: string;
  paragraphs: string[];
  tables: Array<{ headers: string[]; rows: string[][] }>;
}

/** Keep ordinary evidence rows together; only oversized narratives may split. */
export function salvageReportRowNeedsSplit(row: string[]): boolean {
  const limit = Math.floor(2400 / Math.max(1, row.length));
  return row.some(value => value.length > limit || value.split(/\r?\n/).length > 24);
}

export function salvageReportSections(report: any) {
  const sections: SalvageReportSection[] = report?.report_enrichment?.schemaVersion === 1
    && Array.isArray(report.report_enrichment.sections) ? report.report_enrichment.sections : [];
  return {
    executive: sections.filter(section => section.id === 'executive-summary'),
    body: sections.filter(section => section.id !== 'executive-summary' && section.id !== 'references'),
    references: sections.filter(section => section.id === 'references'),
    // Do not suppress legacy content unless its canonical replacement exists.
    canonicalRepair: report?.assessment?.schemaVersion === 2 && sections.some(section => section.id === 'repair-provenance'),
    canonicalValuation: report?.assessment?.schemaVersion === 2 && sections.some(section => section.id === 'valuation-calculations'),
    canonicalComparables: report?.assessment?.schemaVersion === 2 && sections.some(section => section.id === 'comparable-verification'),
  };
}

/** Report evidence becomes a link only when it is a complete public web URL. */
export function safeSalvageReportLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
