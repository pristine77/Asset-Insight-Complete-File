"use client";

import { useEffect, useRef, useState } from "react";
import { ReportDraftService, createReportDraftClientId, getReportDraftDeviceId, type DraftMediaLot, type ReportDraftKind } from "@/services/reportDrafts";
import { reportTransferErrorMessage } from "@/services/reportTransferErrors";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";

type Props = {
  userId: string;
  kind: ReportDraftKind;
  sourceSessionId: string;
  getSnapshot: () => { formData: Record<string, unknown>; lots: DraftMediaLot[]; contractNo: string };
  onBusyChange: (busy: boolean) => void;
};

/** Explicit recovery creates a separate durable draft, never a second submission. */
export default function SeparateReportDraftRecovery({ userId, kind, sourceSessionId, getSnapshot, onBusyChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [invalidated, setInvalidated] = useState(false);
  const saveLock = useRef(false);
  const active = useRef<AbortController | null>(null);
  const mountedScope = useRef("");
  // Eligibility belongs to the form owner who received the server receipt.
  // Never rebind retained form/media to a later signed-in account.
  const origin = useRef({ userId, sourceSessionId, session: captureAuthSession() });
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const accountChangedMessage = "Your account session changed. Reopen your own saved draft before saving a separate copy.";
  useEffect(() => {
    mountedScope.current = `${userId}:${sourceSessionId}`;
    setBusy(false);
    setSaved(false);
    if (userId !== origin.current.userId || sourceSessionId !== origin.current.sourceSessionId || !isAuthSessionCurrent(origin.current.session)) {
      setInvalidated(true);
      setMessage(accountChangedMessage);
    }
    return () => {
      mountedScope.current = "";
      active.current?.abort();
      active.current = null;
      if (saveLock.current) busyCallback.current(false);
      saveLock.current = false;
    };
  }, [userId, sourceSessionId]);
  const save = async () => {
    const scope = `${userId}:${sourceSessionId}`;
    if (saveLock.current || saved || !userId || !sourceSessionId || mountedScope.current !== scope) return;
    const session = origin.current.session;
    if (invalidated || userId !== origin.current.userId || sourceSessionId !== origin.current.sourceSessionId || !isAuthSessionCurrent(session)) {
      setInvalidated(true);
      setMessage(accountChangedMessage);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const current = () => !controller.signal.aborted && mountedScope.current === scope && isAuthSessionCurrent(session);
    saveLock.current = true;
    setBusy(true);
    onBusyChange(true);
    setMessage("");
    try {
      // Persist identity before transport, including uncertain saves and reloads.
      // Only metadata is stored here; originals remain the existing File references.
      const key = `cv:separate-draft:v1:${userId}:${sourceSessionId}`;
      const previous = JSON.parse(localStorage.getItem(key) || "null") as { id?: unknown; revision?: unknown } | null;
      const id = typeof previous?.id === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(previous.id)
        ? previous.id : createReportDraftClientId(kind);
      const revision = typeof previous?.revision === "number" && Number.isSafeInteger(previous.revision) && previous.revision >= 0 ? previous.revision + 1 : 1;
      localStorage.setItem(key, JSON.stringify({ id, revision }));
      const snapshot = getSnapshot();
      const draft = await ReportDraftService.upsertWithMedia({
        clientDraftId: id, kind, revision, deviceId: getReportDraftDeviceId(),
        contractNo: snapshot.contractNo, title: `${snapshot.contractNo || "Report"} — Separate draft`,
        formData: { ...snapshot.formData, clientSubmissionId: id },
      }, snapshot.lots, (_progress, progressMessage) => { if (current()) setMessage(progressMessage); }, controller.signal, session);
      if (!current()) return;
      if (!draft?._id || draft.clientDraftId !== id || draft.user !== userId || draft.type !== (kind === "asset" ? "asset" : "lotListing")) {
        throw new Error("The separate draft save could not be confirmed. Retry this save before leaving the page.");
      }
      setSaved(true);
      setMessage("Separate draft and media saved to your account. Open Drafts in another tab, review the saved lots, then submit that draft. Nothing has been submitted automatically; your previous draft is unchanged.");
    } catch (error) {
      if (current()) setMessage(reportTransferErrorMessage(error, "save"));
    } finally {
      const ownsOperation = active.current === controller;
      if (ownsOperation) { active.current = null; saveLock.current = false; }
      if (ownsOperation && mountedScope.current === scope) {
        // Settle this operation's busy state even when its result is no longer
        // authorized. Never publish an old owner's progress or success.
        setBusy(false);
        busyCallback.current(false);
        if (!isAuthSessionCurrent(session)) { setInvalidated(true); setSaved(false); setMessage(accountChangedMessage); }
      }
    }
  };
  return (
    <section className="grid gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4" aria-label="Separate draft recovery">
      <p className="text-sm">The previous report is unavailable. You can save the current details and media as a separate draft for review. The original draft and submission history will not be changed.</p>
      {message ? <p role="status" className="break-words text-sm">{message}</p> : null}
      {saved ? <a className="text-sm font-semibold underline" href="/previews?tab=drafts" target="_blank" rel="noopener noreferrer">Open saved drafts (new tab)</a> :
        <button type="button" disabled={busy || invalidated || userId !== origin.current.userId || sourceSessionId !== origin.current.sourceSessionId} onClick={() => void save()} className="min-h-11 rounded-md border border-[var(--app-border)] px-4 py-2 text-sm font-semibold disabled:opacity-60">{busy ? "Saving separate draft…" : "Save separate draft"}</button>}
    </section>
  );
}
