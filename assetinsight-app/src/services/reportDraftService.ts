import api from './api';
import { allowsCloudDraft } from './offlineDraftPolicy';
import OfflineCaptureStore from './offlineCaptureStore';
import { isRetryableRequestError } from './connectivityService';
import { createUploadOperation, cancellableUploadRequest } from './uploadCancellation';
import { assertCloudDraftIdentity, hydrateCompleteCloudDraft } from './cloudDraftRestore';
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
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, items.length), concurrency) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    })
  );
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
    const uri = preferredUri(value);
    if (!uri || source.missing || source.availability === 'missing') {
      throw new Error('A draft original is unavailable on this device. Keep all originals and reopen the saved draft before syncing.');
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
      ...(isUploadableLocalUri(uri)
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

function isConfirmedDraftEntry(entry: DraftMediaEntry, media: CloudDraftMedia[]) {
  const expected = entry.descriptor;
  const saved = media.find((item) => item.clientFileId === expected.clientFileId);
  if (!saved?.uploadedAt || !Number.isFinite(Date.parse(saved.uploadedAt)) ||
      typeof saved.url !== 'string' || !/^https?:\/\/[^\s/]+(?:\/|$)/i.test(saved.url) ||
      !Number.isFinite(saved.verifiedSize) || Number(saved.verifiedSize) <= 0) return false;
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
      return !!saved && isConfirmedDraftEntry(entry, [saved]);
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

  async upsertFromLocalDraft(draft: OfflineReportDraft): Promise<ReportDraft> {
    const operation = createUploadOperation();
    const assertAllowed = () => {
      operation.assertActive();
      if (!allowsCloudDraft(draft)) throw new Error('Offline captures save only on this device. Use Submit when you are ready to upload.');
      if (!draft.ownerId || draft.ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('Sign in to the account that owns this draft.');
    };
    assertAllowed();
    // An in-progress upload owns one immutable manifest. UI edits made while
    // bytes are in flight belong to the next revision, never this receipt.
    const snapshot: OfflineReportDraft = JSON.parse(JSON.stringify(draft));
    const entries = buildDraftEntries(snapshot);
    const lots = serializeLots(snapshot.lots);
    const lotIds = new Set(lots.map((lot) => lot.id));
    const mediaIds = new Set(entries.map((entry) => entry.descriptor.clientFileId));
    if (lotIds.size !== lots.length || mediaIds.size !== entries.length) {
      throw new Error('This draft has missing or duplicate media references. Keep all originals and reopen the saved draft before syncing.');
    }
    const revision = Date.now();
    const assertSavedSnapshot = (saved: ReportDraft, cloudId?: string) => {
      assertCloudDraftIdentity(saved, {
        cloudId: cloudId || snapshot.cloudId || String(saved?.id || saved?._id || ''),
        clientDraftId: snapshot.id, type: snapshot.type, revision, ownerId: snapshot.ownerId,
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
        throw new Error('The cloud draft changed while saving. Your local draft and all originals are unchanged. Refresh Drafts and retry syncing.');
      }
    };
    const response = await cancellableUploadRequest(operation, (signal) => api.post<{
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
    }, { signal }));
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
    const pending = entries.filter((entry) => !isConfirmedDraftEntry(entry, cloud.media || []));

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
      const confirmed: string[] = [];
      const multipart: DraftMediaEntry[] = [];

      await mapWithConcurrency(batch, UPLOAD_CONCURRENCY, async (entry) => {
        assertAllowed();
        const target = targetById.get(entry.descriptor.clientFileId);
        if (!target) throw new Error(`No storage target was returned for ${entry.descriptor.name}.`);
        if (target.alreadyUploaded) {
          // Legacy receipts may have a key/date but no measured size. Targets
          // alone do not fill that evidence; confirm HEADs the existing object
          // without retransmitting or replacing the original.
          confirmed.push(entry.descriptor.clientFileId);
          return;
        }
        if (!entry.file) {
          throw new Error(
            `${entry.descriptor.name || 'Draft media'} is unavailable on this device and was not found in cloud storage.`
          );
        }
        if (!target.uploadUrl) {
          // Draft direct PUTs are optional on the server. The authenticated
          // multipart route persists the same media identities when disabled.
          multipart.push(entry);
          return;
        }
        await uploadLocalFileToPresignedUrl(
          entry.file,
          target.uploadUrl,
          entry.descriptor.mimeType
        );
        confirmed.push(entry.descriptor.clientFileId);
      });

      for (const idBatch of chunks(confirmed, TARGET_BATCH_SIZE)) {
        assertAllowed();
        if (!idBatch.length) continue;
        await cancellableUploadRequest(operation, (signal) => api.post(
          `/report-drafts/${draftId}/media/confirm`,
          { clientFileIds: idBatch },
          { timeout: 120000, signal }
        ));
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
        try {
          await cancellableUploadRequest(operation, (signal) => api.post(
            `/report-drafts/${encodeURIComponent(draftId)}/media`,
            body,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000, signal }
          ));
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
          if (!mediaBatch.every((entry) => isConfirmedDraftEntry(entry, savedMedia))) throw error;
        }
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
    const missing = entries.filter((entry) => !isConfirmedDraftEntry(entry, cloud.media || []));
    if (missing.length) {
      throw new Error(
        `${missing.length} draft media file${missing.length === 1 ? '' : 's'} could not be verified in cloud storage.`
      );
    }
    hydrateCompleteCloudDraft(cloud, { cloudId: draftId, clientDraftId: snapshot.id, type: snapshot.type, revision, ownerId: snapshot.ownerId });
    return cloud;
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/report-drafts/${id}`);
  },
};

export default reportDraftService;
