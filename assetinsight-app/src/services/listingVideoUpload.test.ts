import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { pauseActiveUploads, setUploadOwner } from './uploadCancellation';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));
const fs = require('expo-file-system/legacy');
const clips: DirectUploadFile[] = Array.from({ length: 6 }, (_, index) => ({
  uri: `content://media/external/video/media/${720 + index}`, name: `lot-${index}-video.mp4`, type: 'video/mp4', size: 8_000_000,
  fieldname: 'videos', role: 'video', lotIndex: index, imageIndex: 0,
}));
const session = { sessionId: 'stable-session', reportId: 'stable-report', jobId: 'stable-job', files: clips.map((clip, index) => ({
  fileId: `videos-${index}`, key: `isolated-${index}`, uploadUrl: `https://storage.invalid/${index}`, contentType: clip.type,
  method: 'PUT', headers: { 'Content-Type': clip.type },
})) };
const details = { client_submission_id: 'stable-submission', contract_no: 'video-test' };
const originalPlatform = Platform.OS;
const originalFetch = global.fetch;
const originalFormData = global.FormData;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  pauseActiveUploads(); setUploadOwner('owner'); jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  global.fetch = jest.fn();
  global.FormData = class { append() {} } as unknown as typeof FormData;
  jest.mocked(api.post).mockImplementation(async (url: any) => url.endsWith('/upload-session')
    ? { data: { data: session } }
    : { data: { reportId: 'stable-report', jobId: 'stable-job', message: 'Accepted', phase: 'processing' } });
});
afterAll(() => { Object.defineProperty(Platform, 'OS', { value: originalPlatform }); global.fetch = originalFetch; global.FormData = originalFormData; });

describe.each(['/asset', '/lot-listing'] as const)('%s video upload', endpoint => {
  const upload = (files = clips, onProgress = jest.fn()) => uploadReportFilesDirectToR2({ endpoint, details, files, onProgress });
  it('streams exactly four clips concurrently, reports bytes and never creates whole-video JS blobs', async () => {
    const firstFour = deferred();
    const release = deferred();
    let active = 0; let maximum = 0;
    const stream = jest.fn(async (args: any) => {
      active++; maximum = Math.max(maximum, active);
      if (active === 4) firstFour.resolve();
      args.onProgress(args.size / 2, args.size);
      await release.promise;
      args.onProgress(args.size, args.size);
      active--;
      return { status: 200, body: '', headers: {} };
    });
    jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), streamContentUriUpload: stream });
    const progress = jest.fn();
    const result = upload(clips, progress);
    await firstFour.promise;
    expect(stream).toHaveBeenCalledTimes(4);
    release.resolve();
    await expect(result).resolves.toMatchObject({ reportId: 'stable-report' });
    expect(maximum).toBe(4); expect(stream).toHaveBeenCalledTimes(6);
    expect(stream.mock.calls.map(([args]) => args.uri)).toEqual(clips.map(clip => clip.uri));
    expect(progress).toHaveBeenLastCalledWith(100, expect.objectContaining({ completedFiles: 6, totalFiles: 6, uploadedBytes: 48_000_000 }));
    const manifest = (jest.mocked(api.post).mock.calls[0][1] as any).files;
    expect(manifest.map((file: any) => [file.fieldname, file.role, file.lotIndex, file.imageIndex])).toEqual(clips.map((_, index) => ['videos', 'video', index, 0]));
    expect(global.fetch).not.toHaveBeenCalled(); expect(fs.createUploadTask).not.toHaveBeenCalled();
  });

  it('cancels active clips and queued clips; explicit resume reuses the accepted session without re-uploading', async () => {
    const firstFour = deferred();
    const pending = new Map<string, { reject(error: unknown): void }>();
    const stream = jest.fn((args: any) => {
      const request = deferred(); pending.set(args.id, request);
      if (pending.size === 4) firstFour.resolve();
      return request.promise as any;
    });
    const cancel = jest.fn(async (id: string) => { pending.get(id)?.reject(new Error('Cancelled')); });
    jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), streamContentUriUpload: stream, cancelContentUriUpload: cancel });
    const result = upload().catch(error => error);
    await firstFour.promise; pauseActiveUploads();
    expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
    expect(cancel).toHaveBeenCalledTimes(4); expect(stream).toHaveBeenCalledTimes(4);
    jest.mocked(api.post).mockResolvedValueOnce({ data: { data: { ...session, alreadyQueued: true, accepted: true } } });
    await expect(upload()).resolves.toMatchObject({ reportId: 'stable-report', jobId: 'stable-job' });
    const requests = jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/upload-session'));
    expect(requests).toHaveLength(2); expect(requests[1][1]).toEqual(requests[0][1]);
    expect(stream).toHaveBeenCalledTimes(4); expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps a local video file native-backed when filesystem PUT is unavailable', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios' });
    fs.createUploadTask.mockImplementation(() => { throw new Error('Unsupported native PUT'); });
    jest.mocked(api.post).mockImplementation(async (url: any) => {
      if (url.endsWith('/upload-session')) return { data: { data: { ...session, files: [session.files[0]] } } };
      if (url.endsWith('/verify')) return { data: { data: { verified: false } } };
      return { data: { reportId: 'stable-report', jobId: 'stable-job', message: 'Accepted', phase: 'processing' } };
    });
    await expect(upload([{ ...clips[0], uri: 'file:///documents/camera-videos/clip.mp4' }])).resolves.toMatchObject({ reportId: 'stable-report' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(jest.mocked(api.post).mock.calls.some(([url]) => String(url).endsWith('/files/videos-0'))).toBe(true);
  });
});
