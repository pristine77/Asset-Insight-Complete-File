import type { OfflineReportDraft, SavedPhotoFileData } from './autoSaveService';

export type BackupMedia = {
  clientFileId: string; lotId: string; slot: 'main' | 'extra' | 'video'; index: number;
  name: string; mimeType: string; size: number; uri: string;
};
export type CaptureBackupSnapshot = {
  ownerId: string; clientDraftId: string; captureId: string; type: 'asset' | 'lotListing';
  revision: number; contractNo: string; title: string; formData: Record<string, unknown>;
  lots: Record<string, unknown>[]; media: BackupMedia[]; activeLotIdx: number;
};

export function backupOriginalUri(value: { uri?: string; originalUri?: string; sourceUri?: string } | string): string {
  return typeof value === 'string' ? value : value.originalUri || value.uri || value.sourceUri || '';
}

// Only local references are stripped. User-authored values and the saved lot order
// stay intact; original bytes travel solely through the native streaming worker.
const localReference = /^(?:(?:file|content|ph|assets-library|asset):\/{1,2}|data:[^,\s]*,)|^\/(?:data|storage|private|Users|var)\//i;
const localKeys = new Set(['uri', 'originalUri', 'editedUri', 'displayUri', 'thumbnailUri', 'sourceUri', 'cacheUri']);
function metadata(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('The saved details are too deeply nested to back up.');
  if (typeof value === 'string') return localReference.test(value) ? undefined : value;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(item => metadata(item, depth + 1)).filter(item => item !== undefined);
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !localKeys.has(key))
    .map(([key, item]) => [key, metadata(item, depth + 1)]).filter(([, item]) => item !== undefined));
}
function identity(value: string): string {
  let a = 2166136261; let b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

export function isBackupCandidate(draft: OfflineReportDraft): boolean {
  return ['asset', 'lotListing'].includes(draft.type)
    && !['accepted', 'submitted', 'discarded'].includes(draft.submissionState || '')
    && Boolean(draft.captureMode === 'offline' || draft.manualSubmissionRequired || draft.formData?.manualSubmissionRequired);
}

/** Compare content, not timestamps/receipt metadata, to avoid a backup feedback loop. */
export function backupContent(draft: OfflineReportDraft): string {
  return JSON.stringify([draft.type, draft.captureId, draft.title, draft.contractNo, draft.formData, draft.lots]);
}

export function createCaptureBackupSnapshot(draft: OfflineReportDraft): CaptureBackupSnapshot {
  if (!draft.ownerId || !draft.captureId || !Number.isSafeInteger(draft.localRevision) || draft.localRevision! < 1) {
    throw new Error('Save this draft on your device before backing it up.');
  }
  if (!isBackupCandidate(draft)) throw new Error('This capture is not an editable offline draft.');
  if (draft.lots.length > 1000) throw new Error('A backup may contain at most 1,000 lots.');
  const media: BackupMedia[] = [];
  const ids = new Set<string>();
  const lots = draft.lots.map((lot) => {
    if (!lot.id || ids.has(`lot:${lot.id}`)) throw new Error('The saved lot identities need attention.');
    ids.add(`lot:${lot.id}`);
    for (const [slot, files] of [['main', lot.mainImages], ['extra', lot.extraImages], ['video', lot.videoFiles || []]] as const) {
      files.forEach((item, index) => {
        const source: Partial<Omit<SavedPhotoFileData, 'slot'>> = typeof item === 'string' ? { uri: item } : item;
        const uri = backupOriginalUri(source);
        if (!uri || !/^(?:file|content):/i.test(uri) || source.missing || source.availability === 'missing') {
          throw new Error(`Lot ${lot.lotNumber || lot.id}, ${slot === 'video' ? 'video' : 'photo'} ${index + 1} is not available on this phone. Keep the originals and reopen the draft.`);
        }
        const storedId = source.clientFileId || source.mediaId || source.localKey;
        // Identity includes the slot so legitimate shared references stay separate.
        const clientFileId = `backup-${identity(`${lot.id}|${slot}|${index}|${storedId || uri}`)}`;
        if (ids.has(clientFileId)) throw new Error('Two originals have conflicting backup identities.');
        ids.add(clientFileId);
        media.push({ clientFileId, lotId: lot.id, slot, index, uri,
          name: source.name || `${slot}-${index + 1}.${slot === 'video' ? 'mp4' : 'jpg'}`,
          mimeType: source.type || (slot === 'video' ? 'video/mp4' : 'image/jpeg'),
          size: Number.isSafeInteger(source.size) && source.size! > 0 ? source.size! : 0 });
      });
    }
    const { mainImages: _main, extraImages: _extra, videoFiles: _videos, ...details } = lot;
    return { ...metadata(details) as Record<string, unknown>, mainImages: [], extraImages: [], videoFiles: [] };
  });
  if (media.filter(item => item.slot !== 'video').length > 5000) throw new Error('A report may contain at most 5,000 photos.');
  if (media.filter(item => item.slot === 'video').length > 1000) throw new Error('A backup may contain at most 1,000 videos.');
  return { ownerId: draft.ownerId, clientDraftId: draft.id, captureId: draft.captureId, type: draft.type,
    revision: draft.localRevision!, title: draft.title, contractNo: draft.contractNo || draft.formData.contractNo || '',
    formData: { ...metadata(draft.formData) as Record<string, unknown>, manualSubmissionRequired: true }, lots, media,
    activeLotIdx: Number.isInteger(draft.activeLotIdx) && draft.activeLotIdx >= 0 && draft.activeLotIdx < lots.length ? draft.activeLotIdx : 0 };
}
