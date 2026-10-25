import AutoSaveService, { type OfflineReportDraft } from './autoSaveService';
import OfflineCaptureStore from './offlineCaptureStore';
import reportDraftService, { type ReportDraft } from './reportDraftService';
import DraftSyncService from './draftSyncService';

jest.mock('./autoSaveService', () => ({ __esModule: true, default: {
  markDraftCloudSynced: jest.fn(), markDraftCloudSyncError: jest.fn(), getDraft: jest.fn(),
} }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: jest.fn() } }));
jest.mock('./reportDraftService', () => ({ __esModule: true, default: { upsertFromLocalDraft: jest.fn() } }));
jest.mock('./offlineQueueService', () => ({ __esModule: true, default: { isOnline: jest.fn() } }));

// One photo: since 2026-10-11 a draft with no photos or video is not copied.
const draftFor = (ownerId = 'owner-a'): OfflineReportDraft => ({
  id: 'same-local-id', ownerId, captureMode: 'online', localRevision: 4,
  type: 'lotListing', title: 'Saved', formData: { contractNo: '00000' }, activeLotIdx: 0,
  lots: [{ id: 'lot-1', mode: 'single_lot', mainImages: [{ uri: 'file:///photo-1.jpg', name: 'photo-1.jpg' }], extraImages: [], videoFiles: [], coverIndex: 0 }] as any,
  createdAt: '2026-10-06T09:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z',
});
const cloudFor = (ownerId = 'owner-a'): ReportDraft => ({
  id: `cloud-${ownerId}`, user: ownerId, type: 'lotListing', title: 'Saved',
  contractNo: '00000', normalizedContractNo: '00000', formData: {}, lots: [], activeLotIdx: 0,
  createdAt: '2026-10-06T09:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-a');
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockResolvedValue(cloudFor());
  jest.mocked(AutoSaveService.markDraftCloudSynced).mockResolvedValue(undefined);
  jest.mocked(AutoSaveService.markDraftCloudSyncError).mockResolvedValue(undefined);
});

it('only acknowledges the exact source owner, timestamp and local revision', async () => {
  const source = draftFor();
  const wait = deferred<ReportDraft>();
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockReturnValue(wait.promise);
  const sync = DraftSyncService.syncDraft(source);
  source.updatedAt = '2026-10-06T10:01:00.000Z'; source.localRevision = 5;
  wait.resolve(cloudFor());
  expect((await sync).status).toBe('synced');
  expect(AutoSaveService.markDraftCloudSynced).toHaveBeenCalledWith(
    source.id, 'cloud-owner-a', '2026-10-06T10:00:00.000Z', 'owner-a', 4
  );
});

it('guards late errors against newer local saves including equal timestamp revisions', async () => {
  const source = draftFor();
  const wait = deferred<ReportDraft>();
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockReturnValue(wait.promise);
  const sync = DraftSyncService.syncDraft(source);
  source.localRevision = 5;
  wait.reject(new Error('Incomplete cloud backup; originals retained.'));
  expect((await sync).status).toBe('failed');
  expect(AutoSaveService.markDraftCloudSyncError).toHaveBeenCalledWith(source.id, expect.any(String), expect.objectContaining({
    expectedUpdatedAt: '2026-10-06T10:00:00.000Z', expectedOwnerId: 'owner-a', expectedLocalRevision: 4,
  }));
});

it('coalesces duplicate syncs only inside the same owner and draft', async () => {
  const ownerA = deferred<ReportDraft>(); const ownerB = deferred<ReportDraft>();
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockImplementation((draft) =>
    draft.ownerId === 'owner-a' ? ownerA.promise : ownerB.promise
  );
  const a = DraftSyncService.syncDraft(draftFor());
  const repeated = DraftSyncService.syncDraft(draftFor());
  expect(reportDraftService.upsertFromLocalDraft).toHaveBeenCalledTimes(1);
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-b');
  const b = DraftSyncService.syncDraft(draftFor('owner-b'));
  expect(reportDraftService.upsertFromLocalDraft).toHaveBeenCalledTimes(2);
  ownerA.resolve(cloudFor());
  expect((await a).status).toBe('skipped');
  expect((await repeated).status).toBe('skipped');
  ownerB.resolve(cloudFor('owner-b'));
  expect((await b).status).toBe('synced');
  expect(AutoSaveService.markDraftCloudSynced).toHaveBeenCalledTimes(1);
  expect(AutoSaveService.markDraftCloudSynced).toHaveBeenCalledWith('same-local-id', 'cloud-owner-b', expect.any(String), 'owner-b', 4);
});

it.each(['success', 'failure'] as const)('does not save a late %s into a changed account', async (result) => {
  const wait = deferred<ReportDraft>();
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockReturnValue(wait.promise);
  const syncing = DraftSyncService.syncDraft(draftFor());
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner-b');
  if (result === 'success') wait.resolve(cloudFor()); else wait.reject(new Error('network'));
  expect((await syncing).status).toBe('skipped');
  expect(AutoSaveService.markDraftCloudSyncError).not.toHaveBeenCalled();
  expect(AutoSaveService.markDraftCloudSynced).not.toHaveBeenCalled();
});

it('never syncs offline/manual captures even with Force sync', async () => {
  expect((await DraftSyncService.syncDraft({ ...draftFor(), captureMode: 'offline' }, { force: true })).status).toBe('skipped');
  expect((await DraftSyncService.syncDraft({ ...draftFor(), manualSubmissionRequired: true }, { force: true })).status).toBe('skipped');
  expect(reportDraftService.upsertFromLocalDraft).not.toHaveBeenCalled();
});

// 2026-10-11 phone test: a contract-number-only draft became an empty cloud draft.
it('never sends a draft with no photos or video to the cloud', async () => {
  expect((await DraftSyncService.syncDraft({ ...draftFor(), lots: [] })).status).toBe('skipped');
  expect((await DraftSyncService.syncDraft({ ...draftFor(), lots: [] }, { force: true })).status).toBe('skipped');
  expect(reportDraftService.upsertFromLocalDraft).not.toHaveBeenCalled();
  expect(AutoSaveService.markDraftCloudSyncError).not.toHaveBeenCalled();
});
