import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import AssetFormSheet from './AssetFormSheet';
import LotListingFormSheet from './LotListingFormSheet';
import AuctioneerFormBoundary from './AuctioneerFormBoundary';
import auctioneerService, { type AuctioneerReportType, type AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import assetService from '../../services/assetService';
import lotListingService from '../../services/lotListingService';
import AutoSaveService, { type AutoSaveFormData } from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import reportDraftService from '../../services/reportDraftService';
import { prepareOfflineSubmission } from '../../services/offlineSubmissionService';
import { waitForStableConnection } from '../../services/uploadAutoResume';
import { pauseActiveUploads, setUploadOwner } from '../../services/uploadCancellation';
import durableReportTransfer from '../../services/durableReportTransfer';
import durableContinuationService from '../../services/durableContinuationService';
import * as cameraTiming from '../camera/cameraDeadline';

let mockOwner: string | null = 'owner';
let mockLatestCamera: any;
let mockOpenLotCamera: (index: number) => Promise<void>;
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })) } }));
jest.mock('../../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner, getDraft: jest.fn(), setSubmissionState: jest.fn(async () => undefined), recordDraftOpened: jest.fn(async () => undefined) } }));
jest.mock('../../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async draft => draft) }));
// The wait for a steady connection is driven by each test (see signalWaits).
jest.mock('../../services/uploadAutoResume', () => ({
  ...jest.requireActual('../../services/uploadAutoResume'),
  waitForStableConnection: jest.fn(),
}));

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'Inspector', companyName: 'QA' } }) }));
jest.mock('../../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { background: '#101010', surface: '#202020', text: '#ffffff', textSecondary: '#cccccc', borderStrong: '#777777', accent: '#ff3344' } }) }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-CA', regionCode: 'CA' }] }));
jest.mock('./CameraCapture', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => {
    const { visible, lockedStructure, sourceLabels } = props;
    if (visible) mockLatestCamera = props;
    return visible ? <Text testID="camera-locked" accessibilityLabel={sourceLabels?.[0]}>{String(Boolean(lockedStructure))}</Text> : null;
  } };
});
jest.mock('../camera/NativeAuctionCameraScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => {
    const { visible, lockedStructure, sourceLabels } = props;
    if (visible) mockLatestCamera = props;
    return visible ? <Text testID="camera-locked" accessibilityLabel={sourceLabels?.[0]}>{String(Boolean(lockedStructure))}</Text> : null;
  } };
});
jest.mock('./LotManager', () => {
  const React = require('react');
  const { View, Text, TouchableOpacity } = require('react-native');
  return { __esModule: true, default: ({ lots, setLots, lockedStructure, onOpenCamera }: any) => {
    mockOpenLotCamera = onOpenCamera;
    return <View>
    <Text testID="mock-lot-count">{lots.length}</Text>
    <Text testID="mock-photo-count">{lots.reduce((sum: number, lot: any) => sum + lot.files.length, 0)}</Text>
    <Text testID="mock-restored-lots">{JSON.stringify(lots)}</Text>
    <Text testID="mock-locked">{String(Boolean(lockedStructure))}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open mock lot camera" onPress={() => onOpenCamera(0)}><Text>Camera</Text></TouchableOpacity>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add fresh test photo" onPress={() => setLots([{ id: 'fresh-capture-lot', mode: 'single_lot', files: [{ uri: 'file:///fresh-photo.jpg', name: 'fresh.jpg', type: 'image/jpeg' }], extraFiles: [], coverIndex: 0 }])}><Text>Add fresh test photo</Text></TouchableOpacity>
  </View>;
  } };
});
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../services/auctioneerService', () => ({
  ...jest.requireActual('../../services/auctioneerService'),
  __esModule: true,
  default: { getSetup: jest.fn(), continueWorkItem: jest.fn() },
}));
jest.mock('../../services/assetService', () => ({ __esModule: true, default: { createAssetReport: jest.fn() } }));
jest.mock('../../services/lotListingService', () => ({ __esModule: true, default: { createLotListing: jest.fn() } }));
jest.mock('../../services/savedInputService', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../services/reportDraftService', () => ({ __esModule: true, default: { upsertFromLocalDraft: jest.fn(), processPreview: jest.fn() }, getDuplicateLotWarning: () => null }));
jest.mock('../../services/offlineQueueService', () => ({ __esModule: true, default: {
  getConnectivityStatus: jest.fn(), shouldQueueAfterError: jest.fn(), getSubmissionError: jest.fn(),
  enqueueAssetReport: jest.fn(), enqueueLotListing: jest.fn(),
} }));
jest.mock('../../services/autoSaveService', () => ({ __esModule: true, default: {
  getDraft: jest.fn(), saveDraft: jest.fn(), removeDraftRecordOnly: jest.fn(), deleteDraft: jest.fn(),
  deleteAutoSave: jest.fn(), cleanupOrphanedMedia: jest.fn(), migrateLegacyAutoSaveIfNeeded: jest.fn(),
} }));
jest.mock('../../utils/mobileLocation', () => ({
  normalizeHiddenLocation: (location?: string) => ({ location: location || 'Not provided' }),
  getHiddenCurrentLocation: jest.fn(async () => ({ location: 'Not provided' })),
}));

function setup(type: AuctioneerReportType = 'asset'): AuctioneerWorkItemSetup {
  return {
    workItemId: 'work-parent', cycleKey: 'cycle-parent', kind: 'scheduleA', reportType: type,
    clientSubmissionId: 'submission-parent', status: 'claimed', reportId: null,
    contract: { id: 'contract-id', contractNo: '93530.3-A', customerName: 'Incoming customer', eventTitle: 'Fall sale', eventDate: '2026-09-20', location: 'Auction yard' },
    lots: [{ sourceKey: 'upstream-key', lotId: 'upstream-lot', submissionId: 'upstream-submission', lotNumber: '157' }],
  };
}

function successor(previous: AuctioneerWorkItemSetup): AuctioneerWorkItemSetup {
  return { ...previous, workItemId: 'work-next', cycleKey: 'cycle-next', clientSubmissionId: 'submission-next', kind: 'unknown', lots: [] };
}

function draft(type: AuctioneerReportType) {
  return {
    id: 'local-parent', ownerId: 'owner', type, title: 'Incoming capture', contractNo: '93530.3-A', createdAt: '2026-09-14', updatedAt: '2026-09-14',
    formData: { auctioneerWorkItemId: 'work-parent', clientSubmissionId: 'submission-parent', contractNo: '93530.3-A', clientName: 'Incoming customer', appraisalPurpose: 'Auction listing and condition report', appraiser: 'Inspector', currency: 'CAD', language: 'en' as const },
    lots: [{ id: 'auctioneer-work-parent-1', mode: 'single_lot' as const, mainImages: [{ uri: 'file:///isolated-photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }], extraImages: [], videoFiles: [], coverIndex: 0 }],
    activeLotIdx: 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLatestCamera = undefined;
  jest.mocked(auctioneerService.getSetup).mockReset();
  jest.mocked(auctioneerService.continueWorkItem).mockReset();
  jest.mocked(assetService.createAssetReport).mockReset();
  jest.mocked(lotListingService.createLotListing).mockReset();
  mockOwner = 'owner';
  setUploadOwner(mockOwner);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(OfflineQueueService.getConnectivityStatus).mockReset().mockResolvedValue({ status: 'online' } as any);
  jest.mocked(OfflineQueueService.shouldQueueAfterError).mockResolvedValue(false);
  jest.mocked(OfflineQueueService.getSubmissionError).mockReturnValue({ title: 'Upload failed', message: 'Retry this submission.' } as any);
  jest.mocked(AutoSaveService.saveDraft).mockImplementation(async (input) => ({ ...input, ownerId: 'owner', id: 'local-parent' }) as any);
  jest.mocked(OfflineCaptureStore.recordDraftOpened).mockReset().mockResolvedValue(undefined);
  jest.mocked(OfflineCaptureStore.setSubmissionState).mockReset().mockResolvedValue(undefined as any);
  jest.mocked(AutoSaveService.removeDraftRecordOnly).mockResolvedValue(undefined);
  jest.mocked(assetService.createAssetReport).mockResolvedValue({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', accepted: true } as any);
  jest.mocked(lotListingService.createLotListing).mockResolvedValue({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', phase: 'processing' });
  // By default the signal never comes back during a test.
  jest.mocked(waitForStableConnection).mockReset().mockImplementation(() => new Promise<boolean>(() => {}));
});

afterEach(async () => { await cleanup(); jest.restoreAllMocks(); });

describe.each(['asset', 'lotListing'] as const)('%s upload progress and explicit pause', type => {
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const upload = type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing;
  const submitLabel = type === 'asset' ? 'Submit asset report' : 'Submit lot listing';
  const progressId = type === 'asset' ? 'asset-upload-progress' : 'lot-upload-progress';
  async function mount(photoCount = 160) {
    const saved = draft(type);
    delete (saved.formData as any).auctioneerWorkItemId;
    const perLot = photoCount === 160 ? 80 : 200;
    saved.lots = Array.from({ length: Math.ceil(photoCount / perLot) }, (_, lotIndex) => ({
      ...saved.lots[0], id: `capture-lot-${lotIndex}`, coverIndex: 5,
      mainImages: Array.from({ length: Math.min(perLot, photoCount - lotIndex * perLot) }, (_, index) => ({
        uri: `content://photos/lot-${lotIndex}/photo-${index}`, name: `lot-${lotIndex}-photo-${index}.jpg`, type: 'image/jpeg',
        size: 1024, mediaId: `lot-${lotIndex}-photo-${index}`, captureOrder: index,
      })),
    }));
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(saved as any);
    let persisted: any = { ...saved, localRevision: 1 };
    jest.mocked(OfflineCaptureStore.getDraft).mockImplementation(async () => persisted);
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async input => {
      persisted = { ...persisted, ...input, id: 'local-parent', ownerId: 'owner',
        localRevision: persisted.localRevision + 1, lots: input.lots.map(lot => {
          const { files, extraFiles, videoFile, ...rest } = lot;
          return { ...rest, mainImages: files, extraImages: extraFiles,
            videoFiles: videoFile ? [videoFile] : lot.videoFiles || [] };
        }) };
      return persisted;
    });
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => {
      persisted = { ...persisted, submissionState: state, localRevision: persisted.localRevision + 1 };
      return persisted;
    });
    const closed = jest.fn();
    const view = await render(<Form visible draftIdToLoad="local-parent" onClose={closed} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(photoCount));
    return { saved, closed, view };
  }
  function pendingUpload() {
    let reject!: (error: Error) => void;
    let progress!: NonNullable<Parameters<typeof assetService.createAssetReport>[2]>;
    jest.mocked(upload).mockImplementationOnce((_details, _lots, onProgress) => {
      progress = onProgress!;
      return new Promise((_resolve, fail) => { reject = fail; });
    });
    return { reject: (error: Error) => reject(error), progress: (percent: number, detail: any) => progress(percent, detail) };
  }
  const detail = { percent: 24, stage: 'uploading', message: 'Uploading 160 files…', completedFiles: 39, totalFiles: 160,
    uploadedBytes: 39 * 1024, totalBytes: 160 * 1024, activeFileName: 'lot-0-photo-39.jpg' };

  it('shows transfer progress independently of the Asset tab and preserves 160 photos across two lots', async () => {
    const pending = pendingUpload();
    const { saved } = await mount();
    if (type === 'asset') await fireEvent.press(screen.getByText('Details'));
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { pending.progress(24, detail); });
    expect(screen.getByTestId(progressId).props.visible).toBe(true);
    expect(screen.getByText('39 / 160 files')).toBeTruthy();
    expect(screen.getByText('lot-0-photo-39.jpg')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause upload' })).toBeTruthy();
    if (type === 'asset') {
      await fireEvent.press(screen.getByRole('tab', { name: 'Images' }));
      expect(screen.queryByTestId('asset-images-scroll')).toBeNull();
      expect(screen.getByText('160')).toBeTruthy();
      expect(screen.getByText('2')).toBeTruthy();
    }
    const [details, lots] = jest.mocked(upload).mock.calls[0];
    expect(details.mixed_lots).toEqual([expect.objectContaining({ count: 80, cover_index: 5 }), expect.objectContaining({ count: 80, cover_index: 5 })]);
    expect(lots.map(lot => ({ id: lot.id, uris: lot.files.map(file => file.uri) }))).toEqual(saved.lots.map(lot => ({ id: lot.id, uris: lot.mainImages.map(file => file.uri) })));
    await act(async () => { pending.reject(new Error('No transfer progress. Resume this upload when ready.')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(screen.queryByTestId(progressId)).toBeNull();
  });

  it('acknowledges Pause immediately, waits for settlement, then resumes the same saved upload only on request', async () => {
    const pending = pendingUpload();
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Pause upload' }));
    expect(screen.getByRole('button', { name: 'Pausing upload' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Stopping this transfer. Your saved draft will stay available; tap Resume upload when ready.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pausing upload' }));
    await act(async () => { pending.progress(24, detail); });
    expect(screen.queryByText('lot-0-photo-39.jpg')).toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
    await act(async () => { pending.reject(Object.assign(new Error('Upload paused'), { code: 'ERR_CANCELED' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'paused', undefined, 'Upload paused');
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(160);
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    const second = pendingUpload();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(jest.mocked(upload).mock.calls[1][0].client_submission_id).toBe(jest.mocked(upload).mock.calls[0][0].client_submission_id);
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    expect(screen.getByRole('button', { name: 'Pause upload' })).toBeTruthy();
    await act(async () => { second.reject(new Error('Offline')); });
  });

  it.each([992, 5000])('retains all %s photo references, lots and submission identity after interruption at 85%%', async count => {
    const pending = pendingUpload();
    const { saved, closed } = await mount(count);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { pending.progress(85, { ...detail, percent: 85, totalFiles: count, completedFiles: Math.floor(count * .85), totalBytes: count * 1024 }); });
    await act(async () => { pending.reject(Object.assign(new Error('NetworkError'), { code: 'ERR_NETWORK' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(count);
    expect(screen.getByTestId('mock-lot-count').props.children).toBe(saved.lots.length);
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    const resumed = pendingUpload();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(jest.mocked(upload).mock.calls[1][0]).toEqual(jest.mocked(upload).mock.calls[0][0]);
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    expect(jest.mocked(upload).mock.calls[1][1].map(lot => ({ id: lot.id, uris: lot.files.map(file => file.uri) }))).toEqual(saved.lots.map(lot => ({ id: lot.id, uris: lot.mainImages.map(file => file.uri) })));
    await act(async () => { resumed.reject(new Error('Stopped')); });
  });

  it('does not offer to pause a completed receipt while local acceptance is being saved', async () => {
    await mount();
    let finishLocal!: () => void;
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => {
      if (state === 'accepted') await new Promise<void>(resolve => { finishLocal = resolve; });
      return undefined as any;
    });
    jest.mocked(upload).mockImplementationOnce(async (_details, _lots, progress) => {
      progress?.(100, { ...detail, percent: 100, stage: 'complete', message: 'Upload complete', completedFiles: 160 });
      return { jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', accepted: true };
    });
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'accepted', 'report-parent'));
    expect(screen.queryByRole('button', { name: 'Pause upload' })).toBeNull();
    await act(async () => { screen.getByTestId(progressId).props.onRequestClose(); });
    expect(screen.queryByRole('button', { name: 'Pausing upload' })).toBeNull();
    await act(async () => { finishLocal(); });
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalledWith('local-parent', 'paused', expect.anything(), expect.anything());
  });

  // 2026-10-01: pausing during "Finalizing" threw away the server's acceptance
  // and left an accepted report as a paused draft. Finalizing is not pausable.
  it('does not offer to pause, and ignores Android back, while the submission is being finalized', async () => {
    const pending = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { pending.progress(24, detail); });
    expect(screen.getByRole('button', { name: 'Pause upload' })).toBeTruthy();
    await act(async () => {
      pending.progress(95, { ...detail, percent: 95, stage: 'finalizing', message: 'Finalizing submission...', completedFiles: 160, uploadedBytes: 160 * 1024 });
    });
    expect(screen.queryByRole('button', { name: 'Pause upload' })).toBeNull();
    await act(async () => { screen.getByTestId(progressId).props.onRequestClose(); });
    expect(screen.queryByRole('button', { name: 'Pausing upload' })).toBeNull();
    expect(screen.queryByText('Stopping this transfer. Your saved draft will stay available; tap Resume upload when ready.')).toBeNull();
    await act(async () => { pending.reject(new Error('Stopped')); });
  });

  // 2026-10-02: a Pause tapped while the draft was still being saved used to
  // end as "Draft not saved -- check device storage" although the save worked.
  it('treats a Pause tapped while the draft is being saved as a pause, not a failed save', async () => {
    await mount();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async (input: any) => { await saveGate; return { ...input, ownerId: 'owner', id: 'local-parent' }; });
    const savesBefore = jest.mocked(AutoSaveService.saveDraft).mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(jest.mocked(AutoSaveService.saveDraft).mock.calls.length).toBeGreaterThan(savesBefore));
    await fireEvent.press(screen.getByRole('button', { name: 'Pause upload' }));
    await act(async () => { releaseSave(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(Alert.alert).not.toHaveBeenCalledWith('Draft not saved', expect.anything());
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'paused', undefined, expect.stringContaining('Upload paused'));
    expect(upload).not.toHaveBeenCalled();
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
  });

  // 2026-10-02: when the draft could not be saved first, the camera tap used to
  // do nothing at all, which users reported as a frozen camera.
  const cameraTryAgain = () => jest.mocked(Alert.alert).mock.calls
    .find(([title]) => title === 'Camera not opened')?.[2]?.find(button => button.text === 'Try again');

  it('says why the camera did not open when the draft cannot be saved first, and opens it on Try again', async () => {
    await mount();
    jest.mocked(AutoSaveService.saveDraft).mockRejectedValue(new Error('Storage full'));
    await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Camera not opened', expect.stringContaining('Reason: Storage full'), expect.any(Array)));
    expect(screen.queryByTestId('camera-locked')).toBeNull();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(160);
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async (input: any) => ({ ...input, ownerId: 'owner', id: 'local-parent' }));
    await act(async () => { cameraTryAgain()?.onPress?.(); });
    await waitFor(() => expect(screen.getByTestId('camera-locked')).toBeTruthy());
  });

  it('saves the full inspection before opening and binds its media journal to that exact draft', async () => {
    await mount(324);
    await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
    await waitFor(() => expect(mockLatestCamera).toBeTruthy());
    expect(mockLatestCamera.captureContext).toEqual({ ownerId: 'owner', draftId: 'local-parent', sessionId: 'local-parent' });
    const saved = jest.mocked(AutoSaveService.saveDraft).mock.calls.at(-1)![0];
    expect(saved.lots.reduce((n, row) => n + row.files.length + row.extraFiles.length, 0)).toBe(324);
    expect(saved.formData.contractNo).toBe('93530.3-A');
    expect(assetService.createAssetReport).not.toHaveBeenCalled();
    expect(lotListingService.createLotListing).not.toHaveBeenCalled();
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
  });

  it('coalesces repeated camera taps into one draft checkpoint instead of queueing extra work', async () => {
    await mount(324);
    let finish!: (value: any) => void;
    jest.mocked(AutoSaveService.saveDraft).mockClear().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let first!: Promise<void>; let second!: Promise<void>;
    await act(async () => { first = mockOpenLotCamera(0); second = mockOpenLotCamera(0); });
    expect(AutoSaveService.saveDraft).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ...draft(type), ownerId: 'owner', id: 'local-parent' }); await first; await second; });
    expect(mockLatestCamera.captureContext.draftId).toBe('local-parent');
  });

  it('does not silently wait forever or open late when pre-camera draft saving stalls', async () => {
    await mount(324);
    let finish!: (draft: any) => void;
    jest.mocked(AutoSaveService.saveDraft).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    jest.spyOn(cameraTiming, 'cameraDeadline').mockRejectedValueOnce(new cameraTiming.CameraDeadlineError('Camera saving is taking too long.'));
    {
      await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
      expect(Alert.alert).toHaveBeenCalledWith('Camera not opened', expect.stringContaining('taking too long'), expect.any(Array));
      expect(mockLatestCamera).toBeUndefined();
      expect(screen.getByTestId('mock-photo-count').props.children).toBe(324);
      await act(async () => { finish({ ...draft(type), ownerId: 'owner', id: 'local-parent' }); });
      expect(mockLatestCamera).toBeUndefined();
      expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    }
  });

  it('does nothing on Try again once the account has changed', async () => {
    await mount();
    jest.mocked(AutoSaveService.saveDraft).mockRejectedValue(new Error('Storage full'));
    await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
    await waitFor(() => expect(cameraTryAgain()).toBeTruthy());
    jest.mocked(AutoSaveService.saveDraft).mockReset().mockImplementation(async (input: any) => ({ ...input, ownerId: 'owner', id: 'local-parent' }));
    mockOwner = 'other-owner';
    await act(async () => { cameraTryAgain()?.onPress?.(); });
    expect(AutoSaveService.saveDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId('camera-locked')).toBeNull();
  });

  it('does not expose a retry or open the camera when ownership changes during save', async () => {
    await mount();
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async () => {
      mockOwner = 'other-owner';
      throw new Error('Storage unavailable');
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
    expect(cameraTryAgain()).toBeUndefined();
    expect(screen.queryByTestId('camera-locked')).toBeNull();
  });

  /*
   * Automatic resume (2026-10-02, restored by owner decision 2026-10-11): an upload the app stopped by itself waits
   * for a steady connection and continues while the report stays open
   * (services/uploadAutoResume.ts, useUploadAutoResume.ts).
   */
  // Each wait for a steady connection ends when the test says the signal is back.
  function signalWaits() {
    const waits: { signal: AbortSignal; ready: (value: boolean) => void }[] = [];
    jest.mocked(waitForStableConnection).mockImplementation(({ signal }) => new Promise<boolean>((resolve) => { waits.push({ signal, ready: resolve }); }));
    return waits;
  }
  const lostConnection = () => Object.assign(new Error('Upload paused. Your draft is saved. Resume this same upload to check whether the server already accepted it.'),
    { code: 'ERR_CANCELED', acceptanceUncertain: true, pauseReason: 'connection' });
  const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  const waitingText = 'Waiting for signal';

  it('continues by itself once the signal is back, with the same submission and photos', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.progress(40, { ...detail, percent: 40, completedFiles: 64 }); });
    await act(async () => { first.reject(lostConnection()); });
    await waitFor(() => expect(screen.getByText(waitingText)).toBeTruthy());
    expect(screen.getByText('64 of 160 files sent so far')).toBeTruthy();
    expect(Alert.alert).not.toHaveBeenCalledWith('Upload failed', expect.anything());
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'paused', undefined, expect.stringContaining('Upload paused'));
    expect(waits).toHaveLength(1);
    const second = pendingUpload();
    await act(async () => { waits[0].ready(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(jest.mocked(upload).mock.calls[1][0].client_submission_id).toBe(jest.mocked(upload).mock.calls[0][0].client_submission_id);
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    expect(screen.queryByText(waitingText)).toBeNull();
    await act(async () => { second.reject(new Error('Stopped')); });
  });

  it('waits for a connection when Submit finds none, then starts by itself', async () => {
    const waits = signalWaits();
    await mount();
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValueOnce({ status: 'offline' } as any);
    const first = pendingUpload();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(screen.getByText(waitingText)).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
    await act(async () => { waits[0].ready(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(new Error('Stopped')); });
  });

  it('keeps a Pause the person tapped', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Pause upload' }));
    // The Pause aborts the request in flight, which on its own looks like a
    // network failure; the form knows the person asked for it.
    await act(async () => { first.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', request: {} })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(screen.queryByText(waitingText)).toBeNull();
    expect(waits).toHaveLength(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('does not wait after a failure that needs the person', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(Object.assign(new Error('Bad request'), { response: { status: 400, data: { message: 'Bad request' } } })); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload failed', expect.any(String)));
    expect(screen.queryByText(waitingText)).toBeNull();
    expect(waits).toHaveLength(0);
  });

  it('stops waiting for good on Pause upload, and Resume now starts at once', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(networkError()); });
    await waitFor(() => expect(screen.getByText(waitingText)).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Pause upload' }));
    expect(screen.queryByText(waitingText)).toBeNull();
    expect(waits[0].signal.aborted).toBe(true);
    await act(async () => { waits[0].ready(true); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy();
    // 2026-10-11: the Lot Listing header shows it on two lines, as narrow as Submit.
    if (type === 'lotListing') expect(screen.getByText('Resume\nupload')).toBeTruthy();
    // A second interruption waits again; Resume now does not wait for the signal.
    const second = pendingUpload();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await act(async () => { second.reject(networkError()); });
    await waitFor(() => expect(screen.getByText(waitingText)).toBeTruthy());
    const third = pendingUpload();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload now' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(waits[1].signal.aborted).toBe(true);
    expect(jest.mocked(upload).mock.calls[2][0].client_submission_id).toBe(jest.mocked(upload).mock.calls[0][0].client_submission_id);
    await act(async () => { third.reject(new Error('Stopped')); });
  });

  it('hands back to the person after three automatic tries that store nothing new', async () => {
    const waits = signalWaits();
    const attempts = [pendingUpload()];
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    for (let round = 0; round < 3; round += 1) {
      await act(async () => { attempts[round].reject(networkError()); });
      await waitFor(() => expect(waits).toHaveLength(round + 1));
      attempts.push(pendingUpload());
      await act(async () => { waits[round].ready(true); });
      await waitFor(() => expect(upload).toHaveBeenCalledTimes(round + 2));
    }
    await act(async () => { attempts[3].reject(networkError()); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload failed', expect.any(String)));
    expect(waits).toHaveLength(3);
    expect(screen.queryByText(waitingText)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy();
  });

  it('keeps going while each try stores more files', async () => {
    const waits = signalWaits();
    const attempts = [pendingUpload()];
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    for (let round = 0; round < 5; round += 1) {
      await act(async () => { attempts[round].progress(20, { ...detail, completedFiles: 20 * (round + 1) }); });
      await act(async () => { attempts[round].reject(networkError()); });
      await waitFor(() => expect(waits).toHaveLength(round + 1));
      attempts.push(pendingUpload());
      await act(async () => { waits[round].ready(true); });
      await waitFor(() => expect(upload).toHaveBeenCalledTimes(round + 2));
    }
    expect(Alert.alert).not.toHaveBeenCalledWith('Upload failed', expect.anything());
    await act(async () => { attempts[5].reject(new Error('Stopped')); });
  });

  it.each(['account', 'closed form'] as const)('never resumes after a change of %s while waiting', async (change) => {
    const waits = signalWaits();
    const first = pendingUpload();
    const { closed, view } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(lostConnection()); });
    await waitFor(() => expect(waits).toHaveLength(1));
    if (change === 'account') mockOwner = 'other-owner';
    else {
      await view.rerender(<Form visible={false} draftIdToLoad="local-parent" onClose={closed} />);
      expect(waits[0].signal.aborted).toBe(true);
    }
    await act(async () => { waits[0].ready(true); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(waitingText)).toBeNull();
  });

  it.each(['offline', 'logout', 'revision'] as const)('keeps a waiting submission paused after %s changes', async (change) => {
    const waits = signalWaits();
    const first = pendingUpload();
    const { saved } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(networkError()); });
    await waitFor(() => expect(waits).toHaveLength(1));
    await act(async () => {
      if (change === 'offline') pauseActiveUploads();
      else if (change === 'logout') setUploadOwner(null);
      else jest.mocked(OfflineCaptureStore.getDraft).mockResolvedValue({ ...saved, localRevision: 99, formData: { ...saved.formData, ownerName: 'Later edited owner' } } as any);
      waits[0].ready(true);
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(waitingText)).toBeNull();
  });

  it('cannot resume when global Offline arrives during the draft authority read', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    const { saved } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(networkError()); });
    await waitFor(() => expect(waits).toHaveLength(1));
    let complete!: (value: any) => void;
    jest.mocked(OfflineCaptureStore.getDraft).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { waits[0].ready(true); });
    await act(async () => { pauseActiveUploads(); complete(saved); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(waitingText)).toBeNull();
  });

  it('does not register a signal waiter after Offline races the paused-state write', async () => {
    const waits = signalWaits();
    const first = pendingUpload();
    await mount();
    const persist = jest.mocked(OfflineCaptureStore.setSubmissionState).getMockImplementation()!;
    let finishPaused!: () => void;
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation((...args) => args[1] === 'paused'
      ? new Promise(resolve => { finishPaused = () => { void Promise.resolve(persist(...args)).then(resolve); }; })
      : persist(...args));
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => { first.reject(networkError()); });
    await waitFor(() => expect(finishPaused).toBeDefined());
    await act(async () => { pauseActiveUploads(); finishPaused(); });
    expect(waits).toHaveLength(0);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(waitingText)).toBeNull();
  });

  it('ignores late transfer progress after an account change', async () => {
    const pending = pendingUpload();
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    mockOwner = 'another-owner'; setUploadOwner(mockOwner);
    await act(async () => { pending.progress(24, detail); });
    expect(screen.queryByText('lot-0-photo-39.jpg')).toBeNull();
    await act(async () => { pending.reject(new Error('Stopped')); });
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalledWith('local-parent', 'accepted', 'report-parent');
  });
});

describe.each(['asset', 'lotListing'] as const)('%s changed upload recovery', type => {
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const upload = type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing;
  const conflict = (data = {}) => ({ response: { status: 409, data: { code: 'SUBMISSION_MANIFEST_CHANGED', data: { accepted: false, canSupersede: true, ...data } } } });
  const unavailable = () => ({ response: { status: 409, data: { code: 'UPLOAD_SESSION_REPORT_UNAVAILABLE', data: {
    accepted: true, reportAvailable: false, canSupersede: false, canCreateSeparate: true, reportId: 'removed-report', jobId: 'submission-parent',
  } } } });
  const transportFailure = { response: { status: 503 }, message: 'Response unavailable' };
  async function mount(formData = {}) {
    const saved = draft(type);
    delete (saved.formData as any).auctioneerWorkItemId;
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...saved, submissionState: 'paused', formData: { ...saved.formData, ...formData } } as any);
    await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
  }
  function recoveryButtons() {
    return jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Upload needs updating')?.[2];
  }
  it('retains the draft and does not replace anything until explicitly confirmed', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(recoveryButtons()?.map(button => button.text)).toEqual(['Keep Draft', 'Upload updated version']);
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });
  it('saves the replacement identity before transport and reuses it after a lost response', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict({ jobId: 'canonical-old-submission' })).mockRejectedValue(transportFailure);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    await act(async () => { recoveryButtons()?.find(button => button.text === 'Upload updated version')?.onPress?.(); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const replacement = jest.mocked(upload).mock.calls[1][0];
    expect(replacement).toMatchObject({ supersedes_client_submission_id: 'canonical-old-submission', force_new: false, contract_no: '93530.3-A' });
    expect(replacement.client_submission_id).not.toBe('submission-parent');
    const savedIndex = jest.mocked(AutoSaveService.saveDraft).mock.calls.findIndex(([value]) => value.formData.clientSubmissionId === replacement.client_submission_id);
    expect(savedIndex).toBeGreaterThanOrEqual(0);
    expect(jest.mocked(AutoSaveService.saveDraft).mock.calls[savedIndex][0]).toMatchObject({ id: 'local-parent', formData: { supersedesClientSubmissionId: 'canonical-old-submission' } });
    expect(jest.mocked(AutoSaveService.saveDraft).mock.invocationCallOrder[savedIndex]).toBeLessThan(jest.mocked(upload).mock.invocationCallOrder[1]);
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' }).props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(jest.mocked(upload).mock.calls[2][0]).toEqual(replacement);
  });
  it('preserves the persisted replacement pair after reopening the draft', async () => {
    jest.mocked(upload).mockRejectedValue(transportFailure);
    await mount({ clientSubmissionId: 'replacement-id', supersedesClientSubmissionId: 'old-id' });
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ client_submission_id: 'replacement-id', supersedes_client_submission_id: 'old-id', force_new: false });
  });
  it('never offers replacement when the server confirms an available accepted report', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict({ reportId: 'existing-report', accepted: true, reportAvailable: true, canSupersede: false }));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Existing report found', expect.any(String), expect.any(Array)));
    expect(recoveryButtons()).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('blocks a delayed replacement confirmation after account change', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    mockOwner = 'someone-else';
    setUploadOwner(mockOwner);
    await act(async () => { recoveryButtons()?.find(button => button.text === 'Upload updated version')?.onPress?.(); });
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('blocks a delayed replacement confirmation after the form is unmounted', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    const confirm = recoveryButtons()?.find(button => button.text === 'Upload updated version')?.onPress;
    const savedCount = jest.mocked(AutoSaveService.saveDraft).mock.calls.length;
    await cleanup();
    await act(async () => { confirm?.(); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.saveDraft).toHaveBeenCalledTimes(savedCount);
  });
  it('never sends a replacement when saving its recovery identity fails', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    jest.mocked(AutoSaveService.saveDraft).mockRejectedValueOnce(new Error('Storage full'));
    await act(async () => { recoveryButtons()?.find(button => button.text === 'Upload updated version')?.onPress?.(); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Draft not saved', expect.any(String)));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
  });
  it('keeps all media and the old draft, then persists a fresh ordinary identity only after explicit confirmation', async () => {
    jest.mocked(upload).mockRejectedValueOnce(unavailable()).mockRejectedValue(transportFailure);
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async input => ({ ...input, ownerId: 'owner', captureId: `capture-${input.id}` }) as any);
    await mount({ supersedesClientSubmissionId: 'older-unfinished-submission' });
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier report unavailable', expect.any(String), expect.any(Array)));
    const confirm = jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Earlier report unavailable')?.[2]?.find(button => button.text === 'Start separate report')?.onPress;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    await act(async () => { confirm?.(); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const original = jest.mocked(upload).mock.calls[0][0];
    const fresh = jest.mocked(upload).mock.calls[1][0];
    expect(fresh.client_submission_id).not.toBe(original.client_submission_id);
    expect(fresh.capture_id).not.toBe(original.capture_id);
    expect(fresh).toMatchObject({ supersedes_client_submission_id: undefined, force_new: false });
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    const savedIndex = jest.mocked(AutoSaveService.saveDraft).mock.calls.findIndex(([input]) => input.formData.clientSubmissionId === fresh.client_submission_id);
    expect(jest.mocked(AutoSaveService.saveDraft).mock.calls[savedIndex][0].id).not.toBe('local-parent');
    expect(jest.mocked(AutoSaveService.saveDraft).mock.invocationCallOrder[savedIndex]).toBeLessThan(jest.mocked(upload).mock.invocationCallOrder[1]);
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' }).props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(jest.mocked(upload).mock.calls[2][0]).toEqual(fresh);
  });
  it.each(['owner', 'unmount'] as const)('rejects a delayed fresh-report confirmation after %s changes', async change => {
    jest.mocked(upload).mockRejectedValueOnce(unavailable());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier report unavailable', expect.any(String), expect.any(Array)));
    const confirm = jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Earlier report unavailable')?.[2]?.find(button => button.text === 'Start separate report')?.onPress;
    if (change === 'owner') { mockOwner = 'other-owner'; setUploadOwner(mockOwner); }
    else await cleanup();
    const saves = jest.mocked(AutoSaveService.saveDraft).mock.calls.length;
    await act(async () => { confirm?.(); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.saveDraft).toHaveBeenCalledTimes(saves);
  });
  it('does not upload a fresh report when its local save fails or claim that those changes were saved', async () => {
    jest.mocked(upload).mockRejectedValueOnce(unavailable());
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier report unavailable', expect.any(String), expect.any(Array)));
    jest.mocked(AutoSaveService.saveDraft).mockRejectedValueOnce(new Error('Storage full'));
    const confirm = jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Earlier report unavailable')?.[2]?.find(button => button.text === 'Start separate report')?.onPress;
    await act(async () => { confirm?.(); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Draft not saved', expect.stringContaining('No upload was started')));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
  });
  it.each([{}, { reportId: 'report-only' }, { jobId: 'job-only' }, { reportId: 'report', jobId: 'job', accepted: false }])('does not hide the draft on an unconfirmed receipt: %j', async receipt => {
    jest.mocked(upload).mockResolvedValueOnce(receipt as any);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(OfflineQueueService.getSubmissionError).toHaveBeenCalled());
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls.some(call => call[1] === 'accepted')).toBe(false);
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });
  it.each([{ alreadyQueued: true }, { processed: true }, { reusedAcceptance: true }])('retains changed form fields and the same photos when an earlier acceptance is replayed: %j', async marker => {
    jest.mocked(upload).mockResolvedValueOnce({ reportId: 'earlier-report', jobId: 'submission-parent', message: 'Already accepted', accepted: true, ...marker } as any);
    const editedFields = type === 'asset' ? { clientName: 'Edited client after acceptance', appraiser: 'Changed appraiser' } : { salesDate: '2026-11-01', location: 'Edited yard' };
    await mount(editedFields);
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier upload accepted', expect.stringContaining('not confirmation of your current edits')));
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ client_submission_id: 'submission-parent', ...(type === 'asset' ? { client_name: 'Edited client after acceptance', appraiser: 'Changed appraiser' } : { sales_date: '2026-11-01', location: 'Edited yard' }) });
    expect(AutoSaveService.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ formData: expect.objectContaining(editedFields) }));
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(1);
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls.some(call => call[1] === 'accepted')).toBe(false);
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });
  it('does not offer Create Separate if the original was accepted during replacement', async () => {
    jest.mocked(upload).mockRejectedValueOnce(conflict()).mockRejectedValueOnce({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } } });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(recoveryButtons()).toBeTruthy());
    await act(async () => { recoveryButtons()?.find(button => button.text === 'Upload updated version')?.onPress?.(); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(OfflineQueueService.getSubmissionError).toHaveBeenCalled());
    expect(jest.mocked(Alert.alert).mock.calls.some(call => call[2]?.some(button => button.text === 'Create Separate'))).toBe(false);
  });
  it.each(['owner', 'unmount'] as const)('blocks the older active-report Create Separate callback after %s changes', async change => {
    jest.mocked(upload).mockRejectedValueOnce({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } } });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Report Already Processing', expect.any(String), expect.any(Array)));
    const buttons = jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Report Already Processing')?.[2];
    expect(buttons?.map(button => button.text)).toEqual(['Keep Draft', 'Create Separate']);
    const confirm = buttons?.find(button => button.text === 'Create Separate')?.onPress;
    if (change === 'owner') { mockOwner = 'other-owner'; setUploadOwner(mockOwner); }
    else await cleanup();
    const saves = jest.mocked(AutoSaveService.saveDraft).mock.calls.length;
    await act(async () => { confirm?.(); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.saveDraft).toHaveBeenCalledTimes(saves);
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
  });
  it('retains the existing explicit separate-report policy without starting it automatically', async () => {
    jest.mocked(upload).mockRejectedValueOnce({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } } }).mockRejectedValue(transportFailure);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Report Already Processing', expect.any(String), expect.any(Array)));
    expect(upload).toHaveBeenCalledTimes(1);
    const buttons = jest.mocked(Alert.alert).mock.calls.find(call => call[0] === 'Report Already Processing')?.[2];
    await act(async () => { buttons?.find(button => button.text === 'Create Separate')?.onPress?.(); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(jest.mocked(upload).mock.calls[1][0]).toMatchObject({ force_new: true, supersedes_client_submission_id: undefined });
    expect(jest.mocked(upload).mock.calls[1][0].client_submission_id).not.toBe(jest.mocked(upload).mock.calls[0][0].client_submission_id);
    expect(jest.mocked(upload).mock.calls[1][1]).toEqual(jest.mocked(upload).mock.calls[0][1]);
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });
});

describe.each(['asset', 'lotListing'] as const)('%s offline save then review', type => {
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const upload = type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing;
  const saveLabel = type === 'asset' ? 'Save offline asset report' : 'Save offline lot listing';
  function savedDraft(state = 'local') {
    const value = draft(type);
    delete (value.formData as any).auctioneerWorkItemId;
    return { ...value, captureMode: 'offline', manualSubmissionRequired: true, submissionState: state,
      formData: { ...value.formData, captureMode: 'offline', watermarkImages: true, appraiser: 'Saved appraiser', appraisalCompany: 'Saved company', factorsAnalysis: 'Saved line one\nSaved line two' },
      lots: [{ ...value.lots[0], lotNumber: 'X-9', title: 'Saved lot', coverIndex: 1, mainImages: [
        { uri: 'content://photos/second', originalUri: 'content://photos/second', name: 'second.jpg', type: 'image/jpeg', mediaId: 'photo-b' },
        { uri: 'content://photos/first', originalUri: 'content://photos/first', name: 'first.jpg', type: 'image/jpeg', mediaId: 'photo-a' },
      ], extraImages: [{ uri: 'content://photos/report', name: 'report.jpg', type: 'image/jpeg', mediaId: 'report-only' }] }] };
  }
  it.each(['local', 'paused'])('restores a camera video in %s work and submits its original reference with the correct lot', async state => {
    const saved = savedDraft(state);
    const clip = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4', size: 8_000_000,
      mediaId: 'stable-video', ownership: 'gallery' as const, captureOrder: 7, originalOrder: 7 };
    (saved.lots[0].videoFiles as any[]) = [clip];
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(saved as any);
    await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    expect(JSON.parse(screen.getByTestId('mock-restored-lots').props.children)[0].videoFile).toMatchObject(clip);
    expect(upload).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: state === 'paused' ? 'Resume upload' : type === 'asset' ? 'Submit asset report' : 'Submit lot listing' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [details, serviceLots] = jest.mocked(upload).mock.calls[0];
    expect(details.client_submission_id).toBe('submission-parent');
    expect(details.mixed_lots).toEqual([expect.objectContaining({ count: 2, extra_count: 1, video_count: 1, cover_index: 1 })]);
    expect(serviceLots[0]).toMatchObject({ id: saved.lots[0].id, videoFile: { uri: clip.uri, name: clip.name, type: clip.type, size: clip.size } });
    expect(serviceLots[0].files).toHaveLength(2);
    expect(serviceLots[0].extraFiles).toHaveLength(1);
  });
  it('shows Save for new offline work, accepts incomplete details and never uploads', async () => {
    const closed = jest.fn();
    await render(<Form visible onClose={closed} />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    expect(screen.queryByText(type === 'asset' ? 'Submit Report' : 'Submit')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: saveLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(AutoSaveService.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      captureMode: 'offline', explicitActivitySave: true, formData: expect.objectContaining({ captureMode: 'offline', manualSubmissionRequired: true }),
    }));
    expect(upload).not.toHaveBeenCalled();
    expect(reportDraftService.upsertFromLocalDraft).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });
  it('keeps the form open when local Save fails and supports retry', async () => {
    const closed = jest.fn();
    jest.mocked(AutoSaveService.saveDraft).mockRejectedValueOnce(new Error('Storage full'));
    await render(<Form visible onClose={closed} />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    await fireEvent.press(screen.getByRole('button', { name: saveLabel }));
    await waitFor(() => expect(screen.getByText('Storage full')).toBeTruthy());
    expect(closed).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: saveLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });
  it('does not enable submission just because an offline autosave has an identity', async () => {
    await render(<Form visible onClose={jest.fn()} />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save on device' }));
    await waitFor(() => expect(screen.getByRole('button', { name: saveLabel })).toBeTruthy());
    expect(screen.queryByText(type === 'asset' ? 'Submit Report' : 'Submit')).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
  it('restores saved details, photo positions, cover and report-only photos before explicit Submit', async () => {
    const saved = savedDraft();
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(saved as any);
    await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    expect(OfflineCaptureStore.recordDraftOpened).toHaveBeenCalledTimes(1);
    expect(OfflineCaptureStore.recordDraftOpened).toHaveBeenCalledWith('local-parent', expect.any(String));
    const restored = JSON.parse(screen.getByTestId('mock-restored-lots').props.children);
    expect(restored[0]).toMatchObject({ id: saved.lots[0].id, lotNumber: 'X-9', title: 'Saved lot', coverIndex: 1 });
    expect(restored[0].files.map((photo: any) => photo.mediaId)).toEqual(['photo-b', 'photo-a']);
    expect(restored[0].extraFiles.map((photo: any) => photo.mediaId)).toEqual(['report-only']);
    expect(screen.getByRole('radio', { name: 'Offline capture' }).props.accessibilityState.checked).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: saveLabel })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: type === 'asset' ? 'Submit asset report' : 'Submit lot listing' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(prepareOfflineSubmission).toHaveBeenCalled();
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ contract_no: saved.contractNo, client_submission_id: 'submission-parent', watermark_images: true });
    if (type === 'asset') expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ appraiser: 'Saved appraiser', appraisal_company: 'Saved company', factors_analysis: 'Saved line one\nSaved line two' });
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'ready');
  });
  it.each(['ready', 'uploading', 'paused'])('opens interrupted %s work with explicit Resume, never auto-upload', async state => {
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(savedDraft(state) as any);
    await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });
  it('blocks hydration until durable review activity succeeds, then retries without a blank report', async () => {
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(savedDraft() as any);
    jest.mocked(OfflineCaptureStore.recordDraftOpened).mockRejectedValueOnce(new Error('Local storage unavailable'));
    await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Local storage unavailable')).toBeTruthy());
    expect(screen.queryByTestId('mock-photo-count')).toBeNull();
    expect(AutoSaveService.saveDraft).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry opening draft' }));
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    expect(jest.mocked(OfflineCaptureStore.recordDraftOpened).mock.calls[0]).toEqual(jest.mocked(OfflineCaptureStore.recordDraftOpened).mock.calls[1]);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('lotListing offline capture saved without a contract number', () => {
  it('keeps Submit tappable, says where to add the contract number, then submits', async () => {
    const value = draft('lotListing');
    delete (value.formData as any).auctioneerWorkItemId;
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...value, contractNo: undefined, captureMode: 'offline',
      manualSubmissionRequired: true, submissionState: 'local', formData: { ...value.formData, contractNo: '', captureMode: 'offline' } } as any);
    await render(<LotListingFormSheet visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Submit lot listing' }));
    expect(Alert.alert).toHaveBeenCalledWith('Validation Error', 'Enter the contract number in Listing Details, then tap Submit.');
    expect(lotListingService.createLotListing).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Contract number, required'), '93530.3-A');
    await fireEvent.press(screen.getByRole('button', { name: 'Submit lot listing' }));
    await waitFor(() => expect(lotListingService.createLotListing).toHaveBeenCalledTimes(1));
    expect(jest.mocked(lotListingService.createLotListing).mock.calls[0][0]).toMatchObject({ contract_no: '93530.3-A' });
  });
});

describe.each(['asset', 'lotListing'] as const)('%s incoming create-and-continue', (type) => {
  async function mount(submissionState?: 'ready' | 'uploading' | 'paused', fields: AutoSaveFormData = {}, reflectSetup = false) {
    const current = setup(type);
    jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...draft(type), formData: { ...draft(type).formData, ...fields }, submissionState } as any);
    jest.mocked(auctioneerService.continueWorkItem).mockResolvedValue(successor(current));
    const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
    const changed = jest.fn();
    const closed = jest.fn();
    function Navigation() {
      const [active, setActive] = useState(current);
      return <Form visible auctioneer={active} draftIdToLoad="local-parent" onClose={closed} onAuctioneerSetupChange={next => { changed(next); if (reflectSetup) setActive(next); }} />;
    }
    const view = await render(<Navigation />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
    return { current, changed, closed, view, upload: type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing };
  }

  async function mountDurable() {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    const handoff = jest.fn(async () => undefined);
    jest.spyOn(durableContinuationService, 'handoff').mockReturnValue(handoff);
    jest.spyOn(durableContinuationService, 'forParent').mockResolvedValue({ id: 'continue-request', stage: 'staged' } as any);
    const complete = jest.spyOn(durableContinuationService, 'complete');
    const mounted = await mount(undefined, { clientName: 'Carried client', bankPhotosEnabled: false, watermarkImages: false }, true);
    const child = { ...draft(type), id: 'saved-child', captureId: 'child-capture', lots: [], formData: {
      ...draft(type).formData, auctioneerWorkItemId: 'work-next', clientSubmissionId: 'submission-next',
      clientName: 'Carried client', bankPhotosEnabled: false, watermarkImages: false,
    } };
    jest.mocked(AutoSaveService.getDraft).mockImplementation(async id => (id === 'saved-child' ? child : draft(type)) as any);
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async input => ({ ...input, ownerId: 'owner', id: input.id || 'unexpected-new-draft' }) as any);
    jest.mocked(mounted.upload).mockResolvedValue({ backgroundStaged: true, jobId: 'submission-parent', message: 'Saved upload' });
    return { ...mounted, complete, handoff, child, next: { draftId: child.id, setup: successor(mounted.current) } };
  }

  it('keeps exactly one Continue and Close beside each other on every form step', async () => {
    await mount();
    const assertActions = () => {
      expect(within(screen.getByTestId('auctioneer-create-actions')).getAllByRole('button')
        .map(button => button.props.accessibilityLabel)).toEqual(['Create Lot & Continue', 'Create Lot & Close']);
      expect(screen.getAllByRole('button', { name: 'Create Lot & Continue' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Create Lot & Close' })).toHaveLength(1);
    };
    assertActions();
    if (type === 'asset') {
      await fireEvent.press(screen.getByRole('tab', { name: 'Details' }));
      assertActions();
      await fireEvent.press(screen.getByRole('tab', { name: 'Images' }));
      assertActions();
    }
  });

  it('restores the existing offline Save action instead of keeping online creation buttons', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    expect(screen.queryByTestId('auctioneer-create-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create Lot & Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create Lot & Close' })).toBeNull();
    expect(screen.getByRole('button', { name: type === 'asset' ? 'Save offline asset report' : 'Save offline lot listing' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Online capture' }));
    expect(screen.getAllByRole('button', { name: 'Create Lot & Continue' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Create Lot & Close' })).toHaveLength(1);
    expect(within(screen.getByTestId('auctioneer-create-actions')).getAllByRole('button')).toHaveLength(2);
  });

  it('opens the persisted empty next draft before upload acceptance and preserves it through setup acknowledgement', async () => {
    const { complete, upload, changed, closed, handoff, next } = await mountDurable();
    let reserve!: (value: any) => void;
    complete.mockReturnValueOnce(new Promise(resolve => { reserve = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('continue-request'));
    expect(screen.queryByTestId('mock-photo-count')).toBeNull();
    expect(screen.getByText('Opening the next lot')).toBeTruthy();
    expect(screen.queryByText('Report accepted')).toBeNull();
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBe(handoff);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => { reserve(next); });
    await waitFor(() => expect(changed).toHaveBeenCalledWith(next.setup));
    expect(AutoSaveService.getDraft).toHaveBeenCalledWith('saved-child');
    expect(screen.getByLabelText(type === 'asset' ? 'Contract number' : 'Contract number, required').props.value).toBe('93530.3-A');
    if (type === 'asset') {
      expect(screen.getByLabelText('Client name, required').props.value).toBe('Carried client');
      await fireEvent.press(screen.getByRole('tab', { name: 'Images' }));
    } else {
      expect(screen.getByRole('switch', { name: 'Include all lot photos in the condition report' }).props.accessibilityState.checked).toBe(false);
    }
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(0);
    expect(screen.getByTestId('mock-lot-count').props.children).toBe(0);
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalledWith('local-parent', 'accepted', expect.anything());
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Add fresh test photo' }));
    complete.mockRejectedValueOnce(new Error('Next reservation deferred'));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const [details, lots] = jest.mocked(upload).mock.calls[1];
    expect(details).toMatchObject({ auctioneer_work_item_id: 'work-next', client_submission_id: 'submission-next' });
    expect(lots[0].files.map(file => file.uri)).toEqual(['file:///fresh-photo.jpg']);
    expect(jest.mocked(AutoSaveService.saveDraft).mock.calls.at(-1)![0].id).toBe('saved-child');
  });

  it('retries a lost durable reservation without uploading the parent twice', async () => {
    const { complete, upload, changed, next } = await mountDurable();
    complete.mockRejectedValueOnce(new Error('Reservation response lost')).mockResolvedValueOnce(next);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry next lot' })).toBeTruthy());
    expect(screen.queryByText('Report accepted')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry next lot' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(2);
  });

  it('returns to the saved parent without submitting when durable storage confirms no enqueue', async () => {
    const { complete, upload, changed, current } = await mountDurable();
    complete.mockResolvedValueOnce({ parentNotStaged: true, draftId: 'local-parent', setup: current });
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
    expect(upload).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create Lot & Continue' }).props.accessibilityState?.disabled).not.toBe(true);
  });

  it('does not open a next draft after owner change during durable reservation', async () => {
    const { complete, changed, next } = await mountDurable();
    let reserve!: (value: any) => void; complete.mockReturnValueOnce(new Promise(resolve => { reserve = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    mockOwner = 'other-owner'; setUploadOwner(mockOwner);
    await act(async () => { reserve(next); });
    expect(changed).not.toHaveBeenCalled(); expect(AutoSaveService.getDraft).not.toHaveBeenCalledWith('saved-child');
  });

  it('passes the source structure lock through the real form camera boundary', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Open mock lot camera' }));
    expect(screen.getByTestId('camera-locked').props.children).toBe('true');
    expect(screen.getByTestId('camera-locked').props.accessibilityLabel).toBe('Lot 157');
  });

  it('never starts separate work for an unavailable accepted Incoming report', async () => {
    const { upload, closed } = await mount();
    jest.mocked(upload).mockRejectedValueOnce({ response: { status: 409, data: { code: 'UPLOAD_SESSION_REPORT_UNAVAILABLE', data: { accepted: true, reportAvailable: false, canCreateSeparate: true } } } });
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier report unavailable', expect.stringContaining('Incoming'), [{ text: 'Keep Draft', style: 'cancel' }]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });

  it('does not continue or remove a draft whose edited fields received an earlier acceptance', async () => {
    const { upload, closed } = await mount();
    jest.mocked(upload).mockResolvedValueOnce({ jobId: 'job-parent', reportId: 'report-parent', message: 'Already accepted', accepted: true, alreadyQueued: true } as any);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Earlier upload accepted', expect.any(String)));
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });

  it.each([
    {}, { reportId: 'placeholder', jobId: 'job-parent', accepted: false },
    { reportId: 'placeholder', jobId: 'job-parent', accepted: true, phase: 'uploading' },
    { reportId: 'placeholder', jobId: 'job-parent', readyToComplete: true },
  ])('keeps the complete draft when Continue receives an unconfirmed receipt %#', async receipt => {
    const { upload, changed } = await mount();
    jest.mocked(upload).mockResolvedValueOnce(receipt as any);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(1);
  });

  it('keeps the fixed Incoming identity instead of offering a separate changed upload', async () => {
    const { upload } = await mount('paused');
    jest.mocked(upload).mockRejectedValueOnce({ response: { status: 409, data: { code: 'SUBMISSION_MANIFEST_CHANGED' } } });
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload needs checking', expect.stringContaining('Incoming work must keep its assigned upload'), [{ text: 'Keep Draft', style: 'cancel' }]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(jest.mocked(upload).mock.calls[0][0].client_submission_id).toBe('submission-parent');
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
  });

  it('switches an Online saved Incoming draft to local Save when Offline is newly selected', async () => {
    const { upload, closed } = await mount();
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    expect(screen.queryByRole('button', { name: 'Create Lot & Continue' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: type === 'asset' ? 'Save offline asset report' : 'Save offline lot listing' }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(upload).not.toHaveBeenCalled();
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(reportDraftService.upsertFromLocalDraft).not.toHaveBeenCalled();
  });

  it('waits for actual server acceptance, keeps the contract, and mounts an empty next form', async () => {
    const { current, changed, closed, upload } = await mount();
    let accept!: (value: any) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({
      auctioneer_work_item_id: current.workItemId, client_submission_id: current.clientSubmissionId,
      contract_no: current.contract.contractNo,
      mixed_lots: [expect.objectContaining({ source_key: 'upstream-key', source_lot_id: 'upstream-lot', source_submission_id: 'upstream-submission' })],
    });
    await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Accepted', accepted: true }); });
    await waitFor(() => expect(changed).toHaveBeenCalledWith(successor(current)));
    expect(auctioneerService.continueWorkItem).toHaveBeenCalledWith('work-parent', 'report-parent');
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).toHaveBeenCalledWith('local-parent');
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
    expect(screen.getByLabelText(type === 'asset' ? 'Contract number' : 'Contract number, required').props.value).toBe('93530.3-A');
    expect(screen.getByRole('button', { name: 'Create Lot & Continue' }).props.accessibilityState?.disabled).toBe(true);
  });

  it('carries current edited details and settings through the parent setup update, but never old media or submission identity', async () => {
    const { upload, changed } = await mount(undefined, {
      clientName: 'Saved client', ownerName: 'Edited owner', appraiser: 'Edited appraiser', appraisalCompany: 'Edited company',
      appraisalPurpose: 'Edited purpose', preparedFor: 'Edited recipient', industry: 'Edited industry',
      effectiveDate: '2026-10-05', inspectionDate: '2026-10-04', salesDate: '2026-10-09',
      location: 'Edited yard', latitude: 50, longitude: -100, language: 'fr', currency: 'USD',
      includeDamageAnalysis: false, enhanceImages: true, bankPhotosEnabled: false, watermarkImages: false,
      factorsAgeCondition: 'Edited age', factorsQuality: 'Edited quality', factorsAnalysis: 'Edited analysis',
      includeValuationTable: true, selectedValuationMethods: ['TKV', 'OLV'],
    }, true);
    if (type === 'asset') {
      await fireEvent.press(screen.getByRole('tab', { name: 'Details' }));
      await fireEvent.changeText(screen.getByLabelText('Client name, required'), 'Latest client');
      await fireEvent.changeText(screen.getByLabelText('Owner name'), '');
    } else {
      await fireEvent.press(screen.getByRole('switch', { name: 'Include all lot photos in the condition report' }));
      await fireEvent.press(screen.getByRole('switch', { name: 'Apply watermark to new photos' }));
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(auctioneerService.getSetup).toHaveBeenCalledTimes(1);
    expect(AutoSaveService.getDraft).toHaveBeenCalledTimes(2); // boundary + original form, never the successor
    if (type === 'asset') {
      expect(screen.getByLabelText('Client name, required').props.value).toBe('Latest client');
      expect(screen.getByLabelText('Owner name').props.value).toBe('');
      expect(screen.getByLabelText('Appraiser name, required').props.value).toBe('Edited appraiser');
      expect(screen.getByLabelText('Appraisal company').props.value).toBe('Edited company');
      await fireEvent.press(screen.getByRole('tab', { name: 'Images' }));
    } else {
      expect(screen.getByRole('switch', { name: 'Include all lot photos in the condition report' }).props.accessibilityState.checked).toBe(true);
      expect(screen.getByRole('switch', { name: 'Apply watermark to new photos' }).props.accessibilityState.checked).toBe(true);
    }
    expect(screen.getByTestId('mock-lot-count').props.children).toBe(0);
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(0);
    jest.mocked(AutoSaveService.saveDraft).mockImplementation(async input => ({ ...input, ownerId: 'owner', id: input.id || 'unexpected-missing-id' }) as any);
    await fireEvent.press(screen.getByRole('button', { name: 'Add fresh test photo' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const [first, second] = jest.mocked(upload).mock.calls;
    const { client_submission_id: _oldId, auctioneer_work_item_id: _oldWork, progress_id: _oldProgress, mixed_lots: _oldLots, ...firstDetails } = first[0];
    const { client_submission_id, auctioneer_work_item_id, progress_id, mixed_lots, ...nextDetails } = second[0];
    expect(nextDetails).toEqual(firstDetails);
    expect(client_submission_id).toBe('submission-next');
    expect(auctioneer_work_item_id).toBe('work-next');
    expect(progress_id).toBe('submission-next');
    expect(second[1]).toHaveLength(1);
    expect(second[1][0].files.map(file => file.uri)).toEqual(['file:///fresh-photo.jpg']);
    expect(mixed_lots?.[0]).not.toHaveProperty('source_key');
    const nextDraft = jest.mocked(AutoSaveService.saveDraft).mock.calls.at(-1)![0];
    expect(nextDraft.id).not.toBe('local-parent');
    expect(nextDraft.formData.clientSubmissionId).toBe('submission-next');
    expect(nextDraft.formData.supersedesClientSubmissionId).toBeUndefined();
  });

  it.each(['receipt', 'cleanup'] as const)('opens the next form while old %s persistence is still pending', async stage => {
    const { changed, upload } = await mount();
    let finish!: () => void;
    const delayed = new Promise<void>(resolve => { finish = resolve; });
    if (stage === 'receipt') jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => state === 'accepted' ? delayed as any : undefined);
    else jest.mocked(AutoSaveService.removeDraftRecordOnly).mockReturnValueOnce(delayed);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Report accepted')).toBeNull();
    expect(screen.getByLabelText(type === 'asset' ? 'Contract number' : 'Contract number, required').props.value).toBe('93530.3-A');
    expect(upload).toHaveBeenCalledTimes(1);
    if (stage === 'receipt') expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps originals when the local accepted receipt fails without blocking the new form', async () => {
    const { changed } = await mount();
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => { if (state === 'accepted') throw new Error('Disk unavailable'); return undefined as any; });
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
  });

  it('does not clean up an old record when its local receipt finishes after account change', async () => {
    const { changed } = await mount();
    let complete!: () => void;
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => {
      if (state === 'accepted') await new Promise<void>(resolve => { complete = resolve; });
      return undefined as any;
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    mockOwner = 'other-owner'; setUploadOwner(mockOwner);
    await act(async () => { complete(); });
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });

  it('ignores a continuation response after account change', async () => {
    const { current, changed } = await mount();
    let complete!: (value: AuctioneerWorkItemSetup) => void;
    jest.mocked(auctioneerService.continueWorkItem).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(auctioneerService.continueWorkItem).toHaveBeenCalledTimes(1));
    mockOwner = 'other-owner'; setUploadOwner(mockOwner);
    await act(async () => { complete(successor(current)); });
    expect(changed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
  });

  it('double taps neither upload twice nor open two successors, and leaves no accepted form to autosave', async () => {
    const { current, upload, changed } = await mount();
    let accept!: (value: unknown) => void;
    let complete!: (value: AuctioneerWorkItemSetup) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise(resolve => { accept = resolve as any; }));
    jest.mocked(auctioneerService.continueWorkItem).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const submit = screen.getByRole('button', { name: 'Create Lot & Continue' });
    await fireEvent.press(submit);
    await fireEvent.press(submit);
    expect(upload).toHaveBeenCalledTimes(1);
    await act(async () => { accept({ accepted: true, reportId: 'report-parent', jobId: 'job-parent' }); });
    await waitFor(() => expect(auctioneerService.continueWorkItem).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Create Lot & Continue' })).toBeNull();
    expect(screen.queryByTestId('mock-photo-count')).toBeNull();
    await act(async () => { complete(successor(current)); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('retries only continuation after acceptance, without uploading or clearing the original form twice', async () => {
    const { changed, upload } = await mount();
    jest.mocked(auctioneerService.continueWorkItem).mockRejectedValueOnce(new Error('Connection lost during continuation'));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry new lot' })).toBeTruthy());
    expect(changed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry new lot' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(auctioneerService.continueWorkItem).toHaveBeenCalledTimes(2);
    expect(jest.mocked(auctioneerService.continueWorkItem).mock.calls).toEqual([['work-parent', 'report-parent'], ['work-parent', 'report-parent']]);
  });

  it.each([
    [{ message: 'Request failed with status code 409', response: { status: 409, data: { message: 'This contract is no longer assigned to you in Incoming.' } } }, 'This contract is no longer assigned to you in Incoming.'],
    [{ message: 'Request failed with status code 503' }, 'Could not confirm the next form.'],
  ] as const)('shows actionable continuation failure without losing the accepted report %#', async (failure, expected) => {
    const { changed, upload } = await mount();
    jest.mocked(auctioneerService.continueWorkItem).mockRejectedValueOnce(failure);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy());
    expect(screen.queryByText(/status code/i)).toBeNull();
    expect(screen.queryByTestId('mock-photo-count')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry new lot' })).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not call continue or queue an upload when generate-and-next is offline', async () => {
    const { changed, upload } = await mount();
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'offline' } as any);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Connection required', expect.any(String)));
    expect(upload).not.toHaveBeenCalled();
    expect(OfflineQueueService.enqueueAssetReport).not.toHaveBeenCalled();
    expect(OfflineQueueService.enqueueLotListing).not.toHaveBeenCalled();
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(1);
  });

  it('keeps the same report submission identity and photos after a pre-acceptance failure', async () => {
    const { upload, changed } = await mount();
    jest.mocked(upload).mockRejectedValueOnce(new Error('Upload interrupted'));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload failed', expect.any(String)));
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls.map(([details]) => details.client_submission_id)).toEqual(['submission-parent', 'submission-parent']);
  });

  it.each([null, 'other-owner'])('does not start an old form upload after owner changes to %s during connectivity checking', async (nextOwner) => {
    const { upload } = await mount();
    let resolveConnectivity!: (value: any) => void;
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockReturnValueOnce(new Promise((resolve) => { resolveConnectivity = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(OfflineQueueService.getConnectivityStatus).toHaveBeenCalledTimes(1));
    mockOwner = nextOwner;
    setUploadOwner(nextOwner);
    await act(async () => { resolveConnectivity({ status: 'online' }); });
    expect(upload).not.toHaveBeenCalled();
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls).toEqual([['local-parent', 'ready']]);
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
  });

  it('honours Pause while pre-upload connectivity is pending without starting transport', async () => {
    const { upload } = await mount();
    let resolveConnectivity!: (value: any) => void;
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockReturnValueOnce(new Promise((resolve) => { resolveConnectivity = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(OfflineQueueService.getConnectivityStatus).toHaveBeenCalledTimes(1));
    pauseActiveUploads();
    await act(async () => { resolveConnectivity({ status: 'online' }); });
    expect(upload).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'paused', undefined, expect.any(String));
  });

  it('persists explicit submission intent before starting any upload with the original identity', async () => {
    const { upload } = await mount();
    let saveReady!: () => void;
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementationOnce(() => new Promise((resolve) => { saveReady = () => resolve(undefined as any); }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'ready'));
    expect(upload).not.toHaveBeenCalled();
    await act(async () => { saveReady(); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][0].client_submission_id).toBe('submission-parent');
  });

  it.each(['ready', 'uploading', 'paused'] as const)('restores %s as explicit Resume without automatically uploading', async (state) => {
    const { upload } = await mount(state);
    expect(screen.getByText('Resume upload')).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    expect(OfflineQueueService.getConnectivityStatus).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).not.toHaveBeenCalled();
  });
});

it.each(['asset', 'lotListing'] as const)('%s does not process a cloud preview after its owner changes during cloud save', async (type) => {
  const ordinary = draft(type);
  delete (ordinary.formData as any).auctioneerWorkItemId;
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(ordinary as any);
  let resolveCloud!: (value: any) => void;
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockReturnValueOnce(new Promise((resolve) => { resolveCloud = resolve; }));
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  await render(<Form visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
  await fireEvent.press(type === 'asset' ? screen.getByText('Draft') : screen.getByRole('button', { name: 'Save lot listing draft' }));
  await waitFor(() => expect(reportDraftService.upsertFromLocalDraft).toHaveBeenCalledTimes(1));
  mockOwner = 'other-owner';
  setUploadOwner(mockOwner);
  await act(async () => { resolveCloud({ id: 'cloud-owner-a' }); });
  expect(reportDraftService.processPreview).not.toHaveBeenCalled();
});

it.each(['asset', 'lotListing'] as const)('explains a %s cloud draft conflict without raw status codes or deleting local media', async type => {
  const ordinary = draft(type);
  delete (ordinary.formData as any).auctioneerWorkItemId;
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(ordinary as any);
  jest.mocked(reportDraftService.upsertFromLocalDraft).mockRejectedValueOnce({ response: { status: 409, data: { code: 'DRAFT_REVISION_CONFLICT' } }, message: 'Request failed with status code 409' });
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const closed = jest.fn();
  await render(<Form visible draftIdToLoad="local-parent" onClose={closed} />);
  await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
  await fireEvent.press(type === 'asset' ? screen.getByText('Draft') : screen.getByRole('button', { name: 'Save lot listing draft' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Draft Preview Not Started', expect.stringContaining('saved draft changed')));
  expect(jest.mocked(Alert.alert).mock.calls.flat().join(' ')).not.toContain('409');
  expect(closed).not.toHaveBeenCalled();
  expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
  expect(reportDraftService.processPreview).not.toHaveBeenCalled();
});

function BoundaryHarness({ current, draftId }: { current: AuctioneerWorkItemSetup; draftId?: string }) {
  return <AuctioneerFormBoundary visible type={current.reportType} setup={current} draftIdToLoad={draftId} onClose={jest.fn()}>
    {(control) => <View><Text testID="editable-work-item">{control?.setup.workItemId}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Accept without report ID" onPress={() => void control?.acceptAndContinue({ jobId: 'job-parent' })}><Text>Accept</Text></TouchableOpacity>
    </View>}
  </AuctioneerFormBoundary>;
}

it.each(['report_created', 'sent', 'abandoned'] as const)('does not mount an empty editable form for %s setup', async (status) => {
  const current = { ...setup(), status, reportId: status === 'abandoned' ? null : 'report-parent' };
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
  await render(<BoundaryHarness current={current} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
  expect(screen.queryByTestId('editable-work-item')).toBeNull();
  expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
});

it('reconciles a missing acceptance report ID through setup before continuing, never from a job ID', async () => {
  const current = setup();
  jest.mocked(auctioneerService.getSetup).mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, status: 'report_created', reportId: 'report-parent' });
  jest.mocked(auctioneerService.continueWorkItem).mockResolvedValue(successor(current));
  await render(<BoundaryHarness current={current} />);
  await waitFor(() => expect(screen.getByTestId('editable-work-item')).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Accept without report ID' }));
  await waitFor(() => expect(auctioneerService.continueWorkItem).toHaveBeenCalledWith('work-parent', 'report-parent'));
  expect(auctioneerService.getSetup).toHaveBeenCalledTimes(2);
});

it('rejects a draft from another work item before mounting its saved media', async () => {
  const current = setup();
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...draft('asset'), formData: { ...draft('asset').formData, auctioneerWorkItemId: 'other-work' } } as any);
  await render(<BoundaryHarness current={current} draftId="local-parent" />);
  await waitFor(() => expect(screen.getByText('This draft belongs to a different Auctioneer work item.')).toBeTruthy());
  expect(screen.queryByTestId('editable-work-item')).toBeNull();
  expect(auctioneerService.getSetup).not.toHaveBeenCalled();
});

it.each([true, false, undefined])('resumes an exact saved upload only when server capability is %s', async (canResumeUpload) => {
  const current = { ...setup(), status: 'report_created' as const, reportId: 'placeholder-report', canResumeUpload };
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(draft('asset') as any);
  await render(<BoundaryHarness current={current} draftId="local-parent" />);
  if (canResumeUpload === true) {
    await waitFor(() => expect(screen.getByTestId('editable-work-item')).toBeTruthy());
  } else {
    await waitFor(() => expect(screen.getByText('Report already created')).toBeTruthy());
    expect(screen.queryByTestId('editable-work-item')).toBeNull();
  }
});

it('does not permit a fresh form for a resumable placeholder without its original draft', async () => {
  const current = { ...setup(), status: 'report_created' as const, reportId: 'placeholder-report', canResumeUpload: true };
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
  await render(<BoundaryHarness current={current} />);
  await waitFor(() => expect(screen.getByText('Resume the original draft')).toBeTruthy());
  expect(screen.queryByTestId('editable-work-item')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Continue with new lot' })).toBeNull();
});

it('keeps modern draft identity after the parent clears its consumed draft pointer', async () => {
  const current = setup('lotListing');
  jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
  jest.mocked(auctioneerService.continueWorkItem).mockResolvedValue(successor(current));
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(draft('lotListing') as any);
  function DraftNavigation() {
    const [draftId, setDraftId] = useState<string | null>('local-parent');
    return <LotListingFormSheet visible draftIdToLoad={draftId} onDraftLoaded={() => setDraftId(null)} onClose={jest.fn()} />;
  }
  await render(<DraftNavigation />);
  await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
  expect(screen.getByRole('button', { name: 'Create Lot & Continue' })).toBeTruthy();
  expect(auctioneerService.getSetup).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
  await waitFor(() => expect(auctioneerService.continueWorkItem).toHaveBeenCalledWith('work-parent', 'report-parent'));
  expect(jest.mocked(lotListingService.createLotListing).mock.calls[0][0].auctioneer_work_item_id).toBe('work-parent');
});

it('keeps an accepted form blocked when the successor was already used elsewhere', async () => {
  const current = setup();
  jest.mocked(auctioneerService.getSetup).mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, status: 'report_created', reportId: 'report-parent' });
  jest.mocked(auctioneerService.continueWorkItem).mockResolvedValue({ ...successor(current), status: 'report_created', reportId: 'report-next' });
  await render(<BoundaryHarness current={current} />);
  await waitFor(() => expect(screen.getByTestId('editable-work-item')).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Accept without report ID' }));
  await waitFor(() => expect(screen.getByText(/next work item already has report report-next/)).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Retry new lot' })).toBeNull();
  expect(screen.queryByText('work-next')).toBeNull();
});

it('does not replace a missing requested draft with a blank ordinary form', async () => {
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(null);
  await render(<BoundaryHarness current={setup()} draftId="missing-draft" />);
  await waitFor(() => expect(screen.getByText(/requested saved draft is unavailable/)).toBeTruthy());
  expect(screen.queryByTestId('editable-work-item')).toBeNull();
  expect(screen.getByTestId('auctioneer-handoff-scroll')).toBeTruthy();
});
