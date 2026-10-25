import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';
import { cancellableUploadRequest, createUploadOperation, pauseActiveUploads, setUploadOwner, UPLOAD_IDLE_TIMEOUT_MS } from './uploadCancellation';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));
const fs = require('expo-file-system/legacy');
const originalPlatform = Platform.OS;
const originalFetch = global.fetch;
const details = { client_submission_id: 'stable-submission', capture_id: 'stable-capture', contract_no: '160-photos' };
const files: DirectUploadFile[] = Array.from({ length: 160 }, (_, i) => ({
  uri: `file:///original-${i}.jpg`, name: `original-${i}.jpg`, type: 'image/jpeg', size: 1000,
  lotIndex: Math.floor(i / 80), imageIndex: i % 80, role: 'main',
}));
const accepted = { reportId: 'same-report', jobId: 'same-job', message: 'Accepted', phase: 'processing' };
const never = () => new Promise<any>(() => {});
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

beforeEach(() => {
  jest.useFakeTimers();
  pauseActiveUploads(); setUploadOwner('owner'); jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  global.fetch = jest.fn();
  jest.mocked(api.post).mockImplementation(async (url: any, body: any) => {
    if (url.endsWith('/upload-session')) return { data: { data: { ...accepted, sessionId: 'same-session', files: body.files.map((file: any) => ({
      fileId: file.fileId, uploadUrl: 'https://storage.invalid/original', contentType: file.type,
    })) } } };
    if (url.endsWith('/verify')) return { data: { data: { verified: true } } };
    return { data: accepted };
  });
});
afterEach(() => { pauseActiveUploads(); jest.useRealTimers(); });
afterAll(() => { Object.defineProperty(Platform, 'OS', { value: originalPlatform }); global.fetch = originalFetch; });

describe.each(['/asset', '/lot-listing'] as const)('%s stalled uploads', endpoint => {
  const upload = (selected = files, onProgress = jest.fn()) => uploadReportFilesDirectToR2({ endpoint, details, files: selected, onProgress });

  it('stops four hanging tasks, preserves all 160 identities, and explicitly resumes the same verified session without PUTs', async () => {
    const cancel = jest.fn(never);
    const callbacks: any[] = [];
    fs.createUploadTask.mockImplementation((_url: string, _uri: string, _options: any, callback: any) => {
      callbacks.push(callback); return { uploadAsync: never, cancelAsync: cancel };
    });
    const progress = jest.fn();
    const result = upload(files, progress).catch(error => error);
    await flush();
    expect(fs.createUploadTask).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: 'UPLOAD_STALLED', acceptanceUncertain: true });
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(fs.createUploadTask).toHaveBeenCalledTimes(4);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    const progressCalls = progress.mock.calls.length;
    callbacks.forEach(callback => callback({ totalBytesSent: 1000, totalBytesExpectedToSend: 1000 }));
    expect(progress).toHaveBeenCalledTimes(progressCalls);
    const firstManifest = jest.mocked(api.post).mock.calls[0][1];
    const handler = jest.mocked(api.post).getMockImplementation()!;
    jest.mocked(api.post).mockImplementation(async (...args: any[]) => {
      const response = await (handler as any)(...args);
      if (args[0].endsWith('/upload-session')) response.data.data.resumed = true;
      return response;
    });
    await expect(upload()).resolves.toEqual(accepted);
    const reservations = jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/upload-session'));
    expect(reservations[1][1]).toEqual(firstManifest);
    expect((firstManifest as any).files.map((file: any) => [file.lotIndex, file.imageIndex])).toEqual(files.map(file => [file.lotIndex, file.imageIndex]));
    expect(fs.createUploadTask).toHaveBeenCalledTimes(4);
    expect(jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(160);
  });

  it('keeps a slow progressing transfer alive, but identical progress events cannot conceal a stall', async () => {
    let callback!: (value: any) => void;
    const cancel = jest.fn();
    fs.createUploadTask.mockImplementation((_url: string, _uri: string, _options: any, value: any) => {
      callback = value; return { uploadAsync: never, cancelAsync: cancel };
    });
    const result = upload([files[0]]).catch(error => error);
    await flush();
    for (let i = 1; i <= 4; i++) {
      await jest.advanceTimersByTimeAsync(60_000);
      callback({ totalBytesSent: i * 100, totalBytesExpectedToSend: 1000 });
      expect(cancel).not.toHaveBeenCalled();
    }
    await jest.advanceTimersByTimeAsync(60_000);
    callback({ totalBytesSent: 400, totalBytesExpectedToSend: 1000 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'UPLOAD_STALLED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('Pause settles immediately even if filesystem upload and native cancellation never answer', async () => {
    const cancel = jest.fn(never);
    fs.createUploadTask.mockReturnValue({ uploadAsync: never, cancelAsync: cancel });
    const result = upload().catch(error => error);
    await flush(); pauseActiveUploads();
    expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it.each([992, 5000])('stops an unresponsive Android gallery upload of %s references and never sends queued photos or a fallback', async count => {
    Object.defineProperty(Platform, 'OS', { value: 'android' });
    const cancel = jest.fn(never);
    const stream = jest.fn(never);
    jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), streamContentUriUpload: stream, cancelContentUriUpload: cancel });
    const selected = Array.from({ length: count }, (_, i) => ({ ...files[0], uri: `content://media/external/images/media/${i}`, name: `photo-${i}.jpg`, lotIndex: Math.floor(i / 200), imageIndex: i % 200 }));
    const result = upload(selected).catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(stream).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: 'UPLOAD_STALLED' });
    expect(stream).toHaveBeenCalledTimes(4); expect(cancel).toHaveBeenCalledTimes(4);
    expect(global.fetch).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
    const manifest = (jest.mocked(api.post).mock.calls[0][1] as any).files;
    expect(manifest).toHaveLength(count);
    expect(manifest.map((entry: any) => [entry.lotIndex, entry.imageIndex])).toEqual(selected.map(entry => [entry.lotIndex, entry.imageIndex]));
    expect((jest.mocked(api.post).mock.calls[0][1] as any).details).toEqual(details);
  });

  it('times out file metadata preparation before reserving a report and can be paused without its callback', async () => {
    fs.getInfoAsync.mockImplementation(never);
    const result = upload([{ ...files[0], size: undefined }]).catch(error => error);
    await flush(); await jest.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ code: 'UPLOAD_STALLED' });
    expect(api.post).not.toHaveBeenCalled(); expect(fs.createUploadTask).not.toHaveBeenCalled();
  });

  it('never starts a PUT after a timed-out local fetch returns late', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let resolve!: (value: any) => void;
    let signal!: AbortSignal;
    fs.createUploadTask.mockImplementation(() => { throw new Error('Native filesystem unavailable'); });
    global.fetch = jest.fn((_uri: any, options: any) => { signal = options.signal; return new Promise<any>(yes => { resolve = yes; }); });
    try {
      const result = upload([files[0]]).catch(error => error);
      await flush(); await jest.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS);
      expect(await result).toMatchObject({ code: 'UPLOAD_STALLED' });
      expect(signal.aborted).toBe(true);
      const blob = jest.fn(async () => ({ size: 1000 }));
      resolve({ blob }); await flush();
      expect(blob).not.toHaveBeenCalled(); expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(api.post).toHaveBeenCalledTimes(1);
    } finally { warning.mockRestore(); }
  });

  it('treats the native inactivity receipt as a stopped attempt, not an automatic re-upload', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android' });
    const stream = jest.fn().mockRejectedValue(Object.assign(new Error('Upload stopped making progress'), { code: 'E_UPLOAD_STALLED' }));
    jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), streamContentUriUpload: stream });
    await expect(upload([{ ...files[0], uri: 'content://media/external/images/media/1' }])).rejects.toMatchObject({ code: 'E_UPLOAD_STALLED' });
    expect(stream).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

it('settles an aborted API request even if its adapter ignores the abort signal', async () => {
  const operation = createUploadOperation();
  let signal!: AbortSignal;
  const result = cancellableUploadRequest(operation, value => { signal = value; return never(); }).catch(error => error);
  pauseActiveUploads();
  expect(signal.aborted).toBe(true); expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
});

it('local upload failure cancels only its sibling tasks, not an unrelated upload', async () => {
  const failed = createUploadOperation(); const unrelated = createUploadOperation();
  let first!: AbortSignal; let second!: AbortSignal;
  const result = cancellableUploadRequest(failed, signal => { first = signal; return never(); }).catch(error => error);
  const other = cancellableUploadRequest(unrelated, signal => { second = signal; return never(); }).catch(error => error);
  const error = new Error('One report failed'); failed.cancel(error);
  expect(await result).toBe(error); expect(first.aborted).toBe(true); expect(second.aborted).toBe(false);
  expect(unrelated.isActive()).toBe(true);
  pauseActiveUploads(); expect(await other).toMatchObject({ code: 'ERR_CANCELED' });
});

it('one throwing cancellation subscriber cannot prevent the remaining workers from stopping', async () => {
  const operation = createUploadOperation();
  const unsubscribe = operation.onCancel(() => { throw new Error('Broken native cancellation'); });
  let signal!: AbortSignal;
  const result = cancellableUploadRequest(operation, value => { signal = value; return never(); }).catch(error => error);
  const failure = new Error('Upload stopped');
  expect(() => operation.cancel(failure)).not.toThrow();
  expect(signal.aborted).toBe(true); expect(await result).toBe(failure);
  unsubscribe();
});
