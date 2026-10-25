import { useCallback, useEffect, useRef, useState } from 'react';
import { onUploadOwnerChange, onUploadsPaused } from '../../services/uploadCancellation';
import {
  AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS,
  isAutoResumableUploadFailure,
  waitForStableConnection,
} from '../../services/uploadAutoResume';

type PendingResume = {
  /** Repeats the interrupted Submit or Resume; automatic is false for "Resume now". */
  resume: (automatic: boolean) => void;
  /** False once the account or this form changed; nothing then resumes. */
  stillCurrent: () => boolean | Promise<boolean>;
};

/**
 * The form side of automatic resume (rules: services/uploadAutoResume.ts).
 *
 * After an attempt fails, the form asks scheduleAfterFailure() whether to wait.
 * If it may, the form shows "Waiting for signal" (waiting is true) and the
 * attempt is repeated once the connection is steady, as long as the report
 * stays open and the account is unchanged. "Resume now" repeats it at once;
 * Pause upload stops waiting and leaves the usual Resume upload button.
 */
export function useUploadAutoResume(visible: boolean, checkServer: () => Promise<boolean>) {
  const [waiting, setWaiting] = useState(false);
  const watcherRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingResume | null>(null);
  const intentActiveRef = useRef(false);
  // Automatic tries since files last moved forward or the person last acted.
  const triesWithoutProgressRef = useRef(0);
  // Most files confirmed by any attempt since the person last acted.
  const bestConfirmedRef = useRef(-1);
  // Most files confirmed by the current attempt. A resumed attempt counts the
  // files it finds already stored, so only new files raise it above the best.
  const attemptConfirmedRef = useRef(0);
  const checkServerRef = useRef(checkServer);
  checkServerRef.current = checkServer;

  const stop = useCallback(() => {
    intentActiveRef.current = false;
    watcherRef.current?.abort();
    watcherRef.current = null;
    pendingRef.current = null;
    setWaiting(false);
  }, []);

  // Check persisted draft authority before a retry, and keep the same waiter
  // alive across that asynchronous read so Pause/logout can still revoke it.
  const resumeIfCurrent = useCallback(async (pending: PendingResume, watcher: AbortController, automatic: boolean) => {
    let current = false;
    try { current = await pending.stillCurrent(); } catch { /* A failed read needs an explicit retry. */ }
    if (watcherRef.current !== watcher || watcher.signal.aborted) return;
    watcherRef.current = null;
    pendingRef.current = null;
    setWaiting(false);
    if (current) pending.resume(automatic);
  }, []);

  /** Call as each attempt starts. A person's Submit or Resume starts a fresh count. */
  const beginAttempt = useCallback((automatic: boolean) => {
    stop();
    intentActiveRef.current = true;
    attemptConfirmedRef.current = 0;
    if (!automatic) {
      triesWithoutProgressRef.current = 0;
      bestConfirmedRef.current = -1;
    }
  }, [stop]);

  /** Call with each progress report's count of files the server holds. */
  const noteProgress = useCallback((completedFiles?: number) => {
    if (typeof completedFiles === 'number' && completedFiles > attemptConfirmedRef.current) {
      attemptConfirmedRef.current = completedFiles;
    }
  }, []);

  /**
   * After a failed attempt: start waiting and return true, or return false so
   * the form shows its usual message and the Resume upload button.
   */
  const scheduleAfterFailure = useCallback((error: unknown, pending: PendingResume): boolean => {
    if (!intentActiveRef.current || !isAutoResumableUploadFailure(error)) return false;
    if (attemptConfirmedRef.current > bestConfirmedRef.current) {
      bestConfirmedRef.current = attemptConfirmedRef.current;
      triesWithoutProgressRef.current = 0;
    }
    if (triesWithoutProgressRef.current >= AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS) return false;
    triesWithoutProgressRef.current += 1;
    watcherRef.current?.abort();
    const watcher = new AbortController();
    watcherRef.current = watcher;
    pendingRef.current = pending;
    setWaiting(true);
    void Promise.resolve()
      .then(() => waitForStableConnection({ signal: watcher.signal, checkServer: () => checkServerRef.current() }))
      .catch(() => false)
      .then((ready) => {
        if (watcherRef.current !== watcher || watcher.signal.aborted) return;
        if (ready) void resumeIfCurrent(pending, watcher, true);
        else stop();
      });
    return true;
  }, [resumeIfCurrent, stop]);

  /** "Resume now": stop waiting and repeat the attempt at once, as the person's own action. */
  const resumeNow = useCallback(() => {
    const pending = pendingRef.current;
    stop();
    if (pending) {
      intentActiveRef.current = true;
      const watcher = new AbortController();
      watcherRef.current = watcher;
      pendingRef.current = pending;
      void resumeIfCurrent(pending, watcher, false);
    }
  }, [resumeIfCurrent, stop]);

  useEffect(() => onUploadsPaused(reason => { if (reason !== 'connection') stop(); }), [stop]);
  useEffect(() => onUploadOwnerChange(() => stop()), [stop]);

  // A closed form never resumes; reopening it shows Resume upload as before.
  useEffect(() => { if (!visible) stop(); }, [visible, stop]);
  useEffect(() => () => {
    intentActiveRef.current = false;
    watcherRef.current?.abort();
    watcherRef.current = null;
    pendingRef.current = null;
  }, []);

  return { waiting, beginAttempt, noteProgress, scheduleAfterFailure, resumeNow, stop };
}

