/**
 * Wall-clock conversions for CRM follow-up dates (2026-10-11): Saskatchewan
 * has no DST, most of Canada does, and the server runs in neither.
 */
import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarDaysBetween,
  isCalendarDate,
  isValidTimeZone,
  isWallTime,
  zonedDateString,
  zonedHour,
  zonedWallTimeToUtc,
} from "../src/utils/zonedTime.js";

describe("zonedWallTimeToUtc", () => {
  it("converts Regina wall time (UTC-6 all year)", () => {
    expect(zonedWallTimeToUtc("2026-10-20", 8, 0, "America/Regina").toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(zonedWallTimeToUtc("2026-01-15", 8, 0, "America/Regina").toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("follows DST in Toronto on both sides of the change", () => {
    expect(zonedWallTimeToUtc("2026-10-20", 8, 0, "America/Toronto").toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(zonedWallTimeToUtc("2026-12-01", 8, 0, "America/Toronto").toISOString()).toBe("2026-12-01T13:00:00.000Z");
  });

  it("resolves a time skipped by the spring DST jump to just after it", () => {
    // 2026-03-08 02:30 does not exist in Toronto (02:00 -> 03:00).
    const instant = zonedWallTimeToUtc("2026-03-08", 2, 30, "America/Toronto");
    expect(instant.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedHour(instant, "America/Toronto")).toBe(3);
  });

  it("resolves a time repeated by the autumn change to its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in Toronto (EDT, then EST).
    expect(zonedWallTimeToUtc("2026-11-01", 1, 30, "America/Toronto").toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips through zonedDateString near midnight", () => {
    const lateEvening = zonedWallTimeToUtc("2026-10-20", 23, 30, "America/Regina");
    expect(lateEvening.toISOString()).toBe("2026-10-21T05:30:00.000Z");
    expect(zonedDateString(lateEvening, "America/Regina")).toBe("2026-10-20");
    expect(zonedDateString(lateEvening, "UTC")).toBe("2026-10-21");
  });
});

describe("date and zone helpers", () => {
  it("accepts real dates, times and zones only", () => {
    expect(isCalendarDate("2026-10-20")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-10-20T00:00")).toBe(false);
    expect(isWallTime("09:05")).toBe(true);
    expect(isWallTime("24:00")).toBe(false);
    expect(isWallTime("9:05")).toBe(false);
    expect(isValidTimeZone("America/Regina")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("moves and measures calendar days across month and year ends", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(calendarDaysBetween("2026-10-11", "2026-10-20")).toBe(9);
    expect(calendarDaysBetween("2026-10-20", "2026-10-11")).toBe(-9);
  });
});
