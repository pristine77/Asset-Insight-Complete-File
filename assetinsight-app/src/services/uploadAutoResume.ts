/**
 * Automatic resume of an interrupted upload (2026-10-02).
 *
 * Every interrupted upload used to wait for the person to tap Resume upload,
 * even when the app itself had stopped it because the signal dropped or a
 * transfer stalled. On weak coverage that meant watching the phone and tapping
 * again after each drop. Now an open report continues by itself once the
 * connection is back.
 *
 * The rules:
 *   - Only an upload the app stopped by itself resumes on its own: a lost
 *     connection, a stalled transfer, a transient network or server error, or
 *     a Submit that found no connection. A Pause the person tapped, an account
 *     change and anything that needs a decision are left as they are.
 *   - Only while the report stays open. A closed form, a restarted app or a
 *     draft reopened from Drafts keep the explicit Resume upload button.
 *   - The connection must hold for AUTO_RESUME_STABLE_SIGNAL_MS and our own
 *     server must answer first, so a flickering signal does not start and stop
 *     the upload over and over.
 *   - After AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS automatic tries in a row that
 *     store no new file, it stops and leaves the Resume upload button.
 *
 * Resuming is the same action as tapping Resume upload: the same submission and
 * upload session, files already stored are skipped, and the server refuses a
 * second report for the same submission. The form side of this lives in
 * components/forms/useUploadAutoResume.ts.
 */
import NetInfo from '@react-native-community/netinfo';
import { isRetryableRequestError } from './connectivityService';
import { isUploadStalled } from './uploadCancellation';

/** How long the signal must stay up before an automatic resume. */
export const AUTO_RESUME_STABLE_SIGNAL_MS = 15_000;
/** Longest wait between server checks while the phone is connected but our server does not answer. */
export const AUTO_RESUME_MAX_RECHECK_MS = 60_000;
/** Automatic tries in a row that store no new file before handing back to the person. */
export const AUTO_RESUME_MAX_TRIES_WITHOUT_PROGRESS = 3;
/** Error code for a Submit that found no connection; an open report then waits for one. */
export const UPLOAD_WAITING_FOR_CONNECTION = 'UPLOAD_WAITING_FOR_CONNECTION';

/**
 * Whether an upload failure was the app stopping by itself, which an open
 * report may resume once the connection is back. The caller still rules out a
 * Pause the person tapped and an account change, which it knows directly.
 */
export function isAutoResumableUploadFailure(error: any): boolean {
  if (!error) return false;
  if (error.pauseReason === 'connection') return true;
  if (error.code === UPLOAD_WAITING_FOR_CONNECTION) return true;
  // Any other pause was asked for: the Pause button, Offline mode, a sign-out.
  if (String(error.code || '').toUpperCase() === 'ERR_CANCELED' && !error.request) return false;
  return isUploadStalled(error) || isRetryableRequestError(error);
}

type NetworkState = { isConnected?: boolean | null };
/** The part of NetInfo this module uses; tests pass their own. */
export type NetworkWatcher = {
  fetch(): Promise<NetworkState>;
  addEventListener(listener: (state: NetworkState) => void): () => void;
};

/**
 * Resolves true once the phone has been connected for stableMs without a drop
 * and checkServer() answers, or false as soon as the signal is aborted. While
 * the phone is connected but our server does not answer (weak signal, a Wi-Fi
 * sign-in page), it checks again after a wait that doubles up to maxRecheckMs.
 * Only an actual disconnect counts as a drop: NetInfo's own reachability probe
 * reads false on weak but working signal (see offlineQueueService.ts).
 */
export async function waitForStableConnection(options: {
  signal: AbortSignal;
  checkServer: () => Promise<boolean>;
  network?: NetworkWatcher;
  stableMs?: number;
  maxRecheckMs?: number;
}): Promise<boolean> {
  const { signal, checkServer } = options;
  const network = options.network ?? (NetInfo as unknown as NetworkWatcher);
  const stableMs = options.stableMs ?? AUTO_RESUME_STABLE_SIGNAL_MS;
  const maxRecheckMs = options.maxRecheckMs ?? AUTO_RESUME_MAX_RECHECK_MS;
  let recheckMs = stableMs;
  while (!signal.aborted) {
    if (!(await untilConnected(network, signal))) return false;
    const steady = await holdsConnection(network, signal, stableMs);
    if (signal.aborted) return false;
    if (!steady) continue;
    let answered = false;
    try { answered = await checkServer(); } catch { answered = false; }
    if (signal.aborted) return false;
    if (answered) return true;
    if (!(await pause(signal, recheckMs))) return false;
    recheckMs = Math.min(maxRecheckMs, recheckMs * 2);
  }
  return false;
}

/** Settles once; runs cleanup and stops listening for abort. */
function settleOnce(signal: AbortSignal, resolve: (value: boolean) => void) {
  let settled = false;
  const cleanups: Array<() => void> = [];
  const finish = (value: boolean) => {
    if (settled) return;
    settled = true;
    for (const cleanup of cleanups) { try { cleanup(); } catch { /* best effort */ } }
    resolve(value);
  };
  const onAbort = () => finish(false);
  signal.addEventListener('abort', onAbort);
  cleanups.push(() => signal.removeEventListener('abort', onAbort));
  return {
    finish,
    isSettled: () => settled,
    onCleanup(cleanup: () => void) {
      // A listener may call back during subscription, before its unsubscribe exists.
      if (settled) { try { cleanup(); } catch { /* best effort */ } } else cleanups.push(cleanup);
    },
  };
}

/** Resolves true when the phone reports a connection, false on abort. */
function untilConnected(network: NetworkWatcher, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const wait = settleOnce(signal, resolve);
    const onState = (state: NetworkState | undefined) => {
      if (state?.isConnected !== false) wait.finish(true);
    };
    wait.onCleanup(network.addEventListener(onState));
    // The listener may only fire on a change; read the current state as well.
    network.fetch().then(onState, () => undefined);
  });
}

/** Resolves true if no disconnect is reported for ms, false on a drop or abort. */
function holdsConnection(network: NetworkWatcher, signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const wait = settleOnce(signal, resolve);
    const timer = setTimeout(() => wait.finish(true), ms);
    wait.onCleanup(() => clearTimeout(timer));
    wait.onCleanup(network.addEventListener((state) => {
      if (state?.isConnected === false) wait.finish(false);
    }));
  });
}

/** Resolves true after ms, false on abort. */
function pause(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const wait = settleOnce(signal, resolve);
    const timer = setTimeout(() => wait.finish(true), ms);
    wait.onCleanup(() => clearTimeout(timer));
  });
}

