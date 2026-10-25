export function shouldUseGroupDocsMerge(
  value = process.env.REPORT_DOCX_MERGE_MODE
): boolean {
  return value?.trim().toLowerCase() === "groupdocs";
}
