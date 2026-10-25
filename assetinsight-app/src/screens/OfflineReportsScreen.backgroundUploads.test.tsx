/**
 * Drafts and the background upload line (2026-10-02). A draft the line holds
 * must not be cloud-synced here, deleted, or replaced from its
 * cloud copy while it is uploading. The line is real; storage, the cloud and
 * the network are stand-ins.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OfflineReportsScreen from './OfflineReportsScreen';
import AutoSaveService from '../services/autoSaveService';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import reportDraftService from '../services/reportDraftService';
import DraftSyncService from '../services/draftSyncService';
import backgroundUploadManager, { type BackgroundUploadRequest } from '../services/backgroundUploadManager';
import { setUploadOwner } from '../services/uploadCancellation';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('../components/CaptureBackupPanel', () => () => null);
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: 'owner' } }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#555', warning: '#a50', accent: '#c00', info: '#25e' } }) }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined) } }));
jest.mock('../services/api', () => ({ __esModule: true, default: { get: jest.fn(async () => ({ data: { data: [] } })), delete: jest.fn() } }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: {
  getDraft: jest.fn(), getLocalStorageSummary: jest.fn(async () => ({ bytes: 0, formatted: '0 B', drafts: 0, images: 0, videos: 0 })),
  saveCloudDraftSnapshot: jest.fn(), deleteDraftMedia: jest.fn(async () => undefined), deleteDraft: jest.fn(async () => undefined),
  cleanupOrphanedMedia: jest.fn(async () => 0),
} }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: jest.fn(() => 'owner'), listSummaries: jest.fn(), listLegacyDrafts: jest.fn(async () => []), listLegacyJobs: jest.fn(async () => []),
  setSubmissionState: jest.fn(async () => undefined),
  listContinuations: jest.fn(async () => []), subscribeContinuations: () => () => undefined,
} }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: {
  getJobs: jest.fn(async () => []), getConnectivityStatus: jest.fn(async () => ({ status: 'online' })), subscribe: jest.fn(() => () => undefined),
  getSubmissionError: jest.fn(() => ({ title: 'Upload failed', message: 'Retry.' })), retryJob: jest.fn(), retryAll: jest.fn(), deleteJob: jest.fn(),
} }));
jest.mock('../services/reportDraftService', () => ({
  __esModule: true,
  // Exact descriptor conservation is exercised in reportDraftService.test.ts.
  isVerifiedCloudBackupOfLocal: (draft: any, cloud: any) =>
    Array.isArray(cloud.media) && cloud.media.length === draft.lots.reduce((sum: number, lot: any) =>
      sum + lot.mainImages.length + lot.extraImages.length + (lot.videoFiles?.length || 0), 0) &&
    cloud.media.every((item: any) => item.url && item.uploadedAt && item.verifiedSize > 0),
  default: { get: jest.fn(), list: jest.fn(async () => []), delete: jest.fn(async () => undefined) },
}));
jest.mock('../services/draftSyncService', () => ({ __esModule: true, default: { syncDraft: jest.fn() } }));
jest.mock('../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));

const UPDATED_AT = '2026-10-02T10:00:00.000Z';
/** An Online draft on this device; never saved to the cloud unless cloudSyncedAt is given. */
function localDraft(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, ownerId: 'owner', type: 'asset', title: `Report ${id}`, contractNo: `QA-${id}`, captureMode: 'online', submissionState: 'ready',
    formData: { contractNo: `QA-${id}`, clientSubmissionId: `submission-${id}` },
    lots: [{ id: `${id}-lot`, mode: 'single_lot', mainImages: [{ uri: `file:///drafts/${id}/photo.jpg`, name: 'photo.jpg', type: 'image/jpeg' }], extraImages: [], videoFiles: [], coverIndex: 0 }],
    activeLotIdx: 0, createdAt: UPDATED_AT, updatedAt: UPDATED_AT, ...extra,
  };
}
function showDrafts(...drafts: Array<ReturnType<typeof localDraft>>) {
  jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue(drafts.map((draft) => ({ id: draft.id, type: draft.type, captureMode: 'online' })) as any);
  jest.mocked(AutoSaveService.getDraft).mockImplementation(async (id: string) => (drafts.find((draft) => draft.id === id) || null) as any);
}
/** An upload in the line that never finishes during the test. */
function backgroundUpload(draftId: string) {
  const request: BackgroundUploadRequest = {
    draftId, type: 'asset', ownerId: 'owner', title: `QA-${draftId}`, totalFiles: 1, draft: { id: draftId, ownerId: 'owner' } as any,
    upload: jest.fn(() => new Promise(() => {})),
  };
  return request;
}
const cloudCopy = (draftId: string) => ({
  id: `cloud-${draftId}`, clientDraftId: draftId, type: 'asset', user: 'owner', revision: 4,
  title: `Report ${draftId}`, contractNo: `QA-${draftId}`, updatedAt: UPDATED_AT,
  lots: [{ id: `${draftId}-lot`, mainImages: [], extraImages: [], videoFiles: [], coverIndex: 0 }],
  media: [{ clientFileId: 'photo-one', lotId: `${draftId}-lot`, slot: 'main', index: 0,
    url: 'https://media.example.test/photo.jpg', uploadedAt: UPDATED_AT, size: 50, verifiedSize: 50 }],
  formData: { contractNo: `QA-${draftId}` },
});
const synced = (draftId: string) => ({ status: 'synced', cloud: cloudCopy(draftId) });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('owner');
  setUploadOwner('owner');
  backgroundUploadManager.resetForTests();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(reportDraftService.list).mockResolvedValue([]);
  jest.mocked(AutoSaveService.saveCloudDraftSnapshot).mockImplementation(async (args: any) => ({ ...localDraft(args.id), ...args, cloudSyncedAt: UPDATED_AT }) as any);
  jest.mocked(DraftSyncService.syncDraft).mockResolvedValue({ status: 'skipped' } as any);
});
afterEach(async () => {
  await cleanup();
  backgroundUploadManager.resetForTests();
  jest.restoreAllMocks();
});

async function openDrafts(onContinueDraft = jest.fn()) {
  await render(<OfflineReportsScreen onOpenDrawer={jest.fn()} onContinueDraft={onContinueDraft} />);
  await waitFor(() => expect(screen.getByText('Report draft-b')).toBeTruthy());
  return onContinueDraft;
}

it('does not cloud-sync, replace or delete the photos of a draft the line holds', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'), localDraft('draft-c'));
  jest.mocked(DraftSyncService.syncDraft).mockImplementation(async (draft: any) => {
    draft.cloudSyncedAt = UPDATED_AT;
    return synced(draft.id) as any;
  });
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); backgroundUploadManager.enqueue(backgroundUpload('draft-c')); });
  // draft-a uploading, draft-c waiting in line; pause draft-c so it is held as paused.
  await act(async () => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().queued[0].id); });
  await openDrafts();
  await waitFor(() => expect(DraftSyncService.syncDraft).toHaveBeenCalled());
  expect(jest.mocked(DraftSyncService.syncDraft).mock.calls.map(([draft]) => draft.id)).toEqual(['draft-b']);
  await waitFor(() => expect(screen.getByText('Cloud saved')).toBeTruthy());
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  // Sync All, which forces a sync of every draft not yet in the cloud, goes
  // through the same rule; it reloads the list when done.
  jest.mocked(DraftSyncService.syncDraft).mockClear();
  const loads = jest.mocked(OfflineCaptureStore.listSummaries).mock.calls.length;
  await fireEvent.press(screen.getByText('Sync All'));
  await waitFor(() => expect(jest.mocked(OfflineCaptureStore.listSummaries).mock.calls.length).toBeGreaterThan(loads));
  expect(DraftSyncService.syncDraft).not.toHaveBeenCalled();
  for (const id of ['draft-a', 'draft-c']) {
    expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalledWith(id);
  }
});

it('keeps the photos of a draft handed to the line while its cloud save was running', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'));
  let finishCloudSave!: () => void;
  jest.mocked(DraftSyncService.syncDraft).mockImplementation((draft: any) => draft.id === 'draft-a'
    ? new Promise((resolve) => { finishCloudSave = () => resolve(synced('draft-a') as any); })
    : Promise.resolve({ status: 'skipped' } as any));
  await openDrafts();
  await waitFor(() => expect(finishCloudSave).toBeDefined());
  // Submit hands the draft over before the cloud save answers.
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  await act(async () => { finishCloudSave(); });
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('shows the live state, and closes Delete while a draft uploads but not once it is paused', async () => {
  showDrafts(localDraft('draft-a'), localDraft('draft-b'));
  jest.mocked(DraftSyncService.syncDraft).mockResolvedValue({ status: 'skipped' } as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  await openDrafts();
  expect(screen.getByText('Background upload: Uploading 0 of 1')).toBeTruthy();
  const [deleteA, deleteB] = screen.getAllByRole('button', { name: 'Delete' });
  expect(deleteA.props.accessibilityState?.disabled).toBe(true);
  expect(deleteB.props.accessibilityState?.disabled).toBe(false);
  await fireEvent.press(deleteA);
  expect(Alert.alert).not.toHaveBeenCalled();

  await act(async () => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().active!.id); });
  await waitFor(() => expect(screen.getByText('Background upload: Paused')).toBeTruthy());
  await fireEvent.press(screen.getAllByRole('button', { name: 'Delete' })[0]);
  const confirm = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'Delete Draft')?.[2]?.find((button) => button.text === 'Delete');
  await act(async () => { await confirm?.onPress?.(); });
  expect(AutoSaveService.deleteDraft).toHaveBeenCalledWith('draft-a');
  expect(backgroundUploadManager.statusFor('draft-a')).toBeUndefined();
});

it('refuses to replace a draft from its cloud copy while it uploads', async () => {
  // Saved to the cloud since its last change, so Continue restores the cloud copy.
  showDrafts(localDraft('draft-a', { cloudSyncedAt: UPDATED_AT, cloudId: 'cloud-draft-a' }), localDraft('draft-b', { cloudSyncedAt: UPDATED_AT }));
  jest.mocked(reportDraftService.list).mockResolvedValue([cloudCopy('draft-a')] as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  const onContinueDraft = await openDrafts();
  await fireEvent.press(screen.getAllByText('Continue')[0]);
  expect(Alert.alert).toHaveBeenCalledWith('Uploading in the background', expect.stringContaining('Pause it from the upload bar'));
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  expect(onContinueDraft).not.toHaveBeenCalled();
});

it('opens all 224 local photos even when the cached cloud copy contains no usable photos', async () => {
  const draft = localDraft('draft-a', { cloudSyncedAt: UPDATED_AT });
  draft.lots[0].mainImages = Array.from({ length: 224 }, (_, i) => ({
    uri: `content://media/external/images/media/${i}`, name: `${i}.jpg`, type: 'image/jpeg',
  }));
  showDrafts(draft, localDraft('draft-b', { cloudSyncedAt: UPDATED_AT }));
  const cloud = cloudCopy('draft-a');
  cloud.media = cloud.media.map(({ url, uploadedAt, verifiedSize, ...pending }) => pending) as any;
  jest.mocked(reportDraftService.list).mockResolvedValue([cloud] as any);
  const before = JSON.stringify(draft);
  const onContinue = await openDrafts();
  await fireEvent.press(screen.getAllByText('Continue')[0]);
  expect(onContinue).toHaveBeenCalledWith('draft-a', 'asset');
  expect(JSON.stringify(draft)).toBe(before);
  expect(reportDraftService.get).not.toHaveBeenCalled();
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('does not label a shorter but fully uploaded cloud copy as a complete local backup', async () => {
  const draft = localDraft('draft-a', { cloudSyncedAt: UPDATED_AT });
  draft.lots[0].mainImages = Array.from({ length: 224 }, (_, i) => ({
    uri: `content://media/external/images/media/${i}`, name: `${i}.jpg`, type: 'image/jpeg',
  }));
  showDrafts(draft);
  jest.mocked(reportDraftService.list).mockResolvedValue([cloudCopy('draft-a')] as any);
  await render(<OfflineReportsScreen onOpenDrawer={jest.fn()} onContinueDraft={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Report draft-a')).toBeTruthy());
  expect(screen.queryByText('Cloud saved')).toBeNull();
});

async function openCloudOnly(listed = cloudCopy('draft-a')) {
  showDrafts(localDraft('draft-b', { cloudSyncedAt: UPDATED_AT }));
  jest.mocked(reportDraftService.list).mockResolvedValue([listed] as any);
  const onContinue = await openDrafts();
  return { onContinue, press: async () => fireEvent.press(screen.getByRole('button', { name: 'Continue' })) };
}

it('blocks a cloud-only 224-photo draft when only 50 originals were verified', async () => {
  const cloud = cloudCopy('draft-a');
  cloud.media = Array.from({ length: 224 }, (_, index) => ({
    clientFileId: `photo-${index}`, lotId: 'draft-a-lot', slot: 'main', index, size: 50,
    ...(index < 50 ? { url: `https://media.example.test/${index}.jpg`, uploadedAt: UPDATED_AT, verifiedSize: 50 } : {}),
  })) as any;
  jest.mocked(reportDraftService.get).mockResolvedValue(cloud as any);
  const { onContinue, press } = await openCloudOnly(cloud);
  expect(screen.getByText('Backup incomplete')).toBeTruthy();
  await press();
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Draft could not be opened', expect.stringContaining('174 of 224')));
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
});

it('fetches fresh complete cloud detail and saves once despite repeated taps', async () => {
  const fresh = cloudCopy('draft-a');
  fresh.formData = { ...fresh.formData, ownerName: 'Updated owner' } as any;
  let finish!: (draft: any) => void;
  jest.mocked(reportDraftService.get).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { onContinue, press } = await openCloudOnly();
  await press();
  await fireEvent.press(screen.getByRole('button', { name: 'Opening draft' }));
  expect(reportDraftService.get).toHaveBeenCalledTimes(1);
  await act(async () => { finish(fresh); });
  await waitFor(() => expect(onContinue).toHaveBeenCalledWith('draft-a', 'asset'));
  expect(AutoSaveService.saveCloudDraftSnapshot).toHaveBeenCalledTimes(1);
  expect(AutoSaveService.saveCloudDraftSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    ownerId: 'owner', id: 'draft-a', formData: expect.objectContaining({ ownerName: 'Updated owner' }),
    lots: [expect.objectContaining({ mainImages: [expect.objectContaining({ uri: fresh.media[0].url })] })],
  }));
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('keeps a local capture saved while cloud loading was in flight', async () => {
  let finish!: (draft: any) => void;
  jest.mocked(reportDraftService.get).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { onContinue, press } = await openCloudOnly();
  await press();
  const captured = localDraft('draft-a');
  showDrafts(captured, localDraft('draft-b'));
  await act(async () => { finish(cloudCopy('draft-a')); });
  await waitFor(() => expect(onContinue).toHaveBeenCalledWith('draft-a', 'asset'));
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('ignores cloud detail after an account change', async () => {
  let finish!: (draft: any) => void;
  jest.mocked(reportDraftService.get).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { onContinue, press } = await openCloudOnly();
  await press();
  jest.mocked(OfflineCaptureStore.getOwnerId).mockReturnValue('other-owner');
  await act(async () => { finish(cloudCopy('draft-a')); });
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
});

it('keeps paused uploads and local photos when opening a draft', async () => {
  showDrafts(localDraft('draft-a', { cloudSyncedAt: UPDATED_AT }), localDraft('draft-b', { cloudSyncedAt: UPDATED_AT }));
  jest.mocked(reportDraftService.list).mockResolvedValue([cloudCopy('draft-a')] as any);
  await act(async () => { backgroundUploadManager.enqueue(backgroundUpload('draft-a')); });
  await act(async () => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().active!.id); });
  const onContinue = await openDrafts();
  await fireEvent.press(screen.getAllByText('Continue')[0]);
  expect(onContinue).toHaveBeenCalledWith('draft-a', 'asset');
  expect(backgroundUploadManager.statusFor('draft-a')?.status).toBe('paused');
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
});

it('shows a useful cloud fetch error without raw status codes or clearing anything', async () => {
  jest.mocked(reportDraftService.get).mockRejectedValue({ message: 'Request failed with status code 404', response: { status: 404 } });
  const { onContinue, press } = await openCloudOnly();
  await press();
  await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
  const message = String(jest.mocked(Alert.alert).mock.calls.at(-1)?.[1]);
  expect(message).not.toMatch(/404|status code/);
  expect(AutoSaveService.saveCloudDraftSnapshot).not.toHaveBeenCalled();
  expect(AutoSaveService.deleteDraftMedia).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
});
