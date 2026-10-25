"use client";

import { useEffect } from "react";

/** Metadata-only report synchronization belongs to Listings, not the CRM workspace. */
export function ListingActivitySync({ ownerId }: { ownerId: string }) {
  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | undefined;
    void import("@/services/reportActivitySync").then(({ startReportActivitySync }) => {
      if (!stopped) stop = startReportActivitySync(ownerId);
    }).catch(() => undefined);
    return () => { stopped = true; stop?.(); };
  }, [ownerId]);
  return null;
}
