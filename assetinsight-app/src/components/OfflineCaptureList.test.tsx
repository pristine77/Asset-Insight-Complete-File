import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OfflineCaptureList from './OfflineCaptureList';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import AutoSaveService from '../services/autoSaveService';
import backgroundUploadManager, { type BackgroundUploadRequest } from '../services/backgroundUploadManager';
import { setUploadOwner } from '../services/uploadCancellation';
import type { DirectUploadProgressCallback } from '../services/directR2UploadService';

jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#555', warning: '#a50', accent: '#c00' } }) }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: () => 'owner', listSummaries: jest.fn(), listLegacyDrafts: jest.fn(async () => []), listLegacyJobs: jest.fn(async () => []),
  setSubmissionState: jest.fn(async () => undefined),
} }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: { deleteDraft: jest.fn() } }));
// What the background upload line loads when it runs an upload.
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined) } }));
jest.mock('../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: {
  getConnectivityStatus: jest.fn(async () => ({ status: 'online' })), getSubmissionError: jest.fn(() => ({ title: 'Upload failed', message: 'Retry.' })),
} }));

afterEach(async () => { await cleanup(); jest.clearAllMocks(); });

it.each(['ready', 'uploading', 'paused'])('shows explicit resume guidance for an interrupted %s capture', async (submissionState) => {
  jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue([{
    id: 'draft-a', type: 'asset', contractNo: 'QA-157', captureMode: 'offline', submissionState,
    updatedAt: '2026-09-17T10:00:00.000Z', counts: { lots: 1, images: 2, extraImages: 1, missingImages: 0, perLot: [] },
  }] as any);
  const open = jest.fn();
  await render(<OfflineCaptureList onOpen={open} />);
  await waitFor(() => expect(screen.getByText('Report submission needs your confirmation — open the draft, then tap Resume upload. Cloud backup does not submit it.')).toBeTruthy());
  expect(screen.getByText('1 lots · 2 photos · 1 report-only')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Open and submit' }));
  expect(open).toHaveBeenCalledWith('draft-a', 'asset');
});

it('does not label an ordinary unsubmitted saved draft as an interrupted upload', async () => {
  jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue([{
    id: 'draft-a', type: 'asset', captureMode: 'offline', submissionState: 'local',
    updatedAt: '2026-09-17T10:00:00.000Z', counts: { lots: 0, images: 0, extraImages: 0, missingImages: 0, perLot: [] },
  }] as any);
  await render(<OfflineCaptureList onOpen={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Offline captures · 1')).toBeTruthy());
  expect(screen.queryByText(/Report submission needs your confirmation/)).toBeNull();
});

/*
 * Background uploads (2026-10-02): a capture handed to the background upload
 * line shows its live state, and cannot be discarded while it is uploading or
 * waiting in line.
 */
describe('captures in the background upload line', () => {
  const summary = (id: string, submissionState = 'ready') => ({
    id, type: 'asset', contractNo: `QA-${id}`, captureMode: 'offline', submissionState,
    updatedAt: '2026-10-02T10:00:00.000Z', counts: { lots: 1, images: 160, extraImages: 0, missingImages: 0, perLot: [] },
  });
  /** An upload in the line that the test answers for. */
  function backgroundUpload(draftId: string) {
    const controls: { progress?: DirectUploadProgressCallback; accept?: (receipt: unknown) => void } = {};
    const request: BackgroundUploadRequest = {
      draftId, type: 'asset', ownerId: 'owner', title: `QA-${draftId}`, totalFiles: 160, draft: { id: draftId, ownerId: 'owner' } as any,
      upload: (onProgress) => {
        controls.progress = onProgress;
        return new Promise((resolve) => { controls.accept = resolve; });
      },
    };
    return { request, controls };
  }
  /** Runs a step and lets the line finish what it starts, inside act. */
  const settle = (step: () => void) => act(async () => {
    step();
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  beforeEach(() => {
    setUploadOwner('owner');
    backgroundUploadManager.resetForTests();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.mocked(AutoSaveService.deleteDraft).mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await cleanup();
    backgroundUploadManager.resetForTests();
    jest.mocked(Alert.alert).mockRestore();
  });

  it('shows each capture\'s live upload state and keeps Discard closed while it uploads or waits in line', async () => {
    jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue([summary('draft-a'), summary('draft-b'), summary('draft-c', 'paused')] as any);
    const [a, b] = [backgroundUpload('draft-a'), backgroundUpload('draft-b')];
    await settle(() => { backgroundUploadManager.enqueue(a.request); backgroundUploadManager.enqueue(b.request); });
    await render(<OfflineCaptureList onOpen={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Offline captures · 3')).toBeTruthy());
    expect(a.controls.progress).toBeDefined();
    await settle(() => {
      a.controls.progress!(28, { percent: 28, stage: 'uploading', message: '', completedFiles: 45, totalFiles: 160, uploadedBytes: 45, totalBytes: 160 });
    });
    expect(screen.getByText('Background upload: Uploading 45 of 160')).toBeTruthy();
    expect(screen.getByText('Background upload: Waiting in line')).toBeTruthy();
    // A capture outside the line keeps the stored-state guidance.
    expect(screen.getAllByText(/Report submission needs your confirmation/)).toHaveLength(1);
    const discard = screen.getAllByRole('button', { name: 'Discard' });
    expect(discard.map((button) => Boolean(button.props.accessibilityState?.disabled))).toEqual([true, true, false]);
    await fireEvent.press(discard[0]);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(AutoSaveService.deleteDraft).not.toHaveBeenCalled();
  });

  it('lets a paused background upload be discarded, and forgets that upload', async () => {
    jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValue([summary('draft-a')] as any);
    const a = backgroundUpload('draft-a');
    await settle(() => { backgroundUploadManager.enqueue(a.request); });
    expect(a.controls.progress).toBeDefined();
    await settle(() => { backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().active!.id); });
    await render(<OfflineCaptureList onOpen={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Background upload: Paused')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
    const confirm = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'Discard local draft?')?.[2]?.find((button) => button.text === 'Discard draft');
    await settle(() => { confirm?.onPress?.(); });
    expect(AutoSaveService.deleteDraft).toHaveBeenCalledWith('draft-a');
    expect(backgroundUploadManager.statusFor('draft-a')).toBeUndefined();
  });

  it('drops a capture from the list as soon as the server accepts it in the background', async () => {
    jest.mocked(OfflineCaptureStore.listSummaries).mockResolvedValueOnce([summary('draft-a')] as any).mockResolvedValue([]);
    const a = backgroundUpload('draft-a');
    await render(<OfflineCaptureList onOpen={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Offline captures · 1')).toBeTruthy());
    await settle(() => { backgroundUploadManager.enqueue(a.request); });
    expect(a.controls.accept).toBeDefined();
    await settle(() => { a.controls.accept!({ accepted: true, jobId: 'job-a', reportId: 'report-a' }); });
    await waitFor(() => expect(screen.getByText('Offline captures · 0')).toBeTruthy());
    expect(OfflineCaptureStore.setSubmissionState).toHaveBeenCalledWith('draft-a', 'accepted', 'report-a');
  });
});
