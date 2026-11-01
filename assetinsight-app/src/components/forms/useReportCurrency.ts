import { useCallback, useEffect, useRef, useState } from 'react';
import { currencyForReportLocation, detectReportCurrency, normalizeReportCurrency } from '../../utils/reportCurrency';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';

/** Restored/manual/sale choices win; an unresolved location never invents CAD. */
export default function useReportCurrency({ initialCurrency, location, latitude, longitude, visible, paused = false }: {
  initialCurrency?: unknown; location?: unknown; latitude?: number; longitude?: number; visible: boolean; paused?: boolean;
}) {
  const [resetEpoch, setResetEpoch] = useState(0);
  const authEpoch = getAuthOperationEpoch();
  const key = JSON.stringify([visible, paused, location ?? '', latitude, longitude, resetEpoch, authEpoch]);
  const context = useRef({ key, generation: 0, authEpoch });
  const protectedRef = useRef<string | null>(normalizeReportCurrency(initialCurrency));
  if (context.current.key !== key) {
    if (context.current.authEpoch !== authEpoch) protectedRef.current = null;
    context.current = { key, generation: context.current.generation + 1, authEpoch };
  }
  const generation = context.current.generation;
  const [detected, setDetected] = useState({ generation, value: '', pending: true });
  const named = currencyForReportLocation(location) || '';
  const automatic = detected.generation === generation ? detected : { value: '', pending: true };
  const currency = protectedRef.current ?? (named || automatic.value);
  const detecting = protectedRef.current === null && !named && visible && !paused && automatic.pending;
  const latest = useRef({ currency, detecting, authEpoch, visible, paused });
  latest.current = { currency, detecting, authEpoch, visible, paused };

  const setCurrency = useCallback((value: string) => {
    if (context.current.authEpoch !== getAuthOperationEpoch()) return;
    const selected = normalizeReportCurrency(value) || '';
    protectedRef.current = selected;
    const nextGeneration = ++context.current.generation;
    latest.current = { ...latest.current, currency: selected, detecting: false };
    setDetected({ generation: nextGeneration, value: selected, pending: false });
  }, []);
  const resetCurrency = useCallback((startingCurrency?: unknown) => {
    if (context.current.authEpoch !== getAuthOperationEpoch()) return;
    const selected = normalizeReportCurrency(startingCurrency) || '';
    protectedRef.current = selected || null;
    const nextGeneration = ++context.current.generation;
    latest.current = { ...latest.current, currency: selected, detecting: false };
    setDetected({ generation: nextGeneration, value: selected, pending: false });
    setResetEpoch(epoch => epoch + 1);
  }, []);
  // Handlers also read this ref: a captured Submit must not outrun a pending
  // lookup, a manual clear, or an account change before React paints again.
  const currencyForSubmission = useCallback(() => {
    const current = latest.current;
    return current.visible && current.authEpoch === getAuthOperationEpoch() && !current.detecting
      ? normalizeReportCurrency(current.currency) : null;
  }, []);

  useEffect(() => {
    if (!visible || paused || protectedRef.current !== null || named) return;
    const request = context.current.generation;
    let active = true;
    setDetected({ generation: request, value: '', pending: true });
    const isCurrent = () => active && context.current.generation === request &&
      protectedRef.current === null && getAuthOperationEpoch() === authEpoch;
    const finish = (value: string | null) => {
      if (!isCurrent()) return;
      const selected = normalizeReportCurrency(value) || '';
      latest.current = { ...latest.current, currency: selected, detecting: false, authEpoch };
      setDetected({ generation: request, value: selected, pending: false });
    };
    void detectReportCurrency(location, latitude, longitude).then(finish, () => finish(null));
    return () => { active = false; };
  }, [key, visible, paused, named, location, latitude, longitude, authEpoch]);
  return { currency, setCurrency, resetCurrency, detecting, currencyForSubmission };
}
