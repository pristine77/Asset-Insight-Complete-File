"use client";

import { useEffect, useState } from "react";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

function nextDayDelay(now: Date) {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 30);
  return Math.max(1_000, nextDay.getTime() - now.getTime());
}

/**
 * Keeps date rendering isolated from the dashboard so the main screen does not
 * rerender on a timer. The value updates only when the local calendar day rolls
 * over.
 */
export function WorkspaceClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timeout: number;

    const scheduleNextDay = () => {
      const current = new Date();
      timeout = window.setTimeout(() => {
        setNow(new Date());
        scheduleNextDay();
      }, nextDayDelay(current));
    };

    scheduleNextDay();
    return () => window.clearTimeout(timeout);
  }, []);

  return <time suppressHydrationWarning>{DATE_FORMAT.format(now)}</time>;
}
