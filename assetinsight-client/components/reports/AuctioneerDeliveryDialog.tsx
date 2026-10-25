"use client";

import {
  CircleAlert,
  Info,
  Send,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import AuctioneerService, {
  type AuctioneerDeliverySummary,
  type AuctioneerSendDeliveryInput,
} from "@/services/auctioneer";

export type AuctioneerDeliveryDialogProps = {
  open: boolean;
  delivery: AuctioneerDeliverySummary | null;
  onClose: () => void;
  onUpdated: (delivery: AuctioneerDeliverySummary) => void;
};

function errorRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  const failure = errorRecord(error);
  const body = errorRecord(errorRecord(failure.response).data);
  const nested = errorRecord(body.error);
  const message =
    errorText(body.message) ||
    errorText(body.error) ||
    errorText(nested.message) ||
    errorText(failure.message) ||
    fallback;
  const rawCode = errorText(body.code) || errorText(nested.code);
  // Only the API's named error fields cross this boundary. Never render objects,
  // response dumps or Axios transport codes in place of the actual rejection.
  const code = rawCode && /^[a-z][a-z\d_-]{0,95}$/i.test(rawCode) ? rawCode : undefined;
  return code && !message.toUpperCase().includes(code.toUpperCase())
    ? `${message} (${code})`
    : message;
}

function isLotListingDelivery(
  delivery: AuctioneerDeliverySummary | null | undefined
) {
  return (
    delivery?.reportType === "lotListing" ||
    delivery?.reportModel === "LotListing"
  );
}

function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error";
  children: React.ReactNode;
}) {
  const Icon =
    tone === "error" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={`app-alert ${
        tone === "error"
          ? "app-alert--error"
          : tone === "warning"
            ? "app-alert--warning"
            : ""
      }`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        size={18}
        aria-hidden
        style={{
          flex: "0 0 auto",
          color:
            tone === "error"
              ? "var(--app-danger)"
              : tone === "warning"
                ? "var(--app-warning)"
                : "var(--app-info)",
        }}
      />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

export default function AuctioneerDeliveryDialog({
  open,
  delivery,
  onClose,
  onUpdated,
}: AuctioneerDeliveryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [destination, setDestination] =
    useState<AuctioneerSendDeliveryInput["destination"]>("LottingBoard");
  const [opTaskDescription, setOpTaskDescription] = useState("");
  const [completeContract, setCompleteContract] = useState(false);
  const [externalLotId, setExternalLotId] = useState("");
  const [confirmNotCreated, setConfirmNotCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open || !delivery) return;
    setDestination(delivery.destination || "LottingBoard");
    setOpTaskDescription(delivery.opTaskDescription || "");
    setCompleteContract(
      delivery.canCompleteContract !== false &&
        Boolean(delivery.completeContract)
    );
    setExternalLotId("");
    setConfirmNotCreated(false);
    setError(null);
  }, [delivery, open]);

  const needsReconciliation = delivery?.state === "needs_reconciliation";
  const terminal = delivery?.state === "sent";
  const retrying = delivery?.state === "failed";
  const lotListingDelivery = isLotListingDelivery(delivery);
  /*
     Work assigned to this user closes THEIR part of the contract, never the
     contract itself: several people can be assigned to one contract, and
     Auctioneer completes it only once every one of them has closed theirs.
     This used to be a note saying the contract "may remain open", with no way
     to say you were done; the box is that way.
  */
  const closesOwnPart = delivery?.contractCompletionScope === "user";

  const handleSend = async () => {
    if (!delivery || busy) return;
    if (destination === "OpToDoBoard" && !opTaskDescription.trim()) {
      setError("Add an Operations To-Do note before sending.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const updated = await AuctioneerService.sendDelivery(delivery.workItemId, {
        destination,
        ...(destination === "OpToDoBoard"
          ? { opTaskDescription: opTaskDescription.trim() }
          : {}),
        completeContract:
          delivery.canCompleteContract !== false && completeContract,
      });
      onUpdated(updated);
      toast.success(
        updated.state === "sent"
          ? "Report sent to Auctioneer."
          : "Auctioneer delivery queued."
      );
      onClose();
    } catch (sendError: unknown) {
      setError(errorMessage(sendError, "Unable to queue the Auctioneer delivery."));
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    if (!delivery || busy) return;
    const lotId = externalLotId.trim();
    if (!lotId && !confirmNotCreated) {
      setError(
        "Enter the Auctioneer lot ID that was created, or confirm that no lot was created."
      );
      return;
    }
    if (lotId && confirmNotCreated) {
      setError("Choose one reconciliation option.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const updated = await AuctioneerService.reconcileDelivery(
        delivery.workItemId,
        lotId ? { externalLotId: lotId } : { confirmNotCreated: true }
      );
      onUpdated(updated);
      toast.success("Delivery reconciliation saved.");
      onClose();
    } catch (reconcileError: unknown) {
      setError(
        errorMessage(reconcileError, "Unable to reconcile this Auctioneer lot.")
      );
    } finally {
      setBusy(false);
    }
  };

  const title = needsReconciliation
    ? "Reconcile Auctioneer lot"
    : "Send to Auctioneer";

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      aria-labelledby="auctioneer-delivery-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      style={{
        width: "min(600px, calc(100% - 32px))",
        padding: 0,
        color: "var(--app-text)",
      }}
    >
      <header
        className="app-dialog__header"
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 11,
          paddingRight: 64,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            flex: "0 0 auto",
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            background: needsReconciliation
              ? "var(--app-warning-soft)"
              : "var(--app-accent-soft)",
            color: needsReconciliation
              ? "var(--app-warning)"
              : "var(--app-accent)",
          }}
        >
          {needsReconciliation ? <ShieldAlert size={19} /> : <Send size={19} />}
        </span>
        <h2
          id="auctioneer-delivery-title"
          style={{ margin: 0, fontSize: "1.06rem", fontWeight: 760 }}
        >
          {title}
        </h2>
        <button
          type="button"
          className="app-button app-button--icon"
          onClick={onClose}
          disabled={busy}
          aria-label={`Close ${title}`}
          style={{ position: "absolute", top: 16, right: 16 }}
        >
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className="app-dialog__body">
        <div style={{ display: "grid", gap: 16 }}>
          <p className="app-muted" style={{ margin: 0, fontSize: 13.5 }}>
            Contract {delivery?.contractNo || "report"} will send{" "}
            {lotListingDelivery
              ? "final generated listing data and photos"
              : "approved and released Asset Listing data and final report photos"}
            . Generated report files remain in Asset Insight.
          </p>

          {delivery?.error ? (
            <Notice tone={needsReconciliation ? "warning" : "error"}>
              {delivery.error}
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {retrying ? (
            <Notice>
              Retry resumes the saved lot checkpoints using the original
              destination and contract-completion settings.
            </Notice>
          ) : null}

          {needsReconciliation ? (
            <>
              <Notice tone="warning">
                Auctioneer may have created the Unknown Lot before the connection
                failed. Automatic retry is paused to prevent a duplicate.
              </Notice>
              <label className="app-label">
                Existing Auctioneer lot ID
                <input
                  className="app-field"
                  value={externalLotId}
                  onChange={(event) => {
                    setExternalLotId(event.target.value);
                    if (event.target.value.trim()) setConfirmNotCreated(false);
                  }}
                  disabled={busy || confirmNotCreated}
                  autoFocus
                />
                <span className="app-muted" style={{ fontSize: 12, fontWeight: 450 }}>
                  Use this when the lot exists in Auctioneer.
                </span>
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  color: "var(--app-text)",
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={confirmNotCreated}
                  onChange={(event) => {
                    setConfirmNotCreated(event.target.checked);
                    if (event.target.checked) setExternalLotId("");
                  }}
                  disabled={busy}
                  style={{
                    width: 18,
                    height: 18,
                    marginTop: 1,
                    accentColor: "var(--app-accent)",
                  }}
                />
                <span>I verified that Auctioneer did not create this lot</span>
              </label>
            </>
          ) : (
            <>
              <label className="app-label">
                Destination
                <select
                  className="app-field"
                  value={destination}
                  onChange={(event) =>
                    setDestination(
                      event.target
                        .value as AuctioneerSendDeliveryInput["destination"]
                    )
                  }
                  disabled={busy || terminal || retrying}
                  autoFocus
                >
                  <option value="LottingBoard">Lotting Board</option>
                  <option value="OpToDoBoard">Operations To-Do Board</option>
                </select>
              </label>
              {destination === "OpToDoBoard" ? (
                <label className="app-label">
                  Operations To-Do note
                  <textarea
                    className="app-field"
                    value={opTaskDescription}
                    onChange={(event) => setOpTaskDescription(event.target.value)}
                    disabled={busy || terminal || retrying}
                    required
                    rows={4}
                    maxLength={2000}
                    style={{ resize: "vertical" }}
                  />
                  <span
                    className="app-muted"
                    style={{ fontSize: 12, fontWeight: 450, textAlign: "right" }}
                  >
                    {opTaskDescription.length}/2000
                  </span>
                </label>
              ) : null}
              {closesOwnPart ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      color: "var(--app-text)",
                      fontSize: 14,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={completeContract}
                      onChange={(event) =>
                        setCompleteContract(event.target.checked)
                      }
                      disabled={busy || terminal || retrying}
                      aria-describedby="auctioneer-close-part-help"
                      style={{
                        width: 18,
                        height: 18,
                        marginTop: 1,
                        accentColor: "var(--app-accent)",
                      }}
                    />
                    <span>I&apos;ve finished this contract — close my part</span>
                  </label>
                  <p
                    id="auctioneer-close-part-help"
                    className="app-muted"
                    style={{ margin: "0 0 0 28px", fontSize: 12.5 }}
                  >
                    Your part closes once every lot in this delivery has
                    reached Auctioneer. The contract itself closes when every
                    person assigned to it has closed theirs. Leave this
                    unticked if you still have lots to send.
                  </p>
                </div>
              ) : delivery?.canCompleteContract === false ? (
                // An older server that refuses any close for this work and
                // names no scope: offer nothing rather than a box it rejects.
                null
              ) : (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    color: "var(--app-text)",
                    fontSize: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={completeContract}
                    onChange={(event) =>
                      setCompleteContract(event.target.checked)
                    }
                    disabled={busy || terminal || retrying}
                    style={{
                      width: 18,
                      height: 18,
                      marginTop: 1,
                      accentColor: "var(--app-accent)",
                    }}
                  />
                  <span>
                    Mark the contract task complete after every linked lot
                    succeeds
                  </span>
                </label>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="app-dialog__footer">
        <button
          type="button"
          className="app-button app-button--secondary"
          onClick={onClose}
          disabled={busy}
        >
          {terminal ? "Close" : "Cancel"}
        </button>
        {needsReconciliation ? (
          <button
            type="button"
            className="app-button app-button--primary"
            onClick={() => void handleReconcile()}
            disabled={busy}
          >
            {busy ? <span className="app-spinner" aria-hidden /> : null}
            {busy ? "Saving…" : "Save reconciliation"}
          </button>
        ) : terminal ? null : (
          <button
            type="button"
            className="app-button app-button--primary"
            onClick={() => void handleSend()}
            disabled={busy}
          >
            {busy ? (
              <span className="app-spinner" aria-hidden />
            ) : (
              <Send size={17} aria-hidden />
            )}
            {busy
              ? "Queuing…"
              : delivery?.state === "failed"
                ? "Retry delivery"
                : "Send report"}
          </button>
        )}
      </footer>
    </dialog>
  );
}
