import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { pauseActiveUploads, setUploadOwner } from './uploadCancellation';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./connectivityService', () => ({ isRetryableRequestError: () => false }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));

const fs = require('expo-file-system/legacy');
const originalPlatform = Platform.OS;
const details = { client_submission_id: 'same-submission', capture_id: 'same-capture', contract_no: '185-photos' };
const file: DirectUploadFile = { uri: 'file:///original.jpg', name: 'original.jpg', type: 'image/jpeg' };
const accepted = { reportId: 'same-report', jobId: 'same-job', message: 'Accepted', phase: 'processing' };

beforeEach(() => {
  pauseActiveUploads();
  setUploadOwner('owner');
  jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  fs.createUploadTask.mockReturnValue({ uploadAsync: jest.fn().mockResolvedValue({ status: 200 }), cancelAsync: jest.fn() });
  jest.mocked(api.post).mockImplementation(async (url: any, body: any) => {
    if (!url.endsWith('/upload-session')) return { data: accepted };
    return { data: { data: {
      sessionId: 'same-session', ...accepted,
      files: body.files.map((entry: any) => ({ fileId: entry.fileId, uploadUrl: 'https://storage.invalid/file', contentType: entry.type, method: 'PUT' })),
    } } };
  });
});
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe.each(['/asset', '/lot-listing'] as const)('%s submission manifest identity', (endpoint) => {
  it('hands the exact prepared session to durable transport without uploading or claiming acceptance', async () => {
    const handoff = jest.fn(async () => undefined);
    const result = await uploadReportFilesDirectToR2({ endpoint, details, files: [{ ...file, size: 321 }], handoff });
    expect(result).toMatchObject({ backgroundStaged: true, jobId: 'same-job' });
    expect(result.reportId).toBeUndefined();
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ endpoint, details, session: expect.objectContaining({ sessionId: 'same-session' }),
      files: [expect.objectContaining({ fileId: 'images-0', uri: file.uri, size: 321 })] }), expect.any(Object));
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(fs.createUploadTask).not.toHaveBeenCalled();
  });
  it('reads the durable saved file size before freezing the manifest instead of trusting a temporary rendition size', async () => {
    const handoff = Object.assign(jest.fn(async () => undefined), {
      prepareFiles: jest.fn(async (files: DirectUploadFile[]) => files.map(item => ({ ...item, uri: 'file:///saved/edited.jpg', size: undefined }))),
    });
    fs.getInfoAsync.mockResolvedValue({ exists: true, size: 456 });
    await uploadReportFilesDirectToR2({ endpoint, details, files: [{ ...file, size: 999 }], handoff });
    expect(fs.getInfoAsync).toHaveBeenCalledWith('file:///saved/edited.jpg', { size: true });
    expect(jest.mocked(api.post).mock.calls[0][1]).toMatchObject({ files: [{ size: 456 }] });
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.objectContaining({ uri: 'file:///saved/edited.jpg', size: 456 })] }), expect.any(Object));
    expect(fs.createUploadTask).not.toHaveBeenCalled();
  });
  it('preserves the submission and media when the server reports an accepted report is unavailable', async () => {
    const receipt = { accepted: true, reportAvailable: false, canCreateSeparate: true, reportId: 'removed-report', jobId: 'same-submission' };
    const error = Object.assign(new Error('Earlier report unavailable'), { response: { status: 409, data: { code: 'UPLOAD_SESSION_REPORT_UNAVAILABLE', data: receipt } } });
    jest.mocked(api.post).mockRejectedValueOnce(error);
    const progress = jest.fn();
    await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [{ ...file, size: 321 }], onProgress: progress })).rejects.toBe(error);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(jest.mocked(api.post).mock.calls[0][1]).toMatchObject({ details, files: [{ name: file.name, size: 321 }] });
    expect(fs.createUploadTask).not.toHaveBeenCalled();
    expect(progress.mock.calls.some(([percent]) => percent === 100)).toBe(false);
  });

  it('rejects an unavailable already-queued success-shaped response without sending media', async () => {
    jest.mocked(api.post).mockResolvedValueOnce({ data: { data: { ...accepted, sessionId: 'same-session', alreadyQueued: true, accepted: true, reportAvailable: false, canCreateSeparate: true, files: [] } } });
    await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [{ ...file, size: 321 }] })).rejects.toMatchObject({ response: { data: { code: 'UPLOAD_SESSION_REPORT_UNAVAILABLE' } } });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(fs.createUploadTask).not.toHaveBeenCalled();
  });
  it('marks an earlier acceptance explicitly so the form cannot discard later editable fields', async () => {
    jest.mocked(api.post).mockResolvedValueOnce({ data: { data: { ...accepted, sessionId: 'same-session', alreadyQueued: true, accepted: true, reportAvailable: true, files: [] } } });
    await expect(uploadReportFilesDirectToR2({ endpoint, details: { ...details, client_name: 'Newly edited client' }, files: [{ ...file, size: 321 }] })).resolves.toMatchObject({ ...accepted, alreadyQueued: true, message: expect.any(String) });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(fs.createUploadTask).not.toHaveBeenCalled();
  });

  it('does not announce completion when the final receipt is missing its report identity', async () => {
    const defaultPost = jest.mocked(api.post).getMockImplementation()!;
    jest.mocked(api.post).mockImplementation(async (...args: any[]) => args[0].endsWith('/complete') ? { data: { jobId: 'same-submission' } } : (defaultPost as any)(...args));
    const progress = jest.fn();
    await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [{ ...file, size: 321 }], onProgress: progress })).rejects.toMatchObject({ code: 'UPLOAD_RECEIPT_UNCONFIRMED' });
    expect(progress.mock.calls.some(([percent]) => percent === 100)).toBe(false);
    expect(jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/upload-session'))).toHaveLength(1);
  });

  it.each([{ exists: false }, { exists: true, size: 0 }, { exists: true, size: Number.NaN }])(
    'does not reserve an unknown-size session when local metadata is unavailable: %j', async (info) => {
      fs.getInfoAsync.mockResolvedValue(info);
      await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [file] })).rejects.toThrow('size');
      expect(api.post).not.toHaveBeenCalled();
      expect(fs.createUploadTask).not.toHaveBeenCalled();
    }
  );

  it('can retry a failed size read using the same identity without an earlier incomplete reservation', async () => {
    fs.getInfoAsync.mockRejectedValueOnce(new Error('Temporary filesystem failure')).mockResolvedValueOnce({ exists: true, size: 321 });
    await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [file] })).rejects.toThrow('size');
    expect(api.post).not.toHaveBeenCalled();
    await expect(uploadReportFilesDirectToR2({ endpoint, details, files: [file] })).resolves.toMatchObject(accepted);
    const requests = jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/upload-session'));
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toMatchObject({ details, files: [{ size: 321 }] });
    expect(file.size).toBeUndefined();
  });

  it('keeps 13 lots and 185 photo descriptors plus nested details identical when refreshing signed targets', async () => {
    const files: DirectUploadFile[] = Array.from({ length: 185 }, (_, index) => ({
      ...file, uri: `file:///original-${index}.jpg`, name: `original-${index}.jpg`, size: 100 + index,
      lotIndex: Math.min(12, Math.floor(index / 14)), imageIndex: index < 168 ? index % 14 : index - 168,
      role: index === 184 ? 'extra' : 'main', captureOrder: index,
    }));
    const mutableDetails = { ...details, mixed_lots: Array.from({ length: 13 }, (_, index) => ({ count: index === 12 ? 16 : 14, extra_count: index === 12 ? 1 : 0, cover_index: 0 })) };
    const originalDetails = JSON.parse(JSON.stringify(mutableDetails));
    const requests: any[] = [];
    const defaultPost = jest.mocked(api.post).getMockImplementation()!;
    jest.mocked(api.post).mockImplementation(async (...args: any[]) => {
      if (args[0].endsWith('/upload-session')) {
        requests.push(JSON.parse(JSON.stringify(args[1])));
        if (requests.length > 1 && JSON.stringify(requests[0]) !== JSON.stringify(requests[1])) {
          throw Object.assign(new Error('This submission changed after upload started.'), { response: { status: 409 } });
        }
      }
      return (defaultPost as any)(...args);
    });
    let changed = false;
    fs.createUploadTask.mockImplementation((_url: string, uri: string) => ({
      uploadAsync: async () => {
        if (!changed) {
          changed = true;
          mutableDetails.mixed_lots[0].cover_index = 3;
          files[0].name = 'later-edit.jpg';
        }
        return { status: uri === 'file:///original-0.jpg' && requests.length === 1 ? 403 : 200 };
      }, cancelAsync: jest.fn(),
    }));
    await expect(uploadReportFilesDirectToR2({ endpoint, details: mutableDetails, files })).resolves.toMatchObject(accepted);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].details).toEqual(originalDetails);
    expect(requests[0].files).toHaveLength(185);
    expect(requests[0].files.map((entry: any) => entry.fileId)).toEqual(Array.from({ length: 185 }, (_, index) => `images-${index}`));
    expect(new Set(requests[0].files.map((entry: any) => entry.lotIndex)).size).toBe(13);
    expect(fs.createUploadTask).toHaveBeenCalledTimes(186);
  });
});
