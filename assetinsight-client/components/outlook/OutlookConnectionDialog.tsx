"use client";

import {
  CalendarDays,
  CircleCheck,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { OutlookCalendarStatus } from "@/services/outlook";

export default function OutlookConnectionDialog({
  open,
  onClose,
  status,
  loading,
  busy,
  error,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  status: OutlookCalendarStatus;
  loading: boolean;
  busy: boolean;
  error?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      aria-labelledby="outlook-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        width: "min(600px, calc(100% - 32px))",
        padding: 0,
        color: "var(--app-text)",
      }}
    >
      <header
        className="app-dialog__header"
        style={{ position: "relative", paddingRight: 64 }}
      >
        <h2
          id="outlook-dialog-title"
          style={{ margin: 0, fontSize: "1.06rem", fontWeight: 760 }}
        >
          Outlook calendar
        </h2>
        <button
          type="button"
          className="app-button app-button--icon"
          onClick={onClose}
          aria-label="Close Outlook calendar settings"
          style={{ position: "absolute", top: 14, right: 16 }}
        >
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className="app-dialog__body">
        <div style={{ display: "grid", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              aria-hidden
              style={{
                width: 44,
                height: 44,
                flex: "0 0 auto",
                display: "grid",
                placeItems: "center",
                borderRadius: 8,
                background: "var(--app-accent-soft)",
                color: "var(--app-accent)",
              }}
            >
              <CalendarDays size={21} />
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 740 }}>
                Calendar connection
              </h3>
              <p className="app-muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                Manage Outlook sync for your ClearValue account.
              </p>
            </div>
          </div>

          {loading ? (
            <div
              className="app-muted"
              role="status"
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <span className="app-spinner" aria-hidden />
              Checking Outlook connection…
            </div>
          ) : (
            <div
              className={`app-alert ${
                status.connected ? "" : "app-alert--warning"
              }`}
              role="status"
            >
              {status.connected ? (
                <CircleCheck
                  size={18}
                  aria-hidden
                  style={{ flex: "0 0 auto", color: "var(--app-success)" }}
                />
              ) : (
                <Info
                  size={18}
                  aria-hidden
                  style={{ flex: "0 0 auto", color: "var(--app-info)" }}
                />
              )}
              <span>
                {status.connected
                  ? `Connected${status.email ? ` as ${status.email}` : ""}`
                  : "Outlook calendar is not connected yet."}
              </span>
            </div>
          )}

          <section
            aria-labelledby="outlook-connection-details"
            style={{
              padding: 16,
              borderRadius: 8,
              border: "1px solid var(--app-border)",
              background: "var(--app-panel-alt)",
            }}
          >
            <h3
              id="outlook-connection-details"
              style={{ margin: 0, fontSize: 14, fontWeight: 720 }}
            >
              Connection details
            </h3>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(100px, auto) minmax(0, 1fr)",
                gap: "7px 16px",
                margin: "12px 0 0",
                fontSize: 13,
              }}
            >
              <dt className="app-muted">Status</dt>
              <dd style={{ margin: 0, fontWeight: 650 }}>
                {status.connected ? "Connected" : "Not connected"}
              </dd>
              <dt className="app-muted">Email</dt>
              <dd style={{ margin: 0 }}>{status.email || "Not available"}</dd>
              <dt className="app-muted">Connected at</dt>
              <dd style={{ margin: 0 }}>
                {status.connectedAt
                  ? new Date(status.connectedAt).toLocaleString()
                  : "Not available"}
              </dd>
            </dl>
          </section>

          {error ? (
            <div className="app-alert app-alert--error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>

      <footer
        className="app-dialog__footer"
        style={{ flexWrap: "wrap", alignItems: "center" }}
      >
        <button
          type="button"
          className="app-button"
          onClick={onRefresh}
          disabled={loading || busy}
          style={{ marginRight: "auto" }}
        >
          <RefreshCw size={16} aria-hidden />
          Refresh
        </button>
        <button
          type="button"
          className="app-button app-button--secondary"
          onClick={onClose}
        >
          Close
        </button>
        {status.connected ? (
          <button
            type="button"
            className="app-button app-button--danger"
            onClick={onDisconnect}
            disabled={busy}
          >
            {busy ? <span className="app-spinner" aria-hidden /> : null}
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            className="app-button app-button--primary"
            onClick={onConnect}
            disabled={busy}
          >
            {busy ? <span className="app-spinner" aria-hidden /> : null}
            {busy ? "Connecting…" : "Connect Outlook"}
          </button>
        )}
      </footer>
    </dialog>
  );
}
