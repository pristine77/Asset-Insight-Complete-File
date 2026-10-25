import api from './api';
import type { OfflineReportDraft, SavedPhotoFileData } from './autoSaveService';
import OfflineCaptureStore from './offlineCaptureStore';
import reportDraftService, { isVerifiedCloudBackupOfLocal, type CloudDraftMedia, type ReportDraft } from './reportDraftService';
import { uploadLocalFileToPresignedUrl } from './directR2UploadService';
import { pauseActiveUploads, setUploadOwner } from './uploadCancellation';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: jest.fn() } }));
jest.mock('./directR2UploadService', () => ({ uploadLocalFileToPresignedUrl: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn() } }));

type Part = { fieldName: string; string?: string; uri?: string; name?: string; type?: string };
const originalFormData = global.FormData;
beforeAll(() => {
  // Preserve React Native's URI file references without reading original bytes.
  global.FormData = class {
    private parts: Part[] = [];
    append(fieldName: string, value: string | object) {
      this.parts.push({ fieldName, ...(typeof value === 'string' ? { string: value } : value) });
    }
    getParts() { return this.parts; }
  } as unknown as typeof FormData;
});
afterAll(() => { global.FormData = originalFormData; });

const photo = (index = 0, values: Partial<SavedPhotoFileData> = {}): SavedPhotoFileData => ({
  clientFileId: `photo-${index}`,
  uri: `file:///original-${index}.jpg`,
  name: `lot-1-bundle-${index + 1}.jpg`,
  type: 'image/jpeg',
  size: 123 + index,
  ...values,
});
const draftWith = (values: Partial<OfflineReportDraft> = {}): OfflineReportDraft => ({
  id: 'local-draft', ownerId: 'owner-a', type: 'asset', captureMode: 'online',
  title: 'Draft', contractNo: 'Contract 12', formData: { clientSubmissionId: 'stable-submission' },
  lots: [{ id: 'lot-1', lotNumber: '42', mainImages: [photo()], extraImages: [], videoFiles: [], coverIndex: 0 }],
  activeLotIdx: 0, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z',
  ...values,
});
const partsFor = (body: unknown): Part[] => (body as { getParts(): Part[] }).getParts();
const metadataFor = (body: unknown): CloudDraftMedia[] => JSON.parse(partsFor(body).find((part) => part.fieldName === 'metadata')!.string!);
const multipartCalls = () => jest.mocked(api.post).mock.calls.filter(([url]) => url === '/report-drafts/cloud-draft/media');
const confirmationCalls = () => jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/media/confirm'));
const uploaded = (item: CloudDraftMedia): CloudDraftMedia => ({ ...item, url: `https://storage.invalid/${item.clientFileId}`, uploadedAt: '2026-09-30T10:01:00.000Z', verifiedSize: item.size });

let cloud: ReportDraft;
let targetFor: (item: CloudDraftMedia) => object;
let onMultipart: ((body: unknown, config: any) => Promise<unknown>) | undefined;
const apiResponse = () => ({ data: { data: JSON.parse(JSON.stringify(cloud)) } });
beforeEach(() => {
  jest.resetAllMocks();
  pauseActiveUploads();
  setUploadOwner('owner-a');
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-a');
  jest.mocked(uploadLocalFileToPresignedUrl).mockResolvedValue(undefined);
  cloud = { ...draftWith(), id: 'cloud-draft', normalizedContractNo: 'CONTRACT 12', contractNo: 'Contract 12', media: [] };
  targetFor = (item) => ({ clientFileId: item.clientFileId, r2Key: `draft/key/${item.clientFileId}`, alreadyUploaded: false });
  onMultipart = undefined;
  jest.mocked(api.get).mockImplementation(async () => apiResponse());
  jest.mocked(api.post).mockImplementation(async (url, body: any, config) => {
    if (url === '/report-drafts') {
      const old = new Map(cloud.media?.map((item) => [item.clientFileId, item]));
      cloud = { ...cloud, ...body, id: 'cloud-draft', media: body.media.map((item: CloudDraftMedia) => ({ ...item, ...old.get(item.clientFileId) })) };
      return apiResponse();
    }
    if (String(url).endsWith('/media/targets')) return { data: { data: body.media.map(targetFor) } };
    if (String(url).endsWith('/media/confirm')) {
      cloud.media = cloud.media?.map((item) => body.clientFileIds.includes(item.clientFileId) ? uploaded(item) : item);
      return apiResponse();
    }
    if (url === '/report-drafts/cloud-draft/media') {
      if (onMultipart) return onMultipart(body, config);
      const ids = new Set(metadataFor(body).map((item) => item.clientFileId));
      cloud.media = cloud.media?.map((item) => ids.has(item.clientFileId) ? uploaded(item) : item);
      return apiResponse();
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

it.each(['asset', 'lotListing'] as const)('saves %s draft media when the backend intentionally omits uploadUrl', async (type) => {
  const draft = draftWith({ type });
  const snapshot = JSON.stringify(draft);
  const saved = await reportDraftService.upsertFromLocalDraft(draft);
  expect(saved.id).toBe('cloud-draft');
  expect(saved.media?.[0]).toMatchObject({ clientFileId: 'photo-0', uploadedAt: expect.any(String) });
  expect(multipartCalls()).toHaveLength(1);
  const [, body, config] = multipartCalls()[0];
  expect(partsFor(body)).toEqual([
    { fieldName: 'replace', string: 'false' },
    { fieldName: 'metadata', string: JSON.stringify(metadataFor(body)) },
    { fieldName: 'files', uri: photo().uri, name: photo().name, type: 'image/jpeg' },
  ]);
  expect(metadataFor(body)).toEqual(cloud.media!.map(({ url, uploadedAt, verifiedSize, ...item }) => item));
  expect(config).toMatchObject({ headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000, signal: expect.any(AbortSignal) });
  expect(uploadLocalFileToPresignedUrl).not.toHaveBeenCalled();
  expect(confirmationCalls()).toHaveLength(0);
  expect(JSON.stringify(draft)).toBe(snapshot);
});

it('preserves original URI references, lot/slot order, cover choices and video metadata', async () => {
  const draft = draftWith({ lots: [
    { id: 'lot-42', lotNumber: '42A', mainImages: [photo(0, { uri: 'file:///edited.jpg', originalUri: 'content://media/external/images/42' })], extraImages: [photo(1)],
      videoFiles: [{ clientFileId: 'clip-42', uri: 'content://media/external/video/8', name: 'clip.mp4', type: 'video/mp4', size: 8000 }], coverIndex: 1 },
    { id: 'lot-56', lotNumber: '56', mainImages: [photo(2)], extraImages: [], videoFiles: [], coverIndex: 0 },
  ] });
  const snapshot = JSON.stringify(draft);
  await reportDraftService.upsertFromLocalDraft(draft);
  const body = multipartCalls()[0][1];
  expect(partsFor(body).filter((part) => part.fieldName === 'files').map((part) => part.uri)).toEqual([
    'content://media/external/images/42', photo(1).uri, 'content://media/external/video/8', photo(2).uri,
  ]);
  expect(metadataFor(body).map(({ clientFileId, lotId, slot, index, originalOrder }) => ({ clientFileId, lotId, slot, index, originalOrder }))).toEqual([
    { clientFileId: 'photo-0', lotId: 'lot-42', slot: 'main', index: 0, originalOrder: 0 },
    { clientFileId: 'photo-1', lotId: 'lot-42', slot: 'extra', index: 0, originalOrder: 1 },
    { clientFileId: 'clip-42', lotId: 'lot-42', slot: 'video', index: 0, originalOrder: 2 },
    { clientFileId: 'photo-2', lotId: 'lot-56', slot: 'main', index: 0, originalOrder: 3 },
  ]);
  expect((jest.mocked(api.post).mock.calls[0][1] as any).lots).toEqual(draft.lots.map((lot) => ({ ...lot, mainImages: [], extraImages: [], videoFiles: [] })));
  expect(JSON.stringify(draft)).toBe(snapshot);
});

it('keeps presigned PUT confirmation separate from multipart and already uploaded targets', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: [photo(0), photo(1), photo(2)] }] });
  targetFor = (item) => {
    if (item.clientFileId === 'photo-2') {
      cloud.media = cloud.media?.map((saved) => saved.clientFileId === item.clientFileId ? uploaded(saved) : saved);
      return { clientFileId: item.clientFileId, alreadyUploaded: true };
    }
    return { clientFileId: item.clientFileId, alreadyUploaded: false,
      ...(item.clientFileId === 'photo-0' ? { uploadUrl: 'https://storage.invalid/presigned' } : {}) };
  };
  await reportDraftService.upsertFromLocalDraft(draft);
  expect(uploadLocalFileToPresignedUrl).toHaveBeenCalledTimes(1);
  expect(uploadLocalFileToPresignedUrl).toHaveBeenCalledWith(expect.objectContaining({ uri: photo(0).uri }), 'https://storage.invalid/presigned', 'image/jpeg');
  expect(confirmationCalls().flatMap(([, body]) => (body as any).clientFileIds).sort()).toEqual(['photo-0', 'photo-2']);
  expect(multipartCalls().map(([, body]) => metadataFor(body).map((item) => item.clientFileId))).toEqual([['photo-1']]);
  expect(cloud.media?.every((item) => item.uploadedAt && item.url)).toBe(true);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

it('uploads sequential batches of at most ten and retains every original in order', async () => {
  const photos = Array.from({ length: 25 }, (_, index) => photo(index));
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: photos }] });
  const started = deferred();
  const release = deferred();
  onMultipart = async (body) => {
    if (multipartCalls().length === 1) { started.resolve(); await release.promise; }
    const ids = new Set(metadataFor(body).map((item) => item.clientFileId));
    cloud.media = cloud.media?.map((item) => ids.has(item.clientFileId) ? uploaded(item) : item);
    return apiResponse();
  };
  const saving = reportDraftService.upsertFromLocalDraft(draft);
  await started.promise;
  expect(multipartCalls()).toHaveLength(1);
  release.resolve();
  await saving;
  expect(multipartCalls().map(([, body]) => metadataFor(body).length)).toEqual([10, 10, 5]);
  expect(multipartCalls().flatMap(([, body]) => metadataFor(body).map((item) => item.clientFileId))).toEqual(photos.map((item) => item.clientFileId));
});

const uncertainError = () => Object.assign(new Error('Network response lost'), { code: 'ERR_NETWORK' });
it('reconciles a lost multipart response from the saved receipt without replaying bytes', async () => {
  const error = uncertainError();
  onMultipart = async (body) => {
    const ids = new Set(metadataFor(body).map((item) => item.clientFileId));
    cloud.media = cloud.media?.map((item) => ids.has(item.clientFileId) ? uploaded(item) : item);
    throw error;
  };
  const saved = await reportDraftService.upsertFromLocalDraft(draftWith());
  expect(saved.media?.[0].uploadedAt).toBeTruthy();
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(confirmationCalls()).toHaveLength(0);
});

it.each([
  { uploadedAt: undefined }, { url: undefined }, { lotId: 'another-lot' }, { slot: 'extra' },
  { index: 9 }, { originalOrder: 8 }, { name: 'changed.jpg' }, { mimeType: 'video/mp4' },
  { lastModified: 9 }, { verifiedSize: 999 },
])('does not accept a mismatched/incomplete saved receipt %j or blindly replay the batch', async (mismatch) => {
  const error = uncertainError();
  onMultipart = async () => {
    cloud.media = cloud.media?.map((item) => ({ ...uploaded(item), ...mismatch } as CloudDraftMedia));
    throw error;
  };
  await expect(reportDraftService.upsertFromLocalDraft(draftWith())).rejects.toBe(error);
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('retains the original failure when receipt checking fails and never starts the next batch', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: Array.from({ length: 11 }, (_, index) => photo(index)) }] });
  const error = uncertainError();
  onMultipart = async () => { throw error; };
  jest.mocked(api.get).mockRejectedValue(new Error('Receipt unavailable'));
  await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toBe(error);
  expect(multipartCalls()).toHaveLength(1);
});

it.each([400, 401, 403, 409, 413])('preserves terminal HTTP %i without a second upload or receipt reads', async (status) => {
  const error = Object.assign(new Error('Request rejected'), { response: { status } });
  onMultipart = async () => { throw error; };
  await expect(reportDraftService.upsertFromLocalDraft(draftWith())).rejects.toBe(error);
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).not.toHaveBeenCalled();
});

it('an explicit retry uses the same draft/media identities and skips committed prior batches', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: Array.from({ length: 11 }, (_, index) => photo(index, { clientFileId: undefined })) }] });
  const error = uncertainError();
  onMultipart = async (body) => {
    if (metadataFor(body).some((item) => item.originalOrder === 10)) throw error;
    const ids = new Set(metadataFor(body).map((item) => item.clientFileId));
    cloud.media = cloud.media?.map((item) => ids.has(item.clientFileId) ? uploaded(item) : item);
    return apiResponse();
  };
  await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toBe(error);
  const firstPayload = jest.mocked(api.post).mock.calls[0][1] as any;
  const firstUncommitted = metadataFor(multipartCalls()[1][1]);
  onMultipart = undefined;
  await reportDraftService.upsertFromLocalDraft(draft);
  const saves = jest.mocked(api.post).mock.calls.filter(([url]) => url === '/report-drafts');
  expect(saves).toHaveLength(2);
  expect(saves[1][1]).toMatchObject({ clientDraftId: 'local-draft', formData: { clientSubmissionId: 'stable-submission' }, media: firstPayload.media });
  expect(multipartCalls()).toHaveLength(3);
  expect(metadataFor(multipartCalls()[2][1])).toEqual(firstUncommitted);
});

it.each(['pause', 'account', 'offline'] as const)('stops multipart progress after %s even when the server responds successfully', async (change) => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: Array.from({ length: 11 }, (_, index) => photo(index)) }] });
  const started = deferred<AbortSignal>();
  const response = deferred();
  onMultipart = async (_body, config) => { started.resolve(config.signal); await response.promise; return apiResponse(); };
  const saving = reportDraftService.upsertFromLocalDraft(draft).catch((error) => error);
  const signal = await started.promise;
  if (change === 'pause') pauseActiveUploads();
  if (change === 'account') { jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-b'); setUploadOwner('owner-b'); }
  if (change === 'offline') draft.captureMode = 'offline';
  response.resolve();
  const error = await saving;
  expect(error).toBeInstanceOf(Error);
  if (change !== 'offline') { expect(signal.aborted).toBe(true); expect(error.code).toBe('ERR_CANCELED'); }
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).not.toHaveBeenCalled();
});

it('an account change during lost-response checking prevents confirmation and remaining batches', async () => {
  const error = uncertainError();
  onMultipart = async () => { throw error; };
  const started = deferred();
  const response = deferred();
  jest.mocked(api.get).mockImplementation(async () => { started.resolve(); await response.promise; return apiResponse(); });
  const saving = reportDraftService.upsertFromLocalDraft(draftWith()).catch((error) => error);
  await started.promise;
  setUploadOwner('owner-b');
  response.resolve();
  expect(await saving).toMatchObject({ code: 'ERR_CANCELED' });
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('blocks unavailable local media and missing target identities instead of manufacturing uploads', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: [photo(0, { uri: 'https://storage.invalid/photo.jpg' })] }] });
  await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toThrow('unavailable on this device');
  expect(multipartCalls()).toHaveLength(0);
  targetFor = () => ({ clientFileId: 'other-photo', alreadyUploaded: false });
  await expect(reportDraftService.upsertFromLocalDraft(draftWith())).rejects.toThrow('No storage target');
  expect(multipartCalls()).toHaveLength(0);
});

it('refuses success if the final saved draft does not confirm every expected original', async () => {
  onMultipart = async () => apiResponse();
  await expect(reportDraftService.upsertFromLocalDraft(draftWith())).rejects.toThrow('could not be verified');
  expect(multipartCalls()).toHaveLength(1);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('does not resend an already saved draft or require local originals for confirmed saved media', async () => {
  const draft = draftWith();
  await reportDraftService.upsertFromLocalDraft(draft);
  const initialCount = jest.mocked(api.post).mock.calls.length;
  draft.lots[0].mainImages = [photo(0, { uri: 'https://storage.invalid/photo-0' })];
  await reportDraftService.upsertFromLocalDraft(draft);
  expect(jest.mocked(api.post).mock.calls.slice(initialCount).map(([url]) => url)).toEqual(['/report-drafts']);
  expect(multipartCalls()).toHaveLength(1);
});

it.each([
  { captureMode: 'offline' as const }, { manualSubmissionRequired: true },
  { formData: { manualSubmissionRequired: true } }, { ownerId: 'someone-else' },
])('preserves offline and ownership upload gates %j', async (values) => {
  await expect(reportDraftService.upsertFromLocalDraft(draftWith(values))).rejects.toThrow();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['lot', 'photo', 'missing'] as const)('rejects bad local %s references before any metadata write', async (kind) => {
  const draft = draftWith();
  if (kind === 'lot') draft.lots.push({ ...draft.lots[0], mainImages: [] });
  if (kind === 'photo') draft.lots[0].mainImages.push(photo());
  if (kind === 'missing') draft.lots[0].mainImages[0] = photo(0, { missing: true });
  await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toThrow();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['missing', 'extra', 'moved', 'owner', 'revision', 'draft', 'client', 'submission', 'size'] as const)(
  'does not acknowledge a successful transport with %s snapshot mismatch', async (kind) => {
    const draft = draftWith();
    jest.mocked(api.get).mockImplementation(async () => {
      const result = apiResponse();
      const saved = result.data.data;
      if (kind === 'missing') saved.media = [];
      if (kind === 'extra') saved.media.push({ ...saved.media[0], clientFileId: 'unexpected', index: 1, originalOrder: 1 });
      if (kind === 'moved') saved.media[0].slot = 'extra';
      if (kind === 'owner') saved.user = 'someone-else';
      if (kind === 'revision') saved.revision++;
      if (kind === 'draft') saved.id = 'other-cloud';
      if (kind === 'client') saved.clientDraftId = 'other-local';
      if (kind === 'submission') saved.formData.clientSubmissionId = 'other-submission';
      if (kind === 'size') saved.media[0].verifiedSize++;
      return result;
    });
    const original = JSON.stringify(draft);
    await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toThrow();
    expect(JSON.stringify(draft)).toBe(original);
  }
);

it('allows an unknown-size legacy original only after the server measures and verifies its actual size', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: [photo(0, { size: undefined })] }] });
  onMultipart = async () => {
    cloud.media = cloud.media?.map((item) => uploaded({ ...item, size: 800 }));
    return apiResponse();
  };
  expect((await reportDraftService.upsertFromLocalDraft(draft)).media?.[0].verifiedSize).toBe(800);
});

it.each(['unconfirmed', 'legacy-zero-size'] as const)('confirms an alreadyUploaded %s object without uploading original bytes again', async (state) => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: [photo(0, { size: undefined })] }] });
  await expect(reportDraftService.upsertFromLocalDraft(draft)).rejects.toThrow('could not be verified');
  cloud.media = cloud.media?.map((item) => ({ ...item, size: 0, verifiedSize: state === 'legacy-zero-size' ? 0 : undefined,
    uploadedAt: state === 'legacy-zero-size' ? '2026-10-06T10:00:00.000Z' : undefined,
    url: state === 'legacy-zero-size' ? 'https://storage.invalid/original.jpg' : undefined }));
  const beforeUploads = multipartCalls().length;
  const originalPost = jest.mocked(api.post).getMockImplementation()!;
  jest.mocked(api.post).mockImplementation(async (url, body: any, config) => {
    if (String(url).endsWith('/media/confirm')) {
      cloud.media = cloud.media?.map((item) => ({ ...uploaded(item), size: 0, verifiedSize: 800 }));
      return apiResponse();
    }
    return originalPost(url, body, config);
  });
  targetFor = (item) => ({ clientFileId: item.clientFileId, alreadyUploaded: true });
  const saved = await reportDraftService.upsertFromLocalDraft(draft);
  expect(saved.media?.[0].verifiedSize).toBe(800);
  expect(confirmationCalls()).toHaveLength(1);
  expect(multipartCalls()).toHaveLength(beforeUploads);
  expect(uploadLocalFileToPresignedUrl).not.toHaveBeenCalled();
});

it('only regards an exact complete cloud manifest as a backup of all224local originals', async () => {
  const draft = draftWith({ lots: [{ ...draftWith().lots[0], mainImages: Array.from({ length: 224 }, (_, index) => photo(index)) }] });
  const saved = await reportDraftService.upsertFromLocalDraft(draft);
  expect(isVerifiedCloudBackupOfLocal(draft, saved)).toBe(true);
  expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, media: [] })).toBe(false);
  expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, media: saved.media?.slice(0, 50) })).toBe(false);
  expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, media: saved.media?.map((item, index) => index === 0 ? { ...item, clientFileId: 'other-photo' } : item) })).toBe(false);
  expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, media: saved.media?.map((item, index) => index === 0 ? { ...item, lotId: 'other-lot' } : item) })).toBe(false);
  expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, media: saved.media?.map((item, index) => index === 0 ? { ...item, verifiedSize: 0 } : item) })).toBe(false);
});

it('never uses another draft, owner or type as local backup evidence', async () => {
  const draft = draftWith();
  const saved = await reportDraftService.upsertFromLocalDraft(draft);
  for (const different of [{ clientDraftId: 'other-draft' }, { user: 'owner-b' }, { type: 'lotListing' as const },
    { lots: [] }, { storageMode: 'local_media' as const }, { storageMode: 'smart_upload' as const }]) {
    expect(isVerifiedCloudBackupOfLocal(draft, { ...saved, ...different })).toBe(false);
  }
  expect(isVerifiedCloudBackupOfLocal({ ...draft, cloudId: 'other-cloud' }, saved)).toBe(false);
});

it('holds the original metadata snapshot when the caller edits its draft mid-upload', async () => {
  const draft = draftWith();
  onMultipart = async (body) => {
    draft.formData.clientSubmissionId = 'new-edits';
    draft.lots[0].mainImages.push(photo(1));
    const ids = new Set(metadataFor(body).map((item) => item.clientFileId));
    cloud.media = cloud.media?.map((item) => ids.has(item.clientFileId) ? uploaded(item) : item);
    return apiResponse();
  };
  const saved = await reportDraftService.upsertFromLocalDraft(draft);
  expect(saved.formData.clientSubmissionId).toBe('stable-submission');
  expect(saved.media).toHaveLength(1);
  expect(draft.lots[0].mainImages).toHaveLength(2);
});

it('rejects an account switch after the final receipt arrives', async () => {
  jest.mocked(api.get).mockImplementation(async () => {
    const result = apiResponse();
    jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-b');
    return result;
  });
  await expect(reportDraftService.upsertFromLocalDraft(draftWith())).rejects.toThrow('owns this draft');
});

it('fresh detail reads validate exact returned draft and owner', async () => {
  expect((await reportDraftService.get('cloud-draft')).id).toBe('cloud-draft');
  expect(api.get).toHaveBeenLastCalledWith('/report-drafts/cloud-draft', { signal: expect.any(AbortSignal) });
  cloud.user = 'someone-else';
  await expect(reportDraftService.get('cloud-draft')).rejects.toThrow('different signed-in account');
  cloud.user = 'owner-a'; cloud.id = 'other-draft';
  await expect(reportDraftService.get('cloud-draft')).rejects.toThrow('different draft');
});

it('never returns cloud detail into a different account after a delayed GET', async () => {
  jest.mocked(api.get).mockImplementation(async () => {
    jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-b');
    return apiResponse();
  });
  await expect(reportDraftService.get('cloud-draft')).rejects.toThrow('account changed');
});
