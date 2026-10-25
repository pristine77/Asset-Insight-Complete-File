import type { WorkspaceNotification } from "@/services/notifications";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Display saved notification text only; never interpret markup or supplied URLs. */
export function previewReminderDetails(item: WorkspaceNotification) {
  const data = item.data || {};
  if ((item.type || data.type) !== "preview_review_reminder") return null;
  const reportId = text(data.reportId);
  // Older scheduled draft reminders used the dashboard's Drafts view.
  const isDraft = data.kind === "draft" || data.route === "/drafts" || data.route === "/dashboard";
  const reportType = data.reportType === "Asset" ? "asset" : data.reportType === "LotListing" ? "lotListing" : null;
  const correctionSteps = Array.isArray(data.correctionSteps)
    ? data.correctionSteps.map(text).filter(Boolean)
    : text(data.correctionSteps) ? [text(data.correctionSteps)] : [];
  return {
    subject: text(data.subject) || item.title,
    message: text(data.message) || item.body,
    reportError: text(data.reportError),
    correctionSteps,
    contractNo: text(data.contractNo),
    reportLabel: reportType === "asset" ? "Asset Report" : reportType === "lotListing" ? "Lot Listing" : "Report",
    linkLabel: isDraft ? "Open drafts" : "Open related preview",
    previewHref: isDraft ? "/drafts" : reportType && /^[a-f\d]{24}$/i.test(reportId)
      ? `/previews?reportId=${encodeURIComponent(reportId)}&reportType=${reportType}`
      : null,
  };
}
