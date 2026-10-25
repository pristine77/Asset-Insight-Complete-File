import type { FormDraftKind } from "@/components/forms/drafts/storage";
import { captureAuthSession, isAuthSessionCurrent, AuthSessionChangedError, type AuthSessionSnapshot } from "@/lib/auth-storage";
import { assertReportUploadAccepted, isPreviousReportReceipt, reportTransferErrorData, reportTransferErrorMessage } from "./reportTransferErrors";
import type { SubmissionFileDescriptor } from "./uploadJobFiles";
import { attachResumableSession, forgetResumableUpload, getResumableUpload, markResumableNeedsForm, recordResumableProgress, rememberResumableUpload, resumeKey, UploadPersistenceError } from "./uploadResumeStore";

export type BackgroundUploadStatus = "queued" | "uploading" | "paused" | "attention";
export type BackgroundUploadRequest = {
  ownerId: string; kind: FormDraftKind; scopeId?: string;
  endpoint: "/asset" | "/lot-listing"; title: string; totalFiles: number;
  clientSubmissionId: string; details: Record<string, unknown>; files: SubmissionFileDescriptor[];
  /** Original, ordered Files and the full editable envelope, committed atomically. */
  media: File[]; draftSnapshot: unknown; signal?: AbortSignal;
  upload: (onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<unknown>;
  /** Only prepareResumeFromRecord may set this, after reading the immutable bytes. */
  skipPersist?: boolean; needsFormDecision?: (error: unknown) => boolean;
  /** No mutable draft deletion belongs here. Only scoped, acceptance-only UI work. */
  onAccepted?: (result: unknown) => void | Promise<void>;
};
export type BackgroundUploadEntry = {
  id: string; ownerId: string; kind: FormDraftKind; scopeId?: string; title: string;
  status: BackgroundUploadStatus; percent: number; totalFiles: number; pausing: boolean;
  canPause: boolean; finalizing: boolean; needsForm: boolean; message?: string;
  clientSubmissionId: string;
};
export type BackgroundUploadNotice = {
  id: string; ownerId: string; kind: "sent" | "attention"; jobId: string; draftKey: string;
  title: string; heading: string; message: string; autoDismiss: boolean;
};
export type BackgroundUploadSnapshot = { active: BackgroundUploadEntry | null; queued: BackgroundUploadEntry[]; held: BackgroundUploadEntry[]; notices: BackgroundUploadNotice[] };
export type BackgroundUploadAccepted = { ownerId: string; kind: FormDraftKind; scopeId?: string; clientSubmissionId: string; result: unknown };
export const SENT_MESSAGE = "The server confirmed this upload. Processing continues; open Previews to check the report when it is ready.";
export const PAUSED_MESSAGE = "Upload paused. This report and its original media are saved on this browser. Resume to continue the same upload.";
export const STOPPED_MESSAGE = "Upload stopped on this browser. Your saved report and media are kept. Check Reports before starting a separate submission; the server may already have accepted this upload.";
export const BUSY_DRAFT_MESSAGE = "This report is uploading in the background. Pause it before reviewing its saved copy.";
export const INTERRUPTED_MESSAGE = "Upload acceptance could not be confirmed. Your saved report and media are kept. Finish this same upload when the connection is stable.";
export const NEEDS_FORM_MESSAGE = "Review this saved upload before continuing. Your original report and media are retained.";
type Job = BackgroundUploadRequest & { id: string; status: BackgroundUploadStatus; percent: number; pauseRequested: boolean; finalizing: boolean; message?: string; controller?: AbortController; session: AuthSessionSnapshot; generation: number };
const EMPTY: BackgroundUploadSnapshot = { active: null, queued: [], held: [], notices: [] };
export function draftKeyFor(kind: FormDraftKind, scopeId?: string) { return `${kind}:${scopeId || "default"}`; }
export function describeBackgroundUpload(entry: BackgroundUploadEntry): string {
  if (entry.status === "queued") return "Waiting in line";
  if (entry.status === "paused") return "Paused";
  if (entry.status === "attention") return "Needs attention";
  if (entry.pausing) return "Pausing";
  if (entry.finalizing) return "Confirming server acceptance";
  return `Uploading ${Math.round(entry.percent)}%`;
}
function backgroundError(error: unknown) {
  return reportTransferErrorMessage(error, "submit").replace("Your current form and selected media have not been cleared. Keep this page open.", "This saved report and its original media are kept on this browser.");
}

/** One serialized transfer line per tab. Browser closing stops transport, not recovery. */
export function createBackgroundUploadManager() {
  let generation = 0, sequence = 0;
  let ownerId: string | null = null;
  let ownerSession: AuthSessionSnapshot | null = null;
  let active: Job | null = null;
  let queue: Job[] = [], held: Job[] = [];
  let notices: BackgroundUploadNotice[] = [];
  let snapshot: BackgroundUploadSnapshot = EMPTY;
  const persisting = new Map<string, symbol>();
  const foreground = new Set<string>();
  const listeners = new Set<() => void>();
  const acceptedListeners = new Set<(event: BackgroundUploadAccepted) => void>();
  let unloadGuardInstalled = false;
  const belongs = (job: Job) => ownerId === job.ownerId && generation === job.generation && isAuthSessionCurrent(job.session);
  const canPause = (job: Job) => job.status === "queued" || (job.status === "uploading" && !job.pauseRequested && !job.finalizing);
  const toEntry = (job: Job): BackgroundUploadEntry => ({
    id: job.id, ownerId: job.ownerId, kind: job.kind, scopeId: job.scopeId, title: job.title,
    clientSubmissionId: job.clientSubmissionId, status: job.status, percent: job.percent, totalFiles: job.totalFiles,
    pausing: job.status === "uploading" && job.pauseRequested, canPause: canPause(job), finalizing: job.finalizing,
    needsForm: foreground.has(draftKeyFor(job.kind, job.scopeId)), message: job.message,
  });
  function warnBeforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
  function notify() {
    snapshot = { active: active ? toEntry(active) : null, queued: queue.map(toEntry), held: held.map(toEntry), notices: notices.slice() };
    if (typeof window !== "undefined") {
      const busy = Boolean(active) || queue.length > 0 || persisting.size > 0;
      if (busy && !unloadGuardInstalled) { window.addEventListener("beforeunload", warnBeforeUnload); unloadGuardInstalled = true; }
      if (!busy && unloadGuardInstalled) { window.removeEventListener("beforeunload", warnBeforeUnload); unloadGuardInstalled = false; }
    }
    for (const listener of Array.from(listeners)) { try { listener(); } catch {} }
  }
  function notice(job: Job, kind: "sent" | "attention", message: string) {
    if (!belongs(job)) return;
    notices = [...notices.filter((item) => item.jobId !== job.id), { id: `notice-${++sequence}`, ownerId: job.ownerId, kind, jobId: job.id, draftKey: draftKeyFor(job.kind, job.scopeId), title: job.title, heading: kind === "sent" ? "Upload accepted" : "Upload needs attention", message, autoDismiss: kind === "sent" }].slice(-10);
  }
  function startNext() {
    if (!active) {
      const job = queue.shift();
      if (job) { active = job; void runAttempt(job); return; }
    }
    notify();
  }
  function drop(job: Job) {
    job.controller?.abort();
    if (active === job) active = null;
    queue = queue.filter((item) => item !== job); held = held.filter((item) => item !== job);
  }
  function hold(job: Job, status: "paused" | "attention", message: string) {
    if (!belongs(job)) { drop(job); startNext(); return; }
    drop(job);
    Object.assign(job, { status, message, pauseRequested: false, finalizing: false, controller: undefined });
    held.push(job); startNext();
  }
  async function runAttempt(job: Job) {
    const current = () => {
      const ok = belongs(job) && active === job;
      if (!ok) job.controller?.abort();
      return ok;
    };
    if (!current()) { drop(job); startNext(); return; }
    const controller = new AbortController();
    Object.assign(job, { status: "uploading", controller, percent: 0, finalizing: false, message: undefined });
    notify();
    try {
      const result = await job.upload((fraction) => {
        if (!current() || controller.signal.aborted || !Number.isFinite(fraction)) return;
        // Even 100% transport bytes do not mean server acceptance.
        const percent = Math.max(job.percent, Math.min(99, Math.max(0, fraction * 100)));
        if (percent === job.percent && job.finalizing === (fraction >= 0.95)) return;
        Object.assign(job, { percent, finalizing: fraction >= 0.95 });
        void recordResumableProgress(job.ownerId, job.kind, job.scopeId, Math.floor((Math.min(fraction, 0.95) / 0.95) * job.totalFiles), job.clientSubmissionId, { isCurrent: current }).catch(() => undefined);
        notify();
      }, controller.signal);
      if (!current()) return;
      if (controller.signal.aborted) { hold(job, "paused", PAUSED_MESSAGE); return; }
      assertReportUploadAccepted(result);
      if (!job.skipPersist && isPreviousReportReceipt(result)) {
        foreground.add(draftKeyFor(job.kind, job.scopeId));
        const message = "The server returned an existing report for this submission. Check Reports and review this saved copy before creating anything again.";
        await markResumableNeedsForm(job.ownerId, job.kind, job.scopeId, job.clientSubmissionId, { isCurrent: current });
        if (!current()) return;
        notice(job, "attention", message); hold(job, "attention", message); return;
      }
      // Exact immutable snapshot only: never clear the mutable form/draft scope.
      try { await forgetResumableUpload(job.ownerId, job.kind, job.scopeId, job.clientSubmissionId, { isCurrent: current }); } catch { /* A confirmed receipt stays accepted; retained bytes remain recoverable. */ }
      if (!current()) return;
      notice(job, "sent", SENT_MESSAGE);
      foreground.delete(draftKeyFor(job.kind, job.scopeId));
      // Recheck after every observer: an observer may synchronously switch owner.
      const event = { ownerId: job.ownerId, kind: job.kind, scopeId: job.scopeId, clientSubmissionId: job.clientSubmissionId, result };
      for (const listener of Array.from(acceptedListeners)) { if (!current()) return; try { listener(event); } catch {} }
      if (!current()) return;
      // Optional UI callback is fenced at execution, not only before scheduling.
      if (job.onAccepted) {
        try { if (current()) await job.onAccepted(result); } catch { /* Already accepted. */ }
        if (!current()) return;
      }
      active = null; startNext();
    } catch (error) {
      if (!current()) return;
      if (controller.signal.aborted) { hold(job, "paused", PAUSED_MESSAGE); return; }
      const needsForm = reportTransferErrorData(error).status === 409 || Boolean(job.needsFormDecision?.(error));
      if (needsForm) {
        foreground.add(draftKeyFor(job.kind, job.scopeId));
        try { await markResumableNeedsForm(job.ownerId, job.kind, job.scopeId, job.clientSubmissionId, { isCurrent: current }); } catch {}
        if (!current()) return;
      }
      const message = `${backgroundError(error)}${needsForm ? ` ${NEEDS_FORM_MESSAGE}` : ""}`;
      notice(job, "attention", message); hold(job, "attention", message);
    }
  }
  const findJob = (id: string) => [active, ...queue, ...held].find((job): job is Job => Boolean(job) && job!.id === id);
  const entryForDraft = (kind: FormDraftKind, scopeId?: string, clientSubmissionId?: string) => {
    if (ownerSession && !isAuthSessionCurrent(ownerSession)) return null;
    const key = draftKeyFor(kind, scopeId);
    const job = [active, ...queue, ...held].find((item): item is Job => Boolean(item) && draftKeyFor(item!.kind, item!.scopeId) === key && (!clientSubmissionId || item!.clientSubmissionId === clientSubmissionId));
    return job ? toEntry(job) : null;
  };
  function clear(nextOwner: string | null) {
    generation++; ownerId = nextOwner; ownerSession = nextOwner ? captureAuthSession() : null;
    for (const job of [active, ...queue, ...held]) job?.controller?.abort();
    active = null; queue = []; held = []; notices = []; foreground.clear(); persisting.clear(); notify();
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => ownerSession && !isAuthSessionCurrent(ownerSession) ? EMPTY : snapshot,
    getServerSnapshot: () => EMPTY,
    onAccepted(listener: (event: BackgroundUploadAccepted) => void) { acceptedListeners.add(listener); return () => { acceptedListeners.delete(listener); }; },
    setOwner(next: string | null) { if (ownerId === next && (!next || (ownerSession && isAuthSessionCurrent(ownerSession)))) return; clear(next); },
    async enqueue(request: BackgroundUploadRequest): Promise<string> {
      if (!request.ownerId) throw new AuthSessionChangedError();
      if (ownerId === request.ownerId && ownerSession && !isAuthSessionCurrent(ownerSession)) clear(ownerId);
      if (ownerId === null) { ownerId = request.ownerId; ownerSession = captureAuthSession(); }
      const attemptGeneration = generation, session = captureAuthSession();
      const current = () => ownerId === request.ownerId && generation === attemptGeneration && isAuthSessionCurrent(session) && !request.signal?.aborted;
      if (!current()) throw new AuthSessionChangedError();
      const key = resumeKey(request.ownerId, request.kind, request.scopeId, request.clientSubmissionId);
      if (persisting.has(key) || [active, ...queue, ...held].some((job) => job?.clientSubmissionId === request.clientSubmissionId && job.ownerId === request.ownerId)) throw new Error("This upload is already in the queue. Use its existing upload controls.");
      const persistenceToken = Symbol(key);
      persisting.set(key, persistenceToken); notify();
      try {
        if (!request.skipPersist) await rememberResumableUpload({ ownerId: request.ownerId, kind: request.kind, scopeId: request.scopeId, endpoint: request.endpoint, title: request.title, totalFiles: request.totalFiles, clientSubmissionId: request.clientSubmissionId, details: request.details, files: request.files, uploadedFiles: 0 }, request.media, request.draftSnapshot, { signal: request.signal, isCurrent: current });
        else {
          const saved = await getResumableUpload(request.ownerId, request.kind, request.scopeId, request.clientSubmissionId, { signal: request.signal, isCurrent: current });
          if (!saved || saved.needsForm || JSON.stringify(saved.details) !== JSON.stringify(request.details) || JSON.stringify(saved.files) !== JSON.stringify(request.files)) throw new UploadPersistenceError("The original saved upload could not be verified. Review it before retrying.");
        }
        if (!current()) throw new AuthSessionChangedError();
        const job: Job = { ...request, id: `upload-${++sequence}`, session, generation: attemptGeneration, status: "queued", percent: 0, pauseRequested: false, finalizing: false };
        queue.push(job);
        // Give callers the id before a fast transport can report its session.
        setTimeout(startNext, 0);
        return job.id;
      } finally { if (persisting.get(key) === persistenceToken) persisting.delete(key); notify(); }
    },
    noteSession(jobId: string, sessionId: string) {
      const job = findJob(jobId); if (!job || !sessionId || !belongs(job)) return;
      void attachResumableSession(job.ownerId, job.kind, job.scopeId, sessionId, job.clientSubmissionId, { isCurrent: () => belongs(job) }).catch(() => undefined);
    },
    pause(jobId: string) {
      const job = findJob(jobId); if (!job || !belongs(job) || !canPause(job)) return;
      if (job.status === "queued") { hold(job, "paused", PAUSED_MESSAGE); return; }
      job.pauseRequested = true; job.controller?.abort(); notify();
    },
    isForegroundRequired: (kind: FormDraftKind, scopeId?: string) => (!ownerSession || isAuthSessionCurrent(ownerSession)) && foreground.has(draftKeyFor(kind, scopeId)),
    markForegroundReview(kind: FormDraftKind, scopeId?: string) { foreground.add(draftKeyFor(kind, scopeId)); notify(); },
    clearForegroundRequirement(kind: FormDraftKind, scopeId?: string) { foreground.delete(draftKeyFor(kind, scopeId)); },
    resume(jobId: string) {
      const job = findJob(jobId);
      if (!job || !belongs(job) || !["paused", "attention"].includes(job.status) || foreground.has(draftKeyFor(job.kind, job.scopeId))) return;
      held = held.filter((item) => item !== job);
      Object.assign(job, { status: "queued", message: undefined, pauseRequested: false, percent: 0, skipPersist: true });
      queue.push(job); startNext();
    },
    stop(jobId: string) {
      const job = findJob(jobId); if (!job || !belongs(job)) return;
      notice(job, "attention", STOPPED_MESSAGE); hold(job, "paused", STOPPED_MESSAGE);
    },
    dismissNotice(id: string) { notices = notices.filter((item) => item.id !== id); notify(); },
    entryForDraft,
    isDraftBusy(kind: FormDraftKind, scopeId?: string) { const entry = entryForDraft(kind, scopeId); return Boolean(entry && ["queued", "uploading"].includes(entry.status)); },
    resetForTests() { clear(null); sequence = 0; snapshot = EMPTY; },
  };
}
export type BackgroundUploadManager = ReturnType<typeof createBackgroundUploadManager>;
export const backgroundUploads = createBackgroundUploadManager();
