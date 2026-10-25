/**
 * Wall-clock dates and times in a named time zone (IANA, e.g. "America/Regina").
 *
 * CRM follow-up dates (2026-10-11) are chosen on a phone as a calendar date and
 * an optional time "where the agent is", and reminders fire at 8 a.m. on that
 * date. The server runs in another zone (and Saskatchewan has no DST while most
 * of Canada does), so every conversion goes through the zone the phone reported.
 * Node ships full ICU, so Intl does the zone arithmetic; no extra dependency.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True for a time zone this server can convert (IANA names, "UTC"). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return false;
  try {
    partsFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" that is a real calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** "HH:mm", 24-hour. */
export function isWallTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

type WallParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(instant: Date, timeZone: string): WallParts {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Milliseconds the zone is ahead of UTC at that instant (negative west of Greenwich). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the clock in timeZone shows date + hour:minute. A time
 * skipped by a DST jump resolves to the moment just after the jump; a repeated
 * one resolves to its first occurrence.
 */
export function zonedWallTimeToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset half a day before and after: equal unless a clock change
  // falls in between, in which case each gives one candidate instant.
  const offsetBefore = zoneOffsetMs(new Date(guess - 12 * 60 * 60 * 1000), timeZone);
  const offsetAfter = zoneOffsetMs(new Date(guess + 12 * 60 * 60 * 1000), timeZone);
  const showsRequested = (instant: number) => {
    const p = zonedParts(new Date(instant), timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const valid = [guess - offsetBefore, guess - offsetAfter].filter(showsRequested);
  // Repeated (autumn): the first occurrence. Skipped (spring): the old offset,
  // which lands the same distance after the jump (02:30 -> 03:30).
  return new Date(valid.length ? Math.min(...valid) : guess - offsetBefore);
}

/** The calendar date ("YYYY-MM-DD") the clock in timeZone shows at that instant. */
export function zonedDateString(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The hour (0–23) the clock in timeZone shows at that instant. */
export function zonedHour(instant: Date, timeZone: string): number {
  return zonedParts(instant, timeZone).hour;
}

/** "YYYY-MM-DD" moved by whole calendar days. */
export function addCalendarDays(date: string, days: number): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return next.toISOString().slice(0, 10);
}

/** Whole calendar days from a to b ("YYYY-MM-DD"), negative when b is earlier. */
export function calendarDaysBetween(a: string, b: string): number {
  const [ma, mb] = [DATE_PATTERN.exec(a), DATE_PATTERN.exec(b)];
  if (!ma || !mb) throw new Error("Invalid date");
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((tb - ta) / 86_400_000);
}
