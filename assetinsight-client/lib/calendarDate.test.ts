import { describe, expect, it } from "vitest";
import { formatCalendarDate } from "./calendarDate";

describe("a sale's date on Incoming (owner, 2026-10-29)", () => {
  it("prints a plain day as the day it names, whatever the time zone", () => {
    // Winnipeg is UTC-5 in October: new Date("2026-10-30") is 7 pm on the 29th there.
    expect(formatCalendarDate("2026-10-30")).toBe("30 Oct 2026");
    expect(formatCalendarDate("2026-10-30T00:00:00.000Z")).toBe("30 Oct 2026");
    expect(formatCalendarDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("says Not supplied for nothing, and keeps text that is not a date", () => {
    expect(formatCalendarDate("")).toBe("Not supplied");
    expect(formatCalendarDate(undefined)).toBe("Not supplied");
    expect(formatCalendarDate("TBD")).toBe("TBD");
  });
});
