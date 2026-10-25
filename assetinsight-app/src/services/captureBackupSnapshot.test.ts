import type { OfflineReportDraft, SavedPhotoFileData } from './autoSaveService';
import { backupContent, backupOriginalUri, createCaptureBackupSnapshot, isBackupCandidate } from './captureBackupSnapshot';

function draft(count = 2): OfflineReportDraft {
  return {
    id: 'draft-one', ownerId: 'owner-one', captureId: 'capture-one', localRevision: 7,
    type: 'asset', captureMode: 'offline', title: 'Equipment', contractNo: 'QA-001',
    formData: { contractNo: 'QA-001', clientSubmissionId: 'submission-one', factorsAnalysis: 'Keep these notes' },
    lots: [{ id: 'lot-one', lotNumber: 'A-3', title: 'Equipment', coverIndex: 1,
      mainImages: Array.from({ length: count }, (_, index) => ({
        uri: `file:///documents/photo-${index}.jpg`, originalUri: `content://media/original/${index}`,
        sourceUri: `file:///cache/import-${index}.jpg`, editedUri: `file:///documents/edit-${index}.jpg`,
        name: `${index}.jpg`, type: 'image/jpeg', size: 123, mediaId: `photo-${index}`,
      })), extraImages: [], videoFiles: [] }],
    activeLotIdx: 0, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:01:00.000Z',
  };
}

test('backs up saved originals while retaining source draft, details and lot order', () => {
  const source = draft();
  source.lots.push({ id: 'lot-two', lotNumber: 'B-1', title: 'Another lot', coverIndex: 0, mainImages: [],
    extraImages: [{ uri: 'content://media/extra/1', name: 'extra.jpg', type: 'image/jpeg', size: 234 }],
    videoFiles: [{ uri: 'file:///documents/saved.mp4', sourceUri: 'file:///cache/deleted.mp4', name: 'clip.mp4', type: 'video/mp4', size: 345 }] });
  const before = JSON.stringify(source);
  const snapshot = createCaptureBackupSnapshot(source);
  expect(snapshot).toMatchObject({ ownerId: 'owner-one', clientDraftId: 'draft-one', captureId: 'capture-one', revision: 7,
    formData: { factorsAnalysis: 'Keep these notes', clientSubmissionId: 'submission-one', manualSubmissionRequired: true } });
  expect(snapshot.lots.map(lot => lot.id)).toEqual(['lot-one', 'lot-two']);
  expect(snapshot.lots[0]).toMatchObject({ lotNumber: 'A-3', title: 'Equipment', coverIndex: 1, mainImages: [], extraImages: [], videoFiles: [] });
  expect(snapshot.media.map(file => [file.lotId, file.slot, file.index, file.uri])).toEqual([
    ['lot-one', 'main', 0, 'content://media/original/0'], ['lot-one', 'main', 1, 'content://media/original/1'],
    ['lot-two', 'extra', 0, 'content://media/extra/1'], ['lot-two', 'video', 0, 'file:///documents/saved.mp4'],
  ]);
  expect(JSON.stringify(source)).toBe(before);
  expect(JSON.stringify(snapshot.lots)).not.toMatch(/content:|file:/);
  expect(snapshot.media.every(file => !('data' in file) && !('base64' in file))).toBe(true);
});

test('prefers the durable saved URI over a temporary source URI, with legacy fallbacks', () => {
  expect(backupOriginalUri({ originalUri: 'content://original', uri: 'file:///saved', sourceUri: 'file:///cache' })).toBe('content://original');
  expect(backupOriginalUri({ uri: 'file:///saved.mp4', sourceUri: 'file:///cache.mp4' })).toBe('file:///saved.mp4');
  expect(backupOriginalUri({ sourceUri: 'content://legacy' })).toBe('content://legacy');
  expect(backupOriginalUri('file:///legacy.jpg')).toBe('file:///legacy.jpg');
});

test('preserves natural Data/File/Asset labels while removing genuine local references from metadata', () => {
  const source = draft();
  Object.assign(source.formData, { factorsAnalysis: 'Data: 2026', notes: 'File: inspected', description: 'Asset: tractor',
    privatePath: 'file:///documents/private.jpg', embedded: 'data:image/jpeg;base64,AAAA',
    nested: ['Content: checked', 'content://media/original/1', 'ph://local-photo', '/storage/private/photo.jpg'] });
  const metadata = createCaptureBackupSnapshot(source).formData;
  expect(metadata).toMatchObject({ factorsAnalysis: 'Data: 2026', notes: 'File: inspected', description: 'Asset: tractor', nested: ['Content: checked'] });
  expect(metadata).not.toHaveProperty('privatePath');
  expect(metadata).not.toHaveProperty('embedded');
});

test.each(['asset', 'lotListing'] as const)('%s snapshots do not authorize report submission', type => {
  const source = { ...draft(), type, captureMode: 'online' as const, manualSubmissionRequired: true };
  expect(isBackupCandidate(source)).toBe(true);
  expect(createCaptureBackupSnapshot(source).formData.manualSubmissionRequired).toBe(true);
  expect(source.submissionState).toBeUndefined();
});

test.each(['accepted', 'submitted', 'discarded'] as const)('does not re-enqueue a %s report as a fresh backup', submissionState => {
  const source = { ...draft(), submissionState };
  expect(isBackupCandidate(source)).toBe(false);
  expect(() => createCaptureBackupSnapshot(source)).toThrow('not an editable offline draft');
});

test('ordinary online capture is not implicitly enrolled', () => {
  expect(isBackupCandidate({ ...draft(), captureMode: 'online' })).toBe(false);
  expect(isBackupCandidate({ ...draft(), captureMode: 'online', formData: { manualSubmissionRequired: true } })).toBe(true);
});

test('bounds video and lot metadata independently from the 5,000-photo limit', () => {
  const source = draft(0);
  source.lots[0].videoFiles = Array.from({ length: 1001 }, (_, index) => ({ uri: `file:///documents/${index}.mp4`, name: `${index}.mp4`, type: 'video/mp4', size: 123 }));
  expect(() => createCaptureBackupSnapshot(source)).toThrow('1,000 videos');
  source.lots = Array.from({ length: 1001 }, (_, index) => ({ id: `lot-${index}`, mainImages: [], extraImages: [], videoFiles: [], coverIndex: 0 }));
  expect(() => createCaptureBackupSnapshot(source)).toThrow('1,000 lots');
});

test.each([{ ownerId: undefined }, { captureId: undefined }, { localRevision: 0 }, { localRevision: 1.5 }])('requires durable ownership and revision metadata: %j', change => {
  expect(() => createCaptureBackupSnapshot({ ...draft(), ...change })).toThrow('Save this draft on your device');
});

test.each([{ missing: true }, { availability: 'missing' as const }, { originalUri: 'https://fixture.invalid/photo.jpg' }, { originalUri: 'ph://asset' }])('does not silently drop unavailable originals: %j', change => {
  const source = draft();
  source.lots[0].mainImages[1] = { ...source.lots[0].mainImages[1] as SavedPhotoFileData, ...change };
  expect(() => createCaptureBackupSnapshot(source)).toThrow('Lot A-3, photo 2 is not available');
  expect(source.lots[0].mainImages).toHaveLength(2);
});

test('retains unknown size as unknown for native measurement, never a fabricated positive size', () => {
  const source = draft(0);
  source.lots[0].mainImages = ['file:///documents/legacy.jpg'];
  expect(createCaptureBackupSnapshot(source).media[0]).toMatchObject({ uri: 'file:///documents/legacy.jpg', size: 0 });
});

test('same original shared across slots has independent, stable manifest entries', () => {
  const source = draft(1);
  source.lots[0].extraImages = [source.lots[0].mainImages[0]];
  const first = createCaptureBackupSnapshot(source);
  expect(new Set(first.media.map(file => file.clientFileId)).size).toBe(2);
  expect(createCaptureBackupSnapshot(source).media).toEqual(first.media);
});

test('strips embedded local references from metadata without changing ordinary details', () => {
  const source = draft(0);
  source.formData.auctionServiceSelections = { uri: 'file:///private', keep: 'Contract notes', nested: { sourceUri: 'content://private', count: 2 }, bad: 'data:image/jpeg;base64,bytes' };
  const snapshot = createCaptureBackupSnapshot(source);
  expect(snapshot.formData.auctionServiceSelections).toEqual({ keep: 'Contract notes', nested: { count: 2 } });
  expect(source.formData.auctionServiceSelections.uri).toBe('file:///private');
});

test('receipt metadata and timestamps do not create a backup feedback loop, but content changes do', () => {
  const source = draft();
  expect(backupContent({ ...source, localRevision: 8, updatedAt: 'later', cloudId: 'cloud', cloudSyncedAt: 'later', cloudSyncAttempts: 4 })).toBe(backupContent(source));
  expect(backupContent({ ...source, formData: { ...source.formData, ownerName: 'Updated owner' } })).not.toBe(backupContent(source));
});

test('preserves all 5,000 small metadata entries and rejects the next photo without truncation', () => {
  const source = draft(5000);
  const snapshot = createCaptureBackupSnapshot(source);
  expect(snapshot.media).toHaveLength(5000);
  expect(new Set(snapshot.media.map(file => file.clientFileId)).size).toBe(5000);
  expect(snapshot.media[4999]).toMatchObject({ index: 4999, uri: 'content://media/original/4999' });
  expect(JSON.stringify(snapshot).length).toBeLessThan(2 * 1024 * 1024);
  expect(() => createCaptureBackupSnapshot(draft(5001))).toThrow('5,000 photos');
});

test('the photo ceiling spans lots and slots, while video entries keep their own ordered references', () => {
  const source = draft(4999);
  source.lots.push({ id: 'lot-two', mainImages: [], extraImages: ['file:///documents/extra.jpg'],
    videoFiles: ['file:///documents/first.mp4', 'file:///documents/second.mp4'], coverIndex: 0 });
  const snapshot = createCaptureBackupSnapshot(source);
  expect(snapshot.media).toHaveLength(5002);
  expect(snapshot.media.slice(-3).map(media => [media.slot, media.index, media.uri])).toEqual([
    ['extra', 0, 'file:///documents/extra.jpg'], ['video', 0, 'file:///documents/first.mp4'], ['video', 1, 'file:///documents/second.mp4'],
  ]);
  source.lots[1].extraImages.push('file:///documents/over-limit.jpg');
  expect(() => createCaptureBackupSnapshot(source)).toThrow('5,000 photos');
  expect(source.lots[1].extraImages).toHaveLength(2);
});

test('rejects duplicate lots rather than overwriting their originals', () => {
  const source = draft(); source.lots.push({ ...source.lots[0] });
  expect(() => createCaptureBackupSnapshot(source)).toThrow('lot identities');
});
