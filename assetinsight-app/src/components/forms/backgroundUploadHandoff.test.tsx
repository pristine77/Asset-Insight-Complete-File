/**
 * Background uploads, form side (2026-10-02): which Submits the Dashboard's
 * forms hand to the background upload line, and which keep waiting in the
 * form. The line itself is real (services/backgroundUploadManager.ts); the
 * report services, storage and the network are stand-ins, as in
 * AuctioneerForms.test.tsx.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AssetFormSheet from './AssetFormSheet';
import LotListingFormSheet from './LotListingFormSheet';
import auctioneerService, { type AuctioneerReportType, type AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import assetService from '../../services/assetService';
import lotListingService from '../../services/lotListingService';
import AutoSaveService from '../../services/autoSaveService';
import OfflineQueueService from '../../services/offlineQueueService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { prepareOfflineSubmission } from '../../services/offlineSubmissionService';
import { setUploadOwner, type UploadOperation } from '../../services/uploadCancellation';
import { UPLOAD_WAITING_FOR_CONNECTION } from '../../services/uploadResumePolicy';
import backgroundUploadManager, {
  ALREADY_UPLOADING_MESSAGE,
  ALREADY_UPLOADING_TITLE,
  BACKGROUND_UPLOAD_BUSY_MESSAGE,
  WAITING_FOR_SIGNAL_MESSAGE,
  WAITING_FOR_SIGNAL_TITLE,
  type BackgroundUploadRequest,
} from '../../services/backgroundUploadManager';
import { waitForStableConnection } from '../../services/uploadAutoResume';
import type { AuctionManagementTaskPayload } from '../../services/auctionManagementService';
import durableReportTransfer from '../../services/durableReportTransfer';

// Each test mounts a full report form, some twice; the first mount in the file
// is slow on a cold module cache.
jest.setTimeout(20_000);

let mockOwner: string | null = 'owner';
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })) } }));
jest.mock('../../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner, getDraft: jest.fn(), setSubmissionState: jest.fn(async () => undefined), recordDraftOpened: jest.fn(async () => undefined) } }));
jest.mock('../../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async draft => draft) }));
// The wait for a steady connection is the test's to end (signalWaits below).
jest.mock('../../services/uploadAutoResume', () => ({
  ...jest.requireActual('../../services/uploadAutoResume'),
  waitForStableConnection: jest.fn(),
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'Inspector', companyName: 'QA' } }) }));
jest.mock('../../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { background: '#101010', surface: '#202020', text: '#ffffff', textSecondary: '#cccccc', borderStrong: '#777777', accent: '#ff3344' } }) }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-CA', regionCode: 'CA' }] }));
jest.mock('./CameraCapture', () => ({ __esModule: true, default: () => null }));
jest.mock('../camera/NativeAuctionCameraScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('./LotManager', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return { __esModule: true, default: ({ lots }: any) => <View>
    <Text testID="mock-photo-count">{lots.reduce((sum: number, lot: any) => sum + lot.files.length, 0)}</Text>
  </View> };
});
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../services/auctioneerService', () => ({
  ...jest.requireActual('../../services/auctioneerService'),
  __esModule: true,
  default: { getSetup: jest.fn(), continueWorkItem: jest.fn(), getArrivalPhotoRequests: jest.fn(async () => []), sendArrivalPhotos: jest.fn() },
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

function ordinaryDraft(type: AuctioneerReportType) {
  return {
    id: 'local-parent', ownerId: 'owner', type, title: 'Yard capture', contractNo: '93530.3-A', createdAt: '2026-09-14', updatedAt: '2026-09-14',
    formData: { clientSubmissionId: 'submission-parent', contractNo: '93530.3-A', clientName: 'Yard customer', appraisalPurpose: 'Auction listing and condition report', appraiser: 'Inspector', currency: 'CAD', language: 'en' as const, salesDate: '2026-10-20', location: 'Auction yard' },
    lots: [{ id: 'capture-lot-0', mode: 'single_lot' as const, coverIndex: 1, videoFiles: [],
      mainImages: [
        { uri: 'content://photos/first', name: 'first.jpg', type: 'image/jpeg', mediaId: 'photo-a', captureOrder: 0 },
        { uri: 'content://photos/second', name: 'second.jpg', type: 'image/jpeg', mediaId: 'photo-b', captureOrder: 1 },
      ],
      extraImages: [{ uri: 'content://photos/report', name: 'report.jpg', type: 'image/jpeg', mediaId: 'report-only' }] }],
    activeLotIdx: 0,
  };
}

function incomingSetup(type: AuctioneerReportType): AuctioneerWorkItemSetup {
  return {
    workItemId: 'work-parent', cycleKey: 'cycle-parent', kind: 'scheduleA', reportType: type,
    clientSubmissionId: 'submission-parent', status: 'claimed', reportId: null,
    contract: { id: 'contract-id', contractNo: '93530.3-A', customerName: 'Incoming customer', eventTitle: 'Fall sale', eventDate: '2026-09-20', currency: 'CAD', location: 'Auction yard' },
    lots: [{ sourceKey: 'upstream-key', lotId: 'upstream-lot', submissionId: 'upstream-submission', lotNumber: '157' }],
  };
}

function incomingDraft(type: AuctioneerReportType) {
  return {
    id: 'local-parent', ownerId: 'owner', type, title: 'Incoming capture', contractNo: '93530.3-A', createdAt: '2026-09-14', updatedAt: '2026-09-14',
    formData: { auctioneerWorkItemId: 'work-parent', clientSubmissionId: 'submission-parent', contractNo: '93530.3-A', clientName: 'Incoming customer', appraisalPurpose: 'Auction listing and condition report', appraiser: 'Inspector', currency: 'CAD', language: 'en' as const },
    lots: [{ id: 'auctioneer-work-parent-1', mode: 'single_lot' as const, mainImages: [{ uri: 'file:///isolated-photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }], extraImages: [], videoFiles: [], coverIndex: 0 }],
    activeLotIdx: 0,
  };
}

/** A background upload of another report that keeps running until the test ends. */
function otherBackgroundUpload(draftId = 'other-draft') {
  const started: { operation?: UploadOperation } = {};
  const upload = jest.fn((_onProgress: unknown, operation: UploadOperation) => {
    started.operation = operation;
    return new Promise(() => {});
  });
  const request: BackgroundUploadRequest = {
    draftId, type: 'asset', ownerId: 'owner', title: 'Other contract', totalFiles: 12,
    draft: { id: draftId, ownerId: 'owner' } as any, upload,
  };
  return { request, upload, started };
}

const activeReport = () => ({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } }, message: 'Request failed with status code 409' });

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'owner';
  setUploadOwner(mockOwner);
  backgroundUploadManager.resetForTests();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(OfflineQueueService.getConnectivityStatus).mockReset().mockResolvedValue({ status: 'online' } as any);
  jest.mocked(OfflineQueueService.getSubmissionError).mockReturnValue({ title: 'Upload failed', message: 'Retry this submission.' } as any);
  jest.mocked(AutoSaveService.saveDraft).mockImplementation(async (input) => ({ ...input, ownerId: 'owner', id: 'local-parent' }) as any);
  jest.mocked(AutoSaveService.removeDraftRecordOnly).mockResolvedValue(undefined);
  jest.mocked(AutoSaveService.cleanupOrphanedMedia).mockResolvedValue(0);
  jest.mocked(OfflineCaptureStore.setSubmissionState).mockReset().mockResolvedValue(undefined as any);
  jest.mocked(prepareOfflineSubmission).mockReset().mockImplementation(async (draft) => draft as any);
  jest.mocked(assetService.createAssetReport).mockReset().mockResolvedValue({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', accepted: true } as any);
  jest.mocked(lotListingService.createLotListing).mockReset().mockResolvedValue({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', phase: 'processing' });
  // By default the signal never comes back during a test.
  jest.mocked(waitForStableConnection).mockReset().mockImplementation(() => new Promise<boolean>(() => {}));
});

/** Each wait for a steady connection ends when the test says the signal is back. */
function signalWaits() {
  const waits: { signal: AbortSignal; ready: (value: boolean) => void }[] = [];
  jest.mocked(waitForStableConnection).mockImplementation(({ signal }) => new Promise<boolean>((resolve) => { waits.push({ signal, ready: resolve }); }));
  return waits;
}
const noConnection = () => Object.assign(new Error('Saved on this device. Connect to the internet, then tap Resume upload.'), { code: UPLOAD_WAITING_FOR_CONNECTION });

afterEach(async () => {
  await cleanup();
  backgroundUploadManager.resetForTests();
  jest.restoreAllMocks();
});

describe.each(['asset', 'lotListing'] as const)('%s Submit on the Dashboard', (type) => {
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const upload = type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing;
  const submitLabel = type === 'asset' ? 'Submit asset report' : 'Submit lot listing';

  async function mount(backgroundUploads = true, saved: object = ordinaryDraft(type)) {
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(saved as any);
    const closed = jest.fn();
    const view = await render(<Form visible backgroundUploads={backgroundUploads} draftIdToLoad="local-parent" onClose={closed} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBeGreaterThan(0));
    return { closed, view };
  }
  const snapshot = () => backgroundUploadManager.getSnapshot();

  it('closes once only after native durable staging, keeps originals and does not record server acceptance', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    const handoff = jest.fn(async () => undefined);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(handoff);
    let stage!: (value: any) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise(resolve => { stage = resolve; }));
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(closed).not.toHaveBeenCalled();
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBe(handoff);
    expect(jest.mocked(upload).mock.calls[0][0].client_submission_id).toBe('submission-parent');
    await act(async () => { stage({ backgroundStaged: true, jobId: 'submission-parent', message: 'Saved upload' }); });
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls.some(([, state]) => state === 'accepted')).toBe(false);
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
    expect(AutoSaveService.cleanupOrphanedMedia).not.toHaveBeenCalled();
  });

  it('retains the editor after a durable staging failure and does not start the JS queue', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(jest.fn(async () => undefined));
    jest.mocked(upload).mockRejectedValueOnce(new Error('Native durable storage failed'));
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(closed).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(2);
  });

  it('retains the existing in-app upload path for cloud-only sources', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    const saved = ordinaryDraft(type);
    saved.lots[0].mainImages[0].uri = 'https://storage.invalid/saved-photo.jpg';
    jest.mocked(upload).mockReturnValueOnce(new Promise(() => undefined));
    const { closed } = await mount(true, saved);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBeUndefined();
    expect(snapshot().active?.draftId).toBe('local-parent');
  });

  it('ignores a late staged response after the account changes', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(jest.fn(async () => undefined));
    let stage!: (value: any) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise(resolve => { stage = resolve; }));
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    mockOwner = 'another-owner'; setUploadOwner(mockOwner);
    await act(async () => { stage({ backgroundStaged: true, jobId: 'submission-parent', message: 'Saved upload' }); });
    expect(closed).not.toHaveBeenCalled();
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls.some(([, state]) => state === 'accepted')).toBe(false);
  });

  it('saves, hands the same upload to the background line and closes the form at once', async () => {
    // The upload the form itself would send, for comparison. It never
    // answers, so nothing of it outlives this step.
    jest.mocked(upload).mockImplementationOnce(() => new Promise(() => {}));
    await mount(false);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [foregroundDetails, foregroundLots] = jest.mocked(upload).mock.calls[0];
    await cleanup();
    jest.mocked(upload).mockClear();
    jest.mocked(OfflineCaptureStore.setSubmissionState).mockClear();
    jest.mocked(Alert.alert).mockClear();

    let accept!: (value: any) => void;
    jest.mocked(upload).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    // No blocking alert: the upload bar shows progress and the outcome.
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'ready');
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [details, lots, , options] = jest.mocked(upload).mock.calls[0];
    expect(details).toEqual(foregroundDetails);
    expect(lots).toEqual(foregroundLots);
    expect(details.client_submission_id).toBe('submission-parent');
    expect(options?.operation?.isActive()).toBe(true);
    expect(snapshot().active).toMatchObject({ draftId: 'local-parent', type, title: '93530.3-A', totalFiles: 3, status: 'uploading' });
    await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', accepted: true }); });
    await waitFor(() => expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'accepted', 'report-parent'));
    expect(snapshot().notices).toEqual([expect.objectContaining({ kind: 'sent', draftId: 'local-parent' })]);
    expect(snapshot().active).toBeNull();
  });

  // Owner decision 2026-10-11: a Submit with no connection waits for signal and
  // sends by itself. These replace the 6 October test that kept it in the form.
  it('hands a Submit with no connection to the line, closes the form and says it sends by itself', async () => {
    const waits = signalWaits();
    jest.mocked(prepareOfflineSubmission).mockRejectedValueOnce(noConnection());
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'offline' } as any);
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(Alert.alert).toHaveBeenCalledWith(WAITING_FOR_SIGNAL_TITLE, WAITING_FOR_SIGNAL_MESSAGE);
    await waitFor(() => expect(snapshot().active).toMatchObject({ draftId: 'local-parent', status: 'waiting' }));
    expect(upload).not.toHaveBeenCalled();
    // The signal comes back: the same frozen upload starts by itself.
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'online' } as any);
    await act(async () => { waits[0].ready(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][0].client_submission_id).toBe('submission-parent');
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBeUndefined();
  });

  it('on Android durable builds waits in the line too, then hands the upload to Android', async () => {
    const waits = signalWaits();
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    const handoff = jest.fn(async () => undefined);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(handoff);
    jest.mocked(prepareOfflineSubmission).mockRejectedValueOnce(noConnection());
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'offline' } as any);
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(Alert.alert).toHaveBeenCalledWith(WAITING_FOR_SIGNAL_TITLE, WAITING_FOR_SIGNAL_MESSAGE);
    await waitFor(() => expect(snapshot().active).toMatchObject({ draftId: 'local-parent', status: 'waiting' }));
    expect(upload).not.toHaveBeenCalled();
    jest.mocked(upload).mockResolvedValueOnce({ backgroundStaged: true, jobId: 'submission-parent', message: 'Saved upload' } as any);
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValue({ status: 'online' } as any);
    await act(async () => { waits[0].ready(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBe(handoff);
    // Android has it now: the line lets go and nothing is recorded as accepted here.
    await waitFor(() => expect(snapshot().active).toBeNull());
    expect(jest.mocked(OfflineCaptureStore.setSubmissionState).mock.calls.some(([, state]) => state === 'accepted')).toBe(false);
  });

  it('on Android durable builds sends a connected Submit itself, as before', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(jest.fn(async () => undefined));
    jest.mocked(upload).mockReturnValueOnce(new Promise(() => undefined));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(snapshot().active).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalledWith(WAITING_FOR_SIGNAL_TITLE, expect.anything());
  });

  it('waits in the open form when the line may not take it (background uploads off)', async () => {
    const waits = signalWaits();
    jest.mocked(OfflineCaptureStore.getDraft).mockImplementation(async () => {
      const saves = jest.mocked(AutoSaveService.saveDraft).mock.results;
      return await saves[saves.length - 1].value;
    });
    jest.mocked(OfflineQueueService.getConnectivityStatus).mockResolvedValueOnce({ status: 'offline' } as any);
    const { closed } = await mount(false);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(screen.getByText('Waiting for signal')).toBeTruthy());
    expect(closed).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    jest.mocked(upload).mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => { waits[0].ready(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it('keeps any other refusal of the check in the form, as before', async () => {
    jest.mocked(prepareOfflineSubmission).mockRejectedValueOnce(new Error('2 original files are unavailable. Restore or replace them in the draft before submitting.'));
    const { closed } = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload failed', 'Retry this submission.'));
    expect(closed).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('runs the next Submit of a draft that needed a decision in the form once, where the prompt appears', async () => {
    jest.mocked(upload).mockRejectedValueOnce(activeReport()).mockRejectedValueOnce(activeReport());
    const first = await mount();
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(first.closed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(snapshot().held).toEqual([expect.objectContaining({ draftId: 'local-parent', status: 'attention' })]));
    expect(backgroundUploadManager.prefersForeground('local-parent')).toBe(true);
    expect(Alert.alert).not.toHaveBeenCalled();
    await cleanup();

    // Opened again from the upload bar or Drafts: the form owns the draft now.
    const second = await mount();
    expect(snapshot().held).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Report Already Processing', expect.any(String), expect.any(Array)));
    const buttons = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'Report Already Processing')?.[2];
    expect(buttons?.map((button) => button.text)).toEqual(['Keep Draft', 'Create Separate']);
    expect(second.closed).not.toHaveBeenCalled();
    expect(snapshot().active).toBeNull();
    expect(upload).toHaveBeenCalledTimes(2);
    // The mark is used up: the Submit after that goes to the background again.
    expect(backgroundUploadManager.prefersForeground('local-parent')).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(second.closed).toHaveBeenCalledTimes(1));
  });

  it("the form's own Pause stops only its upload; a background upload keeps going", async () => {
    const other = otherBackgroundUpload();
    backgroundUploadManager.enqueue(other.request);
    await waitFor(() => expect(other.upload).toHaveBeenCalledTimes(1));
    let fail!: (error: unknown) => void;
    jest.mocked(upload).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await mount(false);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const formOperation = jest.mocked(upload).mock.calls[0][3]?.operation;
    expect(formOperation?.isActive()).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Pause upload' }));
    expect(formOperation?.isActive()).toBe(false);
    expect(other.started.operation?.isActive()).toBe(true);
    expect(snapshot().active).toMatchObject({ draftId: 'other-draft', status: 'uploading', pausing: false });
    await act(async () => { fail(Object.assign(new Error('Upload paused'), { code: 'ERR_CANCELED' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume upload' })).toBeTruthy());
    expect(other.started.operation?.isActive()).toBe(true);
  });

  it('does not open a draft that is uploading in the background', async () => {
    const busy = otherBackgroundUpload('local-parent');
    backgroundUploadManager.enqueue(busy.request);
    await waitFor(() => expect(busy.upload).toHaveBeenCalledTimes(1));
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(ordinaryDraft(type) as any);
    await render(<Form visible backgroundUploads draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText(BACKGROUND_UPLOAD_BUSY_MESSAGE)).toBeTruthy());
    expect(screen.queryByTestId('mock-photo-count')).toBeNull();
    expect(AutoSaveService.saveDraft).not.toHaveBeenCalled();
    expect(busy.started.operation?.isActive()).toBe(true);
  });

  it('hands a paused background upload back to the form that opens it', async () => {
    const paused = otherBackgroundUpload('local-parent');
    backgroundUploadManager.enqueue(paused.request);
    await waitFor(() => expect(paused.upload).toHaveBeenCalledTimes(1));
    backgroundUploadManager.pause(snapshot().active!.id);
    await mount();
    expect(backgroundUploadManager.statusFor('local-parent')).toBeUndefined();
  });

  it('refuses to save over or send again a draft that is already in the line', async () => {
    const { closed } = await mount();
    const busy = otherBackgroundUpload('local-parent');
    backgroundUploadManager.enqueue(busy.request);
    await waitFor(() => expect(busy.upload).toHaveBeenCalledTimes(1));
    const saves = jest.mocked(AutoSaveService.saveDraft).mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    expect(Alert.alert).toHaveBeenCalledWith(ALREADY_UPLOADING_TITLE, ALREADY_UPLOADING_MESSAGE);
    expect(AutoSaveService.saveDraft).toHaveBeenCalledTimes(saves);
    expect(upload).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('keeps every form outside the Dashboard in the foreground', async () => {
    let accept!: (value: any) => void;
    jest.mocked(upload).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const { closed } = await mount(false);
    await fireEvent.press(screen.getByRole('button', { name: submitLabel }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(snapshot().active).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', accepted: true }); });
    await waitFor(() => expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'accepted', 'report-parent'));
    // The form closes only after the acceptance, as before.
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(snapshot().notices).toEqual([]);
  });
});

describe.each(['asset', 'lotListing'] as const)('%s Incoming work on the Dashboard', (type) => {
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const upload = type === 'asset' ? assetService.createAssetReport : lotListingService.createLotListing;

  async function mountIncoming() {
    const current = incomingSetup(type);
    jest.mocked(auctioneerService.getSetup).mockResolvedValue(current);
    jest.mocked(auctioneerService.continueWorkItem).mockResolvedValue({ ...current, workItemId: 'work-next', cycleKey: 'cycle-next', clientSubmissionId: 'submission-next', kind: 'unknown', lots: [] });
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(incomingDraft(type) as any);
    const closed = jest.fn();
    const changed = jest.fn();
    // Opened from Drafts: the Dashboard's form, background uploads on.
    await render(<Form visible backgroundUploads draftIdToLoad="local-parent" onClose={closed} onAuctioneerSetupChange={changed} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(1));
    return { closed, changed };
  }

  it('Create Lot & Continue on an unsupported binary waits for server acceptance', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(false);
    const { closed, changed } = await mountIncoming();
    let accept!: (value: any) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBeUndefined();
    expect(backgroundUploadManager.getSnapshot().active).toBeNull();
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByTestId(type === 'asset' ? 'asset-upload-progress' : 'lot-upload-progress').props.visible).toBe(true);
    await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Accepted', accepted: true }); });
    await waitFor(() => expect(auctioneerService.continueWorkItem).toHaveBeenCalledWith('work-parent', 'report-parent'));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(backgroundUploadManager.getSnapshot()).toMatchObject({ active: null, queued: [], held: [], notices: [] });
  });

  it('Create Lot & Close preserves assigned identities in a native durable handoff', async () => {
    jest.spyOn(durableReportTransfer, 'available').mockReturnValue(true);
    const handoff = jest.fn(async () => undefined);
    jest.spyOn(durableReportTransfer, 'handoff').mockReturnValue(handoff);
    jest.mocked(upload).mockResolvedValueOnce({ backgroundStaged: true, jobId: 'submission-parent', message: 'Saved upload' });
    const { closed, changed } = await mountIncoming();
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Close' }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ auctioneer_work_item_id: 'work-parent', client_submission_id: 'submission-parent',
      mixed_lots: [expect.objectContaining({ source_key: 'upstream-key', source_lot_id: 'upstream-lot', source_submission_id: 'upstream-submission' })] });
    expect(jest.mocked(upload).mock.calls[0][3]?.handoff).toBe(handoff);
    expect(changed).not.toHaveBeenCalled();
    expect(auctioneerService.continueWorkItem).not.toHaveBeenCalled();
  });

  it('Create Lot & Close of Incoming work also stays in the form until acceptance', async () => {
    const { closed } = await mountIncoming();
    let accept!: (value: any) => void;
    jest.mocked(upload).mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Close' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(backgroundUploadManager.getSnapshot().active).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(jest.mocked(upload).mock.calls[0][0]).toMatchObject({ auctioneer_work_item_id: 'work-parent', client_submission_id: 'submission-parent' });
    await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Accepted', accepted: true }); });
    await waitFor(() => expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('local-parent', 'accepted', 'report-parent'));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(backgroundUploadManager.getSnapshot().notices).toEqual([]);
  });
});

it('keeps an Auction Management task in the form', async () => {
  const task = {
    task: { rowGuid: 'task-1', status: 'in_progress' },
    contract: { rowGuid: 'contract-1', contractNumber: '93530.3-A', saleLocation: 'Auction yard' },
    lots: [],
    serviceCatalog: [],
  } as unknown as AuctionManagementTaskPayload;
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(ordinaryDraft('lotListing') as any);
  let accept!: (value: any) => void;
  jest.mocked(lotListingService.createLotListing).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
  const closed = jest.fn();
  await render(<LotListingFormSheet visible backgroundUploads auctionManagementTask={task} draftIdToLoad="local-parent" onClose={closed} />);
  await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
  // This button returns the whole Submit, which waits for the answer below.
  const pressed = fireEvent.press(screen.getByText('Send to Lotting Board'));
  await waitFor(() => expect(lotListingService.createLotListing).toHaveBeenCalledTimes(1));
  // The form itself sends it and waits for the answer.
  expect(backgroundUploadManager.getSnapshot().active).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByTestId('lot-upload-progress').props.visible).toBe(true);
  expect(jest.mocked(lotListingService.createLotListing).mock.calls[0][3]?.operation?.isActive()).toBe(true);
  await act(async () => { accept({ jobId: 'job-parent', reportId: 'report-parent', message: 'Queued', phase: 'processing' }); });
  await pressed;
  await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
});

/*
 * Arrival Photos (owner, 2026-11-03: "Its just file copy only"): Submit sends
 * the photos to the chosen request and nothing else. No report, no
 * background upload line, no AI.
 */
describe('Arrival Photos Submit', () => {
  const request = {
    requestId: 'request-1', requestedAt: null, requestedBy: 'Office', lotId: 'lot-1', lotNumber: '3012',
    description: 'Tractor', serialNumber: null, make: null, model: null, year: null, location: null,
    contractId: null, contractNumber: '825712', consignorName: null, eventNumber: null, officeOnlyPhotoCount: 0,
  };

  async function mountArrival(onSuccess?: () => void, withVideo = false) {
    const draft = ordinaryDraft('lotListing');
    if (withVideo) (draft.lots[0].videoFiles as any[]).push({uri:'file:///saved-arrival.mp4',name:'saved-arrival.mp4',type:'video/mp4'});
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...draft, formData: { ...draft.formData, capturePurpose: 'arrivalPhotos', arrivalPhotoRequestId: request.requestId, arrivalPhotoRequest: request } } as any);
    jest.mocked(auctioneerService.getArrivalPhotoRequests).mockResolvedValue([request]);
    const closed = jest.fn();
    await render(<LotListingFormSheet visible backgroundUploads draftIdToLoad="local-parent" arrivalRequest={request} onClose={closed} onSuccess={onSuccess} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    return closed;
  }

  // Owner, 2026-11-04: "this will auto populate contract number right?"
  it("shows the chosen request's contract in Contract #, locked", async () => {
    await mountArrival();
    const contract = await screen.findByLabelText('Contract number, from the arrival photo request');
    expect(contract.props.value).toBe('825712');
    expect(contract.props.editable).toBe(false);
    expect(screen.queryByLabelText('Contract number, required')).toBeNull();
  });

  it('copies every photo, main and report-only, to the request and makes no report', async () => {
    jest.mocked(auctioneerService.sendArrivalPhotos).mockResolvedValue({ sent: 3, stored: 3, skipped: 0, photoCount: 3 });
    const closed = await mountArrival();
    await fireEvent.press(await screen.findByRole('button', { name: 'Send arrival photos' }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(auctioneerService.sendArrivalPhotos).toHaveBeenCalledTimes(1);
    const [requestId, photos] = jest.mocked(auctioneerService.sendArrivalPhotos).mock.calls[0];
    expect(requestId).toBe('request-1');
    expect(photos.map((photo) => photo.name)).toEqual(['first.jpg', 'second.jpg', 'report.jpg']);
    expect(lotListingService.createLotListing).not.toHaveBeenCalled();
    expect(backgroundUploadManager.getSnapshot().active).toBeNull();
    expect(Alert.alert).toHaveBeenCalledWith('Arrival photos sent', expect.stringContaining('Office Only'));
  });

  it('notifies Incoming of confirmed Send through success only after receipt and cleanup', async () => {
    const success = jest.fn();
    jest.mocked(auctioneerService.sendArrivalPhotos).mockResolvedValue({sent:3,stored:3,skipped:0,photoCount:3});
    const closed = await mountArrival(success);
    await fireEvent.press(screen.getByRole('button', {name:'Send arrival photos'}));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).toHaveBeenCalledTimes(1);
    expect(jest.mocked(AutoSaveService.removeDraftRecordOnly).mock.invocationCallOrder[0]).toBeLessThan(success.mock.invocationCallOrder[0]);
  });

  it('keeps legacy video drafts intact and refuses a photo-only send until removal', async () => {
    const closed = await mountArrival(undefined, true);
    await fireEvent.press(screen.getByRole('button', {name:'Send arrival photos'}));
    expect(Alert.alert).toHaveBeenCalledWith('Arrival photos only', expect.stringContaining('saved video'));
    expect(auctioneerService.sendArrivalPhotos).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(2);
  });

  it('keeps the form and its photos open when the send is refused', async () => {
    jest.mocked(auctioneerService.sendArrivalPhotos).mockRejectedValue({
      response: { status: 409, data: { message: 'This arrival photo request was cancelled.' } },
    });
    const closed = await mountArrival();
    await fireEvent.press(await screen.findByRole('button', { name: 'Send arrival photos' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Arrival photos not confirmed', expect.any(String)));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(2);
    expect(lotListingService.createLotListing).not.toHaveBeenCalled();
  });

  it('refuses to repurpose an existing ordinary draft or its photos', async () => {
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(ordinaryDraft('lotListing') as any);
    await render(<LotListingFormSheet visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    await fireEvent.press(screen.getByTestId('arrival-photos-switch'));
    expect(Alert.alert).toHaveBeenCalledWith('Start a new capture', expect.any(String));
    expect(screen.getByTestId('arrival-photos-switch').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(2);
    expect(auctioneerService.sendArrivalPhotos).not.toHaveBeenCalled();
  });

  it('restores saved Arrival purpose without an Incoming prop, saves offline, then sends only Arrival', async () => {
    const draft = ordinaryDraft('lotListing');
    const saved = { ...draft, formData: { ...draft.formData, capturePurpose: 'arrivalPhotos' as const,
      arrivalPhotoRequestId: request.requestId, arrivalPhotoRequest: request } };
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue(saved as any);
    jest.mocked(auctioneerService.getArrivalPhotoRequests).mockResolvedValue([request]);
    await render(<LotListingFormSheet visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    expect(screen.getByTestId('arrival-photos-switch').props.accessibilityState.checked).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save on device' }));
    await waitFor(() => expect(AutoSaveService.saveDraft).toHaveBeenCalled());
    const latest = jest.mocked(AutoSaveService.saveDraft).mock.calls.at(-1)![0];
    expect(latest.formData).toMatchObject({ capturePurpose: 'arrivalPhotos', arrivalPhotoRequestId: request.requestId });
    await cleanup();
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...saved, captureMode: 'offline', formData: latest.formData } as any);
    jest.mocked(auctioneerService.sendArrivalPhotos).mockResolvedValue({ sent: 3, stored: 3, skipped: 0, photoCount: 3 });
    const closed = jest.fn();
    await render(<LotListingFormSheet visible draftIdToLoad="local-parent" onClose={closed} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    await fireEvent.press(screen.getByRole('button', { name: 'Send arrival photos' }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(lotListingService.createLotListing).not.toHaveBeenCalled();
    expect(auctioneerService.sendArrivalPhotos).toHaveBeenCalledTimes(1);
  });

  it('does not offer ineffective Pause while delivery is pending and retains photos on uncertainty', async () => {
    let reject!: (cause: any) => void;
    jest.mocked(auctioneerService.sendArrivalPhotos).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const closed = await mountArrival();
    const pressed = fireEvent.press(screen.getByRole('button', { name: 'Send arrival photos' }));
    await waitFor(() => expect(auctioneerService.sendArrivalPhotos).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Pause upload' })).toBeNull();
    expect(screen.getByTestId('lot-upload-progress').props.visible).toBe(true);
    await act(async () => { reject(new Error('Network Error')); });
    await pressed;
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-photo-count').props.children).toBe(2);
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Arrival photos not confirmed', expect.any(String));
  });

  it('does not clean up or notify the next account after a late response', async () => {
    let resolve!: (receipt: any) => void;
    jest.mocked(auctioneerService.sendArrivalPhotos).mockReturnValue(new Promise(done => { resolve = done; }));
    const closed = await mountArrival();
    const pressed = fireEvent.press(screen.getByRole('button', { name: 'Send arrival photos' }));
    await waitFor(() => expect(auctioneerService.sendArrivalPhotos).toHaveBeenCalledTimes(1));
    mockOwner = 'new-owner'; setUploadOwner(mockOwner);
    await act(async () => { resolve({ sent: 3, stored: 3, skipped: 0, photoCount: 3 }); });
    await pressed;
    expect(closed).not.toHaveBeenCalled();
    expect(AutoSaveService.removeDraftRecordOnly).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalledWith('Arrival photos sent', expect.any(String));
  });


  it('keeps a recovered target visible when it has left the open-request list', async () => {
    const draft = ordinaryDraft('lotListing');
    jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ ...draft, formData: { ...draft.formData,
      capturePurpose: 'arrivalPhotos', arrivalPhotoRequestId: request.requestId, arrivalPhotoRequest: request } } as any);
    jest.mocked(auctioneerService.getArrivalPhotoRequests).mockResolvedValue([]);
    await render(<LotListingFormSheet visible draftIdToLoad="local-parent" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('mock-photo-count').props.children).toBe(2));
    await waitFor(() => expect(auctioneerService.getArrivalPhotoRequests).toHaveBeenCalled());
    expect(screen.getByRole('radio', { name: 'Lot 3012, Tractor' }).props.accessibilityState.selected).toBe(true);
  });

});
