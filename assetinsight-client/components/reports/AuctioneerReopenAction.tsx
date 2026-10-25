"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import useSWR from "swr";
import { useAuthContext } from "@/context/AuthContext";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import AuctioneerService, {
  auctioneerReopenErrorMessage,
  type AuctioneerContractReopen,
  type AuctioneerIncomingItem,
} from "@/services/auctioneer";

const DEADLINE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  timeZone: "America/Regina", timeZoneName: "short",
});

type Props = {
  item: AuctioneerIncomingItem;
  busy: boolean;
  onBusyChange: (busy: boolean, operation: symbol) => void;
  onReopened: (receipt: AuctioneerContractReopen, isCurrent: () => boolean) => Promise<boolean>;
};

/** A completed contract is never locally reopened from a date or an old report. */
export default function AuctioneerReopenAction({ item, busy, onBusyChange, onReopened }: Props) {
  const { user } = useAuthContext();
  const ownerId = user?._id || user?.id;
  const session = captureAuthSession();
  const contextKey = `${ownerId || ""}:${session.revision}:${item.cycleKey}:${item.contractId}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const mounted = useRef(false);
  const flight = useRef<symbol | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AuctioneerContractReopen | null>(null);
  const { data: permission, error: permissionError, isValidating, mutate } = useSWR(
    ownerId ? ["auctioneer/reopen-permission", ownerId, session.revision, item.contractId, item.cycleKey] : null,
    () => AuctioneerService.getCapturePermission(item.contractId),
    {
      keepPreviousData: false,
      revalidateOnMount: true, dedupingInterval: 0,
      refreshInterval: () => document.visibilityState === "visible" && navigator.onLine ? 60_000 : 0,
      refreshWhenHidden: false, refreshWhenOffline: false, shouldRetryOnError: false,
    }
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flight.current) onBusyChange(false, flight.current);
    };
  }, [onBusyChange]);

  const reopen = async () => {
    if (!ownerId || !isAuthSessionCurrent(session) || busy || flight.current ||
      (!receipt && permission?.reopen.allowed !== true && permission?.confirmationPending !== true)) return;
    const checkingPriorRequest = !receipt && permission?.confirmationPending === true;
    const operation = Symbol("reopen-contract-part");
    const operationSession = captureAuthSession();
    const isCurrent = () => mounted.current && currentContext.current === contextKey && isAuthSessionCurrent(operationSession);
    flight.current = operation;
    onBusyChange(true, operation);
    setError(null);
    let confirmed = receipt;
    try {
      if (!confirmed) {
        // A displayed button may have outlived the event deadline or assignment.
        const fresh = await AuctioneerService.getCapturePermission(item.contractId);
        if (!isCurrent()) return;
        await mutate(fresh, { revalidate: false });
        if (!isCurrent()) return;
        if (checkingPriorRequest && fresh.confirmationPending !== true) {
          setError("The previous Re-Open request has already been checked. Review the updated availability before starting a new Re-Open.");
          return;
        }
        if (fresh.reopen.allowed !== true && fresh.confirmationPending !== true) {
          setError(auctioneerReopenErrorMessage({ code: fresh.reopen.reason }));
          return;
        }
        confirmed = await AuctioneerService.reopenContractPart(item.contractId);
        if (!isCurrent()) return;
        setReceipt(confirmed);
      }
      const refreshed = await onReopened(confirmed, isCurrent);
      if (isCurrent() && !refreshed) {
        setError("Your part is open, but the new work has not loaded yet. Refresh Incoming before adding more lots.");
      }
    } catch (failure) {
      if (!isCurrent()) return;
      setError(confirmed
        ? "Your part is open, but Incoming could not refresh. Refresh Incoming to load the new work."
        : auctioneerReopenErrorMessage(failure));
      if (!confirmed) void mutate();
    } finally {
      if (flight.current === operation) flight.current = null;
      if (isCurrent()) onBusyChange(false, operation);
    }
  };

  const deadline = permission?.reopen.reopenUntil;
  return (
    <div className="grid min-w-0 gap-2">
      {deadline ? <p className="app-subtitle">Re-open until {DEADLINE.format(new Date(deadline))} (Saskatchewan)</p> : null}
      {error ? <p className="app-alert app-alert--error" role="alert">{error}</p> : null}
      {permissionError && !receipt ? (
        <p className="app-alert app-alert--warning" role="status">
          Re-open availability could not be checked.
          <button className="app-button app-button--secondary" disabled={busy || isValidating} onClick={() => void mutate()}>Check again</button>
        </p>
      ) : null}
      {!receipt && !permissionError && !isValidating &&
        (permission?.reopen.allowed === true || permission?.confirmationPending === true) ? (
        <button className="app-button app-button--secondary" disabled={busy} onClick={() => void reopen()}>
          <RotateCcw size={15} aria-hidden />{busy ? "Re-opening…" : permission.confirmationPending === true ? "Check Re-Open" : "Re-Open"}
        </button>
      ) : null}
      {receipt ? (
        <button className="app-button app-button--secondary" disabled={busy} onClick={() => void reopen()}>
          {busy ? "Refreshing…" : "Refresh Incoming"}
        </button>
      ) : null}
    </div>
  );
}
