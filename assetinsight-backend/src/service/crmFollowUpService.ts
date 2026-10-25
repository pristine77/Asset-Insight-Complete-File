/**
 * CRM follow-up dates (owner decision 2026-10-11).
 *
 * Agents asked to pick the day they will next contact or visit a lead ("I want
 * to go see Curtis Metz on October 20") instead of skimming a reminder every 7
 * days. Task Update now takes an optional follow-up date, and a time if they
 * want one. The rules:
 *
 *   - Date only: the lead is due all of that day; one reminder at 8 a.m. that
 *     day in the phone's time zone. With a time: due at that time; one
 *     reminder 1 hour before.
 *   - While a follow-up is set, dueDate follows it (so Upcoming / Overdue,
 *     list order and the digest keep working unchanged) and the automatic
 *     7/2/30-day cadence is paused for the lead.
 *   - Missed: the lead stays Overdue and the agent gets one reminder each
 *     morning (8 a.m. their time) until the lead is updated or a new date is
 *     picked. Any Task Update after the follow-up has passed ends it, unless it
 *     sets a new date; the automatic cadence then resumes from that update.
 *   - Won or Lost ends the follow-up.
 *   - No date picked: the automatic cadence works exactly as before.
 *   - The follow-up also becomes an event in the agent's Outlook calendar when
 *     Outlook is connected (crmFollowUpOutlookService.ts, run by the follow-up
 *     job, never inside the request).
 *
 * This module only reads and writes the lead document; persistence, pushes and
 * Outlook belong to the callers. It must not import crmWorkflowService (that
 * module imports this one).
 */
import { randomUUID } from "node:crypto";
import {
  addCalendarDays,
  calendarDaysBetween,
  isCalendarDate,
  isValidTimeZone,
  isWallTime,
  zonedDateString,
  zonedWallTimeToUtc,
} from "../utils/zonedTime.js";

/** Date-only follow-ups remind at this hour on the day, in the follow-up's zone. */
export const CRM_FOLLOW_UP_REMINDER_HOUR = 8;
/** Timed follow-ups remind this long before the time. */
export const CRM_FOLLOW_UP_TIMED_REMINDER_LEAD_MS = 60 * 60 * 1000;
/** Used when a client does not send its zone (older app builds, the website). */
export const CRM_FOLLOW_UP_DEFAULT_TIME_ZONE = "America/Regina";
/** Furthest ahead a follow-up may be set. */
export const CRM_FOLLOW_UP_MAX_DAYS_AHEAD = 731;
/** A time picked a few minutes ago (slow form, clock skew) is still accepted. */
const PAST_TIME_GRACE_MS = 5 * 60 * 1000;

/** Fields a list or calendar row needs to show a follow-up. */
export const CRM_FOLLOW_UP_READ_FIELDS = [
  "followUpDate", "followUpTime", "followUpTimeZone", "followUpAt", "followUpRemindAt",
  // Lets Task Update say "Reminder sent" instead of naming a reminder time that has passed.
  "followUpReminderSentAt",
] as const;

export class CrmFollowUpInputError extends Error {
  readonly status = 400;
}

export type CrmFollowUpIntent =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; date: string; time?: string; timeZone: string };

export type CrmFollowUpSchedule = {
  date: string;
  time?: string;
  timeZone: string;
  /** The time, or 00:00 on the day when date-only. */
  followUpAt: Date;
  remindAt: Date;
  /** What dueDate becomes: the time, or the last millisecond of the day. */
  dueAt: Date;
};

const isTruthyFlag = (value: unknown) => ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
const textField = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Reads the follow-up fields of a Task Update request. Multipart forms send
 * strings: followUpDate "YYYY-MM-DD", followUpTime "HH:mm" (optional),
 * followUpTimeZone (IANA, optional), clearFollowUp "true". Leaving them all out
 * keeps the lead's follow-up as it is (subject to the rules above).
 */
export function readCrmFollowUpIntent(body: Record<string, unknown> | undefined | null): CrmFollowUpIntent {
  const date = textField(body?.followUpDate);
  const time = textField(body?.followUpTime);
  const zone = textField(body?.followUpTimeZone);
  const clear = isTruthyFlag(body?.clearFollowUp);

  if (clear && date) throw new CrmFollowUpInputError("Send a follow-up date or clear it, not both.");
  if (clear) return { kind: "clear" };
  if (!date) {
    if (time) throw new CrmFollowUpInputError("A follow-up time needs a follow-up date.");
    return { kind: "unchanged" };
  }
  if (!isCalendarDate(date)) throw new CrmFollowUpInputError("Follow-up date must be a real date (YYYY-MM-DD).");
  if (time && !isWallTime(time)) throw new CrmFollowUpInputError("Follow-up time must be HH:mm (24-hour).");
  if (zone && !isValidTimeZone(zone)) throw new CrmFollowUpInputError("Unknown follow-up time zone.");
  return { kind: "set", date, ...(time ? { time } : {}), timeZone: zone || CRM_FOLLOW_UP_DEFAULT_TIME_ZONE };
}

/** The reminder and due moments of a follow-up, checked against now. */
export function computeCrmFollowUpSchedule(
  input: { date: string; time?: string; timeZone: string },
  now: Date
): CrmFollowUpSchedule {
  const { date, time, timeZone } = input;
  const today = zonedDateString(now, timeZone);
  if (calendarDaysBetween(today, date) > CRM_FOLLOW_UP_MAX_DAYS_AHEAD) {
    throw new CrmFollowUpInputError("Pick a follow-up date within the next two years.");
  }
  if (!time) {
    if (date < today) throw new CrmFollowUpInputError("Pick a follow-up date from today onward.");
    return {
      date,
      timeZone,
      followUpAt: zonedWallTimeToUtc(date, 0, 0, timeZone),
      remindAt: zonedWallTimeToUtc(date, CRM_FOLLOW_UP_REMINDER_HOUR, 0, timeZone),
      dueAt: new Date(zonedWallTimeToUtc(addCalendarDays(date, 1), 0, 0, timeZone).getTime() - 1),
    };
  }
  const [hour, minute] = time.split(":").map(Number);
  const followUpAt = zonedWallTimeToUtc(date, hour, minute, timeZone);
  if (followUpAt.getTime() < now.getTime() - PAST_TIME_GRACE_MS) {
    throw new CrmFollowUpInputError("Pick a follow-up time that has not passed yet.");
  }
  return {
    date,
    time,
    timeZone,
    followUpAt,
    remindAt: new Date(followUpAt.getTime() - CRM_FOLLOW_UP_TIMED_REMINDER_LEAD_MS),
    dueAt: followUpAt,
  };
}

/** The lead's current follow-up as a schedule, or undefined when none is set. */
export function readCrmFollowUpSchedule(lead: any): CrmFollowUpSchedule | undefined {
  const date = lead?.followUpDate;
  const timeZone = lead?.followUpTimeZone;
  if (!lead?.followUpAt || !isCalendarDate(date) || !isValidTimeZone(timeZone)) return undefined;
  const time = isWallTime(lead?.followUpTime) ? lead.followUpTime : undefined;
  if (!time) {
    return {
      date, timeZone,
      followUpAt: zonedWallTimeToUtc(date, 0, 0, timeZone),
      remindAt: zonedWallTimeToUtc(date, CRM_FOLLOW_UP_REMINDER_HOUR, 0, timeZone),
      dueAt: new Date(zonedWallTimeToUtc(addCalendarDays(date, 1), 0, 0, timeZone).getTime() - 1),
    };
  }
  const [hour, minute] = time.split(":").map(Number);
  const followUpAt = zonedWallTimeToUtc(date, hour, minute, timeZone);
  return { date, time, timeZone, followUpAt, remindAt: new Date(followUpAt.getTime() - CRM_FOLLOW_UP_TIMED_REMINDER_LEAD_MS), dueAt: followUpAt };
}

export function hasActiveCrmFollowUp(lead: any): boolean {
  return Boolean(readCrmFollowUpSchedule(lead));
}

/** Asks the follow-up job to bring the Outlook event in line with the lead. */
export function requestCrmFollowUpOutlookSync(lead: any, now: Date): void {
  const current = lead?.followUpOutlook ?? {};
  // Nothing to create, nothing to remove and no sync under way (one may be
  // creating the event right now): leave the record alone.
  if (!hasActiveCrmFollowUp(lead) && !current.eventId && !current.syncPending) return;
  // Field by field, never the whole object: the job may have stored an event id
  // since this document was read, and a whole-object write would lose it.
  lead.set("followUpOutlook.syncPending", true);
  lead.set("followUpOutlook.version", Number(current.version || 0) + 1);
  // Two documents loaded at the same version can both save version + 1. A unique
  // change identity keeps the earlier provider response from confirming both.
  lead.set("followUpOutlook.changeId", randomUUID());
  lead.set("followUpOutlook.attempts", 0);
  lead.set("followUpOutlook.nextAttemptAt", now);
  lead.set("followUpOutlook.lastError", undefined);
}

/** Sets the lead's follow-up. dueDate follows it and the cadence pauses. */
export function applyCrmFollowUp(lead: any, schedule: CrmFollowUpSchedule, context: { now: Date; setBy?: unknown }): void {
  lead.set("followUpDate", schedule.date);
  lead.set("followUpTime", schedule.time || undefined);
  lead.set("followUpTimeZone", schedule.timeZone);
  lead.set("followUpAt", schedule.followUpAt);
  lead.set("followUpRemindAt", schedule.remindAt);
  lead.set("followUpReminderSentAt", undefined);
  lead.set("followUpOverdueRemindedAt", undefined);
  lead.set("followUpSetAt", context.now);
  if (context.setBy) lead.set("followUpSetBy", context.setBy);
  lead.set("dueDate", schedule.dueAt);
  // The cadence's own due-soon / overdue pushes do not apply to a follow-up.
  lead.set("dueSoonPushSentAt", undefined);
  lead.set("overduePushSentAt", undefined);
  requestCrmFollowUpOutlookSync(lead, context.now);
}

/**
 * Ends the lead's follow-up. dueDate goes back to the automatic cadence the
 * caller computed (undefined when the status has none).
 */
export function clearCrmFollowUp(lead: any, context: { now: Date; cadenceDueDate?: Date }): void {
  const hadFollowUp = Boolean(lead?.followUpAt || lead?.followUpDate);
  for (const field of [
    "followUpDate", "followUpTime", "followUpTimeZone", "followUpAt", "followUpRemindAt",
    "followUpReminderSentAt", "followUpOverdueRemindedAt", "followUpSetAt", "followUpSetBy",
  ]) {
    lead.set(field, undefined);
  }
  if (hadFollowUp) {
    lead.set("dueDate", context.cadenceDueDate || undefined);
    lead.set("dueSoonPushSentAt", undefined);
    lead.set("overduePushSentAt", undefined);
  }
  // Removes the Outlook event, if one was made.
  requestCrmFollowUpOutlookSync(lead, context.now);
}

export type CrmFollowUpOutcome = "set" | "cleared" | "kept" | "none";

/**
 * Applies a Task Update's follow-up fields after its status change (see the
 * rules at the top). statusClosed is true for Won and Lost. cadenceDueDate is
 * what dueDate becomes if the follow-up ends here.
 */
export function resolveCrmFollowUpOnTaskUpdate(
  lead: any,
  intent: CrmFollowUpIntent,
  context: { now: Date; setBy?: unknown; statusClosed: boolean; cadenceDueDate?: Date }
): CrmFollowUpOutcome {
  const current = readCrmFollowUpSchedule(lead);
  if (context.statusClosed) {
    if (intent.kind === "set") throw new CrmFollowUpInputError("A won or lost lead has no follow-up date.");
    if (!current) return "none";
    clearCrmFollowUp(lead, context);
    return "cleared";
  }
  if (intent.kind === "set") {
    applyCrmFollowUp(lead, computeCrmFollowUpSchedule(intent, context.now), context);
    return "set";
  }
  if (!current) return "none";
  if (intent.kind === "clear" || current.dueAt.getTime() < context.now.getTime()) {
    // Cleared by the agent, or an update after the follow-up passed.
    clearCrmFollowUp(lead, context);
    return "cleared";
  }
  // Still ahead: a status change in this update must not move it.
  lead.set("dueDate", current.dueAt);
  return "kept";
}
