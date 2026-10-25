import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { pauseActiveUploads, createUploadOperation, cancellableUploadRequest, setUploadOwner, pauseUploadOperation, onUploadOwnerChange } from './uploadCancellation';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';
import { assetService, type AssetCreateDetails } from './assetService';
import { lotListingService, type LotListingDetails } from './lotListingService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));
const fs = require('expo-file-system/legacy');
const file = { uri: 'file:///capture.jpg', name: 'capture.jpg', type: 'image/jpeg', size: 200 };
const details = { client_submission_id: 'stable-submission', capture_id: '626ce9ba-1a53-4b7a-aaf5-bb5b824a2764', contract_no: 'Same-contract' };
const session = { sessionId: 'same-session', jobId: 'same-job', reportId: 'same-report', files: [{ fileId: 'images-0', key: 'test', uploadUrl: 'https://storage.invalid/test', method: 'PUT', contentType: 'image/jpeg' }] };
const upload = (files: DirectUploadFile[] = [file]) => uploadReportFilesDirectToR2({ endpoint: '/asset', details, files });
function deferred<T = any>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function interruptedRequest() {
  const started = deferred<AbortSignal>();
  const response = deferred();
  return { started, response, request: (_url: unknown, _data: unknown, config: any) => {
    started.resolve(config.signal);
    config.signal.addEventListener('abort', () => response.reject(Object.assign(new Error('Aborted'), { code: 'ERR_CANCELED' })), { once: true });
    return response.promise;
  } };
}
const originalFetch = global.fetch;
const originalPlatform = Platform.OS;
const originalFormData = global.FormData;
let warning: jest.SpyInstance;
beforeAll(() => {
  global.FormData = class { append() {} } as unknown as typeof FormData;
});
afterAll(() => { global.fetch = originalFetch; global.FormData = originalFormData; Object.defineProperty(Platform, 'OS', { value: originalPlatform }); });
beforeEach(() => {
  pauseActiveUploads(); setUploadOwner('owner-a'); jest.clearAllMocks();
  warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  global.fetch = jest.fn();
  fs.createUploadTask.mockReturnValue({ uploadAsync: jest.fn().mockResolvedValue({ status: 200 }), cancelAsync: jest.fn().mockResolvedValue(undefined) });
  jest.mocked(api.post).mockImplementation(async (url: any) => {
    if (url.endsWith('/upload-session')) return { data: { data: session } };
    if (url.endsWith('/verify')) return { data: { data: { verified: false } } };
    return { data: { reportId: 'same-report', jobId: 'same-job', message: 'Accepted', phase: 'processing' } };
  });
});
afterEach(() => warning.mockRestore());

it('aborts session creation, retains stable identities and does not begin file transport', async () => {
  const pending = interruptedRequest(); jest.mocked(api.post).mockImplementation(pending.request as any);
  const result = upload().catch((error) => error);
  const signal = await pending.started.promise; pauseActiveUploads();
  expect(signal.aborted).toBe(true);
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
  expect(api.post).toHaveBeenCalledTimes(1); expect(fs.createUploadTask).not.toHaveBeenCalled();
  expect((jest.mocked(api.post).mock.calls[0][1] as any).details).toEqual(details);
});

it('does not start a native stream after pause during native-module loading', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const native = deferred(); const entered = deferred<void>();
  jest.mocked(loadNativeAuctionCamera).mockImplementation(() => { entered.resolve(); return native.promise; });
  const stream = jest.fn();
  const result = upload([{ ...file, uri: 'content://media/external/images/12' }]).catch((error) => error);
  await entered.promise; pauseActiveUploads(); native.resolve({ streamContentUriUpload: stream });
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
  expect(stream).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
});

it('cancels an active native stream and ignores late progress without a fallback', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const pending = deferred(); const entered = deferred<any>();
  const cancel = jest.fn(async () => pending.reject(new Error('Cancelled')));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), cancelContentUriUpload: cancel,
    streamContentUriUpload: jest.fn((args) => { entered.resolve(args); return pending.promise; }) });
  const result = upload([{ ...file, uri: 'content://media/external/images/12' }]).catch((error) => error);
  const args = await entered.promise; pauseActiveUploads();
  expect(() => args.onProgress(100, 200)).not.toThrow();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(cancel).toHaveBeenCalledWith(args.id);
  expect(api.post).toHaveBeenCalledTimes(1); expect(global.fetch).not.toHaveBeenCalled();
});

it('cancels a filesystem task without invoking fetch or server fallback', async () => {
  const pending = deferred(); const entered = deferred<void>();
  const cancel = jest.fn(async () => pending.reject(new Error('Cancelled')));
  fs.createUploadTask.mockReturnValue({ uploadAsync: () => { entered.resolve(); return pending.promise; }, cancelAsync: cancel });
  const result = upload().catch((error) => error); await entered.promise; pauseActiveUploads();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(cancel).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
});

it('aborts the local fetch fallback and never PUTs after cancellation', async () => {
  const pending = interruptedRequest(); fs.createUploadTask.mockImplementation(() => { throw new Error('No transport'); });
  global.fetch = jest.fn((url: any, config: any) => pending.request(url, null, config));
  const result = upload().catch((error) => error); await pending.started.promise; pauseActiveUploads();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('aborts the fetch PUT fallback while retaining the local original', async () => {
  const pending = interruptedRequest(); fs.createUploadTask.mockImplementation(() => { throw new Error('No transport'); });
  global.fetch = jest.fn().mockResolvedValueOnce({ blob: async () => ({ size: 200 }) })
    .mockImplementation((url: any, config: any) => pending.request(url, null, config));
  const result = upload().catch((error) => error); const signal = await pending.started.promise; pauseActiveUploads();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(signal.aborted).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(2); expect(api.post).toHaveBeenCalledTimes(1);
});

it('aborts target refresh and cannot restart PUTs with a new operation epoch', async () => {
  fs.createUploadTask.mockReturnValue({ uploadAsync: jest.fn().mockResolvedValue({ status: 403 }), cancelAsync: jest.fn() });
  const pending = interruptedRequest();
  jest.mocked(api.post).mockResolvedValueOnce({ data: { data: session } }).mockImplementation(pending.request as any);
  const result = upload().catch((error) => error); const signal = await pending.started.promise; pauseActiveUploads();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(signal.aborted).toBe(true);
  expect(fs.createUploadTask).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(2);
});

it.each(['verify', 'fallback'])('aborts %s HTTP without starting another file request', async (stage) => {
  fs.createUploadTask.mockReturnValue({ uploadAsync: jest.fn().mockResolvedValue({ status: 403 }), cancelAsync: jest.fn() });
  const pending = interruptedRequest();
  jest.mocked(api.post).mockImplementation((url: any, body: any, config: any) => {
    if (url.endsWith('/upload-session')) return Promise.resolve({ data: { data: session } });
    if (url.endsWith('/verify') && stage !== 'verify') return Promise.resolve({ data: { data: { verified: false } } });
    return pending.request(url, body, config);
  });
  const result = upload().catch((error) => error); const signal = await pending.started.promise;
  const calls = jest.mocked(api.post).mock.calls.length; pauseActiveUploads();
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(signal.aborted).toBe(true);
  expect(api.post).toHaveBeenCalledTimes(calls);
});

it('an uncertain completed upload resumes the same session/submission instead of making a new report', async () => {
  const entered = deferred<AbortSignal>(); const completed = deferred();
  jest.mocked(api.post).mockImplementation((url: any, _body: any, config: any) => {
    if (url.endsWith('/upload-session')) return Promise.resolve({ data: { data: { ...session, readyToComplete: true } } });
    entered.resolve(config.signal); return completed.promise;
  });
  const result = upload().catch((error) => error); const signal = await entered.promise;
  pauseActiveUploads(); completed.resolve({ data: { reportId: 'same-report', jobId: 'same-job' } });
  expect(signal.aborted).toBe(true); expect(await result).toMatchObject({ code: 'ERR_CANCELED', acceptanceUncertain: true });
  jest.mocked(api.post).mockResolvedValueOnce({ data: { data: { ...session, alreadyQueued: true, accepted: true } } });
  expect(await upload()).toMatchObject({ reportId: 'same-report', jobId: 'same-job' });
  const creation = jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/upload-session'));
  expect(creation).toHaveLength(2); expect(creation[0][1]).toEqual(creation[1][1]);
  expect(fs.createUploadTask).not.toHaveBeenCalled();
});

it('fences owner changes even if an old HTTP response succeeds', async () => {
  const response = deferred(); const started = deferred<void>();
  jest.mocked(api.post).mockImplementation(() => { started.resolve(); return response.promise; });
  const result = upload().catch((error) => error); await started.promise;
  setUploadOwner('owner-b'); response.resolve({ data: { data: session } });
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(fs.createUploadTask).not.toHaveBeenCalled();
});

it('uses native content URI size for the manifest and stream without mutating saved media', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const stream = jest.fn().mockResolvedValue({ status: 200, body: '', headers: {} });
  const info = jest.fn().mockResolvedValue({ exists: true, size: 987, type: 'image/jpeg' });
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo: info, streamContentUriUpload: stream });
  const input = { ...file, uri: 'content://media/external/images/12', size: undefined };
  await upload([input]); expect(info).toHaveBeenCalledWith(input.uri); expect(fs.getInfoAsync).not.toHaveBeenCalled();
  expect((jest.mocked(api.post).mock.calls[0][1] as any).files[0].size).toBe(987);
  expect(stream.mock.calls[0][0]).toMatchObject({ uri: input.uri, size: 987 }); expect(input.size).toBeUndefined();
});

it.each([{ exists: false }, { exists: true, size: 0 }])('rejects unreadable content URI metadata before creating a server upload', async (info) => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo: jest.fn().mockResolvedValue(info) });
  await expect(upload([{ ...file, uri: 'content://media/external/images/12', size: undefined }])).rejects.toThrow('unavailable');
  expect(fs.getInfoAsync).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it('a pause during native size preparation prevents server session creation', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const pending = deferred(); const started = deferred<void>();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo: () => { started.resolve(); return pending.promise; } });
  const result = upload([{ ...file, uri: 'content://media/external/images/12', size: undefined }]).catch((error) => error);
  await started.promise; pauseActiveUploads(); pending.resolve({ exists: true, size: 200 });
  expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(api.post).not.toHaveBeenCalled();
});

describe.each(['asset', 'lotListing'] as const)('%s legacy transport', (kind) => {
  const create = () => kind === 'asset'
    ? assetService.createAssetReport(details as AssetCreateDetails, [{ id: 'lot', files: [file], extraFiles: [], coverIndex: 0 }])
    : lotListingService.createLotListing(details as LotListingDetails, [{ id: 'lot', lot_number: 1, files: [file], extraFiles: [] }]);
  it('does not start multipart after a paused direct call returns a late unsupported error', async () => {
    const response = deferred(); const started = deferred<void>();
    jest.mocked(api.post).mockImplementation(() => { started.resolve(); return response.promise; });
    const result = create().catch((error) => error); await started.promise; pauseActiveUploads();
    response.reject({ response: { status: 404 } }); expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('aborts active legacy multipart and keeps the same submission ID', async () => {
    const pending = interruptedRequest();
    jest.mocked(api.post).mockRejectedValueOnce({ response: { status: 404 } }).mockImplementation(pending.request as any);
    const result = create().catch((error) => error); const signal = await pending.started.promise;
    pauseActiveUploads(); expect(await result).toMatchObject({ code: 'ERR_CANCELED' }); expect(signal.aborted).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(2); expect(details.client_submission_id).toBe('stable-submission');
  });
});

it('unregisters a completed request so later pause cannot cancel it', async () => {
  let signal!: AbortSignal;
  await cancellableUploadRequest(createUploadOperation(), async (value) => { signal = value; return 1; });
  pauseActiveUploads(); expect(signal.aborted).toBe(false);
});

/*
 * Pausing one upload (2026-10-02). With uploads running in the background, the
 * form's Pause and the upload bar's Pause stop their own upload only: the
 * services bind their transfer to the caller's operation.
 */
describe('pausing one upload', () => {
  const listingDetails = details as LotListingDetails;
  const listingLot = { id: 'lot', lot_number: 1, files: [file], extraFiles: [] };

  it('stops the direct transfer of that upload and leaves another upload running', async () => {
    const mine = createUploadOperation(); const other = createUploadOperation();
    const mineRequest = interruptedRequest(); const otherRequest = interruptedRequest();
    jest.mocked(api.post).mockImplementationOnce(mineRequest.request as any).mockImplementationOnce(otherRequest.request as any);
    const mineResult = assetService.createAssetReport(details as AssetCreateDetails, [{ id: 'lot', files: [file], extraFiles: [], coverIndex: 0 }], undefined, { operation: mine }).catch((error) => error);
    const mineSignal = await mineRequest.started.promise;
    const otherResult = lotListingService.createLotListing(listingDetails, [listingLot], undefined, { operation: other }).catch((error) => error);
    const otherSignal = await otherRequest.started.promise;
    pauseUploadOperation(mine);
    expect(mineSignal.aborted).toBe(true);
    expect(await mineResult).toMatchObject({ code: 'ERR_CANCELED', acceptanceUncertain: true });
    expect(otherSignal.aborted).toBe(false);
    expect(other.isActive()).toBe(true);
    // The other upload goes on to its answer; the paused one tried no fallback.
    otherRequest.response.resolve({ data: { data: { ...session, alreadyQueued: true, accepted: true } } });
    expect(await otherResult).toMatchObject({ reportId: 'same-report', jobId: 'same-job' });
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it.each(['asset', 'lotListing'] as const)('stops the %s multipart transfer of that upload only', async (kind) => {
    const mine = createUploadOperation(); const other = createUploadOperation();
    const pending = interruptedRequest();
    jest.mocked(api.post).mockRejectedValueOnce({ response: { status: 404 } }).mockImplementation(pending.request as any);
    const result = (kind === 'asset'
      ? assetService.createAssetReport(details as AssetCreateDetails, [{ id: 'lot', files: [file], extraFiles: [], coverIndex: 0 }], undefined, { operation: mine })
      : lotListingService.createLotListing(listingDetails, [listingLot], undefined, { operation: mine })).catch((error) => error);
    const signal = await pending.started.promise;
    pauseUploadOperation(mine);
    expect(signal.aborted).toBe(true);
    expect(await result).toMatchObject({ code: 'ERR_CANCELED', acceptanceUncertain: true });
    expect(other.isActive()).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('gives the same paused error as a pause of every upload, with a reason when one is given', () => {
    const operation = createUploadOperation();
    pauseUploadOperation(operation, 'connection');
    let error: any;
    try { operation.assertActive(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'ERR_CANCELED', acceptanceUncertain: true, pauseReason: 'connection' });
    expect(() => pauseUploadOperation(null)).not.toThrow();
  });

  it('tells listeners when the upload owner changes, after every upload has stopped, and only then', () => {
    const running = createUploadOperation();
    const seen: Array<{ owner: string | null; uploadStillActive: boolean }> = [];
    const stop = onUploadOwnerChange((owner) => { seen.push({ owner, uploadStillActive: running.isActive() }); });
    setUploadOwner('owner-a');
    expect(seen).toEqual([]);
    setUploadOwner('owner-b');
    expect(seen).toEqual([{ owner: 'owner-b', uploadStillActive: false }]);
    stop();
    setUploadOwner('owner-a');
    expect(seen).toHaveLength(1);
  });
});
