import { AppState, AppStateStatus } from 'react-native';
import AutoSaveService, { OfflineReportDraft } from './autoSaveService';
import OfflineQueueService from './offlineQueueService';
import reportDraftService, { ReportDraft } from './reportDraftService';
import OfflineCaptureStore from './offlineCaptureStore';
import {
  canAttemptDraftCloudSync,
  classifyDraftCloudSyncError,
  DraftCloudSyncFailure,
} from './draftCloudSyncState';

let didInit = false;
let syncing = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
const inFlightDrafts = new Map<string, Promise<DraftCloudSyncResult>>();

export type DraftCloudSyncResult =
  | { status: 'synced'; cloud: ReportDraft }
  | { status: 'failed'; failure: DraftCloudSyncFailure }
  | { status: 'skipped' };

const isCloudClean = (draft: OfflineReportDraft) => {
  if (!draft.cloudSyncedAt) return false;
  return new Date(draft.cloudSyncedAt).getTime() >= new Date(draft.updatedAt).getTime();
};

async function syncDraft(
  draft: OfflineReportDraft,
  options: { force?: boolean } = {}
): Promise<DraftCloudSyncResult> {
  if (!canAttemptDraftCloudSync(draft, options)) return { status: 'skipped' };
  if (!draft.ownerId || draft.ownerId !== OfflineCaptureStore.getOwnerId()) return { status: 'skipped' };
  const ownerId = draft.ownerId;
  const updatedAt = draft.updatedAt;
  const localRevision = draft.localRevision;
  const key = `${ownerId}:${draft.id}`;

  const active = inFlightDrafts.get(key);
  if (active) return active;

  const operation = (async (): Promise<DraftCloudSyncResult> => {
    try {
      const cloud = await reportDraftService.upsertFromLocalDraft(draft);
      if (ownerId !== OfflineCaptureStore.getOwnerId()) return { status: 'skipped' };
      await AutoSaveService.markDraftCloudSynced(
        draft.id,
        cloud.id || cloud._id || '',
        updatedAt,
        ownerId,
        localRevision
      );
      return { status: 'synced', cloud };
    } catch (error: any) {
      if (ownerId !== OfflineCaptureStore.getOwnerId()) return { status: 'skipped' };
      const failure = classifyDraftCloudSyncError(error, draft.cloudSyncAttempts || 0);
      await AutoSaveService.markDraftCloudSyncError(draft.id, failure.message, {
        kind: failure.kind,
        retryAt: failure.retryAt,
        attempts: failure.attempts,
        lastAttemptAt: failure.lastAttemptAt,
        expectedUpdatedAt: updatedAt,
        expectedOwnerId: ownerId,
        expectedLocalRevision: localRevision,
      });
      return { status: 'failed', failure };
    }
  })();

  inFlightDrafts.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlightDrafts.get(key) === operation) {
      inFlightDrafts.delete(key);
    }
  }
}

async function syncOnce(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    if (!didInit || AppState.currentState !== 'active' || !(await OfflineQueueService.isOnline())) return;
    const summaries = await OfflineCaptureStore.listSummaries();
    for (const summary of summaries) {
      if (!didInit) return;
      if (summary.captureMode === 'offline' || summary.manualSubmissionRequired) continue;
      const draft = await AutoSaveService.getDraft(summary.id);
      if (!draft) continue;
      if (!isCloudClean(draft)) {
        await syncDraft(draft);
      }
    }
  } finally {
    syncing = false;
  }
}

function onAppStateChange(next: AppStateStatus) {
  if (next === 'active') {
    void syncOnce();
  }
}

const DraftSyncService = {
  init(): void {
    if (didInit) return;
    didInit = true;
    void syncOnce();
    syncInterval = setInterval(() => {
      void syncOnce();
    }, 30000);
    appStateSub = AppState.addEventListener('change', onAppStateChange);
  },

  cleanup(): void {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = null;
    appStateSub?.remove();
    appStateSub = null;
    didInit = false;
  },

  syncOnce,
  syncDraft,
};

export default DraftSyncService;
