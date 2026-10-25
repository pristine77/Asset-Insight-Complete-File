const CRM_NOTIFICATION_TYPES = new Set([
  "crm_new_task",
  "crm_message_from_admin",
  "crm_due",
  // Follow-up date reminders (2026-10-11): open the lead like crm_due.
  "crm_follow_up",
  "crm_reminder",
  "crm_transfer_request",
  "crm_transfer_response",
  "crm_agent_enabled",
  "lead_assigned",
  "task_reminder",
]);

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getNotificationType(data?: Record<string, unknown> | null): string {
  return toNonEmptyString(data?.type);
}

export function isCrmNotificationData(data?: Record<string, unknown> | null): boolean {
  const type = getNotificationType(data);
  return CRM_NOTIFICATION_TYPES.has(type);
}

export function getCrmTaskIdFromNotificationData(data?: Record<string, unknown> | null): string | null {
  const taskId = toNonEmptyString(data?.taskId);
  if (taskId) return taskId;

  const leadId = toNonEmptyString(data?.leadId);
  if (leadId) return leadId;

  return null;
}

export function shouldOpenCrmTasksFromNotificationData(data?: Record<string, unknown> | null): boolean {
  return isCrmNotificationData(data);
}
