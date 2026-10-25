"use client";
import { useEffect, useRef } from "react";
import { recordBrowserObservation, type FormDraftKind } from "./storage";
export function useReportActivity(owner: string | null, activityId: string, kind: FormDraftKind, contract: string,
  lots: Array<{ id: string; lotNumber?: string; files: File[]; extraFiles?: File[]; coverIndex: number }>, logo: boolean, enabled = true) {
  const scope = useRef<string | null>(null);
  useEffect(() => {
    if (!owner || !activityId || !enabled) { scope.current = null; return; }
    const identity = `${owner}:${activityId}`;
    const baseline = scope.current !== identity;
    scope.current = identity;
    // Metadata only: this never saves or uploads the selected files.
    void recordBrowserObservation(owner, activityId, kind, contract, lots, logo, baseline).catch(() => {
      console.warn("Operational activity could not be saved locally. Report media was not changed.");
    });
  }, [owner, activityId, kind, contract, lots, logo, enabled]);
}
