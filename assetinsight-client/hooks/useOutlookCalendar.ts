"use client";

import { useCallback, useEffect, useState } from "react";
import { OutlookService, type OutlookCalendarStatus } from "@/services/outlook";

export function useOutlookCalendar() {
  const [status, setStatus] = useState<OutlookCalendarStatus>({
    connected: false,
    configured: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingReturn, setPendingReturn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const nextStatus = await OutlookService.getStatus();
      setStatus(nextStatus);
    } catch (fetchError: any) {
      setStatus({ connected: false, configured: false });
      setError(
        fetchError?.response?.data?.message ||
          fetchError?.message ||
          "Failed to load Outlook calendar status."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!pendingReturn) return;
    const handleFocus = () => {
      void fetchStatus();
      setPendingReturn(false);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [fetchStatus, pendingReturn]);

  const connect = useCallback(async () => {
    if (busy) return;
    try {
      setBusy(true);
      setError(null);
      const authUrl = await OutlookService.getAuthUrl();
      if (!authUrl) {
        setError("Unable to start Outlook connection.");
        return;
      }
      setPendingReturn(true);
      window.open(authUrl, "_blank", "noopener");
    } catch (connectError: any) {
      setError(
        connectError?.response?.data?.message ||
          connectError?.message ||
          "Failed to start Outlook connection."
      );
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    try {
      setBusy(true);
      setError(null);
      await OutlookService.disconnect();
      await fetchStatus();
    } catch (disconnectError: any) {
      setError(
        disconnectError?.response?.data?.message ||
          disconnectError?.message ||
          "Failed to disconnect Outlook calendar."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, fetchStatus]);

  return {
    status,
    loading,
    busy,
    error,
    fetchStatus,
    connect,
    disconnect,
    clearError: () => setError(null),
  };
}
