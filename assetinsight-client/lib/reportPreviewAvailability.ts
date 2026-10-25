type PreviewRecord = {
  reportType: string;
  preview_available?: boolean;
  preview_data?: unknown;
  lots?: unknown;
};

export function hasSavedReportPreview(report: PreviewRecord): boolean {
  if (typeof report.preview_available === "boolean") return report.preview_available;
  // Compatibility with backends deployed before preview_available existed.
  const preview = report.preview_data as { lots?: unknown } | null | undefined;
  const lots = preview != null
    ? preview.lots
    : report.reportType === "lotListing" ? report.lots : undefined;
  return Array.isArray(lots) && lots.length > 0 && lots.every(
    (lot) => lot && typeof lot === "object" && !Array.isArray(lot) && Object.keys(lot).length > 0,
  );
}
