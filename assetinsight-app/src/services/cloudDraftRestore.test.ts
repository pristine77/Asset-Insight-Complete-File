import { assertCloudDraftIdentity, hydrateCompleteCloudDraft } from './cloudDraftRestore';
import type { CloudDraftMedia, ReportDraft } from './reportDraftService';

const expected = { cloudId: 'cloud-1', clientDraftId: 'local-1', type: 'lotListing' as const, revision: 10, ownerId: 'owner-a' };
const item = (index: number, overrides: Partial<CloudDraftMedia> = {}): CloudDraftMedia => ({
  clientFileId: `photo-${index}`, lotId: 'lot-1', slot: 'main', index, originalOrder: index,
  name: `photo-${index}.jpg`, mimeType: 'image/jpeg', size: 120, verifiedSize: 120,
  url: `https://storage.invalid/photo-${index}.jpg`, uploadedAt: '2026-10-06T10:00:00.000Z',
  ...overrides,
});
const record = (overrides: Partial<ReportDraft> = {}): ReportDraft => ({
  id: 'cloud-1', clientDraftId: 'local-1', user: 'owner-a', type: 'lotListing', storageMode: 'r2_media', revision: 10,
  contractNo: '00000', normalizedContractNo: '00000', title: 'Saved report',
  formData: { contractNo: '00000', clientSubmissionId: 'submission-1' },
  lots: [{ id: 'lot-1', lotNumber: 'Custom 42', title: 'Saved title', mainImages: [], extraImages: [], videoFiles: [], coverIndex: 1 }],
  media: [item(0), item(1)], activeLotIdx: 0, createdAt: '2026-10-06T09:00:00Z', updatedAt: '2026-10-06T10:00:00Z',
  ...overrides,
});

it('restores all lot/slot order and cover metadata without mutating the response', () => {
  const cloud = record();
  cloud.lots.push({ ...cloud.lots[0], id: 'lot-2', lotNumber: '40A', coverIndex: 0 });
  cloud.media = [item(0, { clientFileId: 'video', slot: 'video', originalOrder: 3, mimeType: 'video/mp4' }),
    item(0, { clientFileId: 'second', lotId: 'lot-2', originalOrder: 4 }), item(1),
    item(0, { clientFileId: 'extra', slot: 'extra', originalOrder: 2 }), item(0)];
  const original = JSON.stringify(cloud);
  const lots = hydrateCompleteCloudDraft(cloud, expected);
  expect(lots.map((lot) => lot.lotNumber)).toEqual(['Custom 42', '40A']);
  expect(lots[0].mainImages.map((photo: any) => photo.clientFileId)).toEqual(['photo-0', 'photo-1']);
  expect(lots[0].extraImages[0]).toMatchObject({ clientFileId: 'extra', slot: 'extra' });
  expect(lots[0].videoFiles[0]).toMatchObject({ clientFileId: 'video', slot: 'video' });
  expect(lots[0].coverIndex).toBe(1);
  expect(lots[1].mainImages[0]).toMatchObject({ clientFileId: 'second' });
  expect(JSON.stringify(cloud)).toBe(original);
});

it('refuses Nick-shaped 5-lot224 manifest when only50 originals are confirmed', () => {
  const cloud = record({ lots: [], media: [] });
  let next = 0;
  [39, 45, 45, 45, 50].forEach((count, lotIndex) => {
    const lotId = `lot-${lotIndex + 1}`;
    cloud.lots.push({ id: lotId, lotNumber: `${lotIndex + 1}`, mainImages: [], extraImages: [], videoFiles: [], coverIndex: 0 });
    for (let index = 0; index < count; index++) {
      const order = next++;
      cloud.media!.push(item(index, { lotId, clientFileId: `photo-${order}`, originalOrder: order,
        ...(order < 50 ? {} : { url: undefined, uploadedAt: undefined, verifiedSize: undefined }) }));
    }
  });
  const original = JSON.stringify(cloud);
  expect(() => hydrateCompleteCloudDraft(cloud, expected)).toThrow('174 of 224');
  expect(JSON.stringify(cloud)).toBe(original);
});

it.each([
  { media: undefined }, { media: null }, { lots: null }, { formData: null }, { storageMode: 'smart_upload' }, { storageMode: 'local_media' },
])('refuses missing detail arrays or unsupported capture %j', (overrides) => {
  expect(() => hydrateCompleteCloudDraft(record(overrides as any), expected)).toThrow();
});

it.each([
  { id: 'other' }, { _id: 'other' }, { clientDraftId: 'other' }, { user: 'owner-b' },
  { user: { _id: 'owner-b' } }, { type: 'asset' }, { revision: 9 }, { revision: undefined },
])('refuses wrong identity/owner/stale revision %j', (overrides) => {
  expect(() => hydrateCompleteCloudDraft(record(overrides as any), expected)).toThrow();
});

it.each([
  { url: undefined }, { url: 'file:///private.jpg' }, { url: 'https://bad host/x.jpg' }, { uploadedAt: undefined },
  { uploadedAt: 'not-a-date' }, { verifiedSize: undefined }, { verifiedSize: 0 }, { verifiedSize: 119 },
  { lotId: 'missing-lot' }, { slot: 'unknown' }, { index: -1 }, { index: 4 }, { index: 1.5 },
  { index: 0 }, { clientFileId: '' }, { clientFileId: 'photo-0' },
  { originalOrder: -1 }, { originalOrder: 1.5 }, { mimeType: 'video/mp4' },
])('refuses an incomplete or inconsistent media descriptor %j', (overrides) => {
  const cloud = record();
  cloud.media![1] = { ...cloud.media![1], ...overrides } as CloudDraftMedia;
  expect(() => hydrateCompleteCloudDraft(cloud, expected)).toThrow();
});

it('refuses duplicate/missing lot IDs and invalid cover choices', () => {
  const duplicate = record(); duplicate.lots.push({ ...duplicate.lots[0] });
  expect(() => hydrateCompleteCloudDraft(duplicate, expected)).toThrow('duplicate lot');
  const missing = record(); missing.lots[0].id = '';
  expect(() => hydrateCompleteCloudDraft(missing, expected)).toThrow('lot mapping');
  const cover = record(); cover.lots[0].coverIndex = 2;
  expect(() => hydrateCompleteCloudDraft(cover, expected)).toThrow('cover photo');
});

it('does not convert legacy embedded photos into an empty restored draft', () => {
  const cloud = record({ media: [] });
  cloud.lots[0].mainImages = ['file:///original.jpg']; cloud.lots[0].coverIndex = 0;
  expect(() => hydrateCompleteCloudDraft(cloud, expected)).toThrow('every original');
});

it('allows a genuinely empty complete draft and a current newer revision', () => {
  const cloud = record({ media: [], revision: 11 }); cloud.lots[0].coverIndex = 0;
  expect(hydrateCompleteCloudDraft(cloud, expected)[0].mainImages).toEqual([]);
  expect(() => assertCloudDraftIdentity(cloud, expected)).not.toThrow();
});

it('supports omitted web cover defaults and legacy capture order without changing explicit saved positions', () => {
  const cloud = record();
  delete (cloud.lots[0] as any).coverIndex;
  cloud.media![0].originalOrder = 0;
  cloud.media![1].originalOrder = 0;
  cloud.media!.reverse();
  const restored = hydrateCompleteCloudDraft(cloud, expected);
  expect(restored[0].coverIndex).toBe(0);
  expect(restored[0].mainImages.map((photo: any) => photo.clientFileId)).toEqual(['photo-0', 'photo-1']);
});

it('preserves a full5000 media metadata manifest without reading original bytes', () => {
  const cloud = record({ media: Array.from({ length: 5000 }, (_, index) => item(index)) });
  const restored = hydrateCompleteCloudDraft(cloud, expected);
  expect(restored[0].mainImages).toHaveLength(5000);
  expect(restored[0].mainImages[4999]).toMatchObject({ clientFileId: 'photo-4999' });
});
