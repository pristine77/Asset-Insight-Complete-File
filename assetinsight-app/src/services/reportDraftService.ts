import { assertOrdinaryReport } from './arrivalPhotoDraft';
import { captureAuthOperation } from './authSessionOperation';
import api from './api';
import { observeDraftUpload } from './draftUploadActivity';
import { allowsCloudDraft } from './offlineDraftPolicy';
import OfflineCaptureStore from './offlineCaptureStore';
import { isRetryableRequestError } from './connectivityService';
import { createUploadOperation, cancellableUploadRequest, uploadGeneration, type UploadOperation } from './uploadCancellation';
import { assertCloudDraftIdentity, hydrateCompleteCloudDraft, isVerifiedDraftMedia } from './cloudDraftRestore';
import type {
  AutoSaveFormData,
  OfflineDraftType,
  OfflineReportDraft,
  SavedLotData,
  SavedPhotoFileData,
  SavedVideoFileData,
} from './autoSaveService';
import {
  uploadLocalFileToPresignedUrl,
  type DirectUploadFile,
} from './directR2UploadService';

export type CloudDraftMedia = {
  clientFileId: string;
  localKey?: string;
  mediaId?: string;
  lotId: string;
  slot: 'main' | 'extra' | 'video';
  index: number;
  captureOrder?: number;
  originalOrder?: number;
  name?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  verifiedSize?: number;
  lastModified?: number;
  r2Key?: string;
  uploadedAt?: string;
};

export const DUPLICATE_LOT_DETECTED = 'DUPLICATE_LOT_DETECTED';

export type DuplicateLotConflict = {
  contractNo?: string;
  lotNumber?: string;
  sourceType?: string;
  sourceId?: string;
  ownerDisplay?: string;
  message?: string;
};

export type ReportDraft = {
  user?: string | { _id?: string };
  _id?: string;
  id: string;
  clientDraftId?: string;
  type: OfflineDraftType;
  storageMode?: 'local_media' | 'r2_media' | 'smart_upload';
  revision?: number;
  /** Exact displayed snapshot required only for a confirmed user discard. */
  discardRevision?: string;
  contractNo: string;
  normalizedContractNo: string;
  title: string;
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  media?: CloudDraftMedia[];
  previewStatus?: 'idle' | 'queued' | 'processing' | 'ready' | 'error';
  previewReportId?: string;
  previewJobId?: string;
  previewRequestedRevision?: number;
  previewProcessedRevision?: number;
  previewError?: string;
  previewRequestedAt?: string;
  previewReadyAt?: string;
  duplicateLotConflicts?: DuplicateLotConflict[];
  syncWarningCode?: string;
  syncWarningMessage?: string;
  /**
   * Only on a draft kept after its upload was accepted whose report then
   * stopped without a preview (server, 2026-11-05). Drafts still being
   * processed are not listed.
   */
  submission?: {
    status: 'failed';
    reportId: string;
    reportType: 'asset' | 'lotListing';
    message: string;
    sentAt: string | null;
    failedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

/** Reads the stable server warning from either a saved draft or an API error. */
export function getDuplicateLotWarning(value: unknown): string | null {
  const candidate = value as any;
  const payload = candidate?.response?.data || candidate;
  const code = String(payload?.code || payload?.syncWarningCode || '').trim();
  if (code !== DUPLICATE_LOT_DETECTED) return null;
  return String(
    payload?.message ||
      payload?.syncWarningMessage ||
      'This contract already contains the same lot number. Change the lot number before creating the preview.'
  );
}

type DraftMediaEntry = {
  descriptor: CloudDraftMedia;
  file?: DirectUploadFile;
  originalUnavailable: boolean;
};

type DraftUploadTarget = {
  clientFileId: string;
  r2Key: string;
  uploadUrl?: string;
  url?: string;
  alreadyUploaded: boolean;
};

const TARGET_BATCH_SIZE = 200;
const MULTIPART_BATCH_SIZE = 10;
const UPLOAD_CONCURRENCY = 4;

const normalizeContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const chunks = <T,>(items: T[], size: number) => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
};

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, items.length), concurrency) }, async () => {
      while (!failure && cursor < items.length) {
        const index = cursor++;
        try {
          await worker(items[index], index);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure) throw failure.error;
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function preferredUri(value: any) {
  if (typeof value === 'string') return value;
  return String(
    value?.originalUri ||
      value?.sourceUri ||
      value?.cacheUri ||
      value?.editedUri ||
      value?.displayUri ||
      value?.uri ||
      ''
  );
}

function stableMediaId(
  draft: OfflineReportDraft,
  value: any,
  lotId: string,
  slot: CloudDraftMedia['slot'],
  fallbackName: string
) {
  if (typeof value !== 'string') {
    const stored = String(
      value?.clientFileId || value?.mediaId || value?.localKey || ''
    ).trim();
    if (stored) return stored;
  }
  const uri = preferredUri(value);
  const name = typeof value === 'string' ? fallbackName : value?.name || fallbackName;
  const timestamp = typeof value === 'string' ? '' : value?.timestamp || value?.createdAt || '';
  return `mobile-${stableHash(`${draft.id}|${lotId}|${slot}|${uri}|${name}|${timestamp}`)}`;
}

function isUploadableLocalUri(uri?: string) {
  return Boolean(uri && !/^https?:\/\//i.test(uri));
}

function buildDraftEntries(draft: OfflineReportDraft): DraftMediaEntry[] {
  const entries: DraftMediaEntry[] = [];
  let originalOrder = 0;

  const append = (
    value: SavedPhotoFileData | SavedVideoFileData | string,
    lotId: string,
    slot: CloudDraftMedia['slot'],
    index: number,
    fallbackName: string,
    fallbackType: string
  ) => {
    const source: any = typeof value === 'string' ? {} : value;
    // Imported video.uri points to the durable local copy; sourceUri can be an expired picker grant.
    const uri = slot === 'video' && source.uri ? source.uri : preferredUri(value);
    const originalUnavailable = !uri || !!source.missing || source.availability === 'missing';
    if (!uri && !source.clientFileId && !source.mediaId && !source.localKey) {
      throw draftError('DRAFT_MEDIA_IDENTITY', 'A draft original has no saved identifier or location. Reopen the saved draft before syncing.');
    }
    const clientFileId = stableMediaId(draft, value, lotId, slot, fallbackName);
    const name = String(source.name || fallbackName);
    const mimeType = String(source.type || fallbackType);
    const descriptor: CloudDraftMedia = {
      clientFileId,
      localKey: clientFileId,
      mediaId: String(source.mediaId || clientFileId),
      lotId,
      slot,
      index,
      captureOrder: Number.isFinite(Number(source.captureOrder))
        ? Number(source.captureOrder)
        : index,
      originalOrder,
      name,
      mimeType,
      size: Number(source.size || 0),
      lastModified: Number(source.lastModified || source.timestamp || 0),
    };
    entries.push({
      descriptor,
      originalUnavailable,
      ...(!originalUnavailable && isUploadableLocalUri(uri)
        ? {
            file: {
              uri,
              name,
              type: mimeType,
              size: descriptor.size,
              fieldname: slot === 'video' ? 'videos' : 'images',
              role: slot,
              imageIndex: index,
              captureOrder: descriptor.captureOrder,
              originalOrder,
            },
          }
        : {}),
    });
    originalOrder += 1;
  };

  draft.lots.forEach((lot, lotIndex) => {
    const lotId = String(lot.id || `draft-lot-${lotIndex + 1}`);
    lot.mainImages.forEach((value, index) =>
      append(value, lotId, 'main', index, `${lotId}-main-${index + 1}.jpg`, 'image/jpeg')
    );
    lot.extraImages.forEach((value, index) =>
      append(value, lotId, 'extra', index, `${lotId}-extra-${index + 1}.jpg`, 'image/jpeg')
    );
    (lot.videoFiles || []).forEach((value, index) =>
      append(value, lotId, 'video', index, `${lotId}-video-${index + 1}.mp4`, 'video/mp4')
    );
  });
  return entries;
}

/** Text and lot settings live in Mongo; media bytes are represented only by the R2 manifest. */
function serializeLots(lots: SavedLotData[]): SavedLotData[] {
  return lots.map((lot, index) => ({
    ...lot,
    id: String(lot.id || `draft-lot-${index + 1}`),
    mainImages: [],
    extraImages: [],
    videoFiles: [],
  }));
}

function isConfirmedDraftEntry(entry: DraftMediaEntry, saved: CloudDraftMedia | undefined) {
  const expected = entry.descriptor;
  if (!saved || !isVerifiedDraftMedia(saved)) return false;
  // A response may have been lost after the multipart batch committed. Only
  // matching saved identities/metadata can establish that this batch succeeded.
  const fields = ['lotId', 'slot', 'index', 'captureOrder', 'originalOrder', 'name', 'mimeType', 'lastModified'] as const;
  return fields.every((field) => saved[field] === expected[field]) &&
    (!expected.size || Number(saved.verifiedSize ?? saved.size) === expected.size);
}

/** A cloud timestamp or smaller completed subset is not a backup of this local capture. */
export function isVerifiedCloudBackupOfLocal(draft: OfflineReportDraft, cloud: ReportDraft): boolean {
  try {
    const cloudId = String(cloud?.id || cloud?._id || '');
    assertCloudDraftIdentity(cloud, {
      cloudId: draft.cloudId || cloudId, clientDraftId: draft.id, type: draft.type, ownerId: draft.ownerId,
    });
    if (cloud.storageMode === 'local_media' || cloud.storageMode === 'smart_upload' ||
        !Array.isArray(cloud.lots) || cloud.lots.length !== draft.lots.length ||
        cloud.lots.some((lot, index) => !lot || lot.id !== String(draft.lots[index].id || `draft-lot-${index + 1}`)) ||
        !Array.isArray(cloud.media)) return false;
    const entries = buildDraftEntries(draft);
    const savedById = new Map(cloud.media.map((item) => [item?.clientFileId, item]));
    if (cloud.media.length !== entries.length || savedById.size !== entries.length ||
        new Set(entries.map((entry) => entry.descriptor.clientFileId)).size !== entries.length) return false;
    return entries.every((entry) => {
      const saved = savedById.get(entry.descriptor.clientFileId);
      return !!saved && isConfirmedDraftEntry(entry, saved);
    });
  } catch {
    return false;
  }
}

const reportDraftService = {
  async list(): Promise<ReportDraft[]> {
    const response = await api.get<{ message: string; data: ReportDraft[] }>('/report-drafts');
    return response.data.data || [];
  },

  async get(id: string): Promise<ReportDraft> {
    const ownerId = OfflineCaptureStore.getOwnerId();
    if (!ownerId) throw new Error('Sign in before opening a cloud draft.');
    const operation = createUploadOperation();
    const response = await cancellableUploadRequest(operation, (signal) =>
      api.get<{ message: string; data: ReportDraft }>(`/report-drafts/${encodeURIComponent(id)}`, { signal })
    );
    operation.assertActive();
    if (OfflineCaptureStore.getOwnerId() !== ownerId) throw new Error('The signed-in account changed while opening this draft.');
    const cloud = response.data.data;
    assertCloudDraftIdentity(cloud, { cloudId: id, ownerId });
    return cloud;
  },

  async processPreview(id: string): Promise<ReportDraft> {
    const response = await api.post<{ message: string; data: ReportDraft }>(
      `/report-drafts/${encodeURIComponent(id)}/process-preview`
    );
    return response.data.data;
  },

  upsertFromLocalDraft: saveDraftWithMedia,

  async delete(id: string, discard?: { intent: 'discard'; baseRevision: string }): Promise<void> {
    if (!discard) {
      await api.delete(`/report-drafts/${id}`);
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(discard.baseRevision)) {
      throw new Error('Refresh Drafts before deleting this saved draft. Your photos are unchanged.');
    }
    const assertSession = captureAuthOperation();
    const owner = OfflineCaptureStore.getOwnerId();
    const assertCurrent = () => {
      assertSession();
      if (!owner || OfflineCaptureStore.getOwnerId() !== owner) throw new Error('The signed-in account changed. Your local draft is unchanged.');
    };
    assertCurrent();
    const response = await api.delete(`/report-drafts/${encodeURIComponent(id)}`, {
      data: discard, timeout: 30_000, skipAuthRefreshReplay: true,
    });
    assertCurrent();
    if (response.status !== 200 || response.data?.retained === true || response.data?.deleted !== true || response.data?.draftId !== id) {
      throw new Error(response.data?.retained === true
        ? 'This draft is still needed for report processing. Keep it and refresh Drafts before trying again.'
        : 'Deletion could not be confirmed. Refresh Drafts to check; your local photos are unchanged.');
    }
  },
};

function draftError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

type DraftUploadProgress = { cloudId: string; verified: number; total: number };
type DraftUploadProgressListener = (progress: DraftUploadProgress) => void | Promise<void>;
type PendingDraftTransfer = {
  result: Promise<ReportDraft>;
  listeners: Set<DraftUploadProgressListener>;
  latest?: DraftUploadProgress;
};
const draftTransfers = new Map<string, Map<string, PendingDraftTransfer>>();

// Both Save Preview and the foreground sync loop can start the same persisted
// draft. Share identical transfers and finish older writes before starting newer ones.
async function saveDraftWithMedia(draft: OfflineReportDraft, onProgress?: DraftUploadProgressListener): Promise<ReportDraft> {
  const scope = JSON.stringify([uploadGeneration(), draft.ownerId, draft.type, draft.id]);
  const snapshotKey = JSON.stringify(draft);
  const transfers = draftTransfers.get(scope) || new Map<string, PendingDraftTransfer>();
  const existing = transfers.get(snapshotKey);
  if (existing) {
    if (onProgress && !existing.listeners.has(onProgress)) {
      existing.listeners.add(onProgress);
      const latest = existing.latest;
      if (latest) await Promise.resolve().then(() => onProgress(latest)).catch(() => undefined);
    }
    return existing.result;
  }
  const operation = createUploadOperation();
  const snapshot: OfflineReportDraft = JSON.parse(snapshotKey);
  const listeners = new Set<DraftUploadProgressListener>();
  if (onProgress) listeners.add(onProgress);
  const previous = Array.from(transfers.values()).pop();
  const result = (previous?.result || Promise.resolve()).catch(() => undefined).then(() => {
    operation.assertActive();
    return observeDraftUpload(snapshot, report => uploadDraft(draft, snapshot, operation, report), async progress => {
      transfer.latest = progress;
      // A caller that unmounts or throws while displaying progress cannot cancel someone else's backup.
      await Promise.allSettled([...listeners].map(listener => Promise.resolve().then(() => listener(progress))));
    });
  }).finally(() => {
    transfers.delete(snapshotKey);
    if (transfers.size === 0) draftTransfers.delete(scope);
  });
  const transfer: PendingDraftTransfer = { result, listeners };
  transfers.set(snapshotKey, transfer);
  draftTransfers.set(scope, transfers);
  return result;
}

async function uploadDraft(
  draft: OfflineReportDraft,
  snapshot: OfflineReportDraft,
  operation: UploadOperation,
  report: DraftUploadProgressListener
): Promise<ReportDraft> {
  assertOrdinaryReport(snapshot.formData);
  const initiallyAllowed = allowsCloudDraft(snapshot);
  const assertAllowed = () => {
    operation.assertActive();
    assertOrdinaryReport(draft.formData);
    if (!initiallyAllowed || !allowsCloudDraft(draft)) throw new Error('Offline captures save only on this device. Use Submit when you are ready to upload.');
    if (!snapshot.ownerId || draft.ownerId !== snapshot.ownerId || snapshot.ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('Sign in to the account that owns this draft.');
  };
  assertAllowed();
  const entries = buildDraftEntries(snapshot);
  const lots = serializeLots(snapshot.lots);
  const lotIds = new Set(lots.map((lot) => lot.id));
  const mediaIds = new Set(entries.map((entry) => entry.descriptor.clientFileId));
  if (lotIds.size !== lots.length || mediaIds.size !== entries.length) {
    throw draftError('DRAFT_MEDIA_IDENTITY', 'This draft has missing or duplicate media references. Keep all originals and reopen the saved draft before syncing.');
  }
  // A retry must use the revision of the saved edits. Giving an old interrupted
  // snapshot today's timestamp would let it overwrite newer edits on the web.
  let revision = Date.parse(snapshot.updatedAt) || Date.parse(snapshot.createdAt) || 0;
  const manifestConflict = () => draftError('DRAFT_MANIFEST_CONFLICT',
    'The cloud draft changed while saving. Your local draft and all originals are unchanged. Refresh Drafts and retry syncing.');

  const assertSavedSnapshot = (saved: ReportDraft, cloudId?: string) => {
    assertCloudDraftIdentity(saved, {
      cloudId: cloudId || snapshot.cloudId || String(saved?.id || saved?._id || ''),
      clientDraftId: snapshot.id, type: snapshot.type, ownerId: snapshot.ownerId,
    });
    const sameLots = Array.isArray(saved.lots) && saved.lots.length === lots.length &&
      saved.lots.every((lot, index) => lot && lot.id === lots[index].id);
    const savedMedia = saved.media;
    const validMedia = Array.isArray(savedMedia) && savedMedia.every((item) => item && typeof item.clientFileId === 'string');
    const savedById = new Map((validMedia ? savedMedia! : []).map((item) => [item.clientFileId, item]));
    const descriptorFields = ['localKey', 'mediaId', 'lotId', 'slot', 'index', 'captureOrder', 'originalOrder', 'name', 'mimeType', 'lastModified'] as const;
    if (saved.revision !== revision || !sameLots || !validMedia || !Array.isArray(savedMedia) ||
        savedMedia.length !== entries.length || savedById.size !== entries.length ||
        saved.formData?.clientSubmissionId !== snapshot.formData.clientSubmissionId ||
        normalizeContractNo(saved.contractNo) !== normalizeContractNo(snapshot.contractNo || snapshot.formData.contractNo) ||
        entries.some(({ descriptor }) => {
          const item = savedById.get(descriptor.clientFileId);
          return !item || descriptorFields.some((field) => item[field] !== descriptor[field]) ||
            (Number(descriptor.size) > 0 && item.size !== descriptor.size);
        })) {
      throw manifestConflict();
    }
  };
  const saveMetadata = () => cancellableUploadRequest(operation, (signal) => api.post<{
    message: string;
    code?: string;
    warning?: boolean;
    conflicts?: DuplicateLotConflict[];
    data: ReportDraft;
  }>('/report-drafts', {
    clientDraftId: snapshot.id,
    type: snapshot.type,
    storageMode: 'r2_media',
    revision,
    contractNo: snapshot.contractNo || snapshot.formData.contractNo,
    normalizedContractNo:
      snapshot.normalizedContractNo || normalizeContractNo(snapshot.contractNo || snapshot.formData.contractNo),
    title: snapshot.title,
    formData: snapshot.formData,
    lots,
    activeLotIdx: snapshot.activeLotIdx,
    media: entries.map((entry) => entry.descriptor),
  }, { signal, ...(snapshot.captureId ? { headers: { 'X-Activity-Id': snapshot.captureId } } : {}) }));
  if (entries.length && entries.every(entry => entry.originalUnavailable) && !snapshot.cloudId) {
    // With no accessible originals and no cloud ID, recover an existing capture
    // by its stable client ID before creating any cloud metadata.
    try {
      const prior = await cancellableUploadRequest(operation, signal => api.get<{ data: ReportDraft }>(
        `/report-drafts/client/${encodeURIComponent(snapshot.id)}`, { params: { type: snapshot.type }, signal }
      ));
      assertAllowed();
      assertCloudDraftIdentity(prior.data.data, {
        cloudId: prior.data.data?.id || prior.data.data?._id || '',
        clientDraftId: snapshot.id, ownerId: snapshot.ownerId, type: snapshot.type,
      });
    } catch (error: any) {
      if (error?.response?.status !== 404) throw error;
      throw draftError('DRAFT_ORIGINAL_UNAVAILABLE', 'The draft originals are unavailable on this device. Keep the saved draft for recovery.');
    }
  }
  let response: Awaited<ReturnType<typeof saveMetadata>>;
  try {
    response = await saveMetadata();
  } catch (error: any) {
    assertAllowed();
    const conflict = error?.response?.data;
    if (error?.response?.status === 409 && conflict?.code === 'DRAFT_REVISION_CONFLICT') throw manifestConflict();
    if (error?.response?.status !== 409 || conflict?.code !== 'STALE_DRAFT_REVISION') throw error;
    const newer = conflict.data as ReportDraft | undefined;
    if (!newer || !Number.isSafeInteger(newer.revision) || newer.revision! <= revision) throw manifestConflict();
    // Older APKs stamped the time of the transfer. Reuse exactly the returned
    // revision. The server accepts this only if its full content hash matches.
    revision = newer.revision!;
    assertSavedSnapshot(newer);
    try {
      response = await saveMetadata();
    } catch (retryError: any) {
      if (retryError?.response?.status === 409 && ['DRAFT_REVISION_CONFLICT', 'STALE_DRAFT_REVISION'].includes(retryError.response.data?.code)) throw manifestConflict();
      throw retryError;
    }
  }
  const syncWarningCode = response.data.code;
  assertAllowed();
  const syncWarningMessage = syncWarningCode ? response.data.message : undefined;
  const duplicateLotConflicts = response.data.conflicts || [];
  let cloud: ReportDraft = {
    ...response.data.data,
    duplicateLotConflicts,
    syncWarningCode,
    syncWarningMessage,
  };
  assertSavedSnapshot(cloud);
  const draftId = String(cloud.id || cloud._id || '');
  const receiptById = (media: CloudDraftMedia[]) => new Map(media.map((item) => [item.clientFileId, item]));
  const existing = receiptById(cloud.media || []);
  const pending = entries.filter((entry) => !isConfirmedDraftEntry(entry, existing.get(entry.descriptor.clientFileId)));
  let verified = entries.length - pending.length;
  await report({ cloudId: draftId, verified, total: entries.length });
  const checkpoint = async (batch: DraftMediaEntry[], media: CloudDraftMedia[] | undefined) => {
    assertAllowed();
    if (!Array.isArray(media)) return;
    const saved = receiptById(media);
    const count = batch.filter((entry) => isConfirmedDraftEntry(entry, saved.get(entry.descriptor.clientFileId))).length;
    if (count) {
      verified += count;
      await report({ cloudId: draftId, verified, total: entries.length });
    }
  };

  const unavailable = new Set<string>();
  for (const batch of chunks(pending, TARGET_BATCH_SIZE)) {
    assertAllowed();
    const targetResponse = await cancellableUploadRequest(operation, (signal) => api.post<{ message: string; data: DraftUploadTarget[] }>(
      `/report-drafts/${draftId}/media/targets`,
      { media: batch.map((entry) => entry.descriptor) },
      { timeout: 60000, signal }
    ));
    const targetById = new Map(
      (targetResponse.data.data || []).map((target) => [target.clientFileId, target])
    );
    const multipart: DraftMediaEntry[] = [];
    const direct: DraftMediaEntry[] = [];
    for (const entry of batch) {
      const target = targetById.get(entry.descriptor.clientFileId);
      if (!target) throw new Error(`No storage target was returned for ${entry.descriptor.name}.`);
      if (!target.alreadyUploaded && !entry.file) {
        // Keep the missing descriptor and back up all other available originals.
        unavailable.add(entry.descriptor.clientFileId);
        continue;
      }
      if (target.alreadyUploaded || target.uploadUrl) direct.push(entry);
      else multipart.push(entry);
    }
    // Confirm small groups so a long direct upload has durable checkpoints
    // even if Android suspends the process between PUT and confirmation.
    for (const directBatch of chunks(direct, MULTIPART_BATCH_SIZE)) {
      await mapWithConcurrency(directBatch, UPLOAD_CONCURRENCY, async (entry) => {
        assertAllowed();
        const target = targetById.get(entry.descriptor.clientFileId)!;
        if (!target.alreadyUploaded) {
          await uploadLocalFileToPresignedUrl(entry.file!, target.uploadUrl!, entry.descriptor.mimeType);
        }
      });
      assertAllowed();
      const receipt = await cancellableUploadRequest(operation, (signal) => api.post<{ data: CloudDraftMedia[] }>(
        `/report-drafts/${draftId}/media/confirm`,
        { clientFileIds: directBatch.map((entry) => entry.descriptor.clientFileId) },
        { timeout: 120000, signal }
      ));
      await checkpoint(directBatch, receipt.data.data);
    }

    for (const mediaBatch of chunks(multipart, MULTIPART_BATCH_SIZE)) {
      assertAllowed();
      const body = new FormData();
      body.append('replace', 'false');
      body.append('metadata', JSON.stringify(mediaBatch.map((entry) => entry.descriptor)));
      mediaBatch.forEach((entry) => body.append('files', {
        uri: entry.file!.uri,
        name: entry.file!.name,
        type: entry.file!.type,
      } as any));
      let mediaReceipt: CloudDraftMedia[] | undefined;
      try {
        const response = await cancellableUploadRequest(operation, (signal) => api.post<{ data: CloudDraftMedia[] }>(
          `/report-drafts/${encodeURIComponent(draftId)}/media`,
          body,
          { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000, signal }
        ));
        mediaReceipt = response.data.data;
        assertAllowed();
      } catch (error) {
        assertAllowed();
        if (!isRetryableRequestError(error)) throw error;
        // Multipart writes allocate fresh object keys. Never replay an
        // uncertain batch: read the same draft before proceeding or retrying.
        let savedMedia: CloudDraftMedia[] = [];
        try {
          const saved = await cancellableUploadRequest(operation, (signal) => api.get<{ data: ReportDraft }>(
            `/report-drafts/${encodeURIComponent(draftId)}`, { signal }
          ));
          assertAllowed();
          assertSavedSnapshot(saved.data.data, draftId);
          savedMedia = saved.data.data.media || [];
        } catch {
          assertAllowed();
          throw error;
        }
        const saved = receiptById(savedMedia);
        if (!mediaBatch.every((entry) => isConfirmedDraftEntry(entry, saved.get(entry.descriptor.clientFileId)))) throw error;
        mediaReceipt = savedMedia;
      }
      await checkpoint(mediaBatch, mediaReceipt);
    }
  }

  assertAllowed();
  const refreshed = await cancellableUploadRequest(operation, (signal) => api.get<{ data: ReportDraft }>(`/report-drafts/${encodeURIComponent(draftId)}`, { signal }));
  assertAllowed();
  cloud = {
    ...refreshed.data.data,
    duplicateLotConflicts,
    syncWarningCode,
    syncWarningMessage,
  };
  assertSavedSnapshot(cloud, draftId);
  const finalMedia = receiptById(cloud.media || []);
  const missing = entries.filter((entry) => !isConfirmedDraftEntry(entry, finalMedia.get(entry.descriptor.clientFileId)));
  if (missing.length) {
    const absent = missing.filter(entry => unavailable.has(entry.descriptor.clientFileId));
    if (absent.length) {
      throw draftError('DRAFT_ORIGINAL_UNAVAILABLE',
        `${absent.length} draft original${absent.length === 1 ? ' is' : 's are'} unavailable on this device and still need a verified cloud backup. Keep the saved draft for recovery.`);
    }
    throw draftError('DRAFT_RECEIPTS_INCOMPLETE',
      `${missing.length} draft media file${missing.length === 1 ? '' : 's'} could not be verified in cloud storage.`
    );
  }
  hydrateCompleteCloudDraft(cloud, { cloudId: draftId, clientDraftId: snapshot.id, type: snapshot.type, revision, ownerId: snapshot.ownerId });
  if (verified !== entries.length) await report({ cloudId: draftId, verified: entries.length, total: entries.length });
  return cloud;
}

export default reportDraftService;
