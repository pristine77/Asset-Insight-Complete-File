import API, { type RetriableAxiosConfig } from "@/lib/api";
import type { AxiosProgressEvent } from "axios";
import { assertAuthSessionCurrent, captureAuthSession, isAuthSessionCurrent, type AuthSessionSnapshot } from "@/lib/auth-storage";
import {
  canUseDirectBrowserUpload,
  mapWithConcurrency,
  putFileWithRetry,
} from "@/services/directUpload";

export type ReportDraftKind = "asset" | "lot-listing";
export type ReportDraftApiType = "asset" | "lotListing";
export type ReportDraftStorageMode = "local_media" | "r2_media" | "smart_upload";

export const DUPLICATE_LOT_DETECTED = "DUPLICATE_LOT_DETECTED";

export type DuplicateLotConflict = {
  contractNo?: string;
  lotNumber?: string;
  sourceType?: string;
  sourceId?: string;
  ownerDisplay?: string;
  message?: string;
};

export type ReportDraftMediaDescriptor = {
  clientFileId: string;
  localKey?: string;
  mediaId?: string;
  lotId?: string;
  slot: "main" | "extra" | "video";
  index: number;
  captureOrder?: number;
  originalOrder?: number;
  name: string;
  mimeType: string;
  size: number;
  verifiedSize?: number;
  lastModified: number;
  r2Key?: string;
  uploadedAt?: string;
  url?: string;
  contentPath?: string;
};

export type SmartUploadServerFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  originalOrder: number;
};

export type SmartUploadDraftSummary = {
  groupingMethod?: "black_divider" | "lot_number";
  sessionId?: string;
  groupingStatus:
    | "uploading"
    | "classifying"
    | "review_ready"
    | "confirmed"
    | "failed";
  progressPercent: number;
  files?: SmartUploadServerFile[];
  groups: Array<{
    lotNumber?: string;
    groupIndex: number;
    imageCount: number;
    fileIds: string[];
    overLimit: boolean;
    files?: SmartUploadServerFile[];
  }>;
  dividerFileIds?: string[];
  warnings?: string[];
  error?: string;
  expectedFileCount?: number;
  confirmedFileCount?: number;
};

export type ReportDraftRecord = {
  _id: string;
  id?: string;
  user: string;
  clientDraftId: string;
  type: ReportDraftApiType;
  storageMode: ReportDraftStorageMode;
  smartUploadSession?: string;
  revision: number;
  deviceId?: string;
  contractNo: string;
  title?: string;
  formData: Record<string, unknown>;
  lots: unknown[];
  activeLotIdx?: number;
  media: ReportDraftMediaDescriptor[];
  smartUploadSummary?: SmartUploadDraftSummary;
  previewStatus?: "idle" | "queued" | "processing" | "ready" | "error";
  previewReportId?: string;
  previewJobId?: string;
  previewRequestedRevision?: number;
  previewProcessedRevision?: number;
  previewError?: string;
  previewRequestedAt?: string;
  previewReadyAt?: string;
  duplicateLotConflicts?: DuplicateLotConflict[];
  syncWarningCode?: string;
  syncWarningMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type PromotedDraftPreview = {
  reportId: string;
  reportType: "asset" | "lotListing";
  status: string;
  preview_data?: Record<string, unknown>;
  files_generating?: boolean;
  files_regenerating?: boolean;
};

export type PromoteDraftPreviewInput = {
  preview_data?: Record<string, unknown>;
  submit?: boolean;
};

export type UpsertReportDraftInput = {
  clientDraftId: string;
  kind: ReportDraftKind;
  storageMode?: ReportDraftStorageMode;
  smartUploadSessionId?: string;
  revision: number;
  deviceId?: string;
  contractNo?: string;
  title?: string;
  formData: Record<string, unknown>;
  lots: unknown[];
  activeLotIdx?: number;
  media?: ReportDraftMediaDescriptor[];
};

export type DraftMediaLot = {
  id?: string;
  lot_id?: string;
  _id?: string;
  files?: File[];
  extraFiles?: File[];
  videoFiles?: File[];
  [key: string]: unknown;
};

type DraftMediaEntry = {
  descriptor: ReportDraftMediaDescriptor;
  file: File;
};

type DraftUploadTarget = {
  clientFileId: string;
  r2Key: string;
  uploadUrl?: string;
  url?: string;
  alreadyUploaded: boolean;
};

export type ReportDraftSaveProgress = {
  phase: "preparing" | "uploading" | "verifying" | "complete";
  percent: number;
  message: string;
  totalFiles: number;
  uploadedFiles: number;
  totalBytes: number;
  uploadedBytes: number;
};

type ReportDraftProgressCallback = (
  percent: number,
  message: string,
  details: ReportDraftSaveProgress
) => void;

const fileIds = new WeakMap<Blob, string>();
const TARGET_BATCH_SIZE = 200;
const FALLBACK_BATCH_SIZE = 10;

const DEVICE_ID_KEY = "cv_report_draft_device_id";

export function getReportDraftDeviceId() {
  if (typeof window === "undefined") return "server";
  let value = window.localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value =
      globalThis.crypto?.randomUUID?.() ||
      `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

export function createReportDraftClientId(kind: ReportDraftKind) {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function isBrowserMedia(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function createStableMediaId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `media-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
  );
}

/**
 * Attach the server media identity to the File itself. A WeakMap fallback is
 * used for browsers that expose non-extensible File objects. This identity is
 * intentionally independent of array position, filename, or lot order.
 */
export function attachReportDraftMediaId(file: Blob, id: string) {
  const value = String(id || "").trim();
  if (!value) return;
  fileIds.set(file, value);
  try {
    Object.defineProperty(file, "__reportDraftMediaId", {
      configurable: true,
      enumerable: false,
      writable: false,
      value,
    });
  } catch {
    // WeakMap identity remains available for this browser session.
  }
}

function stableMediaId(file: File) {
  const tagged = String(
    (file as File & { __reportDraftMediaId?: string }).__reportDraftMediaId ||
      fileIds.get(file) ||
      ""
  ).trim();
  if (tagged) return tagged;
  const next = createStableMediaId();
  attachReportDraftMediaId(file, next);
  return next;
}

function lotIdFor(lot: DraftMediaLot, index: number) {
  return String(lot.id || lot.lot_id || lot._id || `draft-lot-${index + 1}`);
}

/**
 * Mongo stores report text and small structural metadata only. Browser Blobs,
 * object URLs and legacy data URLs are deliberately excluded so a large draft
 * cannot exceed the API/body or Mongo document limits.
 */
export function sanitizeReportDraftMetadata<T>(value: T): T {
  const visit = (input: unknown): unknown => {
    if (isBrowserMedia(input)) return undefined;
    if (Array.isArray(input)) {
      return input
        .map(visit)
        .filter((item) => item !== undefined);
    }
    if (input instanceof Date) return input.toISOString();
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .map(([key, item]) => [key, visit(item)] as const)
          .filter(([, item]) => item !== undefined)
      );
    }
    if (
      typeof input === "string" &&
      (/^data:/i.test(input) || /^blob:/i.test(input))
    ) {
      return undefined;
    }
    return input;
  };
  return visit(value) as T;
}

function mediaDescriptor(
  lotId: string,
  slot: ReportDraftMediaDescriptor["slot"],
  file: File,
  index: number,
  originalOrder: number
): ReportDraftMediaDescriptor {
  const identity = stableMediaId(file);
  const explicitCaptureOrder = Number(
    (file as File & { captureOrder?: number; originalOrder?: number }).captureOrder ??
      (file as File & { originalOrder?: number }).originalOrder
  );
  const captureOrder = Number.isFinite(explicitCaptureOrder)
    ? explicitCaptureOrder
    : index;
  return {
    clientFileId: identity,
    localKey: identity,
    mediaId: identity,
    lotId,
    slot,
    index,
    captureOrder,
    originalOrder,
    name: file.name || `${slot}-${index + 1}`,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified || 0,
  };
}

export function buildReportDraftMediaEntries(lots: DraftMediaLot[]) {
  const entries: DraftMediaEntry[] = [];
  let originalOrder = 0;
  lots.forEach((lot, lotIndex) => {
    const lotId = lotIdFor(lot, lotIndex);
    const append = (
      files: File[] | undefined,
      slot: ReportDraftMediaDescriptor["slot"]
    ) => {
      (files || []).forEach((file, index) => {
        entries.push({
          descriptor: mediaDescriptor(lotId, slot, file, index, originalOrder),
          file,
        });
        originalOrder += 1;
      });
    };
    append(lot.files, "main");
    append(lot.extraFiles, "extra");
    append(lot.videoFiles, "video");
  });
  return entries;
}

export function buildReportDraftMediaManifest(lots: DraftMediaLot[]) {
  return buildReportDraftMediaEntries(lots).map((item) => item.descriptor);
}

/** Returns lot text/settings without embedding browser media bytes in Mongo. */
export function serializeReportDraftLots(lots: DraftMediaLot[]) {
  return lots.map((lot, lotIndex) => {
    const { files: _files, extraFiles: _extra, videoFiles: _videos, ...rest } =
      lot;
    return sanitizeReportDraftMetadata({
      ...rest,
      id: lotIdFor(lot, lotIndex),
      files: [],
      extraFiles: [],
      videoFiles: [],
    });
  });
}

const apiTypeFor = (kind: ReportDraftKind): ReportDraftApiType =>
  kind === "lot-listing" ? "lotListing" : "asset";

function unwrap<T>(response: { data: { data: T } }) {
  return response.data.data;
}

export function getDuplicateLotWarning(value: unknown): string | null {
  const source = value as {
    syncWarningCode?: unknown;
    syncWarningMessage?: unknown;
    duplicateLotConflicts?: unknown;
    response?: { data?: { code?: unknown; message?: unknown; conflicts?: unknown } };
  } | null;
  const response = source?.response?.data;
  const code = String(source?.syncWarningCode || response?.code || "");
  const conflicts = Array.isArray(source?.duplicateLotConflicts)
    ? source.duplicateLotConflicts
    : Array.isArray(response?.conflicts)
      ? response.conflicts
      : [];
  if (code !== DUPLICATE_LOT_DETECTED && conflicts.length === 0) return null;
  return String(
    source?.syncWarningMessage ||
      response?.message ||
      "Duplicate Lot Detected. This lot number already exists under the same contract. Change the lot number before creating the preview."
  );
}

function chunks<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function uploadMultipartFallback(
  draftId: string,
  entries: DraftMediaEntry[],
  onBatchProgress?: (
    batch: DraftMediaEntry[],
    uploadedBytes: number,
    totalBytes: number
  ) => void,
  signal?: AbortSignal,
  session?: AuthSessionSnapshot
) {
  for (const batch of chunks(entries, FALLBACK_BATCH_SIZE)) {
    signal?.throwIfAborted();
    if (session) assertAuthSessionCurrent(session);
    const totalBytes = batch.reduce(
      (sum, item) => sum + Math.max(0, item.file.size),
      0
    );
    const body = new FormData();
    body.append("replace", "false");
    body.append(
      "metadata",
      JSON.stringify(batch.map((item) => item.descriptor))
    );
    batch.forEach((item) => body.append("files", item.file, item.file.name));
    // The browser supplies the multipart boundary. Setting Content-Type here
    // would produce the same "Unexpected end of form" failure as APK uploads.
    await API.post(`/report-drafts/${draftId}/media`, body, {
      timeout: 30 * 60 * 1000,
      signal,
      _authSession: session,
      onUploadProgress: (event: AxiosProgressEvent) => {
        onBatchProgress?.(
          batch,
          Math.min(totalBytes, Math.max(0, event.loaded || 0)),
          totalBytes
        );
      },
    } as RetriableAxiosConfig);
    onBatchProgress?.(batch, totalBytes, totalBytes);
  }
}

function mediaSortValue(item: ReportDraftMediaDescriptor) {
  const original = Number(item.originalOrder);
  if (Number.isFinite(original)) return original;
  const capture = Number(item.captureOrder);
  if (Number.isFinite(capture)) return capture;
  return Number(item.index) || 0;
}

function restoredFileName(item: ReportDraftMediaDescriptor) {
  return item.name || `${item.slot || "media"}-${(item.index || 0) + 1}`;
}

async function downloadDraftFile(
  draftId: string,
  item: ReportDraftMediaDescriptor,
  signal?: AbortSignal,
  onFailure?: () => void,
) {
  const contentPath =
    item.contentPath ||
    `/report-drafts/${encodeURIComponent(draftId)}/media/${encodeURIComponent(
      item.clientFileId
    )}/content`;
  if (!draftId || !item.clientFileId) {
    throw new Error(`Draft photo ${restoredFileName(item)} is not available in R2.`);
  }
  // Restore through the authenticated API. Public R2/custom-domain CORS is an
  // optimization for uploads, not a requirement for recovering user drafts.
  const response = await API.get<Blob>(contentPath, {
    responseType: "blob",
    timeout: 10 * 60 * 1000,
    signal,
  }).catch(async (error: unknown) => {
    onFailure?.();
    signal?.throwIfAborted();
    const failure = error as { response?: { status?: number; data?: unknown } };
    if (!failure.response) throw error;
    let data = failure.response.data;
    if (data instanceof Blob && data.size < 16_384) {
      try { data = JSON.parse(await data.text()); } catch { data = undefined; }
    }
    const code = (data as { code?: string } | undefined)?.code;
    const messages: Record<string, string> = {
      DRAFT_NOT_FOUND: "This draft is no longer available to this account. Return to Drafts and refresh the list.",
      DRAFT_MEDIA_CHANGED: "The saved photo list changed. Retry loading the latest draft.",
      DRAFT_MEDIA_UPLOAD_INCOMPLETE: "The original was not uploaded completely. Keep the original on the device used to save this draft and contact support.",
      DRAFT_MEDIA_SIZE_MISMATCH: "The saved original is incomplete or could not be verified. Keep the original and contact support.",
      DRAFT_MEDIA_MISSING: "The original is missing from storage. Keep the original on the device used to save this draft and contact support.",
      DRAFT_MEDIA_UNAVAILABLE: "Storage is temporarily unavailable. Retry loading the draft.",
    };
    throw new Error((code && messages[code]) || (failure.response.status === 404
      ? "The saved original or draft could not be found. Retry loading the latest draft; if this persists, keep the original and contact support."
      : "The original could not be downloaded. Check your connection and retry loading the draft."));
  });
  const blob = response.data;
  if (!blob.size || (item.size > 0 && blob.size !== item.size)) {
    onFailure?.();
    throw new Error("The downloaded original is incomplete. Retry loading the draft; your saved data has not been changed.");
  }
  const file = new File([blob], restoredFileName(item), {
    type: item.mimeType || blob.type || "application/octet-stream",
    lastModified: item.lastModified || Date.now(),
  });
  attachReportDraftMediaId(file, item.clientFileId || item.mediaId || item.localKey || "");
  return file;
}

export const ReportDraftService = {
  async list(kind?: ReportDraftKind, timeout?: number) {
    return unwrap(
      await API.get<{ data: ReportDraftRecord[] }>("/report-drafts", {
        params: kind ? { type: apiTypeFor(kind) } : undefined,
        ...(timeout ? { timeout } : {}),
      })
    );
  },

  async get(id: string, signal?: AbortSignal, session?: AuthSessionSnapshot) {
    return unwrap(
      await API.get<{ data: ReportDraftRecord }>(`/report-drafts/${id}`, {
        signal,
        ...(session ? { _authSession: session } : {}),
      } as RetriableAxiosConfig)
    );
  },

  async getByClientId(clientDraftId: string, kind: ReportDraftKind) {
    return unwrap(
      await API.get<{ data: ReportDraftRecord }>(
        `/report-drafts/client/${encodeURIComponent(clientDraftId)}`,
        { params: { type: apiTypeFor(kind) } }
      )
    );
  },

  async processPreview(id: string) {
    return unwrap(
      await API.post<{ data: ReportDraftRecord }>(
        `/report-drafts/${encodeURIComponent(id)}/process-preview`
      )
    );
  },

  async promotePreview(id: string, input: PromoteDraftPreviewInput = {}) {
    return unwrap(
      await API.post<{ data: PromotedDraftPreview }>(
        `/report-drafts/${encodeURIComponent(id)}/promote-preview`,
        input
      )
    );
  },

  async upsert(input: UpsertReportDraftInput, signal?: AbortSignal, session?: AuthSessionSnapshot) {
    const response = await API.post<{
      data: ReportDraftRecord;
      code?: string;
      message?: string;
      conflicts?: DuplicateLotConflict[];
    }>(
      "/report-drafts",
      {
        ...input,
        type: apiTypeFor(input.kind),
        kind: undefined,
      },
      { signal, ...(session ? { _authSession: session } : {}) } as RetriableAxiosConfig
    );
    return {
      ...response.data.data,
      duplicateLotConflicts:
        response.data.conflicts || response.data.data.duplicateLotConflicts || [],
      syncWarningCode: response.data.code,
      syncWarningMessage: response.data.code ? response.data.message : undefined,
    };
  },

  async upsertWithMedia(
    input: Omit<UpsertReportDraftInput, "lots" | "media" | "storageMode">,
    lots: DraftMediaLot[],
    onProgress?: ReportDraftProgressCallback,
    signal?: AbortSignal,
    session: AuthSessionSnapshot = captureAuthSession()
  ) {
    signal?.throwIfAborted();
    assertAuthSessionCurrent(session);
    const entries = buildReportDraftMediaEntries(lots);
    const totalFiles = entries.length;
    const totalBytes = entries.reduce(
      (sum, item) => sum + Math.max(0, item.file.size),
      0
    );
    const uploadedBytesById = new Map<string, number>();
    const uploadedIds = new Set<string>();

    const emitProgress = (
      phase: ReportDraftSaveProgress["phase"],
      message: string,
      percentOverride?: number
    ) => {
      if (signal?.aborted || !isAuthSessionCurrent(session)) return;
      const uploadedBytes = Math.min(
        totalBytes,
        entries.reduce(
          (sum, entry) =>
            sum +
            Math.min(
              entry.file.size,
              uploadedBytesById.get(entry.descriptor.clientFileId) || 0
            ),
          0
        )
      );
      const uploadedFiles = uploadedIds.size;
      const byteFraction = totalBytes > 0 ? uploadedBytes / totalBytes : 1;
      const fileFraction = totalFiles > 0 ? uploadedFiles / totalFiles : 1;
      const calculated = Math.round(byteFraction * 85 + fileFraction * 10);
      const percent = Math.max(
        0,
        Math.min(
          100,
          percentOverride ??
            (phase === "preparing"
              ? 2
              : phase === "verifying"
                ? Math.max(96, calculated)
                : phase === "complete"
                  ? 100
                  : Math.min(95, calculated))
        )
      );
      onProgress?.(percent, message, {
        phase,
        percent,
        message,
        totalFiles,
        uploadedFiles,
        totalBytes,
        uploadedBytes,
      });
    };

    const updateEntryBytes = (entry: DraftMediaEntry, bytes: number) => {
      uploadedBytesById.set(
        entry.descriptor.clientFileId,
        Math.max(
          uploadedBytesById.get(entry.descriptor.clientFileId) || 0,
          Math.min(entry.file.size, Math.max(0, bytes))
        )
      );
    };

    const markEntryUploaded = (entry: DraftMediaEntry) => {
      updateEntryBytes(entry, entry.file.size);
      uploadedIds.add(entry.descriptor.clientFileId);
      emitProgress(
        "uploading",
        `Saving draft media ${uploadedIds.size} of ${totalFiles}`
      );
    };

    emitProgress(
      "preparing",
      totalFiles
        ? `Preparing ${totalFiles} draft media file${totalFiles === 1 ? "" : "s"}`
        : "Saving draft details"
    );
    const record = await this.upsert(
      {
        ...input,
        storageMode: "r2_media",
        lots: serializeReportDraftLots(lots),
        media: entries.map((item) => item.descriptor),
      },
      signal,
      session
    );
    assertAuthSessionCurrent(session);
    signal?.throwIfAborted();
    const draftId = record?.id || record?._id;
    if (typeof draftId !== "string" || !draftId.trim()) {
      throw new Error("The server did not confirm the draft save. Retry Save draft before leaving this page.");
    }
    if (entries.length === 0) {
      emitProgress("complete", "Draft saved", 100);
      return record;
    }

    const existingUploadedIds = new Set(
      (record.media || [])
        .filter((item) => item.uploadedAt && item.url)
        .map((item) => item.clientFileId)
    );
    entries.forEach((entry) => {
      if (!existingUploadedIds.has(entry.descriptor.clientFileId)) return;
      uploadedIds.add(entry.descriptor.clientFileId);
      updateEntryBytes(entry, entry.file.size);
    });
    const pendingEntries = entries.filter(
      (item) => !existingUploadedIds.has(item.descriptor.clientFileId)
    );
    if (!pendingEntries.length) {
      emitProgress("complete", "Draft and photos saved", 100);
      return record;
    }

    // A missing bucket CORS rule causes every presigned browser PUT to fail.
    // After the first failure, use the bounded backend multipart path for the
    // remainder of this save instead of producing hundreds of failed requests.
    let directUploadsAvailable = true;
    emitProgress(
      "uploading",
      `Saving draft media ${uploadedIds.size} of ${totalFiles}`
    );

    for (const batch of chunks(pendingEntries, TARGET_BATCH_SIZE)) {
      signal?.throwIfAborted();
      assertAuthSessionCurrent(session);
      const targets = unwrap(
        await API.post<{ data: DraftUploadTarget[] }>(
          `/report-drafts/${draftId}/media/targets`,
          { media: batch.map((item) => item.descriptor) },
          { signal, _authSession: session } as RetriableAxiosConfig
        )
      );
      const targetById = new Map(
        targets.map((target) => [target.clientFileId, target])
      );
      const directIds: string[] = [];
      const fallback: DraftMediaEntry[] = [];

      await mapWithConcurrency(
        batch,
        async (entry) => {
          signal?.throwIfAborted();
          assertAuthSessionCurrent(session);
          const target = targetById.get(entry.descriptor.clientFileId);
          if (!target) throw new Error(`No R2 target was returned for ${entry.file.name}.`);
          if (target.alreadyUploaded) {
            markEntryUploaded(entry);
            return;
          }
          if (
            !target.uploadUrl ||
            !canUseDirectBrowserUpload(target.uploadUrl)
          ) {
            fallback.push(entry);
            return;
          }
          if (!directUploadsAvailable) {
            fallback.push(entry);
            return;
          }
          try {
            await putFileWithRetry(
              target.uploadUrl,
              entry.file,
              entry.descriptor.mimeType,
              (delta) => {
                const current =
                  uploadedBytesById.get(entry.descriptor.clientFileId) || 0;
                updateEntryBytes(entry, current + delta);
                emitProgress(
                  "uploading",
                  `Uploading ${entry.file.name}`
                );
              },
              undefined,
              signal
            );
            directIds.push(entry.descriptor.clientFileId);
            markEntryUploaded(entry);
          } catch (error) {
            if (signal?.aborted) throw error;
            directUploadsAvailable = false;
            fallback.push(entry);
          }
        },
        4,
        signal
      );

      for (const idBatch of chunks(directIds, TARGET_BATCH_SIZE)) {
        if (!idBatch.length) continue;
        signal?.throwIfAborted();
        assertAuthSessionCurrent(session);
        await API.post(
          `/report-drafts/${draftId}/media/confirm`,
          { clientFileIds: idBatch },
          { signal, _authSession: session } as RetriableAxiosConfig
        );
      }
      if (fallback.length) {
        await uploadMultipartFallback(
          draftId,
          fallback,
          (batchEntries, uploadedBytes, batchTotalBytes) => {
            const ratio =
              batchTotalBytes > 0
                ? Math.min(1, uploadedBytes / batchTotalBytes)
                : 1;
            batchEntries.forEach((entry) => {
              updateEntryBytes(entry, Math.round(entry.file.size * ratio));
            });
            emitProgress(
              "uploading",
              `Uploading draft photos through the secure server`
            );
          },
          signal,
          session
        );
        fallback.forEach(markEntryUploaded);
      }
    }

    emitProgress("verifying", "Verifying saved draft media", 98);
    signal?.throwIfAborted();
    assertAuthSessionCurrent(session);
    const saved = await this.get(draftId, signal, session);
    assertAuthSessionCurrent(session);
    signal?.throwIfAborted();
    const savedById = new Map(
      (saved.media || []).map((item) => [item.clientFileId, item])
    );
    const missing = entries.filter((entry) => {
      const item = savedById.get(entry.descriptor.clientFileId);
      return !item?.uploadedAt || !item.url;
    });
    if (missing.length) {
      throw new Error(
        `${missing.length} draft photo${missing.length === 1 ? "" : "s"} could not be verified in storage. Keep this form open and save again.`
      );
    }
    emitProgress("complete", "Draft and photos saved", 100);
    return {
      ...saved,
      syncWarningCode: record.syncWarningCode,
      syncWarningMessage: record.syncWarningMessage,
      duplicateLotConflicts:
        saved.duplicateLotConflicts || record.duplicateLotConflicts || [],
    };
  },

  async restoreLots<T extends DraftMediaLot>(record: ReportDraftRecord, options: {
    signal?: AbortSignal;
    onProgress?: (progress: { completed: number; total: number }) => void;
  } = {}): Promise<T[]> {
    options.signal?.throwIfAborted();
    const draftId = record.id || record._id;
    if (!draftId) throw new Error("This draft has no server identifier and cannot be restored.");
    const lots = (Array.isArray(record.lots) ? record.lots : []).map(
      (value, index) => {
        const lot = { ...(value as T) };
        return {
          ...lot,
          id: lotIdFor(lot, index),
          files: [] as File[],
          extraFiles: [] as File[],
          videoFiles: [] as File[],
        } as T;
      }
    );
    const lotById = new Map(
      lots.map((lot, index) => [lotIdFor(lot, index), lot])
    );
    if (lotById.size !== lots.length) throw new Error("The saved draft contains duplicate lot identifiers. Contact support; no photos were moved or removed.");
    const mediaIds = new Set<string>();
    for (const item of record.media || []) {
      if (!item.clientFileId || mediaIds.has(item.clientFileId) || !lotById.has(String(item.lotId || "")) || !["main", "extra", "video"].includes(item.slot)) {
        throw new Error("The saved draft photo mapping is incomplete or inconsistent. Contact support; no photos were moved or removed.");
      }
      mediaIds.add(item.clientFileId);
    }
    const lotRank = new Map(
      lots.map((lot, index) => [lotIdFor(lot, index), index])
    );
    const slotRank = { main: 0, extra: 1, video: 2 } as const;
    const media = [...(record.media || [])].sort((a, b) => {
      const lot =
        (lotRank.get(String(a.lotId || "")) ?? Number.MAX_SAFE_INTEGER) -
        (lotRank.get(String(b.lotId || "")) ?? Number.MAX_SAFE_INTEGER);
      const slot = (slotRank[a.slot] ?? 9) - (slotRank[b.slot] ?? 9);
      return (
        lot ||
        slot ||
        mediaSortValue(a) - mediaSortValue(b) ||
        a.index - b.index
      );
    });
    const restored = new Map<string, File>();
    let failureObserved = false;
    options.onProgress?.({ completed: 0, total: media.length });
    await mapWithConcurrency(
      media,
      async (item) => {
        if (failureObserved) return;
        const file = await downloadDraftFile(draftId, item, options.signal, () => { failureObserved = true; }).catch((error: unknown) => {
          options.signal?.throwIfAborted();
          const lot = lotById.get(String(item.lotId)) as { lotNumber?: string; lot_number?: string };
          const lotLabel = lot.lotNumber || lot.lot_number || String((lotRank.get(String(item.lotId)) ?? 0) + 1);
          throw new Error(`Lot ${lotLabel}, ${item.slot === "extra" ? "report-only photo" : item.slot === "video" ? "video" : "photo"} ${item.index + 1} (${restoredFileName(item)}): ${error instanceof Error ? error.message : "The original could not be restored."}`);
        });
        options.signal?.throwIfAborted();
        if (failureObserved) return;
        restored.set(item.clientFileId, file);
        options.onProgress?.({ completed: restored.size, total: media.length });
      },
      4,
      options.signal
    );
    options.signal?.throwIfAborted();
    for (const item of media) {
      const lot = lotById.get(String(item.lotId || ""));
      const file = restored.get(item.clientFileId);
      if (!lot || !file) continue;
      if (item.slot === "extra") lot.extraFiles?.push(file);
      else if (item.slot === "video") lot.videoFiles?.push(file);
      else lot.files?.push(file);
    }
    return lots;
  },

  async delete(id: string) {
    await API.delete(`/report-drafts/${id}`);
  },

  async deleteByClientId(clientDraftId: string, kind: ReportDraftKind) {
    await API.delete(
      `/report-drafts/client/${encodeURIComponent(clientDraftId)}`,
      { params: { type: apiTypeFor(kind) } }
    );
  },
};

export function draftKindForRecord(record: ReportDraftRecord): ReportDraftKind {
  return record.type === "lotListing" ? "lot-listing" : "asset";
}
