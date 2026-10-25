"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { crmErrorMessage } from "@/services/crm";
import { crmMutationOutcomeUnknown } from "./crmAuxiliaryHelpers";

/** Immediate ownership lock; a panel's unmount fences every pending result. */
export function useCrmPanelMutation() {
  const active = useRef(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, []);

  const run = useCallback(async <T,>(request: (signal: AbortSignal) => Promise<T>, onSuccess: (value: T) => void) => {
    if (lock.current || !active.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setUncertain(false);
    const current = new AbortController();
    controller.current = current;
    let value: T;
    try {
      value = await request(current.signal);
    } catch (failure) {
      if (active.current && !current.signal.aborted) {
        setError(crmErrorMessage(failure));
        setUncertain(crmMutationOutcomeUnknown(failure));
      }
      return;
    } finally {
      if (active.current && !current.signal.aborted) {
        lock.current = false;
        setBusy(false);
      }
    }
    // A local follow-up cannot reinterpret an accepted backend write as a failure.
    if (active.current && !current.signal.aborted) onSuccess(value);
  }, []);

  return { busy, error, uncertain, setError, run, isLocked: () => lock.current };
}
