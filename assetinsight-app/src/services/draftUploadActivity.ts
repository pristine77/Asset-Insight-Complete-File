import type { OfflineReportDraft } from './autoSaveService';
import { getErrorStatus, isNetworkTransportError } from './connectivityService';
import type { DraftReceiptCounts, DraftUploadReason } from './draftUploadJournal';
import OfflineCaptureStore from './offlineCaptureStore';
import { isUploadStalled } from './uploadCancellation';

export function draftUploadReason(error: any): DraftUploadReason {
  if (error?.code === 'ERR_CANCELED') {
    if (error.pauseReason === 'connection') return 'connection_lost';
    if (error.pauseReason === 'offline_mode') return 'offline_mode';
    return 'unknown';
  }
  if (isUploadStalled(error)) return 'no_progress';
  if (error?.code === 'DRAFT_ORIGINAL_UNAVAILABLE') return 'original_unavailable';
  if (error?.code === 'DRAFT_RECEIPTS_INCOMPLETE') return 'receipts_incomplete';
  if (error?.code === 'DRAFT_MANIFEST_CONFLICT') return 'request_conflict';
  if (error?.code === 'DRAFT_MEDIA_IDENTITY') return 'invalid_manifest';
  const status = getErrorStatus(error);
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'access_denied';
  if (status === 409) return 'request_conflict';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'no_progress';
  if (status && status >= 500 && status < 600) return 'server_error';
  if (status && status >= 400 && status < 500) return 'request_rejected';
  return isNetworkTransportError(error) ? 'transport_error' : 'unknown';
}

type Progress = DraftReceiptCounts & { cloudId: string };
export async function observeDraftUpload<T>(
  draft: OfflineReportDraft,
  run: (report: (progress: Progress) => Promise<void>) => Promise<T>,
  onProgress?: (progress: Progress) => void | Promise<void>
): Promise<T> {
  const owner = draft.ownerId;
  let attempt: number | undefined;
  // Activity storage is best effort. An unavailable journal must never fail a customer's upload.
  if (owner && draft.captureId && OfflineCaptureStore.getOwnerId() === owner) {
    try { attempt = await OfflineCaptureStore.beginDraftUpload(draft); } catch { /* continue with original transfer */ }
  }
  async function record(update: DraftReceiptCounts | 'finished' | DraftUploadReason) {
    if (owner && attempt !== undefined && OfflineCaptureStore.getOwnerId() === owner) {
      try { await OfflineCaptureStore.updateDraftUpload(owner, attempt, update); } catch { /* retain the transfer result */ }
    }
  }
  try {
    const result = await run(async progress => {
      await record(progress);
      await onProgress?.(progress);
    });
    await record('finished');
    return result;
  } catch (error) {
    await record(draftUploadReason(error));
    throw error;
  }
}
