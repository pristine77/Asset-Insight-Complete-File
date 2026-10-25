import API from "@/lib/api";
import { safeReportOperationError } from "./reportTransferErrors";
import {
  DIRECT_UPLOAD_CONCURRENCY,
  mapWithConcurrency,
  uploadFileToReportSession,
} from "@/services/directUpload";
import { loadSmartUploadFile } from "@/components/forms/smartUpload/storage";
import type {
  SmartUploadDraft,
  SmartUploadKind,
  SmartUploadStoredFile,
} from "@/components/forms/smartUpload/storage";

export type SmartUploadEndpoint = "/asset" | "/lot-listing";
export type SmartUploadGroupingMethod = "black_divider" | "lot_number";

export type SmartUploadTarget = {
  fileId: string;
  uploadUrl: string;
  method: "PUT";
  contentType: string;
  headers?: Record<string, string>;
};

export type SmartUploadGroup = {
  lotNumber?: string;
  groupIndex: number;
  imageCount: number;
  fileIds: string[];
  coverFileId?: string;
  overLimit: boolean;
  files?: SmartUploadServerFile[];
};

export type SmartUploadServerFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  originalOrder: number;
  captureOrder?: number;
};

export type SmartUploadMetric = {
  kind?: "lot_start" | "photo" | "uncertain";
  lotNumber?: string | null;
  fileId: string;
  meanLuminance: number;
  darkPixelRatio: number;
  variance: number;
  isDivider: boolean;
  error?: string;
};

export type SmartUploadGrouping = {
  groupingMethod?: SmartUploadGroupingMethod;
  lotStartFileIds?: string[];
  unresolvedLotNumberFileIds?: string[];
  sessionId: string;
  smartUpload: true;
  groupingStatus:
    | "uploading"
    | "classifying"
    | "review_ready"
    | "confirmed"
    | "failed";
  progressPercent: number;
  revision: number;
  orderReviewRequired: boolean;
  unresolvedDividerIds: string[];
  /** Distinguishes a current server's authoritative empty set from legacy responses. */
  hasOrderReviewState?: boolean;
  orderSource?: "manifest" | "capture" | "manual" | "groups";
  algorithmVersion?: string;
  classificationJobId?: string;
  groups: SmartUploadGroup[];
  dividerFileIds: string[];
  metrics: SmartUploadMetric[];
  warnings: string[];
  error?: string;
  expectedFileCount: number;
  confirmedFileCount: number;
  files?: SmartUploadServerFile[];
};

type UploadSession = {
  groupingMethod?: SmartUploadGroupingMethod;
  sessionId: string;
  reportId?: string;
  jobId: string;
  status?: string;
  resumed?: boolean;
  alreadyQueued?: boolean;
  processed?: boolean;
  readyToComplete?: boolean;
  files: SmartUploadTarget[];
  nextCursor?: string | null;
};

type TargetPage = {
  files: SmartUploadTarget[];
  cursor: number;
  nextCursor: string | null;
  total: number;
};

const GROUPING_POLL_INTERVAL_MS = 1_250;
const SMART_UPLOAD_GROUPING_STATUSES = new Set<
  SmartUploadGrouping["groupingStatus"]
>(["uploading", "classifying", "review_ready", "confirmed", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeServerFiles(value: unknown): SmartUploadServerFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, fallbackOrder) => {
    if (!isRecord(candidate)) return [];
    const fileId = String(candidate.fileId || "").trim();
    if (!fileId) return [];
    const size = Number(candidate.size);
    const originalOrder = Number(candidate.originalOrder);
    const captureOrder = Number(candidate.captureOrder);
    return [
      {
        fileId,
        name: String(candidate.name || "image"),
        mimeType: String(candidate.mimeType || "image/jpeg"),
        size: Number.isFinite(size) ? Math.max(0, size) : 0,
        url: String(candidate.url || ""),
        originalOrder: Number.isFinite(originalOrder)
          ? originalOrder
          : fallbackOrder,
        captureOrder: Number.isFinite(captureOrder)
          ? captureOrder
          : undefined,
      },
    ];
  });
}

function normalizeMetrics(value: unknown): SmartUploadMetric[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const fileId = String(candidate.fileId || "").trim();
    if (!fileId) return [];
    const meanLuminance = Number(candidate.meanLuminance);
    const darkPixelRatio = Number(candidate.darkPixelRatio);
    const variance = Number(candidate.variance);
    return [
      {
        fileId,
        meanLuminance: Number.isFinite(meanLuminance) ? meanLuminance : 0,
        kind: ["lot_start", "photo", "uncertain"].includes(String(candidate.kind))
          ? candidate.kind as SmartUploadMetric["kind"] : undefined,
        lotNumber: typeof candidate.lotNumber === "string" ? candidate.lotNumber : null,
        darkPixelRatio: Number.isFinite(darkPixelRatio) ? darkPixelRatio : 0,
        variance: Number.isFinite(variance) ? variance : 0,
        isDivider: candidate.isDivider === true,
        error: typeof candidate.error === "string" ? candidate.error : undefined,
      },
    ];
  });
}

function normalizeSmartUploadGrouping(
  value: unknown,
  fallbackSessionId: string
): SmartUploadGrouping {
  if (!isRecord(value)) {
    throw new Error("Smart Upload returned an invalid grouping response.");
  }
  if (value.groupingMethod !== undefined && value.groupingMethod !== "black_divider" && value.groupingMethod !== "lot_number") {
    throw new Error("The server returned an unsupported upload method. Keep this upload and refresh after checking backend compatibility.");
  }

  const files = normalizeServerFiles(value.files);
  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  const groups = rawGroups.flatMap((candidate, fallbackIndex) => {
    if (!isRecord(candidate)) return [];
    const groupFiles = normalizeServerFiles(candidate.files);
    const explicitFileIds = Array.isArray(candidate.fileIds)
      ? candidate.fileIds.map(String).map((fileId) => fileId.trim()).filter(Boolean)
      : [];
    const explicitCoverFileId = String(candidate.coverFileId || "").trim();
    const fileIds = Array.from(
      new Set([
        ...explicitFileIds,
        ...groupFiles.map((file) => file.fileId),
      ])
    );
    return [
      {
        // The response array is the authoritative group order. Canonicalizing
        // indices prevents a stale/duplicate server label from selecting or
        // editing the wrong neighbouring lot.
        groupIndex: fallbackIndex,
        lotNumber: typeof candidate.lotNumber === "string" ? candidate.lotNumber : undefined,
        imageCount: fileIds.length,
        fileIds,
        coverFileId: fileIds.includes(explicitCoverFileId)
          ? explicitCoverFileId
          : fileIds[0],
        overLimit: candidate.overLimit === true,
        files: groupFiles,
      },
    ];
  });
  const rawStatus = String(value.groupingStatus || "uploading");
  const groupingStatus = SMART_UPLOAD_GROUPING_STATUSES.has(
    rawStatus as SmartUploadGrouping["groupingStatus"]
  )
    ? (rawStatus as SmartUploadGrouping["groupingStatus"])
    : "uploading";
  const progressPercent = Number(value.progressPercent);
  const expectedFileCount = Number(value.expectedFileCount);
  const confirmedFileCount = Number(value.confirmedFileCount);
  const revision = Number(value.revision);
  const rawOrderSource = String(value.orderSource || "");
  const orderSource = ["manifest", "capture", "manual", "groups"].includes(
    rawOrderSource
  )
    ? (rawOrderSource as SmartUploadGrouping["orderSource"])
    : undefined;

  return {
    sessionId: String(value.sessionId || fallbackSessionId),
    groupingMethod: value.groupingMethod === "lot_number" ? "lot_number" : "black_divider",
    lotStartFileIds: Array.isArray(value.lotStartFileIds) ? value.lotStartFileIds.filter((id): id is string => typeof id === "string") : [],
    unresolvedLotNumberFileIds: Array.isArray(value.unresolvedLotNumberFileIds) ? value.unresolvedLotNumberFileIds.filter((id): id is string => typeof id === "string") : [],
    smartUpload: true,
    groupingStatus,
    progressPercent: Number.isFinite(progressPercent)
      ? Math.max(0, Math.min(100, progressPercent))
      : 0,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    orderReviewRequired: value.orderReviewRequired === true,
    hasOrderReviewState:
      Object.prototype.hasOwnProperty.call(value, "orderReviewRequired") ||
      Object.prototype.hasOwnProperty.call(value, "unresolvedDividerIds"),
    unresolvedDividerIds: Array.isArray(value.unresolvedDividerIds)
      ? Array.from(
          new Set(
            value.unresolvedDividerIds
              .filter((fileId): fileId is string => typeof fileId === "string")
              .map((fileId) => fileId.trim())
              .filter(Boolean)
          )
        )
      : [],
    orderSource,
    algorithmVersion:
      typeof value.algorithmVersion === "string"
        ? value.algorithmVersion
        : undefined,
    classificationJobId:
      typeof value.classificationJobId === "string"
        ? value.classificationJobId
        : undefined,
    groups,
    dividerFileIds: Array.isArray(value.dividerFileIds)
      ? Array.from(
          new Set(value.dividerFileIds.map(String).map((fileId) => fileId.trim()).filter(Boolean))
        )
      : [],
    metrics: normalizeMetrics(value.metrics),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map(String).filter(Boolean)
      : [],
    error: typeof value.error === "string" ? value.error : undefined,
    expectedFileCount: Number.isFinite(expectedFileCount)
      ? Math.max(0, expectedFileCount)
      : files.length,
    confirmedFileCount: Number.isFinite(confirmedFileCount)
      ? Math.max(0, confirmedFileCount)
      : 0,
    files,
  };
}

function endpointFor(kind: SmartUploadKind): SmartUploadEndpoint {
  return kind === "asset" ? "/asset" : "/lot-listing";
}

function createManifest(files: SmartUploadDraft["files"]) {
  return files.map((item) => ({
    fileId: item.fileId,
    name: item.name,
    type: item.type || "application/octet-stream",
    size: item.size,
    fieldname: "images",
    imageIndex: item.originalOrder,
    captureTimestamp: item.lastModified || undefined,
    // This is the client-resolved canonical rank, not a raw file timestamp.
    // Reusable divider images often have an older lastModified value.
    captureOrder: item.originalOrder,
    originalOrder: item.originalOrder,
    role: "main",
  }));
}

function unwrapMessage(error: unknown, fallback: string) {
  const candidate = error as {
    response?: {
      data?: {
        message?: string;
        error?: string | { code?: string };
        code?: string;
      };
    };
    message?: string;
  };
  const response = candidate?.response;
  return safeReportOperationError(response ? { ...candidate, response: { ...response, status: (response as { status?: number }).status || 400, data: { ...response.data, message: response.data?.message || response.data?.error } } } : error, fallback);
}

export function getSmartUploadError(error: unknown) {
  return unwrapMessage(error, "Smart Upload could not continue. Check your connection and retry this same saved upload; do not start a duplicate upload.");
}

export function getSmartUploadErrorCode(error: unknown) {
  const data = (
    error as {
      response?: {
        data?: { code?: unknown; error?: { code?: unknown } };
      };
    }
  )?.response?.data;
  const code = data?.code ?? data?.error?.code;
  return typeof code === "string" ? code : undefined;
}

export async function createOrResumeSmartUploadSession(
  draft: SmartUploadDraft
) {
  const endpoint = endpointFor(draft.kind);
  const { data: envelope } = await API.post<{ data: UploadSession }>(
    `${endpoint}/upload-session`,
    {
      groupingMethod: draft.details.smart_upload_grouping_method === "lot_number" ? "lot_number" : "black_divider",
      details: {
        ...draft.details,
        smart_upload: true,
        grouping_mode: "mixed",
        client_submission_id: draft.clientSubmissionId,
        progress_id: draft.clientSubmissionId,
      },
      files: createManifest(draft.files),
    }
  );
  if (draft.details.smart_upload_grouping_method === "lot_number" && envelope.data.groupingMethod !== "lot_number") {
    throw new Error("This server does not support Lot Number Upload yet. Update the backend before uploading; your selected photos are retained.");
  }
  return envelope.data;
}

async function fetchTargetPage(
  endpoint: SmartUploadEndpoint,
  sessionId: string,
  cursor: string
) {
  const { data: envelope } = await API.get<{ data: TargetPage }>(
    `${endpoint}/upload-session/${sessionId}/targets`,
    { params: { cursor, limit: 100 } }
  );
  return envelope.data;
}

async function confirmTargetPage(
  endpoint: SmartUploadEndpoint,
  sessionId: string,
  fileIds: string[]
) {
  await API.post(`${endpoint}/upload-session/${sessionId}/confirm-files`, {
    fileIds,
  });
}

export async function uploadSmartUploadFiles(args: {
  draft: SmartUploadDraft;
  session: UploadSession;
  onProgress: (progress: {
    uploadedBytes: number;
    totalBytes: number;
    uploadedFiles: number;
    totalFiles: number;
  }) => void;
  onFilesConfirmed: (files: SmartUploadStoredFile[]) => Promise<void>;
}) {
  const endpoint = endpointFor(args.draft.kind);
  const descriptorById = new Map(
    args.draft.files.map((item) => [item.fileId, item])
  );
  const stateById = new Map(
    args.draft.files.map((item) => [
      item.fileId,
      {
        fileId: item.fileId,
        name: item.name,
        type: item.type,
        size: item.size,
        lastModified: item.lastModified,
        originalOrder: item.originalOrder,
        uploaded: item.uploaded,
        url: item.url,
      } satisfies SmartUploadStoredFile,
    ])
  );
  const totalBytes =
    args.draft.files.reduce((sum, item) => sum + Math.max(1, item.size), 0) ||
    1;
  let uploadedBytes = args.draft.files.reduce(
    (sum, item) => sum + (item.uploaded ? Math.max(1, item.size) : 0),
    0
  );
  let uploadedFiles = args.draft.files.filter((item) => item.uploaded).length;

  const publishProgress = () =>
    args.onProgress({
      uploadedBytes,
      totalBytes,
      uploadedFiles,
      totalFiles: args.draft.files.length,
    });
  publishProgress();

  let page: Pick<TargetPage, "files" | "nextCursor"> = {
    files: args.session.files || [],
    nextCursor: args.session.nextCursor || null,
  };

  while (page.files.length) {
    const pageLoaded = new Map<string, number>();
    await mapWithConcurrency(
      page.files,
      async (target) => {
        const item = descriptorById.get(target.fileId);
        if (!item) {
          throw new Error(`Upload file ${target.fileId} is missing locally.`);
        }
        if (stateById.get(target.fileId)?.uploaded) return;
        const file = item.file || (await loadSmartUploadFile(args.draft, item));
        if (!file) {
          throw new Error(
            `${item.name} is not stored on this browser. Resume this unfinished upload on the browser where the images were selected.`
          );
        }
        let lastLoaded = 0;
        await uploadFileToReportSession({
          endpoint,
          sessionId: args.session.sessionId,
          fileId: target.fileId,
          uploadUrl: target.uploadUrl,
          file,
          contentType: target.contentType,
          headers: target.headers,
          onDelta: (delta) => {
            // Retries restart XHR progress at zero, so cap the accumulated
            // contribution at the source file size.
            lastLoaded = Math.min(item.size, lastLoaded + delta);
            pageLoaded.set(target.fileId, lastLoaded);
            const activeBytes = [...pageLoaded.values()].reduce(
              (sum, value) => sum + value,
              0
            );
            args.onProgress({
              uploadedBytes: Math.min(totalBytes, uploadedBytes + activeBytes),
              totalBytes,
              uploadedFiles,
              totalFiles: args.draft.files.length,
            });
          },
        });
        // Server fallback does not expose XHR progress. Mark its contribution
        // complete only after the authenticated upload returns successfully.
        pageLoaded.set(target.fileId, item.size);
      },
      DIRECT_UPLOAD_CONCURRENCY
    );

    const pageIds = page.files.map((target) => target.fileId);
    await confirmTargetPage(endpoint, args.session.sessionId, pageIds);
    for (const fileId of pageIds) {
      const state = stateById.get(fileId);
      if (!state || state.uploaded) continue;
      state.uploaded = true;
      uploadedBytes += Math.max(1, state.size);
      uploadedFiles += 1;
    }
    pageLoaded.clear();
    const nextFiles = [...stateById.values()].sort(
      (left, right) => left.originalOrder - right.originalOrder
    );
    await args.onFilesConfirmed(nextFiles);
    publishProgress();

    if (!page.nextCursor) break;
    page = await fetchTargetPage(
      endpoint,
      args.session.sessionId,
      page.nextCursor
    );
  }
}

export async function startSmartUploadDetection(
  kind: SmartUploadKind,
  sessionId: string
) {
  const { data: envelope } = await API.post<{ data: SmartUploadGrouping }>(
    `${endpointFor(kind)}/upload-session/${sessionId}/detect-dividers`,
    {}
  );
  return normalizeSmartUploadGrouping(envelope.data, sessionId);
}

export async function getSmartUploadGrouping(
  kind: SmartUploadKind,
  sessionId: string
) {
  const { data: envelope } = await API.get<{ data: SmartUploadGrouping }>(
    `${endpointFor(kind)}/upload-session/${sessionId}/smart-grouping`,
    { timeout: 20_000 }
  );
  return normalizeSmartUploadGrouping(envelope.data, sessionId);
}

function waitForNextGroupingPoll(signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Smart Upload polling was cancelled.", "AbortError")
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Smart Upload polling was cancelled.", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, GROUPING_POLL_INTERVAL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForSmartUploadGrouping(args: {
  kind: SmartUploadKind;
  sessionId: string;
  signal?: AbortSignal;
  onProgress?: (grouping: SmartUploadGrouping) => void;
}) {
  while (!args.signal?.aborted) {
    const grouping = await getSmartUploadGrouping(args.kind, args.sessionId);
    if (args.signal?.aborted) {
      throw new DOMException("Smart Upload polling was cancelled.", "AbortError");
    }
    args.onProgress?.(grouping);
    if (
      grouping.groupingStatus === "review_ready" ||
      grouping.groupingStatus === "confirmed"
    ) {
      return grouping;
    }
    if (grouping.groupingStatus === "failed") {
      throw new Error(
        grouping.error || "Lot grouping detection failed."
      );
    }
    await waitForNextGroupingPoll(args.signal);
  }
  throw new DOMException("Smart Upload polling was cancelled.", "AbortError");
}

export async function updateSmartUploadDividers(args: {
  kind: SmartUploadKind;
  sessionId: string;
  dividerFileIds: string[];
  revision?: number;
  orderedFileIds?: string[];
  groups?: Array<string[] | { fileIds: string[]; lotNumber?: string }>;
  acknowledgeLotNumberReview?: boolean;
  orderReviewRequired?: boolean;
  unresolvedDividerIds?: string[];
  confirm?: boolean;
}) {
  const { data: envelope } = await API.patch<{ data: SmartUploadGrouping }>(
    `${endpointFor(args.kind)}/upload-session/${args.sessionId}/smart-grouping`,
    {
      dividerFileIds: args.dividerFileIds,
      ...(args.revision !== undefined ? { revision: args.revision } : {}),
      ...(args.orderedFileIds ? { orderedFileIds: args.orderedFileIds } : {}),
      ...(args.groups ? { groups: args.groups } : {}),
      ...(args.acknowledgeLotNumberReview === true ? { acknowledgeLotNumberReview: true } : {}),
      ...(args.orderReviewRequired !== undefined
        ? { orderReviewRequired: args.orderReviewRequired }
        : {}),
      ...(args.unresolvedDividerIds !== undefined
        ? { unresolvedDividerIds: args.unresolvedDividerIds }
        : {}),
      confirm: args.confirm === true,
    },
    { timeout: 45_000 }
  );
  return normalizeSmartUploadGrouping(envelope.data, args.sessionId);
}

export type SmartUploadCompletionResult = {
  message: string;
  jobId: string;
  reportId: string;
  status: string;
  phase: string;
};

export type SmartUploadCompletionStatus = {
  sessionId: string;
  status: "ready" | "preparing" | "queued" | "processed" | "failed";
  accepted: boolean;
  reportId?: string;
  jobId?: string;
  message?: string;
  phase?: string;
};

type CompletionOptions = { signal?: AbortSignal; onStatus?: (message: string) => void };
const COMPLETION_TIMEOUT_MS = 45_000;
const COMPLETION_STATUS_TIMEOUT_MS = 20_000;
const COMPLETION_STATUS_ATTEMPTS = 6;

export class SmartUploadCompletionPendingError extends Error {
  readonly completionPending = true;
  constructor(message = "Preview creation has not been confirmed yet. Your uploaded images and saved lot arrangement are retained. Check this same upload again; do not re-upload the images.", readonly reviewAvailable = false) {
    super(message);
    this.name = "SmartUploadCompletionPendingError";
  }
}

export function isSmartUploadCompletionPending(error: unknown) {
  return (error as { completionPending?: boolean })?.completionPending === true;
}

function throwIfCompletionAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Completion status check cancelled.", "AbortError");
}

function isAmbiguousCompletionError(error: unknown) {
  const candidate = error as { response?: { status?: number }; code?: string };
  const status = candidate?.response?.status;
  return !candidate?.response || [408, 500, 502, 503, 504].includes(Number(status));
}

function completionResult(value: unknown): SmartUploadCompletionResult | null {
  if (!isRecord(value) || typeof value.reportId !== "string" || !value.reportId.trim() || typeof value.jobId !== "string" || !value.jobId.trim()) return null;
  return {
    reportId: value.reportId,
    jobId: value.jobId,
    message: typeof value.message === "string" ? value.message : "Smart Upload was accepted. Preview processing continues in the report queue.",
    status: typeof value.status === "string" ? value.status : "queued",
    phase: typeof value.phase === "string" ? value.phase : "queued",
  };
}

export async function getSmartUploadCompletionStatus(kind: SmartUploadKind, sessionId: string, signal?: AbortSignal): Promise<SmartUploadCompletionStatus> {
  const { data: envelope } = await API.get<{ data: SmartUploadCompletionStatus }>(
    `${endpointFor(kind)}/upload-session/${sessionId}/status`,
    { signal, timeout: COMPLETION_STATUS_TIMEOUT_MS }
  );
  const status = envelope.data;
  if (!isRecord(status) || status.sessionId !== sessionId || !["ready", "preparing", "queued", "processed", "failed"].includes(String(status.status)) || typeof status.accepted !== "boolean") {
    throw new SmartUploadCompletionPendingError("The server did not return a valid completion status. Your same upload is retained; retry its status check.");
  }
  return status;
}

async function postSmartUploadCompletion(kind: SmartUploadKind, sessionId: string, signal?: AbortSignal) {
  throwIfCompletionAborted(signal);
  const { data } = await API.post(
    `${endpointFor(kind)}/upload-session/${sessionId}/complete`, {},
    { signal, timeout: COMPLETION_TIMEOUT_MS }
  );
  throwIfCompletionAborted(signal);
  return completionResult(data);
}

function completionDelay(delay: number, signal?: AbortSignal) {
  throwIfCompletionAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Completion status check cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Recover an ambiguous response using the existing session only; never recreate or re-upload. */
export async function recoverSmartUploadCompletion(kind: SmartUploadKind, sessionId: string, options: CompletionOptions = {}): Promise<SmartUploadCompletionResult> {
  let handoffRetries = 0;
  for (let attempt = 0; attempt < COMPLETION_STATUS_ATTEMPTS; attempt += 1) {
    throwIfCompletionAborted(options.signal);
    if ((typeof navigator !== "undefined" && navigator.onLine === false) || (typeof document !== "undefined" && document.visibilityState === "hidden")) {
      throw new SmartUploadCompletionPendingError("Automatic status checks are paused while this page is offline or in the background. Return to this same upload and check preview status; your uploaded images are retained.");
    }
    options.onStatus?.("Checking the same saved upload. Preview creation may still be processing; no images are being re-uploaded.");
    try {
      const status = await getSmartUploadCompletionStatus(kind, sessionId, options.signal);
      throwIfCompletionAborted(options.signal);
      if (status.accepted) {
        const result = completionResult(status);
        if (result) return result;
        throw new SmartUploadCompletionPendingError("The accepted preview did not include its report and job identifiers. Keep this upload and check its status again.");
      }
      if (status.status === "ready") {
        throw new SmartUploadCompletionPendingError("No preview job is confirmed yet. The saved upload is ready; use Retry preview creation to continue the same session without uploading photos again, or return to its saved review.", true);
      }
      if (status.status === "failed") {
        throw new SmartUploadCompletionPendingError(status.message || "The server could not finish this upload. Your session is retained; check its status or contact support before uploading anything again.");
      }
      if (status.status === "preparing" && handoffRetries < 2) {
        handoffRetries += 1;
        options.onStatus?.("Finishing the same saved upload and queueing its preview. Your images will not be uploaded again.");
        try {
          const accepted = await postSmartUploadCompletion(kind, sessionId, options.signal);
          if (accepted) return accepted;
        } catch (error) {
          throwIfCompletionAborted(options.signal);
          if (!isAmbiguousCompletionError(error)) throw new SmartUploadCompletionPendingError(getSmartUploadError(error));
        }
      }
    } catch (error) {
      throwIfCompletionAborted(options.signal);
      if (isSmartUploadCompletionPending(error)) throw error;
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) throw new SmartUploadCompletionPendingError("Completion status is not available on this server yet. Keep this saved upload and retry the same preview creation after the backend update; do not re-upload your images.");
      if (!isAmbiguousCompletionError(error)) throw new SmartUploadCompletionPendingError(getSmartUploadError(error));
    }
    if (attempt + 1 < COMPLETION_STATUS_ATTEMPTS) await completionDelay(Math.min(1500 * 2 ** attempt, 8000), options.signal);
  }
  throw new SmartUploadCompletionPendingError();
}

export async function completeSmartUpload(kind: SmartUploadKind, sessionId: string, options: CompletionOptions = {}): Promise<SmartUploadCompletionResult> {
  try {
    const result = await postSmartUploadCompletion(kind, sessionId, options.signal);
    if (result) return result;
  } catch (error) {
    throwIfCompletionAborted(options.signal);
    if (!isAmbiguousCompletionError(error)) throw error;
  }
  return recoverSmartUploadCompletion(kind, sessionId, options);
}

export async function cancelSmartUpload(
  kind: SmartUploadKind,
  sessionId: string
) {
  await API.delete(`${endpointFor(kind)}/upload-session/${sessionId}`);
}
