import AutoSaveService from './autoSaveService';
import OfflineCaptureStore from './offlineCaptureStore';
import { LocalMediaStore } from './localMediaStore';
import type { OfflineReportDraft } from './autoSaveService';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/', getInfoAsync: jest.fn() }));
jest.mock('./imageEditService', () => ({ ImageEditService: { isManagedEditedUri: () => false } }));
jest.mock('./localMediaStore', () => ({ LocalMediaStore: {
  setOwner: jest.fn(), getDraftDir: () => 'file:///documents/local_media_store/drafts/owner_draft/',
  getFileInfo: jest.fn(), importMedia: jest.fn(), isManagedUri: () => false,
} }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: {
  setOwner: jest.fn(), getOwnerId: jest.fn(), initialize: jest.fn(), getDraft: jest.fn(),
  saveDraft: jest.fn(), createCloudDraft: jest.fn(), updateDraft: jest.fn(), updateDraftSyncState: jest.fn(), listDrafts: jest.fn(),
  listSummaries: jest.fn(), setSubmissionState: jest.fn(),
} }));

let saved: Map<string, OfflineReportDraft>;
const photo = (id: number) => ({ uri: `file:///documents/camera-photos/${id}.jpg`, name: `${id}.jpg`, type: 'image/jpeg' });
const form = (id = 'draft', captureMode: 'online' | 'offline' = 'offline') => ({
  id, type: 'asset' as const, captureMode, formData: { contractNo: '', captureMode, clientSubmissionId: `submit-${id}` }, activeLotIdx: 0,
  lots: [{ id: 'lot', mode: 'single_lot' as const, files: [photo(1), photo(2)], extraFiles: [], coverIndex: 0 }],
});
beforeEach(() => {
  jest.clearAllMocks(); saved = new Map();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner');
  jest.mocked(OfflineCaptureStore.getDraft).mockImplementation(async (id) => saved.get(id) || null);
  jest.mocked(OfflineCaptureStore.saveDraft).mockImplementation(async (draft) => { const next = { ...draft, localRevision: (draft.localRevision || 0) + 1 }; saved.set(next.id, next); return next; });
  jest.mocked(OfflineCaptureStore.updateDraft).mockImplementation(async (id, change) => {
    const next = change(saved.get(id)!); saved.set(id, next); return next;
  });
  // As the store does: only the cloud-copy fields change, and the revision stays.
  jest.mocked(OfflineCaptureStore.updateDraftSyncState).mockImplementation(async (id, change) => {
    const current = saved.get(id); if (!current) return null;
    const fields = change(current); if (!fields) return current;
    const next = { ...current, ...fields, localRevision: current.localRevision }; saved.set(id, next); return next;
  });
  jest.mocked(OfflineCaptureStore.listDrafts).mockImplementation(async () => [...saved.values()]);
  // The store's visible summaries, as offlineCaptureStore.ts builds them.
  jest.mocked(OfflineCaptureStore.listSummaries).mockImplementation(async (type) => [...saved.values()]
    .filter((draft) => (!type || draft.type === type) && !['accepted', 'submitted', 'discarded'].includes(draft.submissionState || ''))
    .map((draft) => ({
      id: draft.id, type: draft.type, title: draft.title, contractNo: draft.contractNo, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
      ownerId: draft.ownerId, captureMode: draft.captureMode || 'online', localRevision: draft.localRevision || 0,
      submissionState: draft.submissionState || 'local', manualSubmissionRequired: draft.manualSubmissionRequired,
      counts: {
        lots: draft.lots.length, mainImages: 0, extraImages: 0, missingImages: 0, perLot: [],
        images: draft.lots.reduce((sum, lot) => sum + lot.mainImages.length + lot.extraImages.length, 0),
        videos: draft.lots.reduce((sum, lot) => sum + (lot.videoFiles?.length || 0), 0),
      },
    })));
  jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (id, state) => {
    const draft = saved.get(id);
    if (draft) saved.set(id, { ...draft, submissionState: state });
    return saved.get(id) as any;
  });
  jest.mocked(LocalMediaStore.getFileInfo).mockResolvedValue({ exists: true, size: 50 });
  jest.mocked(LocalMediaStore.importMedia).mockImplementation(async (args) => ({ mediaId: args.mediaId || `stable-${args.sourceUri}`, uri: args.sourceUri, ownership: 'camera', name: args.name!, type: args.type!, sourceUri: args.sourceUri, createdAt: '2026-09-17T10:00:00Z' }));
});

it('allows a new offline camera draft without a contract but requires a contract online', async () => {
  expect((await AutoSaveService.saveDraft(form())).lots[0].mainImages).toHaveLength(2);
  await expect(AutoSaveService.saveDraft(form('online', 'online'))).rejects.toThrow('Contract number');
});

it('saves separate reports with the same contract without merging identities', async () => {
  const first = form('one'); first.formData.contractNo = '93530';
  const second = form('two'); second.formData.contractNo = '93530';
  await AutoSaveService.saveDraft(first); await AutoSaveService.saveDraft(second);
  expect([...saved.keys()]).toEqual(['one', 'two']);
});

it('keeps missing photo placeholders, their positions and cover selection', async () => {
  jest.mocked(LocalMediaStore.importMedia).mockResolvedValue(null);
  const input = form(); input.lots[0].coverIndex = 1;
  const result = await AutoSaveService.saveDraft(input);
  expect(result.lots[0].mainImages).toHaveLength(2);
  expect(result.lots[0].mainImages[0]).toMatchObject({ uri: photo(1).uri, missing: true, availability: 'missing' });
  expect(result.lots[0].coverIndex).toBe(1);
});

it('serializes competing autosaves for the same draft before reading the prior revision', async () => {
  const first = form(); const second = { ...form(), title: 'Latest user edit' };
  await Promise.all([AutoSaveService.saveDraft(first), AutoSaveService.saveDraft(second)]);
  expect(saved.get('draft')?.title).toBe('Latest user edit');
  expect(OfflineCaptureStore.saveDraft).toHaveBeenCalledTimes(1);
  expect(OfflineCaptureStore.updateDraft).toHaveBeenCalledTimes(1);
});

it('preserves stable photo identities when photos are reordered', async () => {
  await AutoSaveService.saveDraft(form());
  const input = form(); input.lots[0].files.reverse();
  const result = await AutoSaveService.saveDraft(input);
  expect(result.lots[0].mainImages[0]).toMatchObject({ mediaId: `stable-${photo(2).uri}` });
  expect(result.lots[0].mainImages[1]).toMatchObject({ mediaId: `stable-${photo(1).uri}` });
});

it('persists a replacement identity on the same draft without copying or changing its original references', async () => {
  const input = form();
  const first = await AutoSaveService.saveDraft(input);
  const imports = jest.mocked(LocalMediaStore.importMedia).mock.calls.length;
  const next = await AutoSaveService.saveDraft({ ...input, formData: { ...input.formData,
    clientSubmissionId: 'new-submission', supersedesClientSubmissionId: first.formData.clientSubmissionId,
  } });
  expect(next.id).toBe(first.id);
  expect(next.formData).toMatchObject({ clientSubmissionId: 'new-submission', supersedesClientSubmissionId: 'submit-draft' });
  expect(next.lots).toEqual(first.lots);
  expect(LocalMediaStore.importMedia).toHaveBeenCalledTimes(imports);
  expect(saved.size).toBe(1);
});

it.each(['asset', 'lotListing'] as const)('retains %s video references and metadata across repeated offline saves', async type => {
  const clip = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4',
    mediaId: 'stable-video', captureOrder: 7, originalOrder: 7, width: 1280, height: 720, timestamp: 1700000000 };
  const input = { ...form(), type, lots: [{ ...form().lots[0], videoFile: clip }] };
  const first = await AutoSaveService.saveDraft(input);
  const second = await AutoSaveService.saveDraft(input);
  expect(first.lots[0].videoFiles).toHaveLength(1);
  expect(second.lots[0].videoFiles).toEqual(first.lots[0].videoFiles);
  expect(second.lots[0].videoFiles[0]).toMatchObject({ ...clip, slot: 'video', index: 0, lotId: 'lot' });
  expect(second.lots[0].mainImages).toHaveLength(2);
  expect(second.lots[0].extraImages).toHaveLength(0);
  expect(jest.mocked(LocalMediaStore.importMedia).mock.calls.filter(([args]) => args.slot === 'video')).toHaveLength(1);
});

it('never drops the legacy Incoming review gate when a generic form is saved', async () => {
  const input = form();
  const initial = await AutoSaveService.saveDraft(input);
  saved.set('draft', { ...initial, formData: { ...initial.formData, auctioneerWorkItemId: 'work-one', legacyRequiresIncomingReview: true } });
  const result = await AutoSaveService.saveDraft(input);
  expect(result.formData.legacyRequiresIncomingReview).toBe(true);
  expect(result.formData.auctioneerWorkItemId).toBe('work-one');
});

it('fences the original owner before asynchronous storage initialization', async () => {
  let finish!: () => void;
  jest.mocked(OfflineCaptureStore.initialize).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const saving = AutoSaveService.saveDraft(form());
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other-owner');
  finish();
  await expect(saving).rejects.toThrow('account changed');
  expect(LocalMediaStore.importMedia).not.toHaveBeenCalled();
  expect(OfflineCaptureStore.saveDraft).not.toHaveBeenCalled();
});

it('late cloud success and failure cannot mark a newer revision clean or failed', async () => {
  const initial = await AutoSaveService.saveDraft(form());
  const latest = { ...initial, localRevision: 9, title: 'Latest title', cloudSyncError: undefined };
  saved.set(initial.id, latest);
  await AutoSaveService.markDraftCloudSynced(initial.id, 'cloud-id', initial.updatedAt, 'owner', 8);
  await AutoSaveService.markDraftCloudSyncError(initial.id, 'Old upload failed', {
    expectedOwnerId: 'owner', expectedUpdatedAt: initial.updatedAt, expectedLocalRevision: 8,
  });
  expect(saved.get(initial.id)).toEqual(latest);
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other');
  jest.mocked(OfflineCaptureStore.updateDraftSyncState).mockClear();
  await AutoSaveService.markDraftCloudSynced(initial.id, 'cloud-id', undefined, 'owner');
  await AutoSaveService.markDraftCloudSyncError(initial.id, 'Old account failed', { expectedOwnerId: 'owner' });
  expect(OfflineCaptureStore.updateDraftSyncState).not.toHaveBeenCalled();
});

it('records the cloud copy without a new revision, so a queued upload of that revision is still accepted', async () => {
  const initial = await AutoSaveService.saveDraft(form());
  jest.mocked(OfflineCaptureStore.updateDraft).mockClear();
  await AutoSaveService.markDraftCloudSynced(initial.id, 'cloud-id', initial.updatedAt, 'owner', initial.localRevision);
  expect(saved.get(initial.id)).toMatchObject({ cloudId: 'cloud-id', localRevision: initial.localRevision });
  await AutoSaveService.markDraftCloudSyncError(initial.id, 'Offline', { expectedOwnerId: 'owner', expectedLocalRevision: initial.localRevision, attempts: 1 });
  expect(saved.get(initial.id)).toMatchObject({ cloudSyncError: 'Offline', cloudSyncAttempts: 1, localRevision: initial.localRevision });
  // Neither is a draft edit.
  expect(OfflineCaptureStore.updateDraft).not.toHaveBeenCalled();
});

it('uses owner-bound create-only storage for cloud restoration and never overwrites through saveDraft', async () => {
  const args = {
    ownerId: 'owner', id: 'cloud-only', cloudId: 'server-id', type: 'asset' as const,
    contractNo: '00000', formData: { contractNo: '00000' }, lots: [], activeLotIdx: 0,
  };
  jest.mocked(OfflineCaptureStore.createCloudDraft).mockImplementation(async draft => draft);
  const result = await AutoSaveService.saveCloudDraftSnapshot(args);
  expect(result.id).toBe('cloud-only');
  expect(OfflineCaptureStore.createCloudDraft).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), 'owner');
  expect(OfflineCaptureStore.saveDraft).not.toHaveBeenCalled();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other');
  await expect(AutoSaveService.saveCloudDraftSnapshot(args)).rejects.toThrow('account changed');
  expect(OfflineCaptureStore.createCloudDraft).toHaveBeenCalledTimes(1);
});

// A contract groups independent drafts. Saving one never discards another,
// including a text-only draft or a photo save racing a stale empty summary.
describe('independent drafts of the same contract', () => {
  const emptyDraft = (id: string, values: Partial<OfflineReportDraft> = {}): OfflineReportDraft => ({
    id, ownerId: 'owner', type: 'lotListing', title: '93530', contractNo: '93530', normalizedContractNo: '93530',
    captureMode: 'online', submissionState: 'local', localRevision: 1,
    formData: { contractNo: '93530', clientSubmissionId: `submit-${id}` }, lots: [], activeLotIdx: 0,
    createdAt: '2026-10-11T21:39:00.000Z', updatedAt: '2026-10-11T21:39:00.000Z',
    ...values,
  } as OfflineReportDraft);
  const lotListing = (id: string, files: ReturnType<typeof photo>[], contractNo = '93530') => ({
    id, type: 'lotListing' as const, captureMode: 'online' as const, activeLotIdx: 0,
    formData: { contractNo, captureMode: 'online' as const, clientSubmissionId: `submit-${id}` },
    lots: [{ id: 'lot', mode: 'single_lot' as const, files, extraFiles: [], coverIndex: 0 }],
  });
  const state = (id: string) => saved.get(id)?.submissionState;

  it('retains the older empty draft when the new draft gets its first photo', async () => {
    saved.set('empty', emptyDraft('empty'));
    await AutoSaveService.saveDraft(lotListing('new', [photo(1)], ' 93530 '));
    expect(state('empty')).toBe('local');
    expect(state('new')).not.toBe('discarded');
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });

  it('waits for the first photo: a draft that has none yet discards nothing', async () => {
    saved.set('empty', emptyDraft('empty'));
    await AutoSaveService.saveDraft(lotListing('new', []));
    expect(state('empty')).toBe('local');
    expect(OfflineCaptureStore.listSummaries).not.toHaveBeenCalled();
  });

  it('never scans other drafts to delete them on first or later autosaves', async () => {
    await AutoSaveService.saveDraft(lotListing('new', [photo(1)]));
    await AutoSaveService.saveDraft(lotListing('new', [photo(1), photo(2)]));
    expect(OfflineCaptureStore.listSummaries).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });

  it('preserves meaningful typed work in a different photo-free draft', async () => {
    const earlier = emptyDraft('prepared', { formData: {
      contractNo: '93530', clientName: 'Prepared customer', ownerName: 'Prepared owner',
      factorsAnalysis: 'Instructions entered before the site visit', clientSubmissionId: 'prepared-submit',
    } });
    saved.set(earlier.id, earlier);
    await AutoSaveService.saveDraft(lotListing('new', [photo(1)]));
    expect(saved.get(earlier.id)).toEqual(earlier);
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });

  it('cannot hide a later media save based on an older empty snapshot', async () => {
    const earlier = emptyDraft('prepared');
    saved.set(earlier.id, earlier);
    const persist = jest.mocked(OfflineCaptureStore.saveDraft).getMockImplementation()!;
    jest.mocked(OfflineCaptureStore.saveDraft).mockImplementation(async (...args) => {
      saved.set(earlier.id, { ...earlier, localRevision: 2, lots: [{ id: 'retained', mode: 'single_lot',
        mainImages: [photo(9)], extraImages: [], videoFiles: [], coverIndex: 0 }] as any });
      return persist(...args);
    });
    await AutoSaveService.saveDraft(lotListing('new', [photo(1)]));
    expect(saved.get(earlier.id)).toMatchObject({ submissionState: 'local', localRevision: 2 });
    expect(saved.get(earlier.id)?.lots[0].mainImages).toEqual([photo(9)]);
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });

  it('keeps every draft that holds something or belongs elsewhere', async () => {
    const kept = {
      withPhoto: emptyDraft('withPhoto', { lots: [{ id: 'l', mode: 'single_lot', mainImages: [photo(9)], extraImages: [], videoFiles: [], coverIndex: 0 }] as any }),
      withVideo: emptyDraft('withVideo', { lots: [{ id: 'l', mode: 'single_lot', mainImages: [], extraImages: [], videoFiles: [{ uri: 'file:///clip.mp4' }], coverIndex: 0 }] as any }),
      beingSent: emptyDraft('beingSent', { submissionState: 'paused' }),
      inCloud: emptyDraft('inCloud', { cloudId: 'cloud-1' }),
      offline: emptyDraft('offline', { captureMode: 'offline' }),
      manual: emptyDraft('manual', { manualSubmissionRequired: true }),
      incoming: emptyDraft('incoming', { formData: { contractNo: '93530', auctioneerWorkItemId: 'work-1' } as any }),
      otherContract: emptyDraft('otherContract', { contractNo: '93531', normalizedContractNo: '93531', formData: { contractNo: '93531' } as any }),
      otherType: emptyDraft('otherType', { type: 'asset' }),
      otherOwner: emptyDraft('otherOwner', { ownerId: 'someone-else' }),
      newer: emptyDraft('newer', { createdAt: '2999-01-01T00:00:00.000Z' }),
    };
    for (const draft of Object.values(kept)) saved.set(draft.id, draft);
    await AutoSaveService.saveDraft(lotListing('new', [photo(1)]));
    for (const id of Object.keys(kept)) expect([id, state(id)]).toEqual([id, kept[id as keyof typeof kept].submissionState]);
  });

  it('never fails the save when the check cannot run', async () => {
    saved.set('empty', emptyDraft('empty'));
    jest.mocked(OfflineCaptureStore.listSummaries).mockRejectedValueOnce(new Error('database busy'));
    await expect(AutoSaveService.saveDraft(lotListing('new', [photo(1)]))).resolves.toMatchObject({ id: 'new' });
    expect(state('empty')).toBe('local');
  });

  it('leaves an Offline capture alone, whatever it holds', async () => {
    saved.set('empty', emptyDraft('empty'));
    const offline = { ...lotListing('new', [photo(1)]), captureMode: 'offline' as const };
    await AutoSaveService.saveDraft(offline);
    expect(state('empty')).toBe('local');
  });
});
