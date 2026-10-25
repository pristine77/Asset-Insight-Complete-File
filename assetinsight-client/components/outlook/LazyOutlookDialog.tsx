"use client";

import OutlookConnectionDialog from "./OutlookConnectionDialog";
import { useOutlookCalendar } from "@/hooks/useOutlookCalendar";

export default function LazyOutlookDialog({ onClose }: { onClose: () => void }) {
  const {
    status,
    loading,
    busy,
    error,
    fetchStatus,
    connect,
    disconnect,
  } = useOutlookCalendar();

  return (
    <OutlookConnectionDialog
      open
      onClose={onClose}
      status={status}
      loading={loading}
      busy={busy}
      error={error}
      onRefresh={() => void fetchStatus()}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
    />
  );
}
