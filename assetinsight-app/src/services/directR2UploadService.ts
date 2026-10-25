import api from './api';
import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';
import { beginUploadFinalization, createUploadOperation, cancellableUploadRequest, cancellableUploadTask, isUploadStalled, UPLOAD_IDLE_TIMEOUT_MS, type UploadOperation } from './uploadCancellation';
import { isRetryableRequestError } from './connectivityService';
import { assertReportUploadAccepted } from './reportUploadReceipt';

const FileSystem = require('expo-file-system/legacy');

export type DirectUploadFile = {
  uri: string;
  name: string;
  type: string;
  size?: number;
  fieldname?: 'images' | 'videos';
  lotIndex?: number;
  imageIndex?: number;
  captureOrder?: number;
  originalOrder?: number;
  role?: 'main' | 'extra' | 'video';
};

export type DirectUploadProgressStage =
  | 'preparing'
  | 'creating_session'
  | 'uploading'
  | 'finalizing'
  | 'complete';

export type DirectUploadProgress = {
  percent: number;
  stage: DirectUploadProgressStage;
  message: string;
  completedFiles: number;
  totalFiles: number;
  uploadedBytes: number;
  totalBytes: number;
  activeFileName?: string;
};

export type DirectUploadProgressCallback = (
  progress: number,
  detail?: DirectUploadProgress
) => void;

export type DirectUploadSessionResponse = {
  sessionId: string;
  reportId?: string;
  jobId: string;
  status?: string;
  resumed?: boolean;
  alreadyQueued?: boolean;
  accepted?: boolean;
  reportAvailable?: boolean;
  canCreateSeparate?: boolean;
  processed?: boolean;
  readyToComplete?: boolean;
  files: Array<{
    fileId: string;
    key: string;
    uploadUrl: string;
    method: 'PUT';
    contentType: string;
    headers?: Record<string, string>;
  }>;
};

/** The exact normal upload request, after file-size validation and session admission. */
export type PreparedReportTransfer = {
  endpoint: '/asset' | '/lot-listing';
  details: Record<string, any>;
  session: DirectUploadSessionResponse;
  files: Array<DirectUploadFile & { fileId: string; size: number }>;
};
export type ReportTransferHandoff = ((prepared: PreparedReportTransfer, operation: UploadOperation) => Promise<void>) & {
  /** Resolve the immutable saved sources before declaring sizes to the server. */
  prepareFiles?: (files: DirectUploadFile[], operation: UploadOperation) => Promise<DirectUploadFile[]>;
};

const DIRECT_UPLOAD_CONCURRENCY = 4;
const DIRECT_UPLOAD_RETRIES = 2;
const DIRECT_UPLOAD_SESSION_REFRESH_RETRIES = 1;
const COMPLETE_SESSION_RETRIES = 4;
// The server already performs bounded R2 retries with a fresh stream. Keep the
// client retry count low so a storage outage queues a large resumable session
// promptly instead of retrying hundreds of files for hours.
const SERVER_FALLBACK_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUploadError(error: unknown, fallbackMessage: string): Error {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' && error.trim() ? error : fallbackMessage);
  // Only transport failures and transient HTTP responses are recoverable.
  // Marking a 400/403/413 response as "network" used to send online reports
  // into the offline queue and hide the actionable server response.
  if (isRetryableRequestError(err)) {
    (err as any).isRecoverableUploadError = true;
    (err as any).code = (err as any).code || 'ERR_NETWORK';
  }
  if (!err.message) err.message = fallbackMessage;
  return err;
}

type R2UploadError = Error & { status?: number; responseBody?: string };

function makeR2UploadError(file: DirectUploadFile, status?: number, responseBody?: string): R2UploadError {
  const detail = responseBody?.trim().replace(/\s+/g, " ").slice(0, 180);
  const error = new Error(
    `R2 upload failed for ${file.name}${status ? ` (${status})` : ""}${detail ? `: ${detail}` : ""}`
  ) as R2UploadError;
  error.status = status;
  error.responseBody = responseBody;
  return error;
}

async function uploadOneWithFileSystem(
  operation: UploadOperation,
  file: DirectUploadFile,
  uploadUrl: string,
  contentType: string,
  onFileProgress?: (sentBytes: number, totalBytes?: number) => void,
  signedHeaders?: Record<string, string>
) {
  operation.assertActive();
  const headers = {
    ...(signedHeaders || {}),
    'Content-Type': contentType || file.type || 'application/octet-stream',
  };
  const uploadType = FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 'BINARY_CONTENT';

  if (typeof FileSystem.createUploadTask === 'function') {
    let task: any;
    const result: any = await cancellableUploadTask(operation, async ({ touch, isActive }) => {
      let lastSent = 0;
      task = FileSystem.createUploadTask(
        uploadUrl,
        file.uri,
        { httpMethod: 'PUT', uploadType, headers },
        (progress: any) => {
          if (!isActive()) return;
          const sent = Number(progress?.totalBytesSent || 0);
          const expected = Number(progress?.totalBytesExpectedToSend || file.size || 0) || undefined;
          if (sent > lastSent) { lastSent = sent; touch(); }
          onFileProgress?.(sent, expected);
        }
      );
      return task.uploadAsync();
    }, () => { void Promise.resolve(task?.cancelAsync?.()).catch(() => undefined); }, { idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS });
    operation.assertActive();
    const status = Number(result?.status || 0);
    if (status < 200 || status >= 300) {
      throw makeR2UploadError(file, status, String((result as any)?.body || ""));
    }
    return;
  }

  // Legacy uploadAsync cannot be cancelled; use the abortable fetch fallback instead.
  throw new Error('Cancellable filesystem upload is not available');
}

async function uploadOne(
  operation: UploadOperation,
  file: DirectUploadFile,
  uploadUrl: string,
  contentType: string,
  signedHeaders?: Record<string, string>,
  onFileProgress?: (sentBytes: number, totalBytes?: number) => void
) {
  operation.assertActive();
  if (Platform.OS === 'android' && file.uri.startsWith('content://')) {
    const native = await cancellableUploadTask(operation, () => loadNativeAuctionCamera(), () => {}, { idleTimeoutMs: 30_000 });
    operation.assertActive();
    if (!native.streamContentUriUpload) throw new Error('This app version cannot stream gallery photos. Install the updated mobile build; your draft remains on this device.');
    const id = randomUUID();
    const result = await cancellableUploadTask(operation, ({ touch, isActive }) => {
      let lastSent = 0;
      return native.streamContentUriUpload!({ id, uri: file.uri, url: uploadUrl,
        headers: { ...(signedHeaders || {}), 'Content-Type': contentType || file.type }, size: file.size || 0,
        onProgress: (sent, expected) => {
          if (!isActive()) return;
          if (sent > lastSent) { lastSent = sent; touch(); }
          onFileProgress?.(sent, expected);
        } });
    }, () => { void Promise.resolve(native.cancelContentUriUpload?.(id)).catch(() => undefined); }, { idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS });
    operation.assertActive();
    if (result.status < 200 || result.status >= 300) throw makeR2UploadError(file, result.status, result.body);
    return;
  }
  try {
    await uploadOneWithFileSystem(operation, file, uploadUrl, contentType, onFileProgress, signedHeaders);
    return;
  } catch (error: any) {
    operation.assertActive();
    if (isUploadStalled(error)) throw error;
    // A signed R2 response is authoritative. Do not hide a 4xx/5xx failure by
    // attempting a second transport with the same invalid URL.
    if (Number(error?.status || 0) > 0) throw error;
    // Walkthroughs can be much larger than photos. Keep file-backed video bytes
    // in native transports; the outer retry can use native multipart through
    // the API, but must never read an entire clip into a JavaScript Blob.
    if (file.role === 'video' || file.fieldname === 'videos' || file.type.startsWith('video/')) throw error;
    console.warn('[DirectR2Upload] Filesystem upload failed, using fetch fallback:', error);
  }

  const controller = new AbortController();
  await cancellableUploadTask(operation, async ({ touch, isActive }) => {
    const signal = controller.signal;
    const source = await fetch(file.uri, { signal });
    if (!isActive()) throw new Error('Upload no longer active');
    operation.assertActive();
    const blob = await source.blob();
    if (!isActive()) throw new Error('Upload no longer active');
    operation.assertActive();
    touch();
    onFileProgress?.(0, blob.size || file.size);
    const response = await fetch(uploadUrl, {
      signal,
      method: 'PUT',
      headers: {
        ...(signedHeaders || {}),
        'Content-Type': contentType || file.type || 'application/octet-stream',
      },
      body: blob,
    });
    if (!isActive()) throw new Error('Upload no longer active');
    operation.assertActive();
    if (!response.ok) {
      throw makeR2UploadError(file, response.status, await response.text().catch(() => ""));
    }
    onFileProgress?.(blob.size || file.size || 1, blob.size || file.size);
  }, () => controller.abort(), { idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS });
}

async function uploadOneWithRetry(
  operation: UploadOperation,
  file: DirectUploadFile,
  uploadUrl: string,
  contentType: string,
  signedHeaders?: Record<string, string>,
  onFileProgress?: (sentBytes: number, totalBytes?: number) => void,
  onRetry?: (attempt: number, maxAttempts: number) => void
) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DIRECT_UPLOAD_RETRIES; attempt++) {
    operation.assertActive();
    if (attempt > 0) onRetry?.(attempt + 1, DIRECT_UPLOAD_RETRIES + 1);
    try {
      await uploadOne(operation, file, uploadUrl, contentType, signedHeaders, onFileProgress);
      return;
    } catch (error) {
      operation.assertActive();
      if (isUploadStalled(error)) throw error;
      lastError = error;
      if (!isRetryableRequestError(error)) break;
      if (attempt < DIRECT_UPLOAD_RETRIES) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw normalizeUploadError(lastError, `Upload failed for ${file.name}`);
}

/** Shared by report and draft uploads so both paths use the same native-safe R2 transport. */
export async function uploadLocalFileToPresignedUrl(
  file: DirectUploadFile,
  uploadUrl: string,
  contentType?: string
) {
  await uploadOneWithRetry(createUploadOperation(), file, uploadUrl, contentType || file.type);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) break;
        await worker(items[index], index);
      }
    })
  );
}

function buildManifest(files: DirectUploadFile[]) {
  return files.map((file, index) => ({
    fileId: `${file.fieldname || 'images'}-${index}`,
    name: file.name || `${file.fieldname || 'image'}-${index + 1}`,
    type: file.type || 'application/octet-stream',
    size: file.size,
    fieldname: file.fieldname || 'images',
    lotIndex: file.lotIndex,
    imageIndex: file.imageIndex ?? index,
    captureOrder: file.captureOrder ?? file.originalOrder ?? index,
    originalOrder: index,
    role: file.role || (file.fieldname === 'videos' ? 'video' : 'main'),
  }));
}

async function createOrResumeUploadSession(
  operation: UploadOperation,
  endpoint: '/asset' | '/lot-listing',
  details: Record<string, any>,
  manifest: ReturnType<typeof buildManifest>
) {
  const response = await cancellableUploadRequest(operation, (signal) => api.post<{ data: DirectUploadSessionResponse }>(
    `${endpoint}/upload-session`,
    { details, files: manifest },
    { timeout: 60000, signal }
  ));
  return response.data.data;
}

/**
 * Whether the server has already accepted this upload session, read from its
 * status receipt (GET .../upload-session/:id/status). Returns the receipt when
 * accepted, otherwise null -- including when the status call fails or the
 * server predates it, so the caller just re-sends completion as before.
 */
async function acceptedReceiptFromStatus(
  operation: UploadOperation,
  endpoint: '/asset' | '/lot-listing',
  sessionId: string
): Promise<Record<string, any> | null> {
  try {
    const response = await cancellableUploadRequest(operation, (signal) => api.get(
      `${endpoint}/upload-session/${sessionId}/status`,
      { timeout: 20000, signal }
    ));
    const receipt = (response as any)?.data?.data;
    return receipt?.accepted === true ? receipt : null;
  } catch {
    operation.assertActive();
    return null;
  }
}

async function completeUploadSessionWithRetry(
  operation: UploadOperation,
  endpoint: '/asset' | '/lot-listing',
  sessionId: string,
  onRetry: (attempt: number, maxAttempts: number) => void
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= COMPLETE_SESSION_RETRIES; attempt += 1) {
    operation.assertActive();
    try {
      const response = await cancellableUploadRequest(operation, (signal) => api.post(
        `${endpoint}/upload-session/${sessionId}/complete`,
        {},
        { timeout: 120000, signal }
      ));
      // Never rewrite a historical-acceptance flag: matching photo manifests
      // do not prove the current form values were accepted. Keep the draft.
      return response;
    } catch (error) {
      operation.assertActive();
      lastError = error;
      if (!isRetryableRequestError(error)) {
        throw normalizeUploadError(error, 'The upload could not be finalized');
      }
      // The request may have reached the server and been accepted, with only
      // the answer lost; a long completion also keeps running server-side after
      // the 120 s client timeout. Ask before sending it again, so an accepted
      // report finishes now instead of after up to four blind re-sends and,
      // at the end, a failure for a report that was in fact accepted
      // (2026-10-02). A status read does not bind current field edits, so retain
      // the draft for explicit review using the historical-acceptance flag.
      const receipt = await acceptedReceiptFromStatus(operation, endpoint, sessionId);
      if (receipt) {
        return { data: { ...receipt, reusedAcceptance: true } };
      }
      if (attempt >= COMPLETE_SESSION_RETRIES) {
        throw normalizeUploadError(error, 'The upload could not be finalized');
      }

      // Completion is idempotent on the server. Retrying this exact session
      // confirms the existing report instead of uploading hundreds of files
      // again or accidentally creating a duplicate report.
      onRetry(attempt + 1, COMPLETE_SESSION_RETRIES);
      await sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw normalizeUploadError(lastError, 'The upload could not be finalized');
}

async function verifyUploadSessionFile(
  operation: UploadOperation,
  endpoint: '/asset' | '/lot-listing',
  sessionId: string,
  fileId: string
): Promise<boolean> {
  try {
    const response = await cancellableUploadRequest(operation, (signal) => api.post(
      `${endpoint}/upload-session/${sessionId}/files/${encodeURIComponent(fileId)}/verify`,
      {},
      { timeout: 30000, signal }
    ));
    return response?.data?.data?.verified === true;
  } catch (error: any) {
    operation.assertActive();
    const status = Number(error?.response?.status || 0);
    const code = String(error?.response?.data?.code || '');
    if (
      status === 409 &&
      ['UPLOAD_NOT_VERIFIED', 'UPLOAD_FILE_SIZE_MISMATCH'].includes(code)
    ) {
      return false;
    }
    throw error;
  }
}

async function uploadOneThroughServerFallback(
  operation: UploadOperation,
  endpoint: '/asset' | '/lot-listing',
  sessionId: string,
  fileId: string,
  file: DirectUploadFile,
  onFileProgress?: (sentBytes: number, totalBytes?: number) => void,
  onRetry?: (attempt: number, maxAttempts: number) => void
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERVER_FALLBACK_RETRIES; attempt += 1) {
    operation.assertActive();
    // React Native multipart bodies are one-use. Rebuild the body for every
    // retry so a transient R2/server response cannot replay an exhausted form.
    const formData = new FormData();
    formData.append('file', {
      uri: file.uri,
      name: file.name || 'upload.jpg',
      type: file.type || 'application/octet-stream',
    } as any);
    try {
      // No total time limit: a file that is still moving is never cut off. The
      // deadline is UPLOAD_IDLE_TIMEOUT_MS without upload progress, as for the
      // direct transfers. The old fixed 120 s cap ended every walkaround video
      // or large photo on a slow link, identically on every resume, on exactly
      // the networks this fallback exists for (2026-10-02).
      const controller = new AbortController();
      let lastLoaded = -1;
      await cancellableUploadTask(operation, ({ touch, isActive }) => api.post(
        `${endpoint}/upload-session/${sessionId}/files/${encodeURIComponent(fileId)}`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 0,
          signal: controller.signal,
          onUploadProgress: (event: any) => {
            if (!isActive()) return;
            const loaded = Number(event?.loaded || 0);
            if (loaded > lastLoaded) {
              lastLoaded = loaded;
              touch();
            }
            onFileProgress?.(loaded, Number(event?.total || file.size || 0) || undefined);
          },
        }
      ), () => controller.abort(), {
        idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
        message: `Sending ${file.name || 'a file'} through the server stopped making progress. Your draft is saved. Resume the same upload when the connection is stable.`,
      });
      onFileProgress?.(file.size || 1, file.size);
      return;
    } catch (error) {
      operation.assertActive();
      lastError = error;

      // The server may have committed the object before its response was lost.
      // Verify first so retries never upload the same image again unnecessarily.
      try {
        if (await verifyUploadSessionFile(operation, endpoint, sessionId, fileId)) {
          onFileProgress?.(file.size || 1, file.size);
          return;
        }
      } catch (verificationError) {
        operation.assertActive();
        if (!isRetryableRequestError(verificationError)) throw verificationError;
      }

      if (!isRetryableRequestError(error) || attempt >= SERVER_FALLBACK_RETRIES) {
        break;
      }
      onRetry?.(attempt + 1, SERVER_FALLBACK_RETRIES);
      await sleep(Math.min(5000, 600 * 2 ** (attempt - 1)));
    }
  }
  throw normalizeUploadError(lastError, `Upload failed for ${file.name}`);
}

async function resolveRuntimeFileSizes(
  operation: UploadOperation,
  files: DirectUploadFile[],
  onResolved: (resolvedCount: number) => void
) {
  const sizes = new Array<number>(files.length).fill(1);
  let resolvedCount = 0;

  await mapWithConcurrency(files, 8, async (file, index) => {
    operation.assertActive();
    const suppliedSize = Number(file.size || 0);
    if (Number.isFinite(suppliedSize) && suppliedSize > 0) {
      sizes[index] = suppliedSize;
    } else {
      try {
        const isContentUri = Platform.OS === 'android' && file.uri.startsWith('content://');
        const info: any = await cancellableUploadTask(operation, async ({ isActive }) => {
          const native = isContentUri ? await loadNativeAuctionCamera() : undefined;
          if (!isActive()) throw new Error('Upload no longer active');
          operation.assertActive();
          if (isContentUri && !native?.getContentUriInfo) throw new Error('Install the updated app to read gallery photo sizes. Your draft remains saved.');
          return isContentUri ? native!.getContentUriInfo!(file.uri)
            : FileSystem.getInfoAsync(file.uri, { size: true });
        }, () => {}, { idleTimeoutMs: 30_000, message: `Reading ${file.name || 'an original file'} stopped responding. Your draft is saved. Restore file access, then resume.` });
        operation.assertActive();
        const localSize = Number(info?.size || 0);
        if (info?.exists && Number.isFinite(localSize) && localSize > 0) {
          sizes[index] = localSize;
          file.size = localSize;
        } else {
          throw new Error('An original file is unavailable or its size cannot be read. Restore its permission or replace it before submitting.');
        }
      } catch (error) {
        operation.assertActive();
        if (isUploadStalled(error)) throw error;
        if (file.uri.startsWith('content://')) throw error;
        // Reserving an unknown size makes a later successful metadata read look
        // like changed media under the same submission. Stop before admission.
        throw new Error(`The size of ${file.name || 'an original file'} could not be read. Your draft remains saved. Restore access to the file, then retry.`);
      }
    }
    resolvedCount += 1;
    onResolved(resolvedCount);
  });

  return sizes;
}

async function performReportUpload(args: {
  endpoint: '/asset' | '/lot-listing';
  details: Record<string, any>;
  files: DirectUploadFile[];
  onProgress?: DirectUploadProgressCallback;
  operation?: UploadOperation;
  handoff?: ReportTransferHandoff;
}): Promise<{ jobId: string; reportId?: string; message: string; phase?: string; status?: string; alreadyQueued?: boolean; backgroundStaged?: boolean }> {
  const operation = args.operation || createUploadOperation();
  operation.assertActive();
  // Freeze the JSON request, including nested lot settings, before callbacks or
  // preparation can change caller state. Signed-target refreshes are exact retries.
  const details: Record<string, any> = JSON.parse(JSON.stringify(args.details));
  // Size resolution must not mutate the caller's saved draft, order or media identity.
  const clonedFiles = args.files.map((file) => ({ ...file }));
  const files = args.handoff?.prepareFiles ? await cancellableUploadTask(operation,
    () => args.handoff!.prepareFiles!(clonedFiles, operation), () => undefined,
    { idleTimeoutMs: 30_000, message: 'Reading the saved upload took too long. Your draft and originals are kept. Retry when device storage responds.' }) : clonedFiles;
  operation.assertActive();
  const totalFiles = args.files.length;
  let lastPercent = -1;
  let lastStage: DirectUploadProgressStage | undefined;
  let lastCompletedFiles = -1;
  let lastMessage = '';
  const emitProgress = (
    requestedPercent: number,
    detail: Omit<DirectUploadProgress, 'percent'>
  ) => {
    if (!operation.isActive()) return;
    // Upload retries can report fewer bytes than a prior attempt. Keep the
    // user-facing percentage monotonic while retaining the latest file counts.
    const percent = Math.max(lastPercent, Math.max(0, Math.min(100, Math.round(requestedPercent))));
    if (
      percent === lastPercent &&
      detail.stage === lastStage &&
      detail.completedFiles === lastCompletedFiles &&
      detail.message === lastMessage
    ) {
      return;
    }
    lastPercent = percent;
    lastStage = detail.stage;
    lastCompletedFiles = detail.completedFiles;
    lastMessage = detail.message;
    args.onProgress?.(percent, { percent, ...detail });
  };

  emitProgress(1, {
    stage: 'preparing',
    message: `Preparing ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'}...`,
    completedFiles: 0,
    totalFiles,
    uploadedBytes: 0,
    totalBytes: 0,
  });
  const runtimeFileSizes = await resolveRuntimeFileSizes(operation, files, (resolvedCount) => {
    const preparationPercent = totalFiles > 0 ? 1 + (resolvedCount / totalFiles) * 3 : 4;
    emitProgress(preparationPercent, {
      stage: 'preparing',
      message: `Preparing files (${resolvedCount} of ${totalFiles})...`,
      completedFiles: 0,
      totalFiles,
      uploadedBytes: 0,
      totalBytes: 0,
    });
  });
  operation.assertActive();
  const manifest = buildManifest(files);
  const totalBytes = runtimeFileSizes.reduce((sum, size) => sum + Math.max(1, size), 0) || 1;
  const expectedBytes = [...runtimeFileSizes];
  const sentBytes = new Array<number>(totalFiles).fill(0);
  const completedIndexes = new Set<number>();

  const reportFileProgress = (
    index: number,
    sent: number,
    expected?: number,
    activeFileName?: string
  ) => {
    const normalizedExpected = Number(expected || 0);
    if (Number.isFinite(normalizedExpected) && normalizedExpected > expectedBytes[index]) {
      expectedBytes[index] = normalizedExpected;
    }
    const fileExpected = Math.max(1, expectedBytes[index]);
    const normalizedSent = Math.max(0, Number(sent || 0));
    sentBytes[index] = Math.min(fileExpected, Math.max(sentBytes[index], normalizedSent));
    const dynamicTotalBytes = expectedBytes.reduce((sum, size) => sum + Math.max(1, size), 0) || totalBytes;
    const uploadedBytes = sentBytes.reduce((sum, size) => sum + Math.max(0, size), 0);
    const uploadRatio = Math.max(0, Math.min(1, uploadedBytes / dynamicTotalBytes));
    emitProgress(8 + uploadRatio * 84, {
      stage: 'uploading',
      message: `Uploading ${completedIndexes.size} of ${totalFiles} files...`,
      completedFiles: completedIndexes.size,
      totalFiles,
      uploadedBytes,
      totalBytes: dynamicTotalBytes,
      activeFileName,
    });
  };

  // A re-sent file starts again from zero bytes while the bar keeps its
  // high-water mark, so the bar cannot move during a retry and a working retry
  // looked frozen. Say what is happening instead (2026-10-02).
  const announceRetry = (fileName: string | undefined, message: string) => {
    emitProgress(Math.max(8, lastPercent), {
      stage: 'uploading',
      message,
      completedFiles: completedIndexes.size,
      totalFiles,
      uploadedBytes: sentBytes.reduce((sum, size) => sum + Math.max(0, size), 0),
      totalBytes,
      activeFileName: fileName,
    });
  };

  const markFileComplete = (index: number, fileName: string) => {
    completedIndexes.add(index);
    sentBytes[index] = Math.max(1, expectedBytes[index]);
    reportFileProgress(index, sentBytes[index], expectedBytes[index], fileName);
  };

  emitProgress(5, {
    stage: 'creating_session',
    message: 'Preparing secure upload...',
    completedFiles: 0,
    totalFiles,
    uploadedBytes: 0,
    totalBytes,
  });
  let session = await createOrResumeUploadSession(operation, args.endpoint, details, manifest);
  if (session.alreadyQueued) {
    assertReportUploadAccepted(session);
    emitProgress(100, {
      stage: 'complete',
      message: 'Submission already received.',
      completedFiles: totalFiles,
      totalFiles,
      uploadedBytes: totalBytes,
      totalBytes,
    });
    return {
      jobId: session.jobId,
      reportId: session.reportId,
      alreadyQueued: true,
      message: "Submission already accepted and is being processed.",
      phase: session.processed || session.status === "processed" ? "done" : "processing",
      status: session.status || "processing",
    };
  }
  if (args.handoff) {
    operation.assertActive();
    await args.handoff({ endpoint: args.endpoint, details, session,
      files: files.map((file, index) => ({ ...file, fileId: manifest[index].fileId, size: runtimeFileSizes[index] })),
    }, operation);
    // This is a durable device receipt, never server acceptance. The caller may
    // close the editor but must retain the draft and every original.
    return { jobId: session.jobId, message: 'Upload saved on this device and scheduled.', backgroundStaged: true };
  }
  let uploadById = new Map(session.files.map((file) => [file.fileId, file]));

  if (!session.readyToComplete) {
    emitProgress(8, {
      stage: 'uploading',
      message: `Uploading 0 of ${totalFiles} files...`,
      completedFiles: 0,
      totalFiles,
      uploadedBytes: 0,
      totalBytes,
    });
    const pendingIndexes = files.map((_, index) => index);
    for (let refreshAttempt = 0; refreshAttempt <= DIRECT_UPLOAD_SESSION_REFRESH_RETRIES; refreshAttempt += 1) {
      const failures: Array<{ index: number; error: unknown }> = [];
      await mapWithConcurrency(pendingIndexes, DIRECT_UPLOAD_CONCURRENCY, async (index) => {
        operation.assertActive();
        const file = files[index];
        const descriptor = manifest[index];
        const target = uploadById.get(descriptor.fileId);
        if (!target) throw new Error(`Missing upload target for ${file.name}`);
        try {
          // A lost response may have left the object safely in storage. On an
          // explicit resumed session, verify before sending those bytes again.
          if (session.resumed && refreshAttempt === 0 && await verifyUploadSessionFile(operation, args.endpoint, session.sessionId, descriptor.fileId)) {
            markFileComplete(index, file.name);
            return;
          }
          if (refreshAttempt > 0) announceRetry(file.name, `Sending ${file.name || 'a file'} again...`);
          await uploadOneWithRetry(
            operation,
            file,
            target.uploadUrl,
            target.contentType,
            target.headers,
            (sent, expected) => reportFileProgress(index, sent, expected, file.name),
            (attempt, maxAttempts) => announceRetry(file.name, `Retrying ${file.name || 'a file'} (${attempt} of ${maxAttempts})...`)
          );
          markFileComplete(index, file.name);
        } catch (error) {
          operation.assertActive();
          // Stop a stalled attempt promptly instead of applying this timeout to
          // every remaining photo. Explicit resume reconciles the same session.
          if (isUploadStalled(error)) throw normalizeUploadError(error, `Upload stopped for ${file.name}`);
          failures.push({ index, error });
        }
      });

      if (!failures.length) break;
      if (refreshAttempt >= DIRECT_UPLOAD_SESSION_REFRESH_RETRIES) {
        // Direct R2 uploads can be blocked by a device VPN, carrier, or R2
        // network policy. Fall back per file through the authenticated API,
        // retaining this exact session and manifest.
        const verificationFailures: Array<{ index: number; error: unknown }> = [];
        const needsFallback: Array<{ index: number; error: unknown }> = [];
        operation.assertActive();

        emitProgress(Math.max(8, lastPercent), {
          stage: 'uploading',
          message: `Checking ${failures.length} interrupted uploads...`,
          completedFiles: completedIndexes.size,
          totalFiles,
          uploadedBytes: sentBytes.reduce((sum, size) => sum + Math.max(0, size), 0),
          totalBytes,
        });

        // A direct R2 PUT can succeed while Android receives an opaque network
        // error. Verify those objects concurrently before proxying any bytes.
        await mapWithConcurrency(
          failures,
          DIRECT_UPLOAD_CONCURRENCY,
          async (failure) => {
            const file = files[failure.index];
            const descriptor = manifest[failure.index];
            try {
              const verified = await verifyUploadSessionFile(
                operation,
                args.endpoint,
                session.sessionId,
                descriptor.fileId
              );
              if (verified) markFileComplete(failure.index, file.name);
              else needsFallback.push(failure);
            } catch (error) {
              if (!isRetryableRequestError(error)) {
                verificationFailures.push({ index: failure.index, error });
              } else {
                needsFallback.push(failure);
              }
            }
          }
        );

        if (verificationFailures.length) {
          throw normalizeUploadError(
            verificationFailures[0].error,
            `Upload verification failed for ${args.files[verificationFailures[0].index].name}`
          );
        }

        // Keep the proxy fallback sequential for compatibility with servers
        // deployed before atomic per-file session updates. Abort on the first
        // exhausted failure: the upload session is durable, and the form catch
        // queues that same session for retry instead of blocking on every file.
        needsFallback.sort((left, right) => left.index - right.index);
        for (const failure of needsFallback) {
          operation.assertActive();
          const file = files[failure.index];
          const descriptor = manifest[failure.index];
          try {
            await uploadOneThroughServerFallback(
              operation,
              args.endpoint,
              session.sessionId,
              descriptor.fileId,
              file,
              (sent, expected) => reportFileProgress(failure.index, sent, expected, file.name),
              (attempt, maxAttempts) => {
                emitProgress(Math.max(8, lastPercent), {
                  stage: 'uploading',
                  message: `Retrying ${file.name} (${attempt} of ${maxAttempts})...`,
                  completedFiles: completedIndexes.size,
                  totalFiles,
                  uploadedBytes: sentBytes.reduce(
                    (sum, size) => sum + Math.max(0, size),
                    0
                  ),
                  totalBytes,
                  activeFileName: file.name,
                });
              }
            );
            markFileComplete(failure.index, file.name);
          } catch (error) {
            throw normalizeUploadError(error, `Upload failed for ${file.name}`);
          }
        }
        break;
      }

      // Reusing the same manifest and client submission id returns the same
      // session with fresh signed targets. Completed files are left untouched.
      operation.assertActive();
      session = await createOrResumeUploadSession(operation, args.endpoint, details, manifest);
      uploadById = new Map(session.files.map((file) => [file.fileId, file]));
      pendingIndexes.splice(0, pendingIndexes.length, ...failures.map((failure) => failure.index));
    }
  }

  operation.assertActive();
  // Set before 'finalizing' is shown, so no Pause tap can land in between.
  // See beginUploadFinalization in uploadCancellation.ts.
  const endFinalization = beginUploadFinalization();
  let completeResponse: Awaited<ReturnType<typeof completeUploadSessionWithRetry>>;
  try {
    emitProgress(95, {
      stage: 'finalizing',
      message: 'Finalizing submission...',
      completedFiles: totalFiles,
      totalFiles,
      uploadedBytes: totalBytes,
      totalBytes,
    });
    completeResponse = await completeUploadSessionWithRetry(
      operation,
      args.endpoint,
      session.sessionId,
      (attempt, maxAttempts) => {
        emitProgress(95, {
          stage: 'finalizing',
          message: `Server is busy. Confirming submission (${attempt} of ${maxAttempts})...`,
          completedFiles: totalFiles,
          totalFiles,
          uploadedBytes: totalBytes,
          totalBytes,
        });
      }
    );
  } finally {
    endFinalization();
  }
  assertReportUploadAccepted(completeResponse.data);
  emitProgress(100, {
    stage: 'complete',
    message: 'Upload complete.',
    completedFiles: totalFiles,
    totalFiles,
    uploadedBytes: totalBytes,
    totalBytes,
  });
  return completeResponse.data;
}

export async function uploadReportFilesDirectToR2(args: Parameters<typeof performReportUpload>[0]) {
  // One failed worker must cancel siblings; their late callbacks cannot overlap
  // the user's next explicit resume. Do not cancel other reports or the parent.
  const operation = createUploadOperation(args.operation);
  try {
    return await performReportUpload({ ...args, operation });
  } catch (error) {
    operation.cancel(error instanceof Error ? error : new Error('Upload interrupted'));
    throw error;
  }
}
