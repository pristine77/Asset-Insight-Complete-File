import {
  getCrmTaskIdFromNotificationData,
  shouldOpenCrmTasksFromNotificationData,
} from "./crmNotification";

export type NotificationNavigationTarget =
  | { kind: "crmTasks"; taskId?: string | null }
  | {
      kind: "preview";
      reportId: string;
      reportType: "Asset" | "RealEstate" | "LotListing" | "Salvage";
      mode: "pending" | "submitted";
    }
  | { kind: "reports" }
  | null;

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toReportType(value: unknown): "Asset" | "RealEstate" | "LotListing" | "Salvage" | null {
  const normalized = toNonEmptyString(value);
  if (normalized === "Asset" || normalized === "RealEstate" || normalized === "LotListing" || normalized === "Salvage") {
    return normalized;
  }
  return null;
}

export function getNotificationNavigationTarget(
  data?: Record<string, unknown> | null
): NotificationNavigationTarget {
  if (shouldOpenCrmTasksFromNotificationData(data)) {
    return {
      kind: "crmTasks",
      taskId: getCrmTaskIdFromNotificationData(data),
    };
  }

  const type = toNonEmptyString(data?.type);
  const reportId = toNonEmptyString(data?.reportId);
  const reportType = toReportType(data?.reportType);

  if ((type === "report_preview_ready" || type === "report_declined") && reportId && reportType) {
    return {
      kind: "preview",
      reportId,
      reportType,
      mode: type === "report_preview_ready" && reportType !== "Salvage" ? "submitted" : "pending",
    };
  }

  if (type === "lot_listing_declined" && reportId) {
    return {
      kind: "preview",
      reportId,
      reportType: "LotListing",
      mode: "pending",
    };
  }

  if (type === "lot_listing_preview_ready" && reportId) {
    return {
      kind: "preview",
      reportId,
      reportType: "LotListing",
      mode: "pending",
    };
  }

  if (type === "lot_listing_submitted" && reportId) {
    return {
      kind: "preview",
      reportId,
      reportType: "LotListing",
      mode: "submitted",
    };
  }

  if (
    type === "report_approved" ||
    type === "report_released" ||
    type === "lot_listing_ready" ||
    type === "lot_listing_approved"
  ) {
    return { kind: "reports" };
  }

  return null;
}
