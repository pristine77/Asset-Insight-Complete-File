"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { Mail, RefreshCw, Send } from "lucide-react";
import type { PreviewReminderRequest } from "@/lib/previewResubmitRequest";
import type { PreviewNotificationDraft } from "./previewReportTypes";

type Props = {
  reportId: string | null;
  onClose: () => void;
  onSent: (message: string, warning: boolean) => void;
  onDeliveryAttempt: () => void;
};

export default function PreviewNotificationComposer({ reportId, onClose, onSent, onDeliveryAttempt }: Props) {
  const [draft, setDraft] = useState<PreviewNotificationDraft | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [pending, setPending] = useState<"processing" | "uncertain" | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const inFlight = useRef(false);
  const request = useRef<PreviewReminderRequest | null>(null);

  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setLoading(true); setDraft(null); setError(""); setNeedsReview(false); setPending(null);
    request.current = null;
    fetch(`/api/admin/preview-reports/${encodeURIComponent(reportId)}/reminder`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || "Unable to load the current notification draft.");
        if (data.reportId !== reportId || !data.recipient?.id || typeof data.subject !== "string" || typeof data.message !== "string" || !/^[a-f0-9]{64}$/.test(data.baseRevision || "")) {
          throw new Error("The notification draft is unavailable. Reload after backend support is updated.");
        }
        if (controller.signal.aborted) return;
        setDraft(data); setSubject(data.subject); setMessage(data.message);
        if (data.pendingDelivery) {
          setPending(data.pendingDelivery.status);
          if (data.pendingDelivery.deliveryStatus === "sent") setError("Email has been sent. The in-app notification still needs confirmation; check this same request without resending the email.");
          request.current = { subject: data.subject, message: data.message, baseRevision: data.baseRevision, requestId: data.pendingDelivery.requestId };
        }
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load the notification draft."); })
      .finally(() => { window.clearTimeout(timeout); if (!controller.signal.aborted) setLoading(false); });
    const onTimeout = () => { setLoading(false); setError("Loading the notification draft timed out. Please reload."); };
    controller.signal.addEventListener("abort", onTimeout, { once: true });
    return () => { window.clearTimeout(timeout); controller.signal.removeEventListener("abort", onTimeout); controller.abort(); };
  }, [reportId, reloadToken]);

  const editable = !loading && !sending && !needsReview && !pending;
  const valid = subject.trim().length >= 3 && subject.length <= 180 && !/[\r\n]/.test(subject)
    && message.trim().length >= 10 && message.length <= 10_000;

  async function sendNotification() {
    if (!reportId || !draft || draft.reportId !== reportId || inFlight.current || needsReview || loading || (!pending && (!draft.eligible || !valid))) return;
    const body = request.current || { subject, message, baseRevision: draft.baseRevision, requestId: crypto.randomUUID() };
    request.current = body;
    inFlight.current = true; setSending(true); setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/api/admin/preview-reports/${encodeURIComponent(reportId)}/reminder`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        request.current = null; setPending(null); setNeedsReview(true);
        setError(`${result.message || "The report, owner or notification draft changed."} Reload and review before sending.`);
        return;
      }
      if (response.status === 200 && result.deliveryStatus === "sent") {
        if (result.inAppStatus !== "sent") {
          setPending("uncertain");
          setError(result.message || "Email was sent, but the in-app notification is not confirmed. Check this same request; the email will not be resent.");
          return;
        }
        request.current = null; setPending(null);
        onSent(result.message || "Email and in-app notification sent to the report owner.", false);
        onClose(); return;
      }
      if (response.status === 202 && ["processing", "uncertain"].includes(result.deliveryStatus)) {
        setPending(result.deliveryStatus);
        setError(result.message || "Delivery is not yet confirmed. Do not create another notification; check this request instead.");
        if (result.deliveryStatus === "processing") {
          onSent(result.message || "Notification accepted for processing. Delivery is not yet confirmed; reopen Notify to check this same request.", true);
          onClose();
        }
        return;
      }
      if ([400, 401, 403, 404, 415, 422, 429].includes(response.status)) {
        request.current = null; setNeedsReview(true);
        setError(result.message || "This notification cannot be sent. Reload the current draft before trying again.");
        return;
      }
      throw new Error(result.message || "Delivery could not be confirmed.");
    } catch (reason) {
      setPending("uncertain");
      setError(`${controller.signal.aborted ? "Delivery confirmation timed out." : reason instanceof Error ? reason.message : "Delivery could not be confirmed."} Do not send a new message. Check delivery using this same request.`);
    } finally {
      window.clearTimeout(timeout); inFlight.current = false; setSending(false);
      onDeliveryAttempt();
    }
  }

  return <Dialog open={Boolean(reportId)} onClose={() => { if (!inFlight.current) onClose(); }} fullWidth maxWidth="md" aria-labelledby="preview-notification-title" PaperProps={{ sx: { m: { xs: 2, sm: 4 }, width: { xs: "calc(100% - 32px)", sm: "calc(100% - 64px)" }, maxHeight: "calc(100dvh - 32px)", borderRadius: "6px" } }}>
    <DialogTitle id="preview-notification-title" sx={{ px: { xs: 2, sm: 3 }, py: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center"><Mail size={21} /><Typography component="span" sx={{ fontSize: 20, fontWeight: 750 }}>Notify report owner</Typography></Stack>
      <Typography sx={{ color: "text.secondary", fontSize: 12.5, mt: 0.4 }}>Review the email before sending. The owner also receives an in-app notification.</Typography>
    </DialogTitle>
    <DialogContent dividers sx={{ p: { xs: 2, sm: 3 } }}>
      {loading ? <Stack role="status" direction="row" spacing={1} alignItems="center" sx={{ py: 4 }}><CircularProgress size={22} /><Typography>Loading current report details…</Typography></Stack> : null}
      {error ? <Alert severity={pending ? "warning" : "error"} sx={{ mb: 2, overflowWrap: "anywhere" }}>{error}</Alert> : null}
      {!loading && draft ? <Stack spacing={2}>
        {pending ? <Alert severity="warning">{pending === "processing" ? "This notification is already processing." : "Delivery needs confirmation."} The message and recipient are locked. “Check delivery” uses the same request and will not resend the email.</Alert> : null}
        {!draft.eligible && !pending ? <Alert severity="info">{draft.ineligibleReason || "A notification cannot be sent for this report right now."}</Alert> : null}
        <TextField label="To" value={`${draft.recipient.displayName} <${draft.recipient.email}>`} fullWidth size="small" InputProps={{ readOnly: true }} helperText={`${draft.reportType === "Asset" ? "Asset Report" : "Lot Listing"} · Contract ${draft.contractNo || "not provided"} · ${pending ? "Recipient for this accepted request" : "Current report owner"}`} />
        {draft.reportError ? <Alert severity="error" sx={{ "& .MuiAlert-message": { minWidth: 0, width: "100%" }, overflowWrap: "anywhere" }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.5 }}>Report needs attention</Typography>
          <Typography sx={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{draft.reportError}</Typography>
          {draft.affectedLots?.length ? <Box component="details" sx={{ mt: 1 }}><Box component="summary" sx={{ cursor: "pointer", fontWeight: 650, fontSize: 13 }}>Affected lots ({draft.affectedLots.length})</Box><Box sx={{ mt: 0.75, maxHeight: 150, overflowY: "auto", fontSize: 13 }}>{draft.affectedLots.join(", ")}</Box></Box> : null}
          {draft.correctionSteps?.length ? <Box component="details" sx={{ mt: 1 }}><Box component="summary" sx={{ cursor: "pointer", fontWeight: 650, fontSize: 13 }}>Suggested correction steps</Box><Box component="ol" sx={{ my: 0.75, pl: 2.5, fontSize: 13 }}>{draft.correctionSteps.map((step, index) => <li key={index}>{step}</li>)}</Box></Box> : null}
        </Alert> : null}
        <TextField label="Subject" fullWidth value={subject} disabled={!editable} onChange={(event) => setSubject(event.target.value)} inputProps={{ maxLength: 180 }} helperText={`${subject.length}/180 characters`} />
        <TextField label="Email message" fullWidth multiline minRows={10} maxRows={18} value={message} disabled={!editable} onChange={(event) => setMessage(event.target.value)} inputProps={{ maxLength: 10_000 }} sx={{ "& textarea": { fontSize: 14, lineHeight: 1.55 } }} helperText={`${message.length.toLocaleString()}/10,000 characters. Plain text; the report link is included in the email.`} />
        {draft.lastSentAt ? <Typography sx={{ color: "text.secondary", fontSize: 12 }}>Last notification: {new Date(draft.lastSentAt).toLocaleString()}</Typography> : null}
        <Typography sx={{ color: "text.secondary", fontSize: 12 }}>Report context and correction details are included separately in the email and in-app notification. Editing the message does not remove those details or change the report.</Typography>
        <Typography sx={{ color: "text.secondary", fontSize: 12 }}>Sending this message does not edit, submit or regenerate the report.</Typography>
      </Stack> : null}
    </DialogContent>
    <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, flexWrap: "wrap", gap: 1 }}>
      <Button color="inherit" disabled={sending} onClick={onClose}>{pending ? "Close" : "Cancel"}</Button>
      {needsReview || (!loading && !draft) ? <Button variant="contained" startIcon={<RefreshCw size={16} />} onClick={() => setReloadToken((value) => value + 1)}>Reload and review</Button>
        : <Button variant="contained" disabled={loading || sending || !draft || (!pending && (!draft.eligible || !valid))} onClick={sendNotification} startIcon={sending ? <CircularProgress color="inherit" size={16} /> : pending ? <RefreshCw size={16} /> : <Send size={16} />}>
          {sending ? pending ? "Checking delivery" : "Sending" : pending ? "Check delivery" : "Send email & notification"}
        </Button>}
    </DialogActions>
  </Dialog>;
}
