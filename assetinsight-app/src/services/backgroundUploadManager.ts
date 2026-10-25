/**
 * Shared status for the Android durable transfer scheduler and the in-app
 * upload line. Android owns temporary system/network recovery for its
 * explicitly submitted immutable jobs.
 *
 * Waiting for signal (owner decision 2026-10-11, restoring the 2026-10-02
 * behaviour that the 6 October sync had removed): a report the person
 * submitted, which the app stopped by itself -- no connection at Submit, a lost
 * connection, a stalled transfer, a transient network or server error -- keeps
 * its turn and continues by itself once the signal has been steady for
 * AUTO_RESUME_STABLE_SIGNAL_MS and our own server answers (uploadAutoResume.ts).
 * "Resume now" in the bar tries at once. After
 * AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS automatic tries in a row that store no
 * new file, the upload is paused and a notice says so.
 *
 * On Android builds with the durable scheduler, an ordinary Submit that finds no
 * connection waits here too (the forms decide; see handleSubmit there): its
 * upload function reserves the upload and hands it to Android, and the line
 * lets go once Android has it (response.backgroundStaged).
 *
 * Still explicit: a Pause the person tapped, the Offline capture mode (it holds
 * every upload, including one waiting for signal), an account change, anything
 * that needs a decision, and every upload after the app restarts -- the line is
 * in memory, so a restarted app shows Resume upload on the saved draft.
 */
import type { OfflineDraftType, OfflineReportDraft } from './autoSaveService';
import { assertReportUploadAccepted, isExistingReportUploadReceipt } from './reportUploadReceipt';
import type { DirectUploadProgressCallback, DirectUploadProgressStage } from './directR2UploadService';
import {
  cancellableUploadTask,
  createUploadOperation,
  isUploadStalled,
  onUploadOwnerChange,
  onUploadsPaused,
  pauseUploadOperation,
  type UploadOperation,
  type UploadPauseReason,
} from './uploadCancellation';
import { isUploadManifestConflict } from '../components/forms/uploadManifestRecovery';
import durableReportTransfer from './durableReportTransfer';

/*
 * The upload stack is required when it is first used, not imported at the top.
 * The upload bar and the Drafts lists import this module only to read the line;
 * they must not load native storage and network modules for that (their tests
 * run without them, and a status line has no use for the upload stack).
 * require() is synchronous and cached by the bundler, so each call is cheap.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate lazy loading, see above */
const captureStore = (): typeof import('./offlineCaptureStore').default => require('./offlineCaptureStore').default;
const queueService = (): typeof import('./offlineQueueService').default => require('./offlineQueueService').default;
const autoSave = (): typeof import('./autoSaveService').default => require('./autoSaveService').default;
const submission = (): typeof import('./offlineSubmissionService') => require('./offlineSubmissionService');
const resumePolicy = (): typeof import('./uploadResumePolicy') => require('./uploadResumePolicy');
const autoResume = (): typeof import('./uploadAutoResume') => require('./uploadAutoResume');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Shown where a busy draft cannot be opened (the forms' draft loading). */
export const BACKGROUND_UPLOAD_BUSY_MESSAGE =
  'This report is uploading in the background. Open it again when the upload finishes or after pausing it.';
/** Shown when Submit finds this draft already in the background line. */
export const ALREADY_UPLOADING_TITLE = 'Already uploading';
export const ALREADY_UPLOADING_MESSAGE =
  'This report is already uploading in the background. The upload bar on the main screen shows its progress.';
// The forms' own wording, so one outcome reads the same wherever it appears.
export const EARLIER_UPLOAD_ACCEPTED_TITLE = 'Earlier upload accepted';
export const EARLIER_UPLOAD_ACCEPTED_MESSAGE =
  'The server returned the earlier report, not confirmation of your current edits. This draft and its originals are kept. Open Reports or Previews to review the earlier report before making further changes.';
export const ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE =
  'The server accepted this report. Open Previews to check its progress; local confirmation could not be refreshed.';
export const CONNECTION_KEPT_DROPPING_MESSAGE =
  'The connection kept dropping before any more photos were sent. Your draft is saved. Tap Resume when the signal is steady.';
export const KEPT_INTERRUPTED_MESSAGE =
  'The upload kept being interrupted before any more photos were sent. Your draft is saved. Tap Resume to try again.';
export const SENT_MESSAGE = 'Processing continues on the server. You will receive an email when the files are ready.';
export const PAUSED_MESSAGE =
  'Upload paused. Your draft is saved. Resume this same upload to check whether the server already accepted it.';
const NO_CONNECTION_MESSAGE = 'No connection. Your draft is saved, and the upload continues by itself once the signal is back.';
/** The forms' note when Submit found no connection and handed the report to this line to wait. */
export const WAITING_FOR_SIGNAL_TITLE = 'Waiting for signal';
export const WAITING_FOR_SIGNAL_MESSAGE =
  'No signal right now. Your report is saved on this phone and sends by itself once the signal is steady. The upload bar shows it. If Asset Insight is closed before then, open Drafts and tap Resume upload.';
/** Notices kept for the bar; older ones fall off. */
const MAX_NOTICES = 10;
const LOCAL_STATE_TIMEOUT_MS = 30_000;

export type BackgroundUploadStatus = 'queued' | 'uploading' | 'waiting' | 'paused' | 'attention';

/** What a form hands over: everything one attempt needs, frozen at Submit. */
export type BackgroundUploadRequest = {
  draftId: string;
  type: OfflineDraftType;
  ownerId: string;
  /** Contract number or report name, for the bar and its notices. */
  title: string;
  totalFiles: number;
  /** The draft as saved at Submit; prepareOfflineSubmission() re-reads and re-checks it each attempt. */
  draft: OfflineReportDraft;
  /** Calls the form's own service with the form's details and lots, passing operation through. */
  upload: (onProgress: DirectUploadProgressCallback, operation: UploadOperation) => Promise<unknown>;
};

export type BackgroundUploadEntry = {
  /** Android owns this immutable transfer even when JavaScript is stopped. */
  durable?: boolean;
  id: string;
  draftId: string;
  type: OfflineDraftType;
  title: string;
  status: BackgroundUploadStatus;
  stage?: DirectUploadProgressStage;
  percent: number;
  completedFiles: number;
  totalFiles: number;
  /** Pause was tapped and the transfer is stopping. */
  pausing: boolean;
  /** Whether Pause may be offered; false while the submission is being finalized. */
  canPause: boolean;
  /** False when there is nothing left to send (the server accepted it); Resume is then not offered. */
  canResume?: boolean;
  message?: string;
};

export type BackgroundUploadNotice = {
  id: string;
  kind: 'sent' | 'attention';
  jobId: string;
  draftId: string;
  type: OfflineDraftType;
  title: string;
  heading: string;
  message: string;
  reportId?: string;
  /** False when there is nothing left to send (the server accepted it); Resume is then not offered. */
  canResume?: boolean;
  /**
   * Only an ordinary "Sent" goes away by itself. An acceptance this phone could
   * not record stays until dismissed: the draft still shows Resume upload, and
   * the message says the report is accepted all the same.
   */
  autoDismiss: boolean;
};

export type BackgroundUploadSnapshot = {
  active: BackgroundUploadEntry | null;
  queued: BackgroundUploadEntry[];
  /** Paused and needs-attention uploads, oldest first. */
  held: BackgroundUploadEntry[];
  notices: BackgroundUploadNotice[];
};

export type BackgroundUploadAccepted = { draftId: string; type: OfflineDraftType; reportId?: string };

type Job = BackgroundUploadRequest & {
  id: string;
  status: BackgroundUploadStatus;
  stage?: DirectUploadProgressStage;
  percent: number;
  completedFiles: number;
  message?: string;
  /** Set by the bar's Pause before the operation is cancelled, so the failure reads as a pause. */
  pauseRequested: boolean;
  operation?: UploadOperation;
  watcher?: AbortController;
  // The no-progress streak, counted exactly like useUploadAutoResume.
  triesWithoutProgress: number;
  bestConfirmed: number;
  attemptConfirmed: number;
};

const errorMessage = (error: unknown): string | undefined => {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
};
const isPausedError = (error: unknown) => String((error as any)?.code || '').toUpperCase() === 'ERR_CANCELED';
const isActiveReportConflict = (error: any) =>
  error?.response?.status === 409 && error?.response?.data?.code === 'ACTIVE_REPORT_EXISTS';

/** Short status for a Drafts card: "Uploading 45 of 160", "Waiting in line" and so on. */
export function describeBackgroundUpload(entry: BackgroundUploadEntry): string {
  if (entry.status === 'queued') return 'Waiting in line';
  if (entry.status === 'waiting') return entry.durable ? 'Waiting to continue' : 'Waiting for signal';
  if (entry.status === 'paused') return 'Paused';
  if (entry.status === 'attention') return 'Needs attention';
  if (entry.pausing) return 'Pausing';
  if (entry.stage === 'finalizing' || entry.stage === 'complete') return 'Finalizing';
  return `Uploading ${entry.completedFiles} of ${entry.totalFiles}`;
}

export function createBackgroundUploadManager() {
  // Bumped when the line is emptied (owner change, test reset): work started
  // before that never writes or notifies again.
  let generation = 0;
  let sequence = 0;
  let active: Job | null = null;
  let queue: Job[] = [];
  let held: Job[] = [];
  let notices: BackgroundUploadNotice[] = [];
  // Drafts whose next Submit or Resume must run in the form, where its prompts can appear.
  const foreground = new Set<string>();
  const listeners = new Set<() => void>();
  const acceptedListeners = new Set<(event: BackgroundUploadAccepted) => void>();
  let snapshot: BackgroundUploadSnapshot = { active: null, queued: [], held: [], notices: [] };
  let unwatchOwner: (() => void) | null = null;
  let unwatchPause: (() => void) | null = null;

  const canPause = (job: Job) => {
    if (job.status === 'queued' || job.status === 'waiting') return true;
    if (job.status !== 'uploading' || job.pauseRequested) return false;
    return job.stage !== 'finalizing' && job.stage !== 'complete';
  };
  const toEntry = (job: Job): BackgroundUploadEntry => ({
    id: job.id,
    draftId: job.draftId,
    type: job.type,
    title: job.title,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    completedFiles: job.completedFiles,
    totalFiles: job.totalFiles,
    pausing: job.status === 'uploading' && job.pauseRequested,
    canPause: canPause(job),
    message: job.message,
  });

  /** Publishes a new snapshot (useSyncExternalStore needs a new object per change). */
  function notify() {
    const durable = durableReportTransfer.getSnapshot();
    snapshot = {
      active: durable.active || (active ? toEntry(active) : null),
      queued: [...durable.queued, ...queue.map(toEntry)],
      held: [...durable.held, ...held.map(toEntry)],
      notices: [...notices, ...durable.notices],
    };
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch { /* A faulty view must not stop the line. */ }
    }
  }

  function addNotice(
    job: Job,
    kind: BackgroundUploadNotice['kind'],
    heading: string,
    message: string,
    extra: { reportId?: string; autoDismiss?: boolean } = {},
  ) {
    const notice: BackgroundUploadNotice = {
      id: `notice-${++sequence}`, kind, jobId: job.id, draftId: job.draftId, type: job.type,
      title: job.title, heading, message, reportId: extra.reportId, autoDismiss: extra.autoDismiss === true,
    };
    // One attention notice per draft: the newest replaces the older one.
    notices = [...notices.filter((item) => !(item.kind === 'attention' && item.draftId === job.draftId)), notice]
      .slice(-MAX_NOTICES);
  }

  /** Records the draft as paused; a storage failure must not stop the line. */
  function recordPaused(job: Job, message: string | undefined) {
    const expectedGeneration = generation;
    return Promise.resolve()
      .then(() => {
        if (generation !== expectedGeneration || captureStore().getOwnerId() !== job.ownerId) return;
        return captureStore().setSubmissionState(job.draftId, 'paused', undefined, message);
      })
      .catch(() => undefined);
  }

  function holdQueuedUploads() {
    const pending = queue;
    queue = [];
    for (const job of pending) {
      Object.assign(job, { status: 'paused', message: PAUSED_MESSAGE, pauseRequested: false });
      held.push(job);
      void recordPaused(job, PAUSED_MESSAGE);
    }
    if (pending.length) notify();
  }

  /**
   * Every upload of this account was paused (uploadCancellation.ts). A lost
   * connection ('connection') only stops the running transfer: it then waits
   * for signal and the rest of the line keeps its place. Any other reason --
   * the Offline capture mode, sign-out -- holds the whole line, including an
   * upload waiting for signal, until the person resumes it.
   */
  function onGlobalPause(reason?: UploadPauseReason) {
    if (reason === 'connection') return;
    // A network rejection can win before this pause is observed by transport.
    // Revoke the attempt as well as an already registered waiter, so its late
    // catch cannot re-arm a job after Offline/logout. Accepted receipts still
    // follow the existing protected reconciliation path.
    if (active) active.pauseRequested = true;
    const waiting = active && active.status === 'waiting' ? active : null;
    // The line first: hold() below starts the next upload in line, and there
    // must be none left to start.
    holdQueuedUploads();
    if (waiting) {
      hold(waiting, 'paused', PAUSED_MESSAGE);
      void recordPaused(waiting, PAUSED_MESSAGE);
    }
  }

  /** Starts the next upload in line when none is running, then tells the views. */
  function startNext() {
    if (!active) {
      const next = queue.shift();
      if (next) {
        active = next;
        // Its first synchronous step publishes the snapshot.
        void runAttempt(next, false);
        return;
      }
    }
    notify();
  }

  /** Takes a job out of the running slot or the line and keeps it as paused or needing attention. */
  function hold(job: Job, status: 'paused' | 'attention', message?: string) {
    job.watcher?.abort();
    Object.assign(job, { status, message, pauseRequested: false, operation: undefined, watcher: undefined });
    if (active === job) active = null;
    queue = queue.filter((item) => item !== job);
    held = [...held.filter((item) => item !== job), job];
    startNext();
  }

  /** Forgets a job without writing anything: its account is no longer signed in. */
  function drop(job: Job) {
    job.watcher?.abort();
    if (active === job) active = null;
    queue = queue.filter((item) => item !== job);
    startNext();
  }

  /**
   * The server accepted the upload; it leaves the line for good. recorded is
   * false when this phone could not record the acceptance: that notice stays
   * until dismissed, and the draft is never uploaded again from here.
   */
  function finishSent(job: Job, recorded: boolean, reportId?: string) {
    addNotice(job, 'sent', recorded ? 'Sent' : 'Upload accepted', recorded ? SENT_MESSAGE : ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE,
      { reportId, autoDismiss: recorded });
    if (active === job) active = null;
    const event: BackgroundUploadAccepted = { draftId: job.draftId, type: job.type, reportId };
    for (const listener of Array.from(acceptedListeners)) {
      try { listener(event); } catch { /* The upload is accepted whatever a view does with the news. */ }
    }
    startNext();
  }

  /**
   * Android's durable scheduler took the upload (backgroundStaged): it leaves
   * this line, and the scheduler's own entry in the bar shows it from here.
   * Nothing is recorded as accepted yet -- durableReportTransfer.ts records the
   * acceptance when Android reports it.
   */
  function finishHandedOff(job: Job) {
    if (active === job) active = null;
    startNext();
  }

  /** Same count as useUploadAutoResume: false once the streak without a new file is used up. */
  function takeAutomaticTry(job: Job): boolean {
    if (job.attemptConfirmed > job.bestConfirmed) {
      job.bestConfirmed = job.attemptConfirmed;
      job.triesWithoutProgress = 0;
    }
    if (job.triesWithoutProgress >= autoResume().AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS) return false;
    job.triesWithoutProgress += 1;
    return true;
  }

  /** Waits for a steady connection, keeping this upload's turn, then tries again. */
  function waitForSignal(job: Job, current: () => boolean) {
    const watcher = new AbortController();
    Object.assign(job, { status: 'waiting', operation: undefined, watcher });
    notify();
    void Promise.resolve()
      .then(() => autoResume().waitForStableConnection({
        signal: watcher.signal,
        checkServer: async () => (await queueService().getConnectivityStatus()).status === 'online',
      }))
      .catch(() => false)
      .then((ready) => {
        if (job.watcher !== watcher || watcher.signal.aborted || !current()) return;
        job.watcher = undefined;
        if (ready) void runAttempt(job, true);
        else hold(job, 'paused', PAUSED_MESSAGE);
      });
  }

  async function runAttempt(job: Job, automatic: boolean): Promise<void> {
    const attemptGeneration = generation;
    const current = () => generation === attemptGeneration && active === job;
    // Signed out or switched account since this was queued: never upload or write for it.
    if (captureStore().getOwnerId() !== job.ownerId) { drop(job); return; }
    if (job.pauseRequested) {
      // Pause was tapped between two attempts (a prompt retry was pending).
      void recordPaused(job, PAUSED_MESSAGE);
      hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    if (!automatic) {
      // A person's Submit, Resume or Resume now starts a fresh count.
      job.triesWithoutProgress = 0;
      job.bestConfirmed = -1;
    }
    const operation = createUploadOperation();
    Object.assign(job, { status: 'uploading', stage: 'preparing', message: undefined, attemptConfirmed: 0, operation });
    notify();
    // Every step of the attempt stops waiting as soon as this upload is paused
    // or the account changes. The services already stop their transfers then;
    // this also covers the local checks (a storage read, the 6 s server check)
    // and any step that does not answer, so the bar never stays on "Pausing"
    // and the line is never held by one upload.
    const step = <T>(work: () => Promise<T>) => cancellableUploadTask(operation, () => work(), () => undefined);
    const localWrite = <T>(work: () => Promise<T>) => cancellableUploadTask(operation, () => work(), () => undefined, {
      idleTimeoutMs: LOCAL_STATE_TIMEOUT_MS,
      message: 'Saving upload status on this device took too long. Your originals are kept. Review the draft before resuming.',
    }).catch((error: unknown) => {
      // A stalled write on this phone is not a signal problem: the person
      // reviews the draft before resuming, so it never waits for signal.
      if (isUploadStalled(error)) Object.assign(error as object, { localStateStalled: true });
      throw error;
    });
    let acceptedReportId: string | undefined;
    let accepted = false;
    try {
      // Every attempt re-checks the saved draft: owner, missing originals, an
      // acceptance recorded since, an Incoming assignment that changed.
      await step(() => submission().prepareOfflineSubmission(job.draft));
      const connectivity = await step(() => queueService().getConnectivityStatus());
      if (connectivity.status === 'offline') {
        throw Object.assign(new Error(NO_CONNECTION_MESSAGE), { code: resumePolicy().UPLOAD_WAITING_FOR_CONNECTION });
      }
      // Persist intent before transport, so a killed app reopens as Resume upload.
      await localWrite(() => captureStore().setSubmissionState(job.draftId, 'ready'));
      operation.assertActive();
      const response: any = await step(() => job.upload((percent, detail) => {
        if (!current() || !operation.isActive()) return;
        job.percent = percent;
        if (detail) {
          job.stage = detail.stage;
          job.completedFiles = detail.completedFiles;
          if (detail.totalFiles) job.totalFiles = detail.totalFiles;
          // A resumed attempt counts the files it finds already stored, so only
          // new files raise this above the best so far.
          if (detail.completedFiles > job.attemptConfirmed) job.attemptConfirmed = detail.completedFiles;
        }
        notify();
      }, operation));
      if (response?.backgroundStaged === true) {
        // Reserved on the server and handed to Android, which continues it.
        if (current()) finishHandedOff(job);
        return;
      }
      assertReportUploadAccepted(response);
      accepted = true;
      acceptedReportId = typeof response.reportId === 'string' ? response.reportId : undefined;
      if (!current()) return;
      Object.assign(job, { stage: 'complete', percent: 100, completedFiles: job.totalFiles });
      notify();
      if (isExistingReportUploadReceipt(response)) {
        // The forms' rule: this receipt is the earlier report, not confirmation
        // of the current edits. The draft is left as it is for the person.
        foreground.add(job.draftId);
        addNotice(job, 'attention', EARLIER_UPLOAD_ACCEPTED_TITLE, EARLIER_UPLOAD_ACCEPTED_MESSAGE);
        hold(job, 'attention', EARLIER_UPLOAD_ACCEPTED_MESSAGE);
        return;
      }
      try {
        await localWrite(() => captureStore().setSubmissionState(job.draftId, 'accepted', acceptedReportId));
      } catch {
        // Accepted on the server: say so, and never upload this draft again from here.
        if (current()) finishSent(job, false, acceptedReportId);
        return;
      }
      if (!current()) return;
      // Default age limit, not the forms' 0 (2026-10-02): with 0 the cleanup
      // deletes every camera file no saved draft refers to yet, and the person
      // may be taking photos for the next report right now.
      void Promise.resolve().then(() => {
        if (generation !== attemptGeneration || captureStore().getOwnerId() !== job.ownerId) return;
        return autoSave().cleanupOrphanedMedia();
      }).catch(() => undefined);
      finishSent(job, true, acceptedReportId);
    } catch (error) {
      if (accepted) {
        if (current()) finishSent(job, false, acceptedReportId);
        return;
      }
      await handleFailure(job, error, current);
    }
  }

  async function handleFailure(job: Job, error: unknown, current: () => boolean) {
    if (!current()) return;
    // The account changed: nothing is written for the old account.
    if (captureStore().getOwnerId() !== job.ownerId) { drop(job); return; }

    // The attempt settles as soon as Pause cancels its operation (step() in
    // runAttempt), so a requested pause is what ended it.
    if (job.pauseRequested) {
      void recordPaused(job, errorMessage(error));
      if (current()) hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    // Decisions belong to the person, even when the status code looks transient.
    const conflict = isUploadManifestConflict(error) || isActiveReportConflict(error);
    const localStateStalled = Boolean((error as { localStateStalled?: boolean } | null)?.localStateStalled);
    if (!conflict && !localStateStalled && autoResume().isAutoResumableUploadFailure(error)) {
      // The app stopped it by itself (no connection, lost connection, stall,
      // transient network or server error): wait for signal, keeping its turn.
      // The draft is recorded as paused meanwhile, so a killed app reopens it
      // as Resume upload.
      void recordPaused(job, errorMessage(error));
      if (!current()) return;
      if (!takeAutomaticTry(job)) {
        addNotice(job, 'attention', 'Upload paused', CONNECTION_KEPT_DROPPING_MESSAGE);
        hold(job, 'paused', CONNECTION_KEPT_DROPPING_MESSAGE);
        return;
      }
      waitForSignal(job, current);
      return;
    }
    if (!conflict && (resumePolicy().isInterruptedUpload(error) || isPausedError(error))) {
      void recordPaused(job, errorMessage(error));
      if (!current()) return;
      // Any other global pause (the Offline capture mode, sign-out) must not
      // start queued jobs; onGlobalPause has usually held them already.
      if (isPausedError(error)) {
        holdQueuedUploads();
      }
      hold(job, 'paused', PAUSED_MESSAGE);
      return;
    }
    void recordPaused(job, errorMessage(error));
    if (!current()) return;
    const feedback = isUploadManifestConflict(error)
      ? {
          title: 'Upload needs checking',
          message: 'This upload needs your decision about the earlier upload of the same report. Open the draft and tap Resume upload to see the choices. Your draft and originals are kept.',
        }
      : isActiveReportConflict(error)
        ? {
            title: 'Report Already Processing',
            message: 'A report for this contract is already queued or processing. Open the draft and tap Resume upload to review it or create a separate report. Your draft and originals are kept.',
          }
        : queueService().getSubmissionError(error);
    // The next Submit or Resume of this draft runs in the form, where the
    // form's own prompt for this error appears.
    foreground.add(job.draftId);
    addNotice(job, 'attention', feedback.title, feedback.message);
    hold(job, 'attention', feedback.message);
  }

  /** Empties the line. Work already started stops and never writes again. */
  function clear() {
    generation += 1;
    const running = active;
    if (running) {
      running.watcher?.abort();
      if (running.operation?.isActive()) pauseUploadOperation(running.operation);
    }
    active = null;
    queue = [];
    held = [];
    notices = [];
    foreground.clear();
    notify();
  }

  const allJobs = () => [...(active ? [active] : []), ...queue, ...held];

  const manager = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot(): BackgroundUploadSnapshot {
      return snapshot;
    },
    /** Adds an upload to the end of the line. False when this draft is already queued or running. */
    enqueue(request: BackgroundUploadRequest): boolean {
      if (manager.isBusy(request.draftId)) return false;
      // Subscribed on first use, so importing this module has no side effects.
      if (!unwatchOwner) unwatchOwner = onUploadOwnerChange(() => clear());
      if (!unwatchPause) unwatchPause = onUploadsPaused(onGlobalPause);
      held = held.filter((job) => job.draftId !== request.draftId);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.draftId === request.draftId));
      const job: Job = {
        ...request,
        id: `background-upload-${++sequence}`,
        status: 'queued',
        percent: 0,
        completedFiles: 0,
        pauseRequested: false,
        triesWithoutProgress: 0,
        bestConfirmed: -1,
        attemptConfirmed: 0,
      };
      queue = [...queue, job];
      startNext();
      return true;
    },
    /** The bar's Pause. Refused while finalizing, when the server is accepting the report. */
    pause(jobId: string): boolean | Promise<void> {
      if (jobId.startsWith('durable:')) return durableReportTransfer.pause(jobId);
      const job = allJobs().find((item) => item.id === jobId);
      if (!job) return false;
      if (job.status === 'queued') {
        void recordPaused(job, PAUSED_MESSAGE);
        hold(job, 'paused', PAUSED_MESSAGE);
        return true;
      }
      if (job !== active) return false;
      if (job.status === 'waiting') {
        // The draft was already recorded as paused when the attempt failed.
        hold(job, 'paused', PAUSED_MESSAGE);
        return true;
      }
      if (job.status !== 'uploading' || job.pauseRequested) return false;
      if (job.stage === 'finalizing' || job.stage === 'complete') return false;
      job.pauseRequested = true;
      notify();
      // This upload only; the outcome arrives through the attempt's failure path.
      pauseUploadOperation(job.operation);
      return true;
    },
    /** Puts a paused upload back at the end of the line, as the person's own action. */
    resume(jobId: string): boolean | Promise<void> {
      if (jobId.startsWith('durable:')) return durableReportTransfer.resume(jobId);
      const job = held.find((item) => item.id === jobId);
      if (!job || job.status !== 'paused' || captureStore().getOwnerId() !== job.ownerId) return false;
      held = held.filter((item) => item !== job);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.jobId === job.id));
      Object.assign(job, { status: 'queued', message: undefined, pauseRequested: false });
      queue = [...queue, job];
      startNext();
      return true;
    },
    /** "Resume now" while waiting for signal: tries at once, as the person's own action. */
    resumeNow(): boolean {
      const job = active;
      if (!job || job.status !== 'waiting') return false;
      job.watcher?.abort();
      job.watcher = undefined;
      void runAttempt(job, false);
      return true;
    },
    dismiss(noticeId: string) {
      if (noticeId.startsWith('durable:')) { durableReportTransfer.dismiss(noticeId); return; }
      const before = notices.length;
      notices = notices.filter((notice) => notice.id !== noticeId);
      if (notices.length !== before) notify();
    },
    /**
     * Lets the form own a paused or needs-attention draft again (it is being
     * opened, discarded or restored from the cloud). Queued or running uploads
     * are not affected; check isBusy() first. The foreground mark stays, so
     * the form's next Submit still shows its prompts.
     */
    forget(draftId: string): boolean {
      const before = held.length + notices.length;
      held = held.filter((job) => job.draftId !== draftId);
      notices = notices.filter((notice) => !(notice.kind === 'attention' && notice.draftId === draftId));
      if (held.length + notices.length === before) return false;
      notify();
      return true;
    },
    /** Queued, uploading or waiting for signal: the draft must not be opened, discarded or overwritten. */
    isBusy(draftId: string): boolean {
      return durableReportTransfer.isBusy(draftId) || active?.draftId === draftId || queue.some((job) => job.draftId === draftId);
    },
    statusFor(draftId: string): BackgroundUploadEntry | undefined {
      const durable = durableReportTransfer.statusFor(draftId);
      if (durable) return durable;
      const job = allJobs().find((item) => item.draftId === draftId);
      return job ? toEntry(job) : undefined;
    },
    prefersForeground(draftId: string): boolean {
      return foreground.has(draftId);
    },
    /** Called when the foreground attempt that the mark asked for starts. */
    consumeForegroundMark(draftId: string) {
      foreground.delete(draftId);
    },
    /** Told when the server accepts an upload (the Dashboard refreshes its figures). */
    onAccepted(listener: (event: BackgroundUploadAccepted) => void): () => void {
      acceptedListeners.add(listener);
      return () => { acceptedListeners.delete(listener); };
    },
    /** Tests only: empties the line and its notices. */
    resetForTests() {
      clear();
      unwatchOwner?.(); unwatchOwner = null;
      unwatchPause?.(); unwatchPause = null;
      sequence = 0;
    },
  };
  durableReportTransfer.subscribe(notify);
  durableReportTransfer.onAccepted(event => {
    for (const listener of Array.from(acceptedListeners)) {
      try { listener(event); } catch { /* A status view cannot change server acceptance. */ }
    }
  });
  return manager;
}

export type BackgroundUploadManager = ReturnType<typeof createBackgroundUploadManager>;

const backgroundUploadManager = createBackgroundUploadManager();
export default backgroundUploadManager;
