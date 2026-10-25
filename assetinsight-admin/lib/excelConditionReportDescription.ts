/**
 * A missing Description is an older server DTO, not an instruction to clear it.
 * Keep explicit empty strings and do not infer a Description from the Title.
 */
export function excelConditionReportDescription(
  row: { description?: unknown }
): { description?: string } {
  return typeof row.description === "string" ? { description: row.description } : {};
}

export function excelConditionReportTitleHelp(scope?: "lot" | "item"): string {
  if (scope === "lot") {
    return "Title is used as Description in Excel, CR PDF and CR DOCX after Save & regenerate files.";
  }
  if (scope === "item") {
    return "Title is used as Description for this item's Excel row. CR PDF and CR DOCX use the parent lot's Title.";
  }
  return "Title is used as Description in generated files. CR PDF and CR DOCX use the parent lot's Title.";
}
