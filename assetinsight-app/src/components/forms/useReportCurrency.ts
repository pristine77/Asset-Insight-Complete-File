import { useCallback, useEffect, useRef, useState } from 'react';
import { detectReportCurrency, normalizeReportCurrency } from '../../utils/reportCurrency';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';

/** A restored or manually selected currency wins over every late location response. */
export default function useReportCurrency({ initialCurrency, location, latitude, longitude, visible, paused = false }: {
  initialCurrency?: unknown; location?: unknown; latitude?: number; longitude?: number; visible: boolean; paused?: boolean;
}) {
  const [currency, setValue] = useState(() => normalizeReportCurrency(initialCurrency) || 'CAD');
  const [detecting, setDetecting] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const protectedRef = useRef(Boolean(normalizeReportCurrency(initialCurrency)));
  const generation = useRef(0);
  const setCurrency = useCallback((value: string) => {
    protectedRef.current = true;
    generation.current++;
    setDetecting(false);
    setValue(normalizeReportCurrency(value) || value.toUpperCase());
  }, []);
  const resetCurrency = useCallback(() => {
    protectedRef.current = false;
    generation.current++;
    setDetecting(false);
    setValue('CAD');
    setResetEpoch(epoch => epoch + 1);
  }, []);
  useEffect(() => {
    const request = ++generation.current;
    const authEpoch = getAuthOperationEpoch();
    if (!visible || paused || protectedRef.current) return;
    let active = true;
    setDetecting(true);
    void detectReportCurrency(location, latitude, longitude).then(detected => {
      if (!active || generation.current !== request || protectedRef.current || getAuthOperationEpoch() !== authEpoch) return;
      if (detected) setValue(detected);
      setDetecting(false);
    });
    return () => { active = false; };
  }, [visible, paused, location, latitude, longitude, resetEpoch]);
  return { currency, setCurrency, resetCurrency, detecting };
}
