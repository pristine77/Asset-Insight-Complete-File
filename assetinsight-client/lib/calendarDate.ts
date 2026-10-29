/**
 * A sale's date as a calendar day, the same day wherever it is read
 * (owner, 2026-10-29).
 *
 * Auctioneer 2.0 sends an event's date as a plain day, "2026-10-30". Read with
 * `new Date()`, that is midnight in UTC, and printed in the viewer's own time
 * zone it became the evening before anywhere west of Greenwich: the Winnipeg
 * sale of 30 October showed as 29 Oct on Incoming. A plain day (or that day at
 * midnight UTC) is printed as the day it names; anything with a real time of
 * day is printed as before, in local time.
 */

const LOCAL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const AS_WRITTEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const PLAIN_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?Z?)?$/;

/** "30 Oct 2026" for "2026-10-30"; `fallback` when empty; the text itself when it is not a date. */
export function formatCalendarDate(value: string | null | undefined, fallback = "Not supplied"): string {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const day = PLAIN_DAY.exec(text);
  if (day) {
    const utc = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(utc) ? text : AS_WRITTEN.format(new Date(utc));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : LOCAL.format(parsed);
}
