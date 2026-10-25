import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import type { PhotoFile } from '../components/camera/types';
import { ImageEditService } from './imageEditService';
import {
  getPhotoOriginalUri,
  normalizeImageAdjustments,
  normalizePhotoFile,
} from '../utils/photoFileUtils';
import { LocalMediaStore } from './localMediaStore';
import OfflineCaptureStore from './offlineCaptureStore';
import type { OfflineCaptureMetadata, CaptureModePreference, MediaOwnership } from './offlineCaptureTypes';
import type { AuctioneerWorkItemSetup } from './auctioneerService';
import type { AuctionManagementTaskPayload } from './auctionManagementService';
import { setUploadOwner } from './uploadCancellation';
import durableReportTransfer from './durableReportTransfer';
import { flushBackupHandoff } from './captureBackupHandoff';

const AUTO_SAVE_KEY = '@clearvalue_auto_save';
const getAutoSaveImagesDir = (): string => `${FileSystem.documentDirectory || ''}auto_save_images/`;
const getDraftImagesDir = (draftId: string): string =>
  LocalMediaStore.getDraftDir(draftId);
const draftSaveTails = new Map<string, Promise<unknown>>();
async function serializeDraftSave<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (draftSaveTails.get(key) || Promise.resolve()).catch(() => undefined).then(work);
  draftSaveTails.set(key, next);
  try { return await next; }
  finally { if (draftSaveTails.get(key) === next) draftSaveTails.delete(key); }
}

export type SavedVideoFileData = {
  missing?: boolean;
  ownership?: MediaOwnership;
  availability?: 'available' | 'missing';
  uri: string;
  name: string;
  type: string;
  clientFileId?: string;
  localKey?: string;
  mediaId?: string;
  sourceUri?: string;
  size?: number;
  lotId?: string;
  slot?: 'video';
  index?: number;
  createdAt?: string;
  captureOrder?: number;
  originalOrder?: number;
};

export interface SavedPhotoFileData {
  captureOrigin?: 'camera' | 'import';
  captureTimestamp?: number;
  missing?: boolean;
  ownership?: MediaOwnership;
  availability?: 'available' | 'missing';
  uri: string;
  originalUri?: string;
  editedUri?: string;
  displayUri?: string;
  thumbnailUri?: string;
  name: string;
  type: string;
  clientFileId?: string;
  localKey?: string;
  mediaId?: string;
  sourceUri?: string;
  cacheUri?: string;
  size?: number;
  lotId?: string;
  slot?: 'main' | 'extra';
  index?: number;
  createdAt?: string;
  width?: number;
  height?: number;
  megapixels?: number;
  focusBox?: { x: number; y: number; w: number; h: number };
  adjustments?: PhotoFile['adjustments'];
  timestamp?: number;
  captureOrder?: number;
  originalOrder?: number;
}

export interface SavedLotData {
  id: string;
  lotNumber?: string;
  title?: string;
  mode?: 'single_lot' | 'per_item' | 'per_photo';
  mainImages: (SavedPhotoFileData | string)[];
  extraImages: (SavedPhotoFileData | string)[];
  videoFiles: (SavedVideoFileData | string)[];
  coverIndex: number;
}

export interface AutoSaveFormData {
  manualSubmissionRequired?: boolean;
  auctionServiceSelections?: Record<string, unknown>;
  auctionCloseContract?: boolean;
  captureMode?: CaptureModePreference;
  auctioneerSnapshot?: AuctioneerWorkItemSetup;
  auctionsoftSnapshot?: AuctionManagementTaskPayload;
  legacyRequiresIncomingReview?: boolean;
  auctionManagementTaskId?: string;
  auctionsoft?: { taskId?: string; contractId?: string; [key: string]: unknown };
  clientSubmissionId?: string;
  supersedesClientSubmissionId?: string;
  auctioneerWorkItemId?: string;
  clientName?: string;
  effectiveDate?: string;
  appraisalPurpose?: string;
  ownerName?: string;
  appraiser?: string;
  appraisalCompany?: string;
  industry?: string;
  inspectionDate?: string;
  contractNo?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  salesDate?: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string;
  preparedFor?: string;
  factorsAgeCondition?: string;
  factorsQuality?: string;
  factorsAnalysis?: string;
  includeDamageAnalysis?: boolean;
  enhanceImages?: boolean;
  bankPhotosEnabled?: boolean;
  watermarkImages?: boolean;
  includeValuationTable?: boolean;
  selectedValuationMethods?: ('FML' | 'TKV' | 'OLV' | 'FLV')[];
}

export interface AutoSaveData {
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  savedAt: string;
  formType: 'asset' | 'realEstate' | 'lotListing';
}

export type OfflineDraftType = 'asset' | 'lotListing';

export type DraftCloudSyncErrorKind =
  | 'network'
  | 'transient_server'
  | 'auth'
  | 'validation'
  | 'unknown';

export interface OfflineReportDraft extends OfflineCaptureMetadata {
  id: string;
  type: OfflineDraftType;
  title: string;
  contractNo?: string;
  normalizedContractNo?: string;
  cloudId?: string;
  cloudSyncedAt?: string;
  cloudSyncError?: string;
  cloudSyncErrorKind?: DraftCloudSyncErrorKind;
  cloudSyncRetryAt?: number;
  cloudSyncAttempts?: number;
  cloudSyncLastAttemptAt?: string;
  formData: AutoSaveFormData;
  lots: SavedLotData[];
  activeLotIdx: number;
  createdAt: string;
  updatedAt: string;
}

type AutoSaveLotInput = {
  id: string;
  lotNumber?: string;
  title?: string;
  mode?: 'single_lot' | 'per_item' | 'per_photo';
  files: PhotoFile[];
  extraFiles: PhotoFile[];
  videoFile?: PhotoFile;
  videoFiles?: { uri: string; name?: string; type?: string }[];
  coverIndex: number;
};

const ensureDirectoryExistsAt = async (dir: string): Promise<void> => {
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
};

const ensureDirectoryExists = async (): Promise<void> => {
  await ensureDirectoryExistsAt(getAutoSaveImagesDir());
};

const getFileExtension = (nameOrUri?: string, fallback = 'jpg') => {
  const value = nameOrUri ?? '';
  const match = /\.([a-zA-Z0-9]+)(\?|#|$)/.exec(value);
  return match?.[1]?.toLowerCase() || fallback;
};

const generateFilename = (lotId: string, slot: string, index: number, ext: string) =>
  `${lotId}_${slot}_${index}_${Date.now()}.${ext}`;

const isUriInAutoSaveDir = (uri?: string | null) => Boolean(uri && uri.startsWith(getAutoSaveImagesDir()));

const shouldDeleteManagedUri = (uri?: string | null) =>
  Boolean(
    uri &&
      (isUriInAutoSaveDir(uri) ||
        LocalMediaStore.isManagedUri(uri) ||
        ImageEditService.isManagedEditedUri(uri))
  );

const ensureUriExists = async (uri?: string | null) => {
  if (!uri) return false;
  if (/^https?:\/\//i.test(uri)) return true;
  try {
    const info = await LocalMediaStore.getFileInfo(uri);
    return Boolean(info.exists);
  } catch {
    return false;
  }
};

const isRemoteMediaUri = (uri?: string | null) => Boolean(uri && /^https?:\/\//i.test(uri));

const copyToDirectory = async (
  sourceUri: string,
  filename: string,
  destinationDir: string
): Promise<string> => {
  await ensureDirectoryExistsAt(destinationDir);

  if (sourceUri.startsWith(destinationDir)) {
    return sourceUri;
  }

  const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
  if (!sourceInfo.exists) {
    console.warn(`[AutoSave] Source file does not exist: ${sourceUri}`);
    return '';
  }

  const destinationUri = `${destinationDir}${filename}`;
  await FileSystem.copyAsync({
    from: sourceUri,
    to: destinationUri,
  });

  return destinationUri;
};

const getFileSize = async (uri?: string | null): Promise<number | undefined> => {
  if (!uri || /^https?:\/\//i.test(uri)) return undefined;
  try {
    const info = await LocalMediaStore.getFileInfo(uri);
    return info.exists && typeof info.size === 'number' ? info.size : undefined;
  } catch {
    return undefined;
  }
};

const copyToAutoSaveDir = async (sourceUri: string, filename: string): Promise<string> =>
  copyToDirectory(sourceUri, filename, getAutoSaveImagesDir());

const deleteLocalFile = async (uri?: string | null): Promise<void> => {
  if (!uri || !shouldDeleteManagedUri(uri)) return;
  const targetUri: string = uri;

  try {
    const info = await FileSystem.getInfoAsync(targetUri);
    if (info.exists) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true });
    }
  } catch (error) {
    console.error('Error deleting local image:', error);
  }
};

const normalizeSavedPhotoFile = async (
  photo: SavedPhotoFileData | string,
  fallbackName: string
): Promise<SavedPhotoFileData | null> => {
  if (typeof photo === 'string') {
    return normalizePhotoFile({
      uri: photo,
      originalUri: photo,
      displayUri: photo,
      name: fallbackName,
      type: 'image/jpeg',
      ...(!(await ensureUriExists(photo)) ? { availability: 'missing' as const, missing: true } : { missing: false }),
    }) as SavedPhotoFileData;
  }

  const originalUri = photo.originalUri ?? photo.uri;
  const originalExists = await ensureUriExists(originalUri);
  const editedExists = await ensureUriExists(photo.editedUri);
  const fallbackUri = originalExists ? originalUri : editedExists ? photo.editedUri : null;

  if (!fallbackUri) return { ...photo, availability: 'missing', missing: true };

  return normalizePhotoFile({
    ...photo,
    uri: originalExists ? originalUri : fallbackUri,
    originalUri: originalExists ? originalUri : fallbackUri,
    editedUri: editedExists ? photo.editedUri : undefined,
    displayUri: editedExists ? photo.editedUri : fallbackUri,
    adjustments: normalizeImageAdjustments(photo.adjustments),
    availability: 'available',
    missing: false,
  }) as SavedPhotoFileData;
};

const normalizeSavedVideoFile = async (
  video: SavedVideoFileData | string,
  fallbackName: string
): Promise<SavedVideoFileData | null> => {
  if (typeof video === 'string') {
    return { uri: video, name: fallbackName, type: 'video/mp4', availability: await ensureUriExists(video) ? 'available' : 'missing' };
  }

  return { ...video, availability: await ensureUriExists(video.uri) ? 'available' : 'missing' };
};

const persistPhotoFile = async (
  photo: PhotoFile,
  lotId: string,
  slot: 'main' | 'extra',
  index: number,
  destinationDir: string = getAutoSaveImagesDir(),
  keepManagedEditedUri = true,
  existing?: SavedPhotoFileData | string | null,
  draftId?: string
): Promise<SavedPhotoFileData | null> => {
  const normalized = normalizePhotoFile(photo);
  const originalUri = getPhotoOriginalUri(normalized);
  const candidate = typeof existing === 'string' ? null : existing;
  const existingPhoto = candidate && (
    (normalized.mediaId && normalized.mediaId === candidate.mediaId) ||
    [candidate.uri, candidate.originalUri, candidate.sourceUri].includes(originalUri)
  ) ? candidate : null;

  // Cloud-restored drafts keep R2 as the media source. Downloading those
  // files back into LocalMediaStore on every autosave caused large drafts to
  // consume device storage again and introduced a second ordering source.
  if (isRemoteMediaUri(originalUri)) {
    return normalizePhotoFile({
      ...normalized,
      uri: originalUri,
      originalUri,
      displayUri: normalized.editedUri || normalized.displayUri || originalUri,
      clientFileId: (photo as any)?.clientFileId,
      localKey: (photo as any)?.localKey,
      mediaId: normalized.mediaId || (photo as any)?.clientFileId,
      sourceUri: normalized.sourceUri || originalUri,
      lotId,
      slot,
      index,
    }) as SavedPhotoFileData;
  }

  if (
    existingPhoto &&
    existingPhoto.sourceUri === originalUri &&
    normalized.editedUri === existingPhoto.editedUri &&
    (await ensureUriExists(existingPhoto.uri))
  ) {
    return normalizePhotoFile({
      ...existingPhoto,
      adjustments: normalizeImageAdjustments(normalized.adjustments),
      originalUri: existingPhoto.originalUri || existingPhoto.uri,
      displayUri: existingPhoto.editedUri || existingPhoto.displayUri || existingPhoto.uri,
      thumbnailUri: existingPhoto.thumbnailUri,
      timestamp: normalized.timestamp ?? existingPhoto.timestamp,
      captureOrder: normalized.captureOrder ?? existingPhoto.captureOrder,
      originalOrder: normalized.originalOrder ?? existingPhoto.originalOrder,
    }) as SavedPhotoFileData;
  }

  if (draftId) {
    const imported = await LocalMediaStore.importMedia({
      draftId,
      lotId,
      slot,
      index,
      sourceUri: originalUri,
      name: normalized.name,
      type: normalized.type,
      mediaId: normalized.mediaId || existingPhoto?.mediaId,
    });

    if (!imported) return { ...normalized, availability: 'missing', missing: true, lotId, slot, index };

    let persistedEditedUri: string | undefined;
    if (normalized.editedUri && (await ensureUriExists(normalized.editedUri))) {
      persistedEditedUri = keepManagedEditedUri && ImageEditService.isManagedEditedUri(normalized.editedUri)
        ? normalized.editedUri
        : (
            await LocalMediaStore.importMedia({
              draftId,
              lotId,
              slot,
              index,
              sourceUri: normalized.editedUri,
              name: `${normalized.name || imported.name}-edited.jpg`,
              type: 'image/jpeg',
              mediaId: `${imported.mediaId}-edited`,
            })
          )?.uri;
    }

    return normalizePhotoFile({
      ...normalized,
      uri: imported.uri,
      originalUri: imported.uri,
      editedUri: persistedEditedUri,
      displayUri: persistedEditedUri ?? imported.thumbnailUri ?? imported.uri,
      thumbnailUri: imported.thumbnailUri,
      name: imported.name,
      type: imported.type,
      mediaId: imported.mediaId,
      ownership: imported.ownership,
      availability: 'available',
      missing: false,
      captureTimestamp: normalized.timestamp || existingPhoto?.captureTimestamp,
      sourceUri: originalUri,
      cacheUri: normalized.cacheUri,
      size: imported.size,
      lotId,
      slot,
      index,
      createdAt: existingPhoto?.createdAt || imported.createdAt,
      adjustments: normalizeImageAdjustments(normalized.adjustments),
    }) as SavedPhotoFileData;
  }

  const originalExt = getFileExtension(normalized.name || originalUri, 'jpg');
  const persistedOriginal = await copyToDirectory(
    originalUri,
    generateFilename(lotId, `${slot}_original`, index, originalExt),
    destinationDir
  );

  if (!persistedOriginal) return null;

  let persistedEditedUri: string | undefined;
  if (normalized.editedUri) {
    if (await ensureUriExists(normalized.editedUri)) {
      persistedEditedUri = keepManagedEditedUri && ImageEditService.isManagedEditedUri(normalized.editedUri)
        ? normalized.editedUri
        : await copyToDirectory(
            normalized.editedUri,
            generateFilename(lotId, `${slot}_edited`, index, 'jpg'),
            destinationDir
          );
    }
  }

  return normalizePhotoFile({
    ...normalized,
    uri: persistedOriginal,
    originalUri: persistedOriginal,
    editedUri: persistedEditedUri,
    displayUri: persistedEditedUri ?? persistedOriginal,
    sourceUri: originalUri,
    cacheUri: normalized.cacheUri,
    size: await getFileSize(persistedOriginal),
    lotId,
    slot,
    index,
    adjustments: normalizeImageAdjustments(normalized.adjustments),
  }) as SavedPhotoFileData;
};

const persistVideoFile = async (
  videoFile: { uri: string; name?: string; type?: string },
  lotId: string,
  index: number,
  destinationDir: string = getAutoSaveImagesDir(),
  existing?: SavedVideoFileData | string | null,
  draftId?: string
): Promise<SavedVideoFileData | null> => {
  const existingVideo = typeof existing === 'string' ? null : existing;
  if (isRemoteMediaUri(videoFile.uri)) {
    return {
      ...(typeof videoFile === 'object' ? videoFile : {}),
      uri: videoFile.uri,
      name: videoFile.name || `video-${index}.mp4`,
      type: videoFile.type || 'video/mp4',
      clientFileId: (videoFile as any)?.clientFileId,
      localKey: (videoFile as any)?.localKey,
      mediaId: (videoFile as any)?.mediaId || (videoFile as any)?.clientFileId,
      sourceUri: videoFile.uri,
      lotId,
      slot: 'video',
      index,
      captureOrder: (videoFile as any)?.captureOrder,
      originalOrder: (videoFile as any)?.originalOrder,
    };
  }
  if (
    existingVideo &&
    existingVideo.sourceUri === videoFile.uri &&
    (await ensureUriExists(existingVideo.uri))
  ) {
    return existingVideo;
  }

  if (draftId) {
    const imported = await LocalMediaStore.importMedia({
      draftId,
      lotId,
      slot: 'video',
      index,
      sourceUri: videoFile.uri,
      name: videoFile.name,
      type: videoFile.type || 'video/mp4',
      mediaId: (videoFile as SavedVideoFileData).mediaId || existingVideo?.mediaId,
    });
    if (!imported) return { ...videoFile, name: videoFile.name || `video-${index}.mp4`, type: videoFile.type || 'video/mp4', availability: 'missing' };
    return {
      ...videoFile,
      uri: imported.uri,
      name: imported.name,
      type: imported.type,
      mediaId: imported.mediaId,
      ownership: imported.ownership,
      availability: 'available',
      sourceUri: videoFile.uri,
      size: imported.size,
      lotId,
      slot: 'video',
      index,
      createdAt: existingVideo?.createdAt || imported.createdAt,
    };
  }

  const ext = getFileExtension(videoFile.name || videoFile.uri, 'mp4');
  const persistedUri = await copyToDirectory(
    videoFile.uri,
    generateFilename(lotId, 'video', index, ext),
    destinationDir
  );

  if (!persistedUri) return null;

  return {
    ...videoFile,
    uri: persistedUri,
    name: videoFile.name || `video-${index}.${ext}`,
    type: videoFile.type || 'video/mp4',
    sourceUri: videoFile.uri,
    size: await getFileSize(persistedUri),
    lotId,
    slot: 'video',
    index,
  };
};

const asSavedPhoto = (value?: SavedPhotoFileData | string): SavedPhotoFileData | string | null =>
  value || null;
const existingPhotoFor = (images: SavedLotData['mainImages'] | undefined, photo: PhotoFile) => {
  const original = getPhotoOriginalUri(photo);
  return images?.find((image) => typeof image === 'string' ? image === original :
    (photo.mediaId && photo.mediaId === image.mediaId) ||
    [image.uri, image.originalUri, image.sourceUri].includes(original));
};

const getExistingLot = (existingLots: SavedLotData[] | undefined, lotId: string, index: number) =>
  existingLots?.find((lot) => lot.id === lotId) || existingLots?.[index];

const persistLotsForStorage = async (
  lots: AutoSaveLotInput[],
  destinationDir: string,
  keepManagedEditedUri = true,
  existingLots?: SavedLotData[],
  draftId?: string
): Promise<SavedLotData[]> =>
  Promise.all(
    lots.map(async (lot, lotIndex) => {
      const existingLot = getExistingLot(existingLots, lot.id, lotIndex);
      const mainImages = (
        await Promise.all(
          lot.files.map((file, index) =>
            persistPhotoFile(
              file,
              lot.id,
              'main',
              index,
              destinationDir,
              keepManagedEditedUri,
              asSavedPhoto(existingPhotoFor(existingLot?.mainImages, file)),
              draftId
            )
          )
        )
      ).filter(Boolean) as SavedPhotoFileData[];

      const extraImages = (
        await Promise.all(
          lot.extraFiles.map((file, index) =>
            persistPhotoFile(
              file,
              lot.id,
              'extra',
              index,
              destinationDir,
              keepManagedEditedUri,
              asSavedPhoto(existingPhotoFor(existingLot?.extraImages, file)),
              draftId
            )
          )
        )
      ).filter(Boolean) as SavedPhotoFileData[];

      const videoCandidates = lot.videoFile
        ? [lot.videoFile]
        : Array.isArray(lot.videoFiles)
          ? lot.videoFiles
          : [];

      const videoFiles = (
        await Promise.all(
          videoCandidates.map((video, index) =>
            persistVideoFile(video, lot.id, index, destinationDir, existingLot?.videoFiles?.[index], draftId)
          )
        )
      ).filter(Boolean) as SavedVideoFileData[];

      return {
        id: lot.id,
        lotNumber: lot.lotNumber,
        title: lot.title,
        mode: lot.mode,
        mainImages,
        extraImages,
        videoFiles,
        coverIndex: lot.coverIndex,
      };
    })
  );

const getDraftKeepUris = (draft: Pick<OfflineReportDraft, 'lots'>): string[] => {
  const keep: string[] = [];
  for (const lot of draft.lots) {
    for (const image of [...lot.mainImages, ...lot.extraImages]) {
      if (typeof image === 'string') {
        keep.push(image);
      } else {
        keep.push(image.uri, image.originalUri || '', image.editedUri || '', image.displayUri || '', image.thumbnailUri || '');
      }
    }
    for (const video of lot.videoFiles || []) {
      keep.push(typeof video === 'string' ? video : video.uri);
    }
  }
  return keep.filter(Boolean);
};

const getDraftSourceUris = (draft: Pick<OfflineReportDraft, 'lots'>): string[] => {
  const uris: string[] = [];
  for (const lot of draft.lots) {
    for (const image of [...lot.mainImages, ...lot.extraImages]) {
      if (typeof image !== 'string') uris.push(image.sourceUri || '');
    }
    for (const video of lot.videoFiles || []) {
      if (typeof video !== 'string') uris.push(video.sourceUri || '');
    }
  }
  return uris.filter(Boolean);
};

const countDraftMedia = (draft: Pick<OfflineReportDraft, 'lots'>) =>
  draft.lots.reduce(
    (total, lot) =>
      total + lot.mainImages.length + lot.extraImages.length + (lot.videoFiles?.length || 0),
    0
  );

const countInputMedia = (lots: AutoSaveLotInput[]) =>
  lots.reduce(
    (total, lot) =>
      total + (lot.files?.length || 0) + (lot.extraFiles?.length || 0) + (lot.videoFile ? 1 : 0) + (lot.videoFiles?.length || 0),
    0
  );

const formatBytes = (bytes: number): string => {
  const gb = bytes / (1024 * 1024 * 1024);
  const mb = bytes / (1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return bytes > 0 ? '<1 MB' : '0 MB';
};

const getDeviceStorageStats = async (): Promise<{
  availableBytes?: number;
  totalBytes?: number;
}> => {
  const [available, total] = await Promise.all([
    FileSystem.getFreeDiskStorageAsync().catch(() => undefined),
    FileSystem.getTotalDiskCapacityAsync().catch(() => undefined),
  ]);

  return {
    availableBytes: typeof available === 'number' && Number.isFinite(available) ? available : undefined,
    totalBytes: typeof total === 'number' && Number.isFinite(total) ? total : undefined,
  };
};

const getLocalUrisSize = async (uris: Iterable<string | undefined | null>): Promise<number> => {
  const uniqueUris = new Set(
    Array.from(uris)
      .filter(Boolean)
      .map((uri) => String(uri))
      .filter((uri) => !/^https?:\/\//i.test(uri))
  );

  let total = 0;
  for (const uri of uniqueUris) {
    total += (await getFileSize(uri)) || 0;
  }
  return total;
};

const makeDraftId = (type: OfflineDraftType) =>
  `${type}-draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const normalizeDraftContractNo = (value?: string | null) =>
  String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const getDraftNormalizedContractNo = (draft: Partial<OfflineReportDraft>) =>
  normalizeDraftContractNo(
    draft.normalizedContractNo || draft.contractNo || draft.formData?.contractNo
  );

const draftTitleFor = (type: OfflineDraftType, formData: AutoSaveFormData, fallback?: string) => {
  const trimmedFallback = fallback?.trim();
  if (trimmedFallback) return trimmedFallback;
  if (type === 'asset') {
    return formData.clientName?.trim() || formData.contractNo?.trim() || 'Asset Report';
  }
  return formData.contractNo?.trim() || formData.location?.trim() || 'Lot Listing';
};

const loadDraftsRaw = () => OfflineCaptureStore.listDrafts();

const normalizeAutoSaveData = async (parsed: AutoSaveData): Promise<AutoSaveData> => {
  for (const [lotIndex, lot] of parsed.lots.entries()) {
    lot.mainImages = (
      await Promise.all(
        lot.mainImages.map((image, imageIndex) =>
          normalizeSavedPhotoFile(image, `restored-main-${lotIndex}-${imageIndex}.jpg`)
        )
      )
    ).filter(Boolean) as SavedLotData['mainImages'];

    lot.extraImages = (
      await Promise.all(
        lot.extraImages.map((image, imageIndex) =>
          normalizeSavedPhotoFile(image, `restored-extra-${lotIndex}-${imageIndex}.jpg`)
        )
      )
    ).filter(Boolean) as SavedLotData['extraImages'];

    lot.videoFiles = (
      await Promise.all(
        (lot.videoFiles || []).map((video, videoIndex) =>
          normalizeSavedVideoFile(video, `restored-video-${lotIndex}-${videoIndex}.mp4`)
        )
      )
    ).filter(Boolean) as SavedLotData['videoFiles'];
  }

  return parsed;
};

const normalizeDraftForRead = async (draft: OfflineReportDraft): Promise<OfflineReportDraft> => {
  const data: AutoSaveData = {
    formData: draft.formData,
    lots: draft.lots,
    activeLotIdx: draft.activeLotIdx,
    savedAt: draft.updatedAt,
    formType: draft.type,
  };

  const normalized = await normalizeAutoSaveData(data);

  return {
    ...draft,
    contractNo: draft.contractNo || normalized.formData.contractNo?.trim() || undefined,
    normalizedContractNo: getDraftNormalizedContractNo({
      ...draft,
      formData: normalized.formData,
    }) || undefined,
    formData: normalized.formData,
    lots: normalized.lots,
    activeLotIdx: normalized.activeLotIdx,
  };
};

export const AutoSaveService = {
  setOwner(ownerId: string | null) {
    setUploadOwner(ownerId);
    OfflineCaptureStore.setOwner(ownerId);
    LocalMediaStore.setOwner(ownerId);
    durableReportTransfer.setOwner(ownerId);
  },
  initialize: () => OfflineCaptureStore.initialize(),
  listLegacyDrafts: () => OfflineCaptureStore.listLegacyDrafts(),
  claimLegacyDraft: (id: string) => OfflineCaptureStore.claimLegacyDraft(id),
  getDraftSummaries: (type?: OfflineDraftType) => OfflineCaptureStore.listSummaries(type),
  async migrateLegacyAutoSaveIfNeeded(): Promise<void> {
    await OfflineCaptureStore.initialize();
  },

  async getDrafts(type?: OfflineDraftType): Promise<OfflineReportDraft[]> {
    const ownerId = OfflineCaptureStore.getOwnerId();
    await this.migrateLegacyAutoSaveIfNeeded();
    if (ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('The signed-in account changed while opening drafts.');
    const drafts = await loadDraftsRaw();
    const filtered = type ? drafts.filter((draft) => draft.type === type) : drafts;
    const normalized = await Promise.all(filtered.map((draft) => normalizeDraftForRead(draft)));
    if (ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('The signed-in account changed while opening drafts.');
    return normalized.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  },

  async getDraft(id: string): Promise<OfflineReportDraft | null> {
    const ownerId = OfflineCaptureStore.getOwnerId();
    const draft = await OfflineCaptureStore.getDraft(id);
    const normalized = draft ? await normalizeDraftForRead(draft) : null;
    if (ownerId !== OfflineCaptureStore.getOwnerId()) throw new Error('The signed-in account changed while opening this draft.');
    return normalized;
  },

  async saveDraft(args: {
    explicitActivitySave?: boolean;
    id?: string | null;
    type: OfflineDraftType;
    title?: string;
    formData: AutoSaveFormData;
    lots: AutoSaveLotInput[];
    activeLotIdx: number;
    captureMode?: CaptureModePreference;
  }): Promise<OfflineReportDraft> {
    const ownerId = OfflineCaptureStore.getOwnerId();
    if (!ownerId) throw new Error('Sign in before saving a report draft.');
    await this.migrateLegacyAutoSaveIfNeeded();
    if (OfflineCaptureStore.getOwnerId() !== ownerId) throw new Error('The signed-in account changed while saving.');
    return serializeDraftSave(`${ownerId}:${args.id || args.formData.clientSubmissionId || makeDraftId(args.type)}`, async () => {
    if (OfflineCaptureStore.getOwnerId() !== ownerId) throw new Error('The signed-in account changed while saving.');
    const contractNo = args.formData.contractNo?.trim();
    const normalizedContractNo = normalizeDraftContractNo(contractNo);
    if (!normalizedContractNo && (args.captureMode || args.formData.captureMode || 'online') !== 'offline') {
      throw new Error('Contract number is required before saving this draft.');
    }

    // A contract groups multiple independent reports; only an exact draft ID is a retry.
    const existing = args.id ? await OfflineCaptureStore.getDraft(args.id) : null;
    const formData: AutoSaveFormData = { ...existing?.formData, ...args.formData,
      clientSubmissionId: args.formData.clientSubmissionId || existing?.formData.clientSubmissionId,
      auctioneerWorkItemId: args.formData.auctioneerWorkItemId || existing?.formData.auctioneerWorkItemId,
      auctioneerSnapshot: args.formData.auctioneerSnapshot || existing?.formData.auctioneerSnapshot,
      auctionsoftSnapshot: args.formData.auctionsoftSnapshot || existing?.formData.auctionsoftSnapshot,
    };
    if (existing?.formData.legacyRequiresIncomingReview) {
      const currentSetup = args.formData.auctioneerSnapshot;
      const currentTask = args.formData.auctionsoftSnapshot;
      const verifiedModern = !!currentSetup && currentSetup.workItemId === existing.formData.auctioneerWorkItemId &&
        currentSetup.clientSubmissionId === existing.formData.clientSubmissionId && currentSetup.reportType === args.type &&
        currentSetup.contract.contractNo === existing.formData.contractNo;
      const verifiedLegacy = !!currentTask && currentTask.task.rowGuid === (existing.formData.auctionsoft?.taskId || existing.formData.auctionManagementTaskId) &&
        currentTask.contract.rowGuid === existing.formData.auctionsoft?.contractId;
      formData.legacyRequiresIncomingReview = !(verifiedModern || verifiedLegacy);
    }
    const id = existing?.id || args.id || makeDraftId(args.type);
    const now = new Date().toISOString();
    const lots = await persistLotsForStorage(
      args.lots,
      getDraftImagesDir(id),
      false,
      existing?.lots,
      id
    );
    const expectedMedia = countInputMedia(args.lots);
    const persistedMedia = countDraftMedia({ lots } as OfflineReportDraft);
    if (expectedMedia > 0 && persistedMedia < expectedMedia) {
      throw new Error(
        `Draft media save failed: saved ${persistedMedia} of ${expectedMedia} captured file(s). Keep the form open and try saving again.`
      );
    }

    const draft: OfflineReportDraft = {
      ...existing,
      ownerId,
      captureMode: args.captureMode || args.formData.captureMode || existing?.captureMode || 'online',
      id,
      type: args.type,
      title: draftTitleFor(args.type, args.formData, args.title),
      contractNo,
      normalizedContractNo,
      cloudId: existing?.cloudId,
      cloudSyncedAt: existing?.cloudSyncedAt,
      formData,
      lots,
      activeLotIdx: args.activeLotIdx,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const saved = existing ? await OfflineCaptureStore.updateDraft(id, (current) => ({ ...current, ...draft,
      localRevision: current.localRevision, cloudId: current.cloudId, cloudSyncedAt: current.cloudSyncedAt,
      cloudSyncError: current.cloudSyncError, cloudSyncErrorKind: current.cloudSyncErrorKind,
      cloudSyncRetryAt: current.cloudSyncRetryAt, cloudSyncAttempts: current.cloudSyncAttempts,
      cloudSyncLastAttemptAt: current.cloudSyncLastAttemptAt,
    }), args.explicitActivitySave) : await OfflineCaptureStore.saveDraft(draft, args.explicitActivitySave);
    await flushBackupHandoff();
    // A contract number is not draft identity. Even a photo-free draft can
    // contain valuable typed work, so saving this draft never hides another.
    return saved;
    });
  },

  async markDraftCloudSynced(
    id: string,
    cloudId: string,
    expectedUpdatedAt?: string,
    expectedOwnerId?: string,
    expectedLocalRevision?: number
  ): Promise<void> {
    if (expectedOwnerId && OfflineCaptureStore.getOwnerId() !== expectedOwnerId) return;
    const now = new Date().toISOString();
    // Bookkeeping only: no new revision, so an upload already queued from this
    // revision still matches when the server accepts it.
    await OfflineCaptureStore.updateDraftSyncState(id, (draft) =>
        (!expectedOwnerId || draft.ownerId === expectedOwnerId) &&
        (!expectedUpdatedAt || draft.updatedAt === expectedUpdatedAt) &&
        (expectedLocalRevision === undefined || draft.localRevision === expectedLocalRevision)
          ? {
              cloudId,
              cloudSyncedAt: now,
              cloudSyncError: undefined,
              cloudSyncErrorKind: undefined,
              cloudSyncRetryAt: undefined,
              cloudSyncAttempts: undefined,
              cloudSyncLastAttemptAt: undefined,
            }
          : null
    );
  },

  async markDraftCloudSyncError(
    id: string,
    message: string,
    metadata: {
      kind?: DraftCloudSyncErrorKind;
      retryAt?: number;
      attempts?: number;
      lastAttemptAt?: string;
      expectedOwnerId?: string;
      expectedUpdatedAt?: string;
      expectedLocalRevision?: number;
    } = {}
  ): Promise<void> {
    if (metadata.expectedOwnerId && OfflineCaptureStore.getOwnerId() !== metadata.expectedOwnerId) return;
    // Bookkeeping only, written without a new revision (see markDraftCloudSynced).
    await OfflineCaptureStore.updateDraftSyncState(id, (draft) =>
      (metadata.expectedOwnerId && draft.ownerId !== metadata.expectedOwnerId) ||
      (metadata.expectedUpdatedAt && draft.updatedAt !== metadata.expectedUpdatedAt) ||
      (metadata.expectedLocalRevision !== undefined && draft.localRevision !== metadata.expectedLocalRevision)
        ? null : ({
              cloudSyncError: message,
              cloudSyncErrorKind: metadata.kind,
              cloudSyncRetryAt: metadata.retryAt,
              cloudSyncAttempts: metadata.attempts,
              cloudSyncLastAttemptAt: metadata.lastAttemptAt,
            }));
  },

  async saveCloudDraftSnapshot(args: {
    ownerId: string;
    id?: string;
    cloudId?: string;
    type: OfflineDraftType;
    title?: string;
    contractNo?: string;
    normalizedContractNo?: string;
    formData: AutoSaveFormData;
    lots: SavedLotData[];
    activeLotIdx: number;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<OfflineReportDraft> {
    const ownerId = args.ownerId;
    if (!ownerId || OfflineCaptureStore.getOwnerId() !== ownerId) {
      throw new Error('The signed-in account changed. Reopen this draft from its owner account.');
    }
    const now = new Date().toISOString();
    const contractNo = args.contractNo || args.formData.contractNo?.trim();
    const normalizedContractNo = args.normalizedContractNo || normalizeDraftContractNo(contractNo);
    if (!normalizedContractNo) {
      throw new Error('Contract number is required before saving this draft.');
    }

    const saved = await OfflineCaptureStore.createCloudDraft({
      ownerId,
      id: args.id || makeDraftId(args.type),
      type: args.type,
      title: draftTitleFor(args.type, args.formData, args.title),
      contractNo,
      normalizedContractNo,
      cloudId: args.cloudId,
      cloudSyncedAt: now,
      formData: args.formData,
      lots: args.lots,
      activeLotIdx: args.activeLotIdx,
      createdAt: args.createdAt || now,
      updatedAt: args.updatedAt || now,
    }, ownerId);
    const normalized = await normalizeDraftForRead(saved);
    if (OfflineCaptureStore.getOwnerId() !== ownerId) {
      throw new Error('The signed-in account changed while restoring this draft.');
    }
    return normalized;
  },

  async deleteDraft(id: string): Promise<void> {
    await OfflineCaptureStore.setSubmissionState(id, 'discarded');
  },

  async removeDraftRecordOnly(id: string): Promise<void> {
    const draft = await OfflineCaptureStore.getDraft(id);
    if (!draft) return;
    // An acceptance receipt must remain available to the metadata outbox after UI cleanup.
    if (draft.submissionState !== 'accepted' && draft.submissionState !== 'submitted') {
      await OfflineCaptureStore.setSubmissionState(id, 'discarded');
    }
  },

  async deleteDraftMedia(id: string): Promise<void> {
    const owner = OfflineCaptureStore.getOwnerId();
    // Gallery/camera originals are user-owned. Managed copies are only pruned after all
    // owners, queued submissions and legacy recovery references have been considered.
    const protectedUris = await OfflineCaptureStore.getProtectedMediaUris();
    if (OfflineCaptureStore.getOwnerId() !== owner) throw new Error('The signed-in account changed before cleaning local media.');
    await LocalMediaStore.pruneDraftFiles(id, protectedUris);
  },

  async getLocalStorageSummary(
    extraFileUris: string[] = [],
    extraCounts: { images?: number; videos?: number } = {}
  ): Promise<{
    bytes: number;
    formatted: string;
    drafts: number;
    images: number;
    videos: number;
    availableBytes?: number;
    availableFormatted?: string;
    totalBytes?: number;
    totalFormatted?: string;
  }> {
    const drafts = await this.getDrafts();
    const counts = drafts.reduce(
      (acc, draft) => {
        for (const lot of draft.lots) {
          acc.images += lot.mainImages.length + lot.extraImages.length;
          acc.videos += lot.videoFiles?.length || 0;
        }
        return acc;
      },
      { images: 0, videos: 0 }
    );
    const bytes = await getLocalUrisSize([
      ...drafts.flatMap((draft) => getDraftKeepUris(draft)),
      ...extraFileUris,
    ]);
    const device = await getDeviceStorageStats();

    return {
      bytes,
      formatted: formatBytes(bytes),
      drafts: drafts.length,
      images: counts.images + (extraCounts.images || 0),
      videos: counts.videos + (extraCounts.videos || 0),
      availableBytes: device.availableBytes,
      availableFormatted:
        device.availableBytes !== undefined ? formatBytes(device.availableBytes) : undefined,
      totalBytes: device.totalBytes,
      totalFormatted: device.totalBytes !== undefined ? formatBytes(device.totalBytes) : undefined,
    };
  },

  async cleanupOrphanedMedia(activeFileUris: string[] = [], maxNativeCacheAgeMs?: number): Promise<number> {
    const owner = OfflineCaptureStore.getOwnerId();
    const assertOwner = () => { if (OfflineCaptureStore.getOwnerId() !== owner) throw new Error('The signed-in account changed while cleaning local media.'); };
    const drafts = await loadDraftsRaw();
    assertOwner();
    const activeUris = [
      ...await OfflineCaptureStore.getProtectedMediaUris(),
      ...activeFileUris,
      ...drafts.flatMap((draft) => getDraftKeepUris(draft)),
      ...drafts.flatMap((draft) => getDraftSourceUris(draft)),
    ];
    assertOwner();
    const deletedDraftBytes = await LocalMediaStore.cleanupOrphanedDraftFolders(
      drafts.map((draft) => draft.id),
      activeUris
    );
    assertOwner();
    const deletedNativeBytes = await LocalMediaStore.cleanupNativeCameraCache(
      activeUris,
      maxNativeCacheAgeMs
    );
    assertOwner();
    return deletedDraftBytes + deletedNativeBytes;
  },

  async getDraftSummary(): Promise<{ total: number; asset: number; lotListing: number }> {
    const drafts = await this.getDrafts();
    return {
      total: drafts.length,
      asset: drafts.filter((draft) => draft.type === 'asset').length,
      lotListing: drafts.filter((draft) => draft.type === 'lotListing').length,
    };
  },

  async hasAutoSave(): Promise<boolean> {
    try {
      const data = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      return data !== null;
    } catch (error) {
      console.error('Error checking auto-save:', error);
      return false;
    }
  },

  async getAutoSave(): Promise<AutoSaveData | null> {
    try {
      const data = await AsyncStorage.getItem(AUTO_SAVE_KEY);
      if (!data) return null;

      const parsed: AutoSaveData = JSON.parse(data);
      if (parsed.formType === 'asset' || parsed.formType === 'lotListing') return null;
      return normalizeAutoSaveData(parsed);
    } catch (error) {
      console.error('Error getting auto-save:', error);
      return null;
    }
  },

  async saveAutoSave(
    formData: AutoSaveFormData,
    lots: AutoSaveLotInput[],
    activeLotIdx: number,
    formType: 'asset' | 'realEstate' | 'lotListing' = 'asset'
  ): Promise<void> {
    if (formType === 'asset' || formType === 'lotListing') {
      await this.saveDraft({ type: formType, formData, lots, activeLotIdx });
      return;
    }
    try {
      await ensureDirectoryExists();

      const savedLots = await persistLotsForStorage(lots, getAutoSaveImagesDir(), true);

      const autoSaveData: AutoSaveData = {
        formData,
        lots: savedLots,
        activeLotIdx,
        savedAt: new Date().toISOString(),
        formType,
      };

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(autoSaveData));
    } catch (error) {
      console.error('Error saving auto-save:', error);
      throw error;
    }
  },

  async saveImage(
    lotId: string,
    imageUri: string,
    type: 'main' | 'extra' | 'video',
    index: number
  ): Promise<string> {
    try {
      const ext = type === 'video' ? 'mp4' : 'jpg';
      return await copyToAutoSaveDir(imageUri, generateFilename(lotId, type, index, ext));
    } catch (error) {
      console.error('Error saving image:', error);
      return '';
    }
  },

  async deleteAutoSave(): Promise<void> {
    await OfflineCaptureStore.initialize();
    const raw = await AsyncStorage.getItem(AUTO_SAVE_KEY);
    if (raw) {
      const legacy = JSON.parse(raw) as AutoSaveData;
      if (legacy.formType === 'asset' || legacy.formType === 'lotListing') return;
    }
    try {
      const existing = await this.getAutoSave();
      if (existing) {
        for (const lot of existing.lots) {
          for (const image of lot.mainImages) {
            if (typeof image === 'string') {
              await deleteLocalFile(image);
            } else {
              await deleteLocalFile(image.uri);
              await deleteLocalFile(image.originalUri);
              await deleteLocalFile(image.editedUri);
            }
          }

          for (const image of lot.extraImages) {
            if (typeof image === 'string') {
              await deleteLocalFile(image);
            } else {
              await deleteLocalFile(image.uri);
              await deleteLocalFile(image.originalUri);
              await deleteLocalFile(image.editedUri);
            }
          }

          for (const video of lot.videoFiles || []) {
            await deleteLocalFile(typeof video === 'string' ? video : video.uri);
          }
        }
      }

      const dirInfo = await FileSystem.getInfoAsync(getAutoSaveImagesDir());
      if (dirInfo.exists) {
        await FileSystem.deleteAsync(getAutoSaveImagesDir(), { idempotent: true });
      }

      await AsyncStorage.removeItem(AUTO_SAVE_KEY);
    } catch (error) {
      console.error('Error deleting auto-save:', error);
      throw error;
    }
  },

  async getAutoSaveSummary(): Promise<{
    exists: boolean;
    savedAt?: string;
    totalImages?: number;
    totalLots?: number;
    formType?: string;
  }> {
    try {
      const data = await this.getAutoSave();
      if (!data) {
        return { exists: false };
      }

      const totalImages = data.lots.reduce(
        (sum, lot) => sum + lot.mainImages.length + lot.extraImages.length,
        0
      );

      return {
        exists: true,
        savedAt: data.savedAt,
        totalImages,
        totalLots: data.lots.length,
        formType: data.formType,
      };
    } catch (error) {
      console.error('Error getting auto-save summary:', error);
      return { exists: false };
    }
  },

  async updateFormData(formData: AutoSaveFormData): Promise<void> {
    try {
      const existing = await this.getAutoSave();
      if (!existing) return;

      existing.formData = { ...existing.formData, ...formData };
      existing.savedAt = new Date().toISOString();

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(existing));
    } catch (error) {
      console.error('Error updating form data:', error);
    }
  },

  async updateLots(lots: SavedLotData[], activeLotIdx: number): Promise<void> {
    try {
      const existing = await this.getAutoSave();
      if (!existing) return;

      existing.lots = lots;
      existing.activeLotIdx = activeLotIdx;
      existing.savedAt = new Date().toISOString();

      await AsyncStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(existing));
    } catch (error) {
      console.error('Error updating lots:', error);
    }
  },
};

export default AutoSaveService;
