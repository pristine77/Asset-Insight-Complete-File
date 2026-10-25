import type { OfflineDraftType, SavedLotData, SavedPhotoFileData } from './autoSaveService';
import type { ReportDraft } from './reportDraftService';

export type CloudDraftExpectation = {
  cloudId: string;
  clientDraftId?: string;
  type?: OfflineDraftType;
  revision?: number;
  ownerId?: string;
};

const fail = (message: string): never => {
  throw new Error(`${message} Your saved draft and original photos are unchanged. Open the original draft on the device used to capture it, or retry after its upload completes.`);
};

/** A detail response is not interchangeable with a cached row or another draft. */
export function assertCloudDraftIdentity(cloud: ReportDraft, expected: CloudDraftExpectation): void {
  if (!cloud || typeof cloud !== 'object' || !expected.cloudId ||
      String(cloud.id || cloud._id || '') !== expected.cloudId ||
      (cloud.id && cloud._id && cloud.id !== cloud._id) ||
      (expected.clientDraftId && cloud.clientDraftId !== expected.clientDraftId) ||
      (expected.type && cloud.type !== expected.type)) {
    fail('The server returned a different draft. Refresh Drafts before continuing.');
  }
  const owner = typeof cloud.user === 'object' ? cloud.user?._id : cloud.user;
  if (expected.ownerId && owner && owner !== expected.ownerId) {
    fail('This draft belongs to a different signed-in account.');
  }
  if (expected.revision !== undefined &&
      (!Number.isFinite(cloud.revision) || Number(cloud.revision) < expected.revision)) {
    fail('The saved draft changed while it was loading. Refresh Drafts before continuing.');
  }
}

/**
 * All-or-nothing metadata hydration. Pending descriptors are evidence of missing
 * uploads, never permission to silently restore an empty/partial photo array.
 * This checks server verification receipts; it does not download original bytes.
 */
export function hydrateCompleteCloudDraft(cloud: ReportDraft, expected: CloudDraftExpectation): SavedLotData[] {
  assertCloudDraftIdentity(cloud, expected);
  if (cloud.storageMode === 'smart_upload') fail('Open this Smart Upload draft in the web app to review its grouping.');
  if (cloud.storageMode === 'local_media') fail('This draft stores its originals only on the capture device.');
  if (!Array.isArray(cloud.lots) || !Array.isArray(cloud.media) ||
      !cloud.formData || typeof cloud.formData !== 'object' || Array.isArray(cloud.formData)) {
    fail('The complete saved draft could not be loaded.');
  }
  const manifest = cloud.media!;

  const lots = cloud.lots.map((lot): SavedLotData => {
    if (!lot || typeof lot.id !== 'string' || !lot.id.trim()) fail('The saved lot mapping is incomplete.');
    return { ...lot, coverIndex: lot.coverIndex ?? 0, mainImages: [], extraImages: [], videoFiles: [] };
  });
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  if (lotById.size !== lots.length) fail('The saved draft contains duplicate lot identifiers.');
  const ids = new Set<string>();
  const positions = new Set<string>();
  let incomplete = 0;
  for (const item of manifest) {
    if (!item || typeof item.clientFileId !== 'string' || !item.clientFileId.trim() ||
        ids.has(item.clientFileId) || !lotById.has(item.lotId) ||
        !['main', 'extra', 'video'].includes(item.slot) || !Number.isInteger(item.index) || item.index < 0) {
      fail('The saved photo mapping is incomplete or inconsistent.');
    }
    ids.add(item.clientFileId);
    const position = JSON.stringify([item.lotId, item.slot, item.index]);
    if (positions.has(position)) fail('Two saved media files occupy the same lot position.');
    positions.add(position);
    if (item.originalOrder !== undefined) {
      if (!Number.isInteger(item.originalOrder) || item.originalOrder < 0) {
        fail('The saved media order is inconsistent.');
      }
    }
    const verifiedSize = Number(item.verifiedSize);
    if (!item.uploadedAt || !Number.isFinite(Date.parse(item.uploadedAt)) ||
        typeof item.url !== 'string' || !/^https?:\/\/[^\s/]+(?:\/|$)/i.test(item.url) ||
        !Number.isFinite(verifiedSize) || verifiedSize <= 0 ||
        (Number(item.size) > 0 && verifiedSize !== Number(item.size))) incomplete++;
    if ((item.slot === 'video' && item.mimeType?.startsWith('image/')) ||
        (item.slot !== 'video' && item.mimeType?.startsWith('video/'))) {
      fail('A saved photo or video has the wrong media type.');
    }
  }
  if (incomplete) fail(`${incomplete} of ${manifest.length} draft media files have not been completely uploaded and verified.`);

  // The slot index is the saved editing position. Legacy capture order may be
  // per-lot rather than global, and must not move photos or change coverIndex.
  const media = [...manifest].sort((a, b) => a.index - b.index);
  for (const item of media) {
    const lot = lotById.get(item.lotId)!;
    const target = item.slot === 'main' ? lot.mainImages : item.slot === 'extra' ? lot.extraImages : lot.videoFiles;
    if (target.length !== item.index) fail('The saved photo sequence has missing positions.');
    const saved: SavedPhotoFileData = {
      uri: item.url!, originalUri: item.url!, displayUri: item.url!,
      name: item.name || `${item.slot}-${item.index + 1}.${item.slot === 'video' ? 'mp4' : 'jpg'}`,
      type: item.mimeType || (item.slot === 'video' ? 'video/mp4' : 'image/jpeg'),
      clientFileId: item.clientFileId, localKey: item.localKey,
      mediaId: item.mediaId || item.clientFileId, lotId: item.lotId,
      ...(item.slot !== 'video' ? { slot: item.slot } : {}),
      index: item.index, captureOrder: item.captureOrder, originalOrder: item.originalOrder,
      size: item.verifiedSize, timestamp: item.lastModified,
    };
    if (item.slot === 'video') {
      lot.videoFiles.push({ ...saved, slot: 'video' });
    } else if (item.slot === 'main') lot.mainImages.push(saved);
    else lot.extraImages.push(saved);
  }
  lots.forEach((lot, index) => {
    const saved = cloud.lots[index];
    // Old embedded arrays must never silently disappear behind an empty manifest.
    for (const key of ['mainImages', 'extraImages', 'videoFiles'] as const) {
      if (Array.isArray(saved[key]) && saved[key].length && saved[key].length !== lot[key].length) {
        fail('The saved media manifest does not include every original.');
      }
    }
    const photoCount = lot.mainImages.length + lot.extraImages.length;
    if (!Number.isInteger(lot.coverIndex) || lot.coverIndex < -1 ||
        (photoCount > 0 ? lot.coverIndex >= photoCount : lot.coverIndex > 0)) {
      fail('The saved cover photo no longer matches the complete lot.');
    }
  });
  return lots;
}
