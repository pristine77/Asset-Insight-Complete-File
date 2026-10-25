"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import {
  backgroundUploads,
  describeBackgroundUpload,
  type BackgroundUploadEntry,
} from "@/services/backgroundUploadManager";
import {
  describeResumeOutcome,
  prepareResumeFromRecord,
} from "@/services/uploadResumeRecovery";
import {
  getResumableUpload,
  listResumableUploads,
  type UploadResumeRecord,
} from "@/services/uploadResumeStore";
import { openUploadForReview } from "@/services/uploadReviewNavigation";
import { safeReportOperationError } from "@/services/reportTransferErrors";
import { useBackgroundUploads } from "./useBackgroundUploads";

/**
 * The upload line, shown above every Listings page.
 *
 * Submit closes its form and the transfer continues here, so this bar is the
 * only place that knows work is outstanding. It also surfaces uploads this
 * browser was carrying when the tab was closed: those are offered as an
 * explicit "Finish upload", never resumed automatically, because an attempt
 * that was cut off may already have been accepted by the server.
 */

const ACTION_CLASS =
  "inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-45";

/** One immediately locked action, revoked on unmount or auth-session change. */
function useUploadAction() {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  const run = useCallback(async (action: (current: () => boolean, signal: AbortSignal) => Promise<string | void>) => {
    if (pending.current) return;
    const controller = new AbortController();
    const session = captureAuthSession();
    pending.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && isAuthSessionCurrent(session);
    setBusy(true); setRefusal(null);
    try {
      const message = await action(current, controller.signal);
      if (current() && message) setRefusal(message);
    } catch (error) {
      if (current()) setRefusal(safeReportOperationError(error, "This upload could not be checked. Your saved report and media are kept. Check Reports before submitting again."));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (current()) setBusy(false);
    }
  }, []);
  return { busy, refusal, run };
}

function ProgressTrack({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-panel-alt)]"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-300"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function ActiveRow({ entry }: { entry: BackgroundUploadEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-[var(--app-text)]">{entry.title}</p>
          <p className="text-xs text-[var(--app-text-muted)]">{describeBackgroundUpload(entry)}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className={ACTION_CLASS}
            disabled={!entry.canPause}
            onClick={() => backgroundUploads.pause(entry.id)}
          >
            Pause
          </button>
        </div>
      </div>
      <ProgressTrack percent={entry.percent} label={`Upload progress for ${entry.title}`} />
      {entry.finalizing ? (
        <p className="text-xs text-[var(--app-text-muted)]">
          Waiting for the server to confirm acceptance. Your saved report and media are kept until it confirms.
        </p>
      ) : null}
    </div>
  );
}

function HeldRow({ entry }: { entry: BackgroundUploadEntry }) {
  const router = useRouter();
  const { busy, refusal, run } = useUploadAction();
  const review = () => run(async (current, signal) => {
    const record = await getResumableUpload(entry.ownerId, entry.kind, entry.scopeId, entry.clientSubmissionId, { isCurrent: current, signal });
    if (!current()) return;
    if (!record) return "The saved upload could not be found. Check Reports before creating a separate submission.";
    await openUploadForReview(record, router, current);
  });
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] pt-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-sm font-medium text-[var(--app-text)]">{entry.title}</p>
        <p className="text-xs text-[var(--app-text-muted)]">
          {entry.message || describeBackgroundUpload(entry)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* A conflict the form must resolve would fail identically from here. */}
        {entry.needsForm ? null : (
          <button
            type="button"
            className={ACTION_CLASS}
            disabled={busy}
            onClick={() => backgroundUploads.resume(entry.id)}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          className={ACTION_CLASS}
          disabled={busy}
          onClick={() => void review()}
        >
          {busy ? "Opening…" : "Review saved report"}
        </button>
      </div>
      {refusal ? <p className="w-full text-xs text-[var(--app-danger)]" role="alert">{refusal}</p> : null}
    </div>
  );
}

/** An upload this browser was carrying when its tab closed. */
function ResumableRow({
  record,
  onDone,
}: {
  record: UploadResumeRecord;
  onDone: () => void;
}) {
  const router = useRouter();
  const { busy, refusal, run } = useUploadAction();
  const finish = () => run(async (current, signal) => {
      const outcome = await prepareResumeFromRecord(record, { isCurrent: current, signal });
      if (!current()) return;
      if (outcome.status === "ready") {
        await backgroundUploads.enqueue({ ...outcome.request, signal });
        if (current()) onDone();
        return;
      }
      return describeResumeOutcome(outcome) || undefined;
  });
  const review = () => run(async (current) => { await openUploadForReview(record, router, current); });

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--app-border)] pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words text-sm font-medium text-[var(--app-text)]">{record.title}</p>
          <p className="text-xs text-[var(--app-text-muted)]">
            Interrupted before server acceptance was confirmed. The report and original media are saved in this browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!record.needsForm ? (
          <button type="button" className={ACTION_CLASS} disabled={busy} onClick={() => void finish()}>
            {busy ? "Checking…" : "Finish upload"}
          </button>
          ) : null}
          <button type="button" className={ACTION_CLASS} disabled={busy} onClick={() => void review()}>
            Review saved report
          </button>
        </div>
      </div>
      {refusal ? (
        <p className="text-xs text-[var(--app-danger)]" role="alert">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}

export function UploadBar({ ownerId }: { ownerId: string }) {
  const uploads = useBackgroundUploads();
  const active = uploads.active?.ownerId === ownerId ? uploads.active : null;
  const queued = uploads.queued.filter((entry) => entry.ownerId === ownerId);
  const held = uploads.held.filter((entry) => entry.ownerId === ownerId);
  const notices = uploads.notices.filter((notice) => notice.ownerId === ownerId);
  const [resumable, setResumable] = useState<{ ownerId: string; rows: UploadResumeRecord[] }>({ ownerId, rows: [] });
  const [readError, setReadError] = useState<{ ownerId: string; message: string } | null>(null);
  const requestId = useRef(0);
  const owner = useRef(ownerId);
  owner.current = ownerId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);

  const refreshResumable = useCallback(() => {
    const request = ++requestId.current;
    const session = captureAuthSession();
    const current = () => mounted.current && owner.current === ownerId && requestId.current === request && isAuthSessionCurrent(session);
    void listResumableUploads(ownerId)
      .then((rows) => {
        if (!current()) return;
        setReadError(null);
        setResumable({ ownerId, rows: rows.filter((row) => row.ownerId === ownerId) });
      })
      .catch(() => { if (current()) setReadError({ ownerId, message: "Saved uploads could not be checked. Keep this browser’s data and retry before starting another submission." }); });
  }, [ownerId]);

  useEffect(() => { refreshResumable(); return () => { requestId.current++; }; }, [refreshResumable]);

  useEffect(() => backgroundUploads.onAccepted((event) => { if (event.ownerId === ownerId) refreshResumable(); }), [ownerId, refreshResumable]);

  useEffect(() => {
    const sent = notices.filter((notice) => notice.autoDismiss);
    if (!sent.length) return;
    const timer = window.setTimeout(() => {
      for (const notice of sent) backgroundUploads.dismissNotice(notice.id);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [notices]);

  const offers = resumable.ownerId === ownerId ? resumable.rows.filter((row) => !backgroundUploads.entryForDraft(row.kind, row.scopeId, row.clientSubmissionId)) : [];
  const savedError = readError?.ownerId === ownerId ? readError.message : null;
  if (!active && !queued.length && !held.length && !notices.length && !offers.length && !savedError) {
    return null;
  }

  return (
    <section
      className="sticky bottom-0 z-30 mx-auto w-full max-w-5xl rounded-t-xl border border-b-0 border-[var(--app-border)] bg-[var(--app-panel)] p-3 shadow-lg sm:p-4"
      aria-label="Report uploads"
    >
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        <p className="text-xs text-[var(--app-text-muted)]">Uploads continue while this tab stays open. If you close it, return here and choose Finish upload. Do not clear browser data.</p>
        {savedError ? <div><p className="text-xs text-[var(--app-danger)]" role="alert">{savedError}</p><button type="button" className={ACTION_CLASS} onClick={refreshResumable}>Retry saved uploads</button></div> : null}
        {active ? <ActiveRow entry={active} /> : null}
        {queued.length ? (
          <p className="text-xs text-[var(--app-text-muted)]">
            {queued.length} more {queued.length === 1 ? "report is" : "reports are"} waiting in line.
          </p>
        ) : null}
        {held.map((entry) => (
          <HeldRow key={entry.id} entry={entry} />
        ))}
        {offers.map((record) => (
          <ResumableRow key={record.key} record={record} onDone={refreshResumable} />
        ))}
      </div>
      {notices.map((notice) => (
        <div
          key={notice.id}
          className="mt-2 flex flex-wrap items-start justify-between gap-2 border-t border-[var(--app-border)] pt-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--app-text)]">
              {notice.heading} · {notice.title}
            </p>
            <p className="text-xs text-[var(--app-text-muted)]">{notice.message}</p>
          </div>
          <button
            type="button"
            className={ACTION_CLASS}
            onClick={() => backgroundUploads.dismissNotice(notice.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </section>
  );
}

export default UploadBar;
