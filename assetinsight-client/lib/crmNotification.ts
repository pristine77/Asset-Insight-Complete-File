import type { WorkspaceNotification } from "@/services/notifications";

const CRM_NOTIFICATION_TYPES = new Set([
  // crm_follow_up: follow-up date reminders (2026-10-11).
  "crm_new_task", "crm_message_from_admin", "crm_due", "crm_follow_up", "crm_reminder",
  "crm_transfer_request", "crm_transfer_response", "crm_agent_enabled",
  "lead_assigned", "task_reminder",
]);

/** Canonical CRM notices open the web CRM; unrelated notification routes stay unchanged. */
export function crmNotificationHref(item: Pick<WorkspaceNotification, "category" | "type" | "data">): string | null {
  const types = [item.type, item.data?.type].filter((value): value is string => typeof value === "string");
  if (item.category !== "crm" && !types.some((type) => CRM_NOTIFICATION_TYPES.has(type))) return null;
  if (types.includes("crm_transfer_request")) return "/crm/transfers";
  for (const value of [item.data?.taskId, item.data?.leadId]) {
    if (typeof value === "string" && /^[a-f\d]{24}$/i.test(value.trim())) {
      return `/crm/tasks?task=${encodeURIComponent(value.trim())}`;
    }
  }
  return "/crm";
}
