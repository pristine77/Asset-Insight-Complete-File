import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';
import auctioneerDeliveryService, {
  type AuctioneerDeliverySummary,
} from '../../services/auctioneerDeliveryService';

/** Read-only polling, separate from the potentially large report/media list. */
export default function useReportDeliveries(owner: string) {
  const [deliveries, setDeliveries] = useState<AuctioneerDeliverySummary[]>([]);
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const revision = useRef(0);
  const alive = useRef(false);
  const session = useRef(getAuthOperationEpoch());
  const currentOwner = useRef(owner);
  currentOwner.current = owner;

  const currentSession = useCallback(
    () => alive.current && Boolean(owner) && currentOwner.current === owner && session.current === getAuthOperationEpoch(),
    [owner]
  );

  const refresh = useCallback(async () => {
    if (!currentSession()) return;
    const request = ++revision.current;
    const current = () => currentSession() && request === revision.current;
    setChecking(true);
    try {
      const next = await auctioneerDeliveryService.getDeliveries();
      if (!current()) return;
      setDeliveries(next);
      setError(false);
    } catch {
      // Keep previously confirmed statuses, but every Send has its own fresh preflight.
      if (current()) setError(true);
    } finally {
      if (current()) setChecking(false);
    }
  }, [currentSession]);

  const updated = useCallback((delivery: AuctioneerDeliverySummary) => {
    if (!currentSession()) return;
    // A read started before this receipt must not replace it with an older state.
    revision.current += 1;
    setChecking(false);
    setDeliveries((previous) => previous.map((row) =>
      row.workItemId === delivery.workItemId ? delivery : row
    ));
  }, [currentSession]);

  useEffect(() => {
    alive.current = true;
    session.current = getAuthOperationEpoch();
    setDeliveries([]);
    setError(false);
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setForeground(active);
      if (active) void refresh();
      else {
        revision.current += 1;
        setChecking(false);
      }
    });
    return () => {
      alive.current = false;
      revision.current += 1;
      subscription.remove();
    };
  }, [refresh]);

  const pending = deliveries.some((row) => row.state === 'queued' || row.state === 'sending');
  useEffect(() => {
    if (!foreground || !pending || checking) return;
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [foreground, pending, checking, refresh]);

  return { deliveries, error, checking, refresh, updated };
}
