import type { OfflineReportDraft } from './autoSaveService';
import { allowsCloudDraft } from './offlineDraftPolicy';
import {
  getErrorStatus,
  getServerErrorMessage,
  isNetworkTransportError,
  isRetryableRequestError,
} from './connectivityService';

export type DraftCloudSyncErrorKind =
  | 'network'
  | 'transient_server'
  | 'auth'
  | 'validation'
  | 'unknown';

export type DraftCloudSyncFailure = {
  kind: DraftCloudSyncErrorKind;
  message: string;
  retryable: boolean;
  attempts: number;
  retryAt?: number;
  lastAttemptAt: string;
};

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

const recoverableMessage = (kind: DraftCloudSyncErrorKind) =>
  kind === 'network'
    ? 'The upload connection was interrupted. This draft remains safe and will retry automatically.'
    : 'The server is temporarily unavailable. This draft remains safe and will retry automatically.';

/**
 * Converts transport details into stable, user-facing draft state. The backoff
 * is persisted with the draft so screen refreshes and app restarts cannot
 * hammer a temporarily unavailable server.
 */
export function classifyDraftCloudSyncError(
  error: any,
  previousAttempts = 0,
  now = Date.now()
): DraftCloudSyncFailure {
  const status = getErrorStatus(error);
  const attempts = Math.max(0, previousAttempts) + 1;
  const lastAttemptAt = new Date(now).toISOString();

  if (isRetryableRequestError(error)) {
    const kind: DraftCloudSyncErrorKind = isNetworkTransportError(error)
      ? 'network'
      : 'transient_server';
    const retryDelay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 4));
    return {
      kind,
      message: recoverableMessage(kind),
      retryable: true,
      attempts,
      retryAt: now + retryDelay,
      lastAttemptAt,
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: 'Your session has expired. Sign in again to continue syncing this draft.',
      retryable: false,
      attempts,
      lastAttemptAt,
    };
  }

  if (status && status >= 400 && status < 500) {
    return {
      kind: 'validation',
      message:
        getServerErrorMessage(error) ||
        'This draft needs attention before it can be saved to the cloud.',
      retryable: false,
      attempts,
      lastAttemptAt,
    };
  }

  return {
    kind: 'unknown',
    message: getServerErrorMessage(error) || 'This draft could not be saved to the cloud.',
    retryable: false,
    attempts,
    lastAttemptAt,
  };
}

export function isRecoverableDraftCloudError(draft: OfflineReportDraft): boolean {
  if (draft.cloudSyncErrorKind === 'network' || draft.cloudSyncErrorKind === 'transient_server') {
    return true;
  }

  // Older app versions stored only the raw Axios message. Treat those records
  // as recoverable once so they are upgraded to the structured state.
  return /status code (408|425|429|500|502|503|504|522|524)|network error|network request failed|failed to fetch|timeout/i.test(
    String(draft.cloudSyncError || '')
  );
}

/**
 * Whether a cloud copy of this draft is worth making (2026-10-11 phone test).
 * A draft with no photos or video -- a form closed after typing a contract
 * number -- was copied to the cloud as an empty second draft of that contract.
 * It is copied once it has a photo or video. A draft already copied keeps its
 * cloud copy current whatever it holds.
 */
export function hasCloudDraftContent(draft: Pick<OfflineReportDraft, 'lots' | 'cloudId' | 'cloudSyncedAt'>): boolean {
  if (draft.cloudId || draft.cloudSyncedAt) return true;
  return (draft.lots || []).some((lot) =>
    (lot.mainImages?.length || 0) + (lot.extraImages?.length || 0) + (lot.videoFiles?.length || 0) > 0);
}

export function canAttemptDraftCloudSync(
  draft: OfflineReportDraft,
  options: { force?: boolean; now?: number } = {}
): boolean {
  // Explicit offline capture never permits photo/cloud draft sync, including Force sync.
  if (!allowsCloudDraft(draft)) return false;
  // Nothing captured yet, including Force sync: no empty cloud copies.
  if (!hasCloudDraftContent(draft)) return false;
  if (options.force) return true;
  if (!draft.cloudSyncError) return true;
  if (!isRecoverableDraftCloudError(draft)) return false;
  return !draft.cloudSyncRetryAt || draft.cloudSyncRetryAt <= (options.now ?? Date.now());
}

export function getDraftCloudSyncMessage(draft: OfflineReportDraft): string | undefined {
  if (!draft.cloudSyncError) return undefined;
  if (isRecoverableDraftCloudError(draft)) {
    const kind = draft.cloudSyncErrorKind === 'network' ? 'network' : 'transient_server';
    return recoverableMessage(kind);
  }
  return draft.cloudSyncError;
}
