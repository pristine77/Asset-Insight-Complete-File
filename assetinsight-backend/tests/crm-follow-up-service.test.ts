/**
 * CRM follow-up rules (owner decision 2026-10-11), on in-memory lead documents:
 * date-only reminds at 8 a.m., a time reminds 1 hour before; dueDate follows
 * the follow-up and the cadence pauses; Won/Lost and a later update end it.
 */
import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import CrmLead from "../src/models/crmLead.model.js";
import {
  computeCrmFollowUpSchedule,
  CrmFollowUpInputError,
  hasActiveCrmFollowUp,
  readCrmFollowUpIntent,
  requestCrmFollowUpOutlookSync,
  resolveCrmFollowUpOnTaskUpdate,
} from "../src/service/crmFollowUpService.js";
import { applyCrmStatusChange, computeNextCrmReminderDate, normalizeCrmLeadDocument } from "../src/service/crmWorkflowService.js";

// Sunday 2026-10-11, noon in Regina.
const NOW = new Date("2026-10-11T18:00:00.000Z");
const REGINA = "America/Regina";

function newLead(extra: Record<string, unknown> = {}) {
  return new CrmLead({
    clientName: "Curtis Metz", title: "CRM Follow-up", assignedTo: new mongoose.Types.ObjectId(),
    assignedBy: new mongoose.Types.ObjectId(), status: "contacted", statusChangedAt: NOW, taskStartDate: NOW,
    dueDate: computeNextCrmReminderDate("contacted", undefined, NOW), ...extra,
  }) as any;
}
function withFollowUp(date: string, time?: string, extra: Record<string, unknown> = {}) {
  const lead = newLead(extra);
  resolveCrmFollowUpOnTaskUpdate(lead, { kind: "set", date, ...(time ? { time } : {}), timeZone: REGINA }, { now: NOW, statusClosed: false });
  return lead;
}
const expectInvalid = (run: () => unknown, message: RegExp) => {
  expect(run).toThrow(CrmFollowUpInputError);
  expect(run).toThrow(message);
};

describe("reading the Task Update fields", () => {
  it("keeps the follow-up when no field is sent", () => {
    expect(readCrmFollowUpIntent({ comment: "Called" })).toEqual({ kind: "unchanged" });
    expect(readCrmFollowUpIntent(undefined)).toEqual({ kind: "unchanged" });
  });

  it("reads a date, an optional time and the phone's zone (form strings)", () => {
    expect(readCrmFollowUpIntent({ followUpDate: "2026-10-20" }))
      .toEqual({ kind: "set", date: "2026-10-20", timeZone: REGINA });
    expect(readCrmFollowUpIntent({ followUpDate: "2026-10-20", followUpTime: "15:00", followUpTimeZone: "America/Toronto" }))
      .toEqual({ kind: "set", date: "2026-10-20", time: "15:00", timeZone: "America/Toronto" });
    expect(readCrmFollowUpIntent({ clearFollowUp: "true" })).toEqual({ kind: "clear" });
  });

  it("refuses contradictory or malformed fields", () => {
    expectInvalid(() => readCrmFollowUpIntent({ clearFollowUp: "true", followUpDate: "2026-10-20" }), /not both/);
    expectInvalid(() => readCrmFollowUpIntent({ followUpTime: "15:00" }), /needs a follow-up date/);
    expectInvalid(() => readCrmFollowUpIntent({ followUpDate: "2026-02-30" }), /real date/);
    expectInvalid(() => readCrmFollowUpIntent({ followUpDate: "2026-10-20", followUpTime: "3pm" }), /HH:mm/);
    expectInvalid(() => readCrmFollowUpIntent({ followUpDate: "2026-10-20", followUpTimeZone: "Mars/Base" }), /time zone/);
  });
});

describe("the follow-up schedule", () => {
  it("date only: reminder 8 a.m. that day, due all day", () => {
    const schedule = computeCrmFollowUpSchedule({ date: "2026-10-20", timeZone: REGINA }, NOW);
    expect(schedule.followUpAt.toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(schedule.remindAt.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(schedule.dueAt.toISOString()).toBe("2026-10-21T05:59:59.999Z");
  });

  it("with a time: reminder 1 hour before, due at the time", () => {
    const schedule = computeCrmFollowUpSchedule({ date: "2026-10-20", time: "15:00", timeZone: REGINA }, NOW);
    expect(schedule.followUpAt.toISOString()).toBe("2026-10-20T21:00:00.000Z");
    expect(schedule.remindAt.toISOString()).toBe("2026-10-20T20:00:00.000Z");
    expect(schedule.dueAt.toISOString()).toBe("2026-10-20T21:00:00.000Z");
  });

  it("accepts today and a time just passed, refuses the past and more than two years ahead", () => {
    expect(computeCrmFollowUpSchedule({ date: "2026-10-11", timeZone: REGINA }, NOW).date).toBe("2026-10-11");
    expect(computeCrmFollowUpSchedule({ date: "2026-10-11", time: "11:57", timeZone: REGINA }, NOW).time).toBe("11:57");
    expectInvalid(() => computeCrmFollowUpSchedule({ date: "2026-10-10", timeZone: REGINA }, NOW), /from today onward/);
    expectInvalid(() => computeCrmFollowUpSchedule({ date: "2026-10-11", time: "11:00", timeZone: REGINA }, NOW), /not passed/);
    expectInvalid(() => computeCrmFollowUpSchedule({ date: "2028-10-20", timeZone: REGINA }, NOW), /two years/);
  });
});

describe("a Task Update and the follow-up", () => {
  it("sets the follow-up: dueDate follows it, flags reset, Outlook sync requested", () => {
    const lead = withFollowUp("2026-10-20", undefined, { dueSoonPushSentAt: NOW });
    expect(lead.followUpDate).toBe("2026-10-20");
    expect(lead.followUpTime).toBeUndefined();
    expect(lead.followUpTimeZone).toBe(REGINA);
    expect(lead.dueDate.toISOString()).toBe("2026-10-21T05:59:59.999Z");
    expect(lead.followUpRemindAt.toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(lead.dueSoonPushSentAt).toBeUndefined();
    expect(lead.followUpOutlook).toMatchObject({ syncPending: true, version: 1, attempts: 0 });
  });

  it("keeps an upcoming follow-up when an update leaves it alone, even with a status change", () => {
    const lead = withFollowUp("2026-10-20");
    const later = new Date("2026-10-15T18:00:00.000Z");
    applyCrmStatusChange(lead, "inspection_required", undefined, later);
    expect(lead.dueDate.toISOString()).toBe("2026-10-21T05:59:59.999Z");
    const outcome = resolveCrmFollowUpOnTaskUpdate(lead, { kind: "unchanged" }, {
      now: later, statusClosed: false, cadenceDueDate: computeNextCrmReminderDate("inspection_required", undefined, later),
    });
    expect(outcome).toBe("kept");
    expect(lead.followUpDate).toBe("2026-10-20");
  });

  it("ends a follow-up that has passed when the lead is updated; the cadence resumes from the update", () => {
    const lead = withFollowUp("2026-10-20");
    const afterwards = new Date("2026-10-22T16:00:00.000Z");
    const cadence = computeNextCrmReminderDate("contacted", undefined, afterwards)!;
    const outcome = resolveCrmFollowUpOnTaskUpdate(lead, { kind: "unchanged" }, { now: afterwards, statusClosed: false, cadenceDueDate: cadence });
    expect(outcome).toBe("cleared");
    expect(hasActiveCrmFollowUp(lead)).toBe(false);
    expect(lead.followUpDate).toBeUndefined();
    expect(lead.dueDate.toISOString()).toBe(cadence.toISOString());
  });

  it("clears on request, and Won/Lost end it", () => {
    const cleared = withFollowUp("2026-10-20");
    expect(resolveCrmFollowUpOnTaskUpdate(cleared, { kind: "clear" }, { now: NOW, statusClosed: false })).toBe("cleared");
    expect(cleared.followUpAt).toBeUndefined();

    const won = withFollowUp("2026-10-20");
    applyCrmStatusChange(won, "won", undefined, NOW);
    expect(hasActiveCrmFollowUp(won)).toBe(false);
    expect(won.dueDate).toBeUndefined();

    const lost = withFollowUp("2026-10-20");
    applyCrmStatusChange(lost, "lost", "timing", NOW);
    expect(hasActiveCrmFollowUp(lost)).toBe(false);
    expect(lost.dueDate.toISOString()).toBe(computeNextCrmReminderDate("lost", "timing", NOW)!.toISOString());
  });

  it("refuses a follow-up on a won or lost lead", () => {
    expectInvalid(() => resolveCrmFollowUpOnTaskUpdate(newLead({ status: "won" }), { kind: "set", date: "2026-10-20", timeZone: REGINA }, {
      now: NOW, statusClosed: true,
    }), /won or lost/);
  });

  it("normalizing a lead keeps the follow-up's due date", () => {
    const lead = withFollowUp("2026-10-20", "09:30");
    lead.set("dueDate", new Date("2026-10-18T00:00:00.000Z"));
    expect(normalizeCrmLeadDocument(lead)).toBe(true);
    expect(lead.dueDate.toISOString()).toBe("2026-10-20T15:30:00.000Z");
  });
});

describe("Outlook sync requests", () => {
  it("asks for nothing when there is no follow-up, no event and no sync under way", () => {
    const lead = newLead();
    requestCrmFollowUpOutlookSync(lead, NOW);
    expect(lead.followUpOutlook?.syncPending).toBeUndefined();
  });

  it("asks to remove an event whose follow-up was cleared, with a new version", () => {
    const lead = withFollowUp("2026-10-20");
    lead.set("followUpOutlook.eventId", "AAMk-event");
    lead.set("followUpOutlook.syncPending", false);
    resolveCrmFollowUpOnTaskUpdate(lead, { kind: "clear" }, { now: NOW, statusClosed: false });
    expect(lead.followUpOutlook).toMatchObject({ eventId: "AAMk-event", syncPending: true, version: 2 });
  });
});
