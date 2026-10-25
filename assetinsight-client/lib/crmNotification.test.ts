import { describe, expect, it } from "vitest";
import { crmNotificationHref } from "./crmNotification";

const taskId = "69209256be08b81c6d33e76f";

describe("CRM notification routing", () => {
  it.each(["crm_new_task", "crm_message_from_admin", "crm_due", "crm_reminder", "crm_transfer_response", "lead_assigned", "task_reminder"])("opens canonical %s at its assigned task", (type) => {
    expect(crmNotificationHref({ type, data: { taskId, route: "/incoming" } })).toBe(`/crm/tasks?task=${taskId}`);
    expect(crmNotificationHref({ data: { type, leadId: taskId } })).toBe(`/crm/tasks?task=${taskId}`);
  });

  it("opens transfer requests in the inbox even if they contain a lead ID", () => {
    expect(crmNotificationHref({ type: "crm_transfer_request", data: { leadId: taskId } })).toBe("/crm/transfers");
  });

  it.each(["../account", "javascript:alert(1)", "x?owner=other", {}, null, ""])("keeps an invalid task ID out of a CRM URL: %j", (taskId) => {
    expect(crmNotificationHref({ category: "crm", data: { taskId } })).toBe("/crm");
  });

  it("uses a valid lead fallback and keeps agent-enabled notices at CRM entry", () => {
    expect(crmNotificationHref({ category: "crm", data: { taskId: "invalid", leadId: taskId } })).toBe(`/crm/tasks?task=${taskId}`);
    expect(crmNotificationHref({ type: "crm_agent_enabled" })).toBe("/crm");
  });

  it("does not change unrelated internal or preview notification routing", () => {
    expect(crmNotificationHref({ type: "preview_review_reminder", data: { reportId: taskId } })).toBeNull();
    expect(crmNotificationHref({ type: "crm_task", data: { route: "/incoming" } })).toBeNull();
    expect(crmNotificationHref({ category: "report", data: { route: "/reports" } })).toBeNull();
  });
});
