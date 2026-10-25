import type { NotificationItem } from "../services/notificationService";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function previewReminderDetails(item: NotificationItem) {
  const data = item.data || {};
  if ((item.type || data.type) !== "preview_review_reminder") return null;
  const reportId = text(data.reportId);
  const reportType: "Asset" | "LotListing" | null = data.reportType === "Asset" || data.reportType === "LotListing" ? data.reportType : null;
  // Older scheduled draft reminders used the dashboard's Drafts view.
  const isDraft = data.kind === "draft" || data.route === "/drafts" || data.route === "/dashboard";
  return {
    subject: text(data.subject) || item.title,
    message: text(data.message) || item.body,
    reportError: text(data.reportError),
    correctionSteps: Array.isArray(data.correctionSteps)
      ? data.correctionSteps.map(text).filter(Boolean)
      : text(data.correctionSteps) ? [text(data.correctionSteps)] : [],
    contractNo: text(data.contractNo),
    reportLabel: reportType === "Asset" ? "Asset Report" : reportType === "LotListing" ? "Lot Listing" : "Report",
    isDraft,
    target: !isDraft && reportType && /^[a-f\d]{24}$/i.test(reportId)
      ? { reportId, reportType, mode: "pending" as const } : null,
  };
}
