/**
 * The upload bar (2026-10-02) over the real background upload line: what it
 * says for each state, and what its buttons do. Storage, the pre-upload check
 * and the network wait are stand-ins; the report service is a stand-in bound
 * to the line's operation, as the real services are.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import UploadBar, { SENT_NOTICE_MS } from './UploadBar';
import backgroundUploadManager, { ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE, type BackgroundUploadRequest } from '../services/backgroundUploadManager';
import { cancellableUploadRequest, createUploadOperation, setUploadOwner, type UploadOperation } from '../services/uploadCancellation';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import type { OfflineReportDraft } from '../services/autoSaveService';
import type { DirectUploadProgressCallback, DirectUploadProgressStage } from '../services/directR2UploadService';
import durableReportTransfer from '../services/durableReportTransfer';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }) }));
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: {
  background: '#f8f8f8', border: '#dddddd', surfaceRaised: '#ffffff', surfaceMuted: '#eeeeee', text: '#111111',
  textSecondary: '#444444', textMuted: '#777777', success: '#07875f', warning: '#b76408', info: '#2563eb',
} }) }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: {
  fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined),
} }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: () => 'owner', setSubmissionState: jest.fn(async () => undefined),
} }));
jest.mock('../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: {
  getConnectivityStatus: jest.fn(async () => ({ status: 'online' })),
  getSubmissionError: jest.fn((error: unknown) => jest.requireActual('../services/connectivityService').getSubmissionError(error)),
} }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: { cleanupOrphanedMedia: jest.fn(async () => 0) } }));
// The signal never comes back during these tests; Resume now is the way on.
jest.mock('../services/uploadAutoResume', () => ({
  ...jest.requireActual('../services/uploadAutoResume'),
  waitForStableConnection: jest.fn(() => new Promise(() => {})),
}));

type Transfer = {
  operation: UploadOperation;
  signal?: AbortSignal;
  progress(completedFiles: number, stage?: DirectUploadProgressStage): void;
  accept(): void;
  fail(error: unknown): void;
};

/** One report in the line, with a stand-in service the test answers for. */
function report(name: string, totalFiles = 160) {
  const draftId = `draft-${name}`;
  const transfers: Transfer[] = [];
  const upload = jest.fn((onProgress: DirectUploadProgressCallback, parent: UploadOperation) => {
    const operation = createUploadOperation(parent);
    let settle!: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
    const answer = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const transfer: Transfer = {
      operation,
      progress: (completedFiles, stage = 'uploading') => {
        const percent = Math.round((completedFiles / totalFiles) * 100);
        onProgress(percent, { percent, stage, message: '', completedFiles, totalFiles, uploadedBytes: completedFiles, totalBytes: totalFiles });
      },
      accept: () => settle.resolve({ accepted: true, jobId: `job-${name}`, reportId: `report-${name}`, message: 'Accepted' }),
      fail: (error) => settle.reject(error),
    };
    transfers.push(transfer);
    return cancellableUploadRequest(operation, (signal) => { transfer.signal = signal; return answer; });
  });
  const request: BackgroundUploadRequest = {
    draftId, type: 'asset', ownerId: 'owner', title: `QA-${name}`, totalFiles,
    draft: { id: draftId, ownerId: 'owner' } as unknown as OfflineReportDraft, upload,
  };
  return { draftId, request, upload, last: () => transfers[transfers.length - 1] };
}

/** Runs the line's pending steps (promises and zero-delay timers) inside act. */
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(20); });
const run = (step: () => void) => act(async () => { step(); await jest.advanceTimersByTimeAsync(20); });

beforeEach(() => {
  jest.useFakeTimers();
  setUploadOwner('owner');
  backgroundUploadManager.resetForTests();
  jest.mocked(OfflineCaptureStore.setSubmissionState).mockReset().mockResolvedValue(undefined as any);
});
afterEach(async () => {
  await cleanup();
  backgroundUploadManager.resetForTests();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function showBar() {
  const onOpenDraft = jest.fn();
  await render(<UploadBar onOpenDraft={onOpenDraft} />);
  return onOpenDraft;
}

it('takes no room when nothing is uploading, paused or reported', async () => {
  await showBar();
  expect(screen.queryByTestId('upload-bar')).toBeNull();
});

it('shows a rehydrated native queue even before Android starts its first worker', async () => {
  jest.spyOn(backgroundUploadManager, 'getSnapshot').mockReturnValue({ active: null, held: [], notices: [], queued: [{
    id: 'durable:queued', draftId: 'queued', type: 'asset', title: 'Saved capture', status: 'queued', percent: 0,
    completedFiles: 0, totalFiles: 224, pausing: false, canPause: true, durable: true,
  }] });
  await showBar();
  expect(screen.getByText('In line: Saved capture · 224 files')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause upload of Saved capture' })).toBeTruthy();
});

it('retains Resume after a durable attention notice was dismissed and waits for safe release before Open', async () => {
  jest.spyOn(backgroundUploadManager, 'getSnapshot').mockReturnValue({ active: null, queued: [], notices: [], held: [{
    id: 'durable:held', draftId: 'held', type: 'asset', title: 'Held capture', status: 'attention', percent: 50,
    completedFiles: 112, totalFiles: 224, pausing: false, canPause: false, durable: true,
  }] });
  let release!: () => void;
  jest.spyOn(durableReportTransfer, 'releaseForEditing').mockReturnValue(new Promise(resolve => { release = resolve; }));
  const opened = await showBar();
  expect(screen.getByRole('button', { name: 'Resume upload of Held capture' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Open Held capture' }));
  expect(opened).not.toHaveBeenCalled();
  await act(async () => { release(); });
  expect(opened).toHaveBeenCalledWith('held', 'asset');
});

it('shows the running upload with its count and progress; Pause stops it and offers Resume and Open', async () => {
  const onOpenDraft = await showBar();
  const a = report('157');
  await run(() => { backgroundUploadManager.enqueue(a.request); });
  await run(() => a.last().progress(45));
  expect(screen.getByText('Uploading QA-157 · 45 of 160 files')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Upload of QA-157' }).props.accessibilityValue).toEqual({ min: 0, max: 160, now: 45 });
  const transfer = a.last();
  await fireEvent.press(screen.getByRole('button', { name: 'Pause upload of QA-157' }));
  expect(transfer.signal?.aborted).toBe(true);
  await settle();
  expect(screen.getByText('Paused: QA-157 · 45 of 160 sent')).toBeTruthy();
  expect(screen.queryByTestId('upload-bar-active')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Open QA-157' }));
  expect(onOpenDraft).toHaveBeenCalledWith('draft-157', 'asset');
  await fireEvent.press(screen.getByRole('button', { name: 'Resume upload of QA-157' }));
  await settle();
  expect(a.upload).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('upload-bar-active')).toBeTruthy();
  expect(screen.queryByText(/^Paused: QA-157/)).toBeNull();
});

it('counts the uploads waiting in line, lists them on tap, and pauses one of them', async () => {
  await showBar();
  const [a, b] = [report('157'), report('158', 40)];
  await run(() => { backgroundUploadManager.enqueue(a.request); backgroundUploadManager.enqueue(b.request); });
  expect(screen.getByText('+1 waiting')).toBeTruthy();
  expect(screen.queryByText('In line: QA-158 · 40 files')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '1 more upload waiting in line' }));
  expect(screen.getByText('In line: QA-158 · 40 files')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Pause upload of QA-158' }));
  await settle();
  expect(screen.getByText('Paused: QA-158 · 0 of 40 sent')).toBeTruthy();
  expect(screen.queryByText('+1 waiting')).toBeNull();
  expect(b.upload).not.toHaveBeenCalled();
  expect(screen.getByText('Uploading QA-157 · 0 of 160 files')).toBeTruthy();
});

// 2026-10-01: pausing during "Finalizing" threw away the server's acceptance.
it('hides Pause while the submission is being finalized', async () => {
  await showBar();
  const a = report('157');
  await run(() => { backgroundUploadManager.enqueue(a.request); });
  await run(() => a.last().progress(160, 'finalizing'));
  expect(screen.getByText('Finalizing QA-157…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pause upload of QA-157' })).toBeNull();
});

// Owner decision 2026-10-11 (restoring 2026-10-02): after a connection failure
// the upload waits for signal and continues by itself; Resume now tries at once.
it('waits for signal with Resume now and Pause', async () => {
  await showBar();
  const a = report('157');
  await run(() => { backgroundUploadManager.enqueue(a.request); });
  await run(() => a.last().progress(45));
  await run(() => a.last().fail(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })));
  expect(screen.getByText('Waiting for signal · 45 of 160 sent')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause upload of QA-157' })).toBeTruthy();
  expect(a.upload).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Resume upload now' }));
  await settle();
  expect(a.upload).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/^Waiting for signal/)).toBeNull();
});

it('says Sent when the server accepts a report, for a few seconds, and can be dismissed sooner', async () => {
  await showBar();
  const [a, b] = [report('157'), report('158')];
  await run(() => { backgroundUploadManager.enqueue(a.request); backgroundUploadManager.enqueue(b.request); });
  await run(() => a.last().accept());
  expect(screen.getByText('Sent: QA-157')).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(SENT_NOTICE_MS - 100); });
  expect(screen.getByText('Sent: QA-157')).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(200); });
  expect(screen.queryByText('Sent: QA-157')).toBeNull();
  await run(() => b.last().accept());
  await fireEvent.press(screen.getByRole('button', { name: 'Dismiss sent notice for QA-158' }));
  expect(screen.queryByText('Sent: QA-158')).toBeNull();
  expect(screen.queryByTestId('upload-bar')).toBeNull();
});

it('keeps an acceptance this phone could not record, with what it means', async () => {
  jest.mocked(OfflineCaptureStore.setSubmissionState).mockImplementation(async (_id, state) => {
    if (state === 'accepted') throw new Error('Local storage unavailable');
    return undefined as any;
  });
  await showBar();
  const a = report('157');
  await run(() => { backgroundUploadManager.enqueue(a.request); });
  await run(() => a.last().accept());
  const text = `Sent: QA-157 — ${ACCEPTED_NOT_CONFIRMED_LOCALLY_MESSAGE}`;
  expect(screen.getByText(text)).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(SENT_NOTICE_MS * 3); });
  expect(screen.getByText(text)).toBeTruthy();
});

it('says why an upload needs attention, with Open and Dismiss', async () => {
  const onOpenDraft = await showBar();
  const a = report('157');
  await run(() => { backgroundUploadManager.enqueue(a.request); });
  await run(() => a.last().fail({ response: { status: 409, data: { code: 'ACTIVE_REPORT_EXISTS' } } }));
  expect(screen.getByText(/^Needs attention: QA-157 — A report for this contract is already queued or processing/)).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Open QA-157' }));
  expect(onOpenDraft).toHaveBeenCalledWith('draft-157', 'asset');
  expect(screen.queryByText(/^Needs attention/)).toBeNull();

  const b = report('158');
  await run(() => { backgroundUploadManager.enqueue(b.request); });
  await run(() => b.last().fail({ response: { status: 401 }, message: 'Unauthorized' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Dismiss notice for QA-158' }));
  expect(screen.queryByText(/^Needs attention/)).toBeNull();
  expect(onOpenDraft).toHaveBeenCalledTimes(1);
});

it('shows the newest three notices and counts the rest, so the bar never fills the screen', async () => {
  await showBar();
  for (const name of ['1', '2', '3', '4']) {
    const item = report(name);
    await run(() => { backgroundUploadManager.enqueue(item.request); });
    await run(() => item.last().fail({ response: { status: 401 }, message: 'Unauthorized' }));
  }
  expect(screen.queryByText(/^Needs attention: QA-1 /)).toBeNull();
  expect(screen.getAllByText(/^Needs attention: QA-[234] /)).toHaveLength(3);
  expect(screen.getByText("+1 earlier notice · Drafts shows each report's status")).toBeTruthy();
});
