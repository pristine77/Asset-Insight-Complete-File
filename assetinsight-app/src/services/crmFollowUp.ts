/**
 * Phone side of CRM follow-up dates (owner decision 2026-10-11).
 *
 * In Task Update an agent may pick the date they will next contact or visit a
 * lead, and a time if they want one. The server holds the rules
 * (Asset-Insight src/service/crmFollowUpService.ts): a date-only follow-up
 * reminds at 8 a.m. that day, a timed one 1 hour before; automatic reminders
 * pause until then; a missed one reminds each morning until the lead is
 * updated; Won and Lost end it. Dates travel as "YYYY-MM-DD" and "HH:mm" with
 * the phone's time zone, so "Oct 20 at 3 p.m." means 3 p.m. where the agent is.
 */
import * as Localization from 'expo-localization';
import type { CrmTaskItem, CrmTaskStatus } from './crmService';

/** Used when the phone does not report a zone. */
const FALLBACK_TIME_ZONE = 'America/Regina';

/** The phone's IANA time zone, e.g. "America/Regina". */
export function deviceTimeZone(): string {
  try {
    const zone = Localization.getCalendars?.()?.[0]?.timeZone;
    if (zone) return zone;
  } catch {
    // Older native module: fall through.
  }
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // No Intl time zone support.
  }
  return FALLBACK_TIME_ZONE;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** "YYYY-MM-DD" of a Date in the phone's own calendar. */
export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "HH:mm" of a Date on the phone's clock. */
export function localTimeString(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A phone-local Date for "YYYY-MM-DD" (and "HH:mm"), for the pickers and labels. */
export function localDate(date: string, time?: string | null): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = (time || '00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** "Tue, Oct 20" (with the year when it is not this year). */
export function formatFollowUpDate(date: string, now: Date = new Date()): string {
  const value = localDate(date);
  return value.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(value.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "3:00 PM" */
export function formatFollowUpTime(date: string, time: string): string {
  return localDate(date, time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Tue, Oct 20" or "Tue, Oct 20 · 3:00 PM" */
export function formatFollowUp(date: string, time?: string | null, now: Date = new Date()): string {
  const day = formatFollowUpDate(date, now);
  return time ? `${day} · ${formatFollowUpTime(date, time)}` : day;
}

/** True once the follow-up has passed (date only: after that day ends; timed: after the time). */
export function isFollowUpPast(task: Pick<CrmTaskItem, 'followUpDate' | 'followUpTime' | 'followUpAt'>, now: Date = new Date()): boolean {
  if (!task.followUpDate) return false;
  if (task.followUpTime && task.followUpAt) return new Date(task.followUpAt).getTime() < now.getTime();
  return task.followUpDate < localDateString(now);
}

const isClosed = (status: CrmTaskStatus) => status === 'won' || status === 'lost';

/**
 * Ends text with exactly one period. Canadian English phones write times as
 * "2:00 p.m.", so appending "." blindly gave "2:00 p.m.." on screen and in
 * screen-reader labels.
 */
export function asSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/** The server's reminder hour for a date-only follow-up (8 a.m. there). */
const DATE_ONLY_REMINDER_TIME = '08:00';
const TIMED_REMINDER_LEAD_MS = 60 * 60 * 1000;

/**
 * What the reminder card says once a follow-up is picked. When the reminder
 * moment has already come (today after 8 a.m., or less than an hour ahead) the
 * server's next sweep sends it, every 5 minutes, so the card says so instead
 * of naming a time that has passed. A time that has passed is refused by the
 * server, so the card asks for a later one before Submit. Once the server
 * has sent the reminder for the saved follow-up the card says so.
 */
export function followUpReminderText(
  date: string,
  time?: string | null,
  now: Date = new Date(),
  reminderSent = false,
): string {
  const when = asSentence(`Follow-up ${formatFollowUp(date, time, now)}`);
  if (reminderSent) return `${when} Reminder sent. Automatic reminders are paused until then.`;
  if (time && localDate(date, time).getTime() < now.getTime()) {
    return `${when} That time has passed. Pick a later time or remove the time.`;
  }
  const remindAt = time
    ? localDate(date, time).getTime() - TIMED_REMINDER_LEAD_MS
    : localDate(date, DATE_ONLY_REMINDER_TIME).getTime();
  const reminder = remindAt <= now.getTime()
    ? 'Reminder within a few minutes.'
    : time ? 'Reminder 1 hour before.' : 'Reminder at 8 a.m. that day.';
  return `${when} ${reminder} Automatic reminders are paused until then.`;
}

/**
 * The 42 days ("YYYY-MM-DD") of a month view: Sunday-first weeks, starting the
 * Sunday on or before the 1st. month is 0–11. 42 days always fits the server's
 * 62-day calendar read.
 */
export function buildMonthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) =>
    localDateString(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
}

/** Follow-ups by their date, each day in time order (date-only ones first). */
export function groupFollowUpsByDate(items: CrmTaskItem[]): Map<string, CrmTaskItem[]> {
  const byDate = new Map<string, CrmTaskItem[]>();
  for (const item of items) {
    if (!item.followUpDate) continue;
    const day = byDate.get(item.followUpDate) || [];
    day.push(item);
    byDate.set(item.followUpDate, day);
  }
  for (const day of byDate.values()) {
    day.sort((a, b) => (a.followUpTime || '').localeCompare(b.followUpTime || ''));
  }
  return byDate;
}

export type FollowUpDraft = { date: string | null; time: string | null };

/** The picker's starting value: the lead's upcoming follow-up, or empty (none, or already passed). */
export function initialFollowUpDraft(task: CrmTaskItem | null | undefined, now: Date = new Date()): FollowUpDraft {
  if (!task?.followUpDate || isFollowUpPast(task, now)) return { date: null, time: null };
  return { date: task.followUpDate, time: task.followUpTime || null };
}

/**
 * The follow-up field of the Task Update: a new date, 'clear', or undefined to
 * keep what the lead has. Won/Lost send nothing (the server ends it).
 */
export function followUpChange(
  task: CrmTaskItem | null | undefined,
  draft: FollowUpDraft,
  status: CrmTaskStatus,
  timeZone: string,
  now: Date = new Date()
): { date: string; time?: string; timeZone: string } | 'clear' | undefined {
  if (isClosed(status)) return undefined;
  const original = initialFollowUpDraft(task, now);
  if (!draft.date) return original.date ? 'clear' : undefined;
  if (original.date === draft.date && original.time === draft.time) return undefined;
  return { date: draft.date, ...(draft.time ? { time: draft.time } : {}), timeZone };
}

/** True when the draft is the lead's saved follow-up and the server has already sent its reminder. */
export function followUpReminderSentFor(task: CrmTaskItem | null | undefined, draft: FollowUpDraft): boolean {
  if (!task?.followUpReminderSentAt || !task.followUpDate || !draft.date) return false;
  return task.followUpDate === draft.date && (task.followUpTime || null) === draft.time;
}
