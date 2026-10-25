/**
 * Two upload behaviours fixed on 2026-10-02.
 *
 * 1. When a phone's network blocks direct storage, files go through the API
 *    (the server fallback). That request had a fixed 120 s total limit, so a
 *    walkaround video or a large photo on a slow link was cut off while still
 *    moving, the same way on every resume. It now stops only when progress
 *    stops for UPLOAD_IDLE_TIMEOUT_MS, like the direct transfers.
 * 2. A file re-sent after a failure starts again from zero bytes while the bar
 *    keeps its high-water mark, so a working retry looked frozen. Retries now
 *    say "Retrying <file> (n of m)...".
 */
import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { pauseActiveUploads, setUploadOwner, UPLOAD_IDLE_TIMEOUT_MS } from './uploadCancellation';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
// 503 is transient; storage's 403 (a blocked network) is not.
jest.mock('./connectivityService', () => ({ isRetryableRequestError: (error: any) => error?.status === 503 || error?.retryable === true }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));

const fs = require('expo-file-system/legacy');
const originalPlatform = Platform.OS;
const details = { client_submission_id: 'fallback-submission', capture_id: 'fallback-capture', contract_no: 'FALLBACK-1' };
const file: DirectUploadFile = { uri: 'file:///walkaround.mp4', name: 'walkaround.mp4', type: 'video/mp4', size: 1000, fieldname: 'videos', role: 'video' };
const photo: DirectUploadFile = { uri: 'file:///original.jpg', name: 'original.jpg', type: 'image/jpeg', size: 1000 };
const receipt = { accepted: true, reportAvailable: true, reportId: 'fallback-report', jobId: 'fallback-submission', status: 'processing', phase: 'processing' };
const flush = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

type Fallback = { config: any; resolve: (value: any) => void };

/** Serve every API call; the server-fallback post is left pending for the test to drive. */
function serve(): { fallbacks: Fallback[] } {
  const fallbacks: Fallback[] = [];
  jest.mocked(api.post).mockImplementation((async (url: any, body: any, config: any) => {
    const path = String(url);
    if (path.endsWith('/upload-session')) {
      return { data: { data: { sessionId: 'fallback-session', jobId: receipt.jobId, reportId: receipt.reportId,
        files: body.files.map((entry: any) => ({ fileId: entry.fileId, uploadUrl: 'https://storage.invalid/file', contentType: entry.type, method: 'PUT' })) } } };
    }
    if (path.endsWith('/verify')) return { data: { data: { verified: false } } };
    if (path.endsWith('/complete')) return { data: receipt };
    if (path.includes('/files/')) return new Promise((resolve) => { fallbacks.push({ config, resolve }); });
    throw new Error(`unexpected request ${path}`);
  }) as any);
  return { fallbacks };
}

beforeEach(() => {
  jest.useFakeTimers();
  pauseActiveUploads();
  setUploadOwner('owner');
  jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
});
afterEach(() => { pauseActiveUploads(); jest.useRealTimers(); });
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe('server fallback transfer', () => {
  beforeEach(() => {
    // Direct storage is blocked: every direct PUT answers 403.
    fs.createUploadTask.mockImplementation(() => ({ uploadAsync: jest.fn().mockResolvedValue({ status: 403, body: 'blocked' }), cancelAsync: jest.fn() }));
  });

  it('keeps going past 120 seconds while bytes are moving, with no total time limit', async () => {
    const { fallbacks } = serve();
    const result = uploadReportFilesDirectToR2({ endpoint: '/asset', details, files: [file] });
    await jest.advanceTimersByTimeAsync(0);
    await flush();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].config.timeout).toBe(0);
    for (let step = 1; step <= 4; step += 1) {
      await jest.advanceTimersByTimeAsync(60_000);
      fallbacks[0].config.onUploadProgress({ loaded: step * 200, total: 1000 });
    }
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fallbacks[0].config.signal.aborted).toBe(false);
    fallbacks[0].resolve({ data: { data: { fileId: 'videos-0', uploaded: true } } });
    await expect(result).resolves.toMatchObject(receipt);
  });

  it('stops once progress has stopped for the idle deadline', async () => {
    const { fallbacks } = serve();
    const result = uploadReportFilesDirectToR2({ endpoint: '/asset', details, files: [file] }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);
    await flush();
    expect(fallbacks).toHaveLength(1);
    fallbacks[0].config.onUploadProgress({ loaded: 200, total: 1000 });
    await jest.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS + 1_000);
    expect(await result).toMatchObject({ code: 'UPLOAD_STALLED' });
    expect(fallbacks[0].config.signal.aborted).toBe(true);
  });
});

describe('direct transfer retries', () => {
  it('say which file is being retried, so a working retry does not look frozen', async () => {
    serve();
    const uploads = [{ status: 503, body: 'busy' }, { status: 200 }];
    fs.createUploadTask.mockImplementation(() => ({ uploadAsync: jest.fn().mockResolvedValue(uploads.shift()), cancelAsync: jest.fn() }));
    const progress = jest.fn();
    const result = uploadReportFilesDirectToR2({ endpoint: '/lot-listing', details, files: [photo], onProgress: progress });
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject(receipt);
    const messages = progress.mock.calls.map(([, detail]) => detail?.message);
    expect(messages).toContain('Retrying original.jpg (2 of 3)...');
    // The retry is announced before the file finishes.
    expect(messages.indexOf('Retrying original.jpg (2 of 3)...')).toBeLessThan(messages.lastIndexOf('Upload complete.'));
  });
});
