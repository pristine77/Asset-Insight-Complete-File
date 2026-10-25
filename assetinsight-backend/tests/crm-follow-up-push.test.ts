/**
 * Wording of the CRM follow-up reminders (2026-10-11), in the agent's own time
 * zone, and the data the app uses to open the lead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyUser = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser }));

import { sendCrmFollowUpNotification } from "../src/service/crmPushService.js";

const base = { userId: "agent-1", tokens: ["ExponentPushToken[test]"], leadId: "lead-1", clientName: "Curtis Metz", timeZone: "America/Regina" };

beforeEach(() => notifyUser.mockClear());

describe("CRM follow-up reminders", () => {
  it("date only, on the morning of the day", async () => {
    await sendCrmFollowUpNotification({ ...base, followUpDate: "2026-10-20", followUpAt: new Date("2026-10-20T06:00:00.000Z"), kind: "upcoming" });
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: "agent-1", category: "crm", type: "crm_follow_up",
      title: "CRM follow-up today",
      body: "Follow up with Curtis Metz today (Tue, Oct 20).",
      data: expect.objectContaining({ type: "crm_follow_up", taskId: "lead-1", leadId: "lead-1", overdue: false, followUpDate: "2026-10-20" }),
    }));
  });

  it("timed, an hour before, in the agent's clock", async () => {
    await sendCrmFollowUpNotification({ ...base, followUpDate: "2026-10-20", followUpTime: "15:00", followUpAt: new Date("2026-10-20T21:00:00.000Z"), kind: "upcoming" });
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ title: "CRM follow-up in 1 hour", body: "Curtis Metz at 3:00 p.m. today." }));
  });

  it("overdue, each morning", async () => {
    await sendCrmFollowUpNotification({ ...base, followUpDate: "2026-10-20", followUpAt: new Date("2026-10-20T06:00:00.000Z"), kind: "overdue" });
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({
      title: "CRM follow-up overdue",
      body: "Curtis Metz was due Tue, Oct 20. Update the lead or pick a new date.",
      data: expect.objectContaining({ overdue: true }),
    }));
  });

  it("overdue with a time ends the sentence once after p.m.", async () => {
    await sendCrmFollowUpNotification({ ...base, followUpDate: "2026-10-20", followUpTime: "14:00", followUpAt: new Date("2026-10-20T20:00:00.000Z"), kind: "overdue" });
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({
      title: "CRM follow-up overdue",
      body: "Curtis Metz was due Tue, Oct 20 at 2:00 p.m. Update the lead or pick a new date.",
    }));
  });
});
