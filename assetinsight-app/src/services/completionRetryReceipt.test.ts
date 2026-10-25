/** Finalization status recovery retains historical-acceptance evidence and current edits. */
import { Platform } from 'react-native';
import api from './api';
import { uploadReportFilesDirectToR2, type DirectUploadFile } from './directR2UploadService';
import { isExistingReportUploadReceipt } from './reportUploadReceipt';
import { isUploadFinalizing, pauseActiveUploads, setUploadOwner } from './uploadCancellation';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
// Only errors the test marks as retryable are retried, so each case is explicit.
jest.mock('./connectivityService', () => ({ isRetryableRequestError: (error: any) => error?.retryable === true }));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));

const fs = require('expo-file-system/legacy');
const originalPlatform = Platform.OS;
const details = { client_submission_id: 'finalize-submission', capture_id: 'finalize-capture', contract_no: 'FINALIZE-1' };
const file: DirectUploadFile = { uri: 'file:///original.jpg', name: 'original.jpg', type: 'image/jpeg', size: 321 };
const receipt = { accepted: true, reportAvailable: true, reportId: 'finalize-report', jobId: 'finalize-submission', status: 'processing', phase: 'processing' };
const lostAnswer = () => Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED', retryable: true });

/**
 * Upload sessions succeed; each /complete call is answered by the next entry,
 * and each status check by the next entry of `statuses` (none: the check fails,
 * as on a server that predates it).
 */
function serve(completions: Array<() => Promise<any>>, seen: boolean[] = [], statuses: Array<() => Promise<any>> = []) {
  jest.mocked(api.get).mockImplementation((async (url: any) => {
    if (!String(url).endsWith('/upload-session/finalize-session/status')) throw new Error(`unexpected request ${url}`);
    const next = statuses.shift();
    if (!next) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    return next();
  }) as any);
  jest.mocked(api.post).mockImplementation(async (url: any, body: any) => {
    if (String(url).endsWith('/upload-session')) {
      return { data: { data: { sessionId: 'finalize-session', jobId: receipt.jobId, reportId: receipt.reportId,
        files: body.files.map((entry: any) => ({ fileId: entry.fileId, uploadUrl: 'https://storage.invalid/file', contentType: entry.type, method: 'PUT' })) } } };
    }
    if (String(url).endsWith('/complete')) {
      seen.push(isUploadFinalizing());
      const next = completions.shift();
      if (!next) throw new Error('unexpected extra completion request');
      return next();
    }
    throw new Error(`unexpected request ${url}`);
  });
  return seen;
}

beforeEach(() => {
  pauseActiveUploads();
  setUploadOwner('owner');
  jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  fs.createUploadTask.mockReturnValue({ uploadAsync: jest.fn().mockResolvedValue({ status: 200 }), cancelAsync: jest.fn() });
});
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe.each(['/asset', '/lot-listing'] as const)('%s completion', (endpoint) => {
  const upload = () => uploadReportFilesDirectToR2({ endpoint, details, files: [file] });

  it("preserves historical acceptance on retry rather than authorizing removal of newer edits", async () => {
    serve([
      async () => { throw lostAnswer(); },
      async () => ({ data: { ...receipt, reusedAcceptance: true } }),
    ]);
    const result: any = await upload();
    expect(result).toMatchObject({ ...receipt, reusedAcceptance: true });
    expect(isExistingReportUploadReceipt(result)).toBe(true);
    expect(jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(2);
  }, 15_000);

  it('still reports an acceptance found on the first request as an earlier upload', async () => {
    // Not a retry of this attempt: the server already held an acceptance, so
    // later field edits may not be in it. The form keeps the draft for review.
    serve([async () => ({ data: { ...receipt, reusedAcceptance: true } })]);
    const result: any = await upload();
    expect(result.reusedAcceptance).toBe(true);
    expect(result.acceptedOnRetry).toBeUndefined();
    expect(isExistingReportUploadReceipt(result)).toBe(true);
  });

  it('flags the submission as finalizing for exactly the completion request', async () => {
    const seen = serve([async () => ({ data: receipt })]);
    expect(isUploadFinalizing()).toBe(false);
    await expect(upload()).resolves.toMatchObject(receipt);
    expect(seen).toEqual([true]);
    expect(isUploadFinalizing()).toBe(false);
  });

  it('clears the finalizing flag when completion fails', async () => {
    serve([async () => { throw Object.assign(new Error('Bad request'), { response: { status: 400, data: { message: 'Bad request' } } }); }]);
    await expect(upload()).rejects.toBeTruthy();
    expect(isUploadFinalizing()).toBe(false);
  });
});

/*
 * Item 1 (2026-10-02): after a lost answer, ask the server whether it already
 * accepted the upload before re-sending completion.
 */
describe('finalizing asks the server before re-sending', () => {
  const completeCalls = () => jest.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith('/complete'));
  const statusReceipt = (accepted: boolean) => async () => ({ data: { data: accepted
    ? { sessionId: 'finalize-session', status: 'queued', accepted: true, reportAvailable: true, reportId: receipt.reportId, jobId: receipt.jobId, phase: 'processing', message: 'Your upload was accepted.' }
    : { sessionId: 'finalize-session', status: 'ready', accepted: false, reportAvailable: null, phase: 'upload', message: 'Your saved upload can be continued.' } } });
  const upload = () => uploadReportFilesDirectToR2({ endpoint: '/asset', details, files: [file] });

  it('recovers acceptance without claiming current field edits were accepted', async () => {
    serve([async () => { throw lostAnswer(); }], [], [statusReceipt(true)]);
    const result: any = await upload();
    expect(result).toMatchObject({ accepted: true, reportId: receipt.reportId, jobId: receipt.jobId, reusedAcceptance: true });
    expect(isExistingReportUploadReceipt(result)).toBe(true);
    expect(completeCalls()).toHaveLength(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('re-sends completion when the server has not accepted it yet', async () => {
    serve([async () => { throw lostAnswer(); }, async () => ({ data: receipt })], [], [statusReceipt(false)]);
    await expect(upload()).resolves.toMatchObject(receipt);
    expect(completeCalls()).toHaveLength(2);
  }, 15_000);

  it('re-sends completion as before when the status check itself fails', async () => {
    serve([async () => { throw lostAnswer(); }, async () => ({ data: receipt })]);
    await expect(upload()).resolves.toMatchObject(receipt);
    expect(completeCalls()).toHaveLength(2);
    expect(api.get).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('checks once more after the last attempt, so an accepted report never ends as a failure', async () => {
    jest.useFakeTimers();
    try {
      serve(
        [1, 2, 3, 4].map(() => async () => { throw lostAnswer(); }),
        [],
        [statusReceipt(false), statusReceipt(false), statusReceipt(false), statusReceipt(true)],
      );
      const result = upload();
      await jest.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toMatchObject({ accepted: true, reusedAcceptance: true });
      expect(completeCalls()).toHaveLength(4);
      expect(api.get).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not ask after an error that is not worth retrying', async () => {
    serve([async () => { throw Object.assign(new Error('Bad request'), { response: { status: 400, data: { message: 'Bad request' } } }); }]);
    await expect(upload()).rejects.toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});
