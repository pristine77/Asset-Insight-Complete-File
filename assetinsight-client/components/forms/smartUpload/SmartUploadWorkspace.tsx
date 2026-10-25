"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  CloudUpload,
  Image as ImageIcon,
  Loader2,
  ScanLine,
  Split,
  Trash2,
  UploadCloud,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  cancelSmartUpload,
  completeSmartUpload,
  createOrResumeSmartUploadSession,
  getSmartUploadErrorCode,
  getSmartUploadError,
  getSmartUploadGrouping,
  getSmartUploadCompletionStatus,
  recoverSmartUploadCompletion,
  isSmartUploadCompletionPending,
  startSmartUploadDetection,
  updateSmartUploadDividers,
  uploadSmartUploadFiles,
  waitForSmartUploadGrouping,
  type SmartUploadGrouping,
  type SmartUploadCompletionResult,
  type SmartUploadGroupingMethod,
} from "@/services/smartUpload";
import {
  createSmartUploadDraft,
  deleteSmartUploadDraft,
  loadSmartUploadFile,
  loadSmartUploadDraft,
  releaseSmartUploadMedia,
  saveServerSmartUploadDraft,
  updateSmartUploadDraft,
  type SmartUploadDraft,
  type SmartUploadKind,
} from "./storage";
import {
  isLikelySmartUploadDividerName,
  resolveSmartUploadFileOrder,
  type SmartUploadOrderingDiagnostic,
  type SmartUploadOrderingStrategy,
} from "./ordering";
import { SMART_UPLOAD_MAX_FILES, SMART_UPLOAD_MAX_FILE_BYTES, SMART_UPLOAD_MAX_TOTAL_BYTES } from "./limits";

type Props = {
  groupingMethod?: SmartUploadGroupingMethod;
  open: boolean;
  kind: SmartUploadKind;
  userId: string;
  scopeId?: string;
  clientSubmissionId?: string;
  resumeSessionId?: string;
  details: Record<string, unknown>;
  onClose: () => void;
  onSubmitted: (result: {
    message: string;
    reportId: string;
    jobId: string;
  }) => void | Promise<void>;
};

type UploadProgress = {
  uploadedBytes: number;
  totalBytes: number;
  uploadedFiles: number;
  totalFiles: number;
};

type OrderingReview = {
  strategy: SmartUploadOrderingStrategy;
  diagnostic: SmartUploadOrderingDiagnostic;
  changed: boolean;
  ambiguous: boolean;
  message: string;
};

const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const SEQUENCE_PAGE_SIZE = 12;
const GROUP_PAGE_SIZE = 6;
const LOT_PHOTO_PAGE_SIZE = 12;
const THUMBNAIL_SIZE = 256;

function isSupportedSmartUploadImage(file: File) {
  const mimeType = String(file.type || "").trim().toLowerCase();
  const hasSupportedExtension = ACCEPTED_EXTENSIONS.test(file.name);
  return (
    hasSupportedExtension &&
    (!mimeType ||
      mimeType === "application/octet-stream" ||
      ACCEPTED_MIME_TYPES.has(mimeType))
  );
}

function storedStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === "string"))
  );
}

function withPersistedOrderReview(
  details: Record<string, unknown>,
  unplacedDividerIds: string[],
  ambiguous: boolean
) {
  return {
    ...details,
    smart_upload_unplaced_divider_ids: [...unplacedDividerIds],
    smart_upload_order_ambiguous: ambiguous,
  };
}

function serverOrderReview(): OrderingReview {
  return {
    strategy: "preserved-selection",
    diagnostic: "filesystem-order-needs-review",
    changed: false,
    ambiguous: true,
    message:
      "This upload's original computer could not prove the image order. Check each detected lot before creating the preview.",
  };
}

function unresolvedDividerIdsFor(
  draft: SmartUploadDraft,
  grouping: SmartUploadGrouping
) {
  const availableFileIds = new Set(draft.files.map((file) => file.fileId));
  const detectedDividerIds = new Set(grouping.dividerFileIds);
  const persisted = storedStringArray(
    draft.details.smart_upload_unplaced_divider_ids
  );
  const serverUnresolved = grouping.unresolvedDividerIds || [];
  // Current servers persist the exact unresolved set. Only infer named
  // dividers for a legacy session that has no local or server-side set at all;
  // otherwise a refresh would re-add boundaries the user already resolved.
  const inferred =
    !grouping.hasOrderReviewState &&
    grouping.orderReviewRequired &&
    persisted.length === 0 &&
    serverUnresolved.length === 0
    ? draft.files
        .filter(
          (file) =>
            detectedDividerIds.has(file.fileId) &&
            isLikelySmartUploadDividerName(file.name)
        )
        .map((file) => file.fileId)
    : [];
  return Array.from(
    new Set([
      ...(grouping.hasOrderReviewState ? [] : persisted),
      ...serverUnresolved,
      ...inferred,
    ])
  ).filter(
    (fileId) => availableFileIds.has(fileId) && detectedDividerIds.has(fileId)
  );
}

function groupingReviewState(
  draft: SmartUploadDraft,
  grouping: SmartUploadGrouping
) {
  if (draft.details.smart_upload_grouping_method === "lot_number" && grouping.groupingMethod !== "lot_number") {
    throw new Error("This server has not confirmed Lot Number Upload support. Keep this upload and update the backend before continuing; no preview was submitted.");
  }
  const unplacedDividerIds = unresolvedDividerIdsFor(draft, grouping);
  const ambiguous =
    unplacedDividerIds.length > 0 ||
    grouping.orderReviewRequired ||
    (!grouping.hasOrderReviewState &&
      grouping.orderSource !== "groups" &&
      draft.details.smart_upload_order_ambiguous === true);
  return {
    unplacedDividerIds,
    ambiguous,
    details: withPersistedOrderReview(
      { ...draft.details, smart_upload_grouping_method: grouping.groupingMethod || "black_divider" },
      unplacedDividerIds,
      ambiguous
    ),
  };
}

function editGroupsForDivider(args: {
  draft: SmartUploadDraft;
  grouping: SmartUploadGrouping;
  fileId: string;
  adding: boolean;
}) {
  const groups = args.grouping.groups.map((group) => [...group.fileIds]);
  if (args.adding) {
    const groupIndex = groups.findIndex((group) => group.includes(args.fileId));
    const fileIndex = groups[groupIndex]?.indexOf(args.fileId) ?? -1;
    if (groupIndex < 0 || fileIndex < 0) return null;
    const before = groups[groupIndex].slice(0, fileIndex);
    const after = groups[groupIndex].slice(fileIndex + 1);
    // A divider is meaningful only when it separates report photos on both
    // sides. Never let a one-tap edge toggle silently delete a real photo.
    if (!before.length || !after.length) return null;
    groups.splice(groupIndex, 1, before, after);
    return {
      groups,
      focusLotIndex: Math.min(groupIndex, groups.length - 1),
    };
  }

  const sequence = args.draft.files.map((file) => file.fileId);
  const sequenceIndex = sequence.indexOf(args.fileId);
  if (sequenceIndex < 0) return null;
  const assigned = new Set(groups.flat());
  const previousId = sequence
    .slice(0, sequenceIndex)
    .reverse()
    .find((candidate) => assigned.has(candidate));
  const nextId = sequence
    .slice(sequenceIndex + 1)
    .find((candidate) => assigned.has(candidate));
  const previousGroupIndex = previousId
    ? groups.findIndex((group) => group.includes(previousId))
    : -1;
  const nextGroupIndex = nextId
    ? groups.findIndex((group) => group.includes(nextId))
    : -1;

  if (
    previousGroupIndex >= 0 &&
    nextGroupIndex >= 0 &&
    previousGroupIndex !== nextGroupIndex &&
    Math.abs(previousGroupIndex - nextGroupIndex) === 1
  ) {
    const firstIndex = Math.min(previousGroupIndex, nextGroupIndex);
    const secondIndex = Math.max(previousGroupIndex, nextGroupIndex);
    const merged =
      previousGroupIndex < nextGroupIndex
        ? [...groups[previousGroupIndex], args.fileId, ...groups[nextGroupIndex]]
        : [...groups[nextGroupIndex], args.fileId, ...groups[previousGroupIndex]];
    groups.splice(firstIndex, secondIndex - firstIndex + 1, merged);
    return { groups, focusLotIndex: firstIndex };
  }

  if (
    previousGroupIndex >= 0 &&
    previousGroupIndex === nextGroupIndex
  ) {
    const target = groups[previousGroupIndex];
    const previousPosition = previousId ? target.indexOf(previousId) : -1;
    const nextPosition = nextId ? target.indexOf(nextId) : -1;
    const insertAt =
      previousPosition >= 0
        ? previousPosition + 1
        : nextPosition >= 0
          ? nextPosition
          : target.length;
    target.splice(insertAt, 0, args.fileId);
    return { groups, focusLotIndex: previousGroupIndex };
  }

  const targetIndex =
    previousGroupIndex >= 0 ? previousGroupIndex : nextGroupIndex;
  if (targetIndex < 0) return { groups: [[args.fileId]], focusLotIndex: 0 };
  if (targetIndex === previousGroupIndex) groups[targetIndex].push(args.fileId);
  else groups[targetIndex].unshift(args.fileId);
  return { groups, focusLotIndex: targetIndex };
}

let thumbnailQueue: Promise<void> = Promise.resolve();

function withThumbnailSlot<T>(task: () => Promise<T>) {
  const result = thumbnailQueue.then(task, task);
  thumbnailQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function canvasBlob(canvas: HTMLCanvasElement) {
  const convert = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.72));
  return (await convert("image/webp")) || (await convert("image/jpeg"));
}

async function createThumbnailUrl(args: {
  file?: File;
  url?: string;
  signal: AbortSignal;
}) {
  if (typeof createImageBitmap !== "function") return null;
  if (args.signal.aborted) throw new DOMException("Cancelled", "AbortError");
  let source: Blob | undefined = args.file;
  if (!source && args.url) {
    const response = await fetch(args.url, { signal: args.signal });
    if (!response.ok) throw new Error("Unable to load preview image");
    source = await response.blob();
  }
  if (!source) return null;

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(source, {
      resizeWidth: THUMBNAIL_SIZE,
      resizeHeight: THUMBNAIL_SIZE,
      resizeQuality: "low",
    });
    if (args.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_SIZE;
    canvas.height = THUMBNAIL_SIZE;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    const thumbnail = await canvasBlob(canvas);
    return thumbnail ? URL.createObjectURL(thumbnail) : null;
  } finally {
    bitmap?.close();
  }
}

function newSubmissionId(kind: SmartUploadKind) {
  return globalThis.crypto?.randomUUID?.() ||
    `smart-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (value < 1024 * 1024) return `${Math.max(0, value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function ImagePreview({
  file,
  url,
  recoveryDraft,
  recoveryFile,
  alt,
  className,
}: {
  file?: File;
  url?: string;
  recoveryDraft?: Pick<SmartUploadDraft, "scope">;
  recoveryFile?: SmartUploadDraft["files"][number];
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!file && !url && (!recoveryDraft || !recoveryFile)) {
      setSrc("");
      return;
    }
    let disposed = false;
    let ownedUrl: string | null = null;
    const controller = new AbortController();
    let fallbackFile = file;
    setSrc("");
    void withThumbnailSlot(async () => {
      if (controller.signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      if (!fallbackFile && recoveryDraft && recoveryFile) {
        fallbackFile = await loadSmartUploadFile(recoveryDraft, recoveryFile);
      }
      if (controller.signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      return createThumbnailUrl({
        file: fallbackFile,
        url,
        signal: controller.signal,
      });
    })
      .then((next) => {
        if (disposed) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        if (next) {
          ownedUrl = next;
          setSrc(next);
          return;
        }
        if (url) setSrc(url);
        else if (fallbackFile) {
          ownedUrl = URL.createObjectURL(fallbackFile);
          setSrc(ownedUrl);
        }
      })
      .catch((thumbnailError) => {
        if (disposed || (thumbnailError as { name?: string })?.name === "AbortError") {
          return;
        }
        if (url) setSrc(url);
        else if (fallbackFile) {
          ownedUrl = URL.createObjectURL(fallbackFile);
          setSrc(ownedUrl);
        }
      });
    return () => {
      disposed = true;
      controller.abort();
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [file, recoveryDraft, recoveryFile, url]);
  return src ? (
    // A local object URL has no useful Next Image optimization path.

    <img
      src={src}
      alt={alt}
      className={className}
      draggable={false}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
    />
  ) : (
    <div className={className} aria-hidden="true" />
  );
}

function progressLabel(stage: SmartUploadDraft["stage"], numbered = false) {
  if (stage === "uploading") return "Uploading images";
  if (stage === "classifying") return numbered ? "Reading lot-number photos" : "Detecting black dividers";
  if (stage === "submitting") return "Creating preview";
  if (stage === "review") return "Review detected lots";
  if (stage === "failed") return "Smart Upload needs attention";
  return "Images ready to upload";
}

function attachGroupingUrls(
  files: SmartUploadDraft["files"],
  grouping: SmartUploadGrouping
) {
  const serverFiles = [
    ...(grouping.files || []),
    ...(grouping.groups || []).flatMap((group) => group.files || []),
  ];
  const serverFileById = new Map(
    serverFiles.map((file) => [file.fileId, file])
  );
  const canonicalOrderById = new Map(
    serverFiles.map((file, index) => [
      file.fileId,
      Number.isFinite(file.originalOrder) ? file.originalOrder : index,
    ])
  );
  return files
    .map(({ file: _file, ...descriptor }) => ({
      ...descriptor,
      originalOrder:
        canonicalOrderById.get(descriptor.fileId) ?? descriptor.originalOrder,
      url: descriptor.url || serverFileById.get(descriptor.fileId)?.url,
    }))
    .sort(
      (left, right) =>
        left.originalOrder - right.originalOrder ||
        left.fileId.localeCompare(right.fileId)
    );
}

export default function SmartUploadWorkspace({
  groupingMethod = "black_divider",
  open,
  kind,
  userId,
  scopeId,
  clientSubmissionId,
  resumeSessionId,
  details,
  onClose,
  onSubmitted,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draft, setDraft] = useState<SmartUploadDraft | null>(null);
  const [grouping, setGrouping] = useState<SmartUploadGrouping | null>(null);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState<number | null>(null);
  const [lotNumberEdit, setLotNumberEdit] = useState<{ key: string; value: string } | null>(null);
  const numbered = (grouping?.groupingMethod || draft?.details.smart_upload_grouping_method || groupingMethod) === "lot_number";
  const workspaceTitle = numbered ? "Lot Number Upload" : "Smart Upload";
  const hasUnsavedLotNumber = Boolean(numbered && lotNumberEdit && lotNumberEdit.value !== (grouping?.groups.find((group) => group.fileIds[0] === lotNumberEdit.key)?.lotNumber || ""));
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [sequencePage, setSequencePage] = useState(0);
  const [groupPage, setGroupPage] = useState(0);
  const [selectedLotIndex, setSelectedLotIndex] = useState(0);
  const [selectedLotPhotoPage, setSelectedLotPhotoPage] = useState(0);
  const [orderingReview, setOrderingReview] = useState<OrderingReview | null>(
    null
  );
  const [unplacedDividerIds, setUnplacedDividerIds] = useState<string[]>([]);
  const [selectedOrderAcknowledged, setSelectedOrderAcknowledged] =
    useState(false);
  const [dividerBeingPlaced, setDividerBeingPlaced] = useState<string | null>(
    null
  );
  const [groupingNotice, setGroupingNotice] = useState<string | null>(null);
  const [previousGrouping, setPreviousGrouping] = useState<{
    groups: SmartUploadGrouping["groups"];
    dividerFileIds: string[];
    unplacedDividerIds: string[];
    orderingAmbiguous: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [checkingCompletion, setCheckingCompletion] = useState(false);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const [completionReviewAvailable, setCompletionReviewAvailable] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadLockRef = useRef(false);
  const completionLockRef = useRef(false);
  const detailsRef = useRef(details);
  detailsRef.current = { ...details, smart_upload_grouping_method: groupingMethod };
  const callbacksRef = useRef({ onSubmitted, onClose });
  callbacksRef.current = { onSubmitted, onClose };

  const finishCompletion = useCallback(async (result: SmartUploadCompletionResult, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    // Only confirmed server acceptance permits deletion of local recovery state.
    await deleteSmartUploadDraft(userId, kind, scopeId).catch(() => undefined);
    if (signal?.aborted) return;
    setDraft(null);
    setGrouping(null);
    setAcknowledgedRevision(null);
    setLotNumberEdit(null);
    try {
      await callbacksRef.current.onSubmitted(result);
    } catch {
      toast.warning("The report was accepted, but the dashboard did not refresh. Reload the dashboard to see it.");
      callbacksRef.current.onClose();
    }
  }, [kind, scopeId, userId]);

  const runCompletion = useCallback(async (sessionId: string, retry: boolean) => {
    if (completionLockRef.current) return;
    completionLockRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCheckingCompletion(true);
    setCompletionReviewAvailable(false);
    setError(null);
    setCompletionMessage("Your uploaded images and saved lot arrangement are retained. Checking the same preview request.");
    setDraft((current) => current ? { ...current, sessionId, stage: "submitting" } : current);
    try {
      // Persist before the request so a reload recovers this exact session.
      await updateSmartUploadDraft(userId, kind, { sessionId, stage: "submitting" }, scopeId);
      if (controller.signal.aborted) return;
      const operation = retry ? completeSmartUpload : recoverSmartUploadCompletion;
      const result = await operation(kind, sessionId, {
        signal: controller.signal,
        onStatus: (message) => { if (!controller.signal.aborted) setCompletionMessage(message); },
      });
      await finishCompletion(result, controller.signal);
    } catch (completionError) {
      if (controller.signal.aborted) return;
      const message = getSmartUploadError(completionError);
      setCompletionReviewAvailable(isSmartUploadCompletionPending(completionError) && (completionError as { reviewAvailable?: boolean }).reviewAvailable === true);
      setCompletionMessage(isSmartUploadCompletionPending(completionError)
        ? message
        : `${message} Your saved upload is retained. Retry this same preview request; do not re-upload your images.`);
    } finally {
      if (abortRef.current === controller) {
        completionLockRef.current = false;
        if (!controller.signal.aborted) setCheckingCompletion(false);
      }
    }
  }, [finishCompletion, kind, scopeId, userId]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setLoadingDraft(true);
    setAcknowledgedRevision(null);
    setLotNumberEdit(null);
    setError(null);
    setDraft(null);
    setGrouping(null);
    setOrderingReview(null);
    setUnplacedDividerIds([]);
    setSelectedOrderAcknowledged(false);
    setDividerBeingPlaced(null);
    setGroupingNotice(null);
    setPreviousGrouping(null);
    setCheckingCompletion(false);
    setCompletionMessage(null);
    setCompletionReviewAvailable(false);
    void loadSmartUploadDraft(userId, kind, scopeId)
      .then(async (saved) => {
        let restored = saved;
        let serverGrouping: SmartUploadGrouping | null = null;
        if (!restored && resumeSessionId) {
          // Server-only recovery must not mistake a classification job or a
          // placeholder report identifier for accepted preview generation.
          const status = await getSmartUploadCompletionStatus(kind, resumeSessionId).catch(() => null);
          if (cancelled) return;
          if (status?.accepted || status?.status === "preparing") {
            restored = await saveServerSmartUploadDraft({
              userId, kind, scopeId,
              clientSubmissionId: clientSubmissionId || newSubmissionId(kind),
              sessionId: resumeSessionId, details: detailsRef.current,
              stage: "submitting", files: [],
            });
          }
        }
        if (!restored && resumeSessionId) {
          serverGrouping = await getSmartUploadGrouping(kind, resumeSessionId);
          const serverFiles = [
            ...(serverGrouping.files || []),
            ...(serverGrouping.groups || []).flatMap(
              (group) => group.files || []
            ),
          ];
          const uniqueFiles = Array.from(
            new Map(serverFiles.map((file) => [file.fileId, file])).values()
          ).sort((left, right) => left.originalOrder - right.originalOrder);
          const stage =
            serverGrouping.groupingStatus === "review_ready" ||
            serverGrouping.groupingStatus === "confirmed"
              ? ("review" as const)
              : serverGrouping.groupingStatus === "classifying"
                ? ("classifying" as const)
                : serverGrouping.groupingStatus === "failed"
                  ? ("failed" as const)
                  : ("uploading" as const);
          restored = await saveServerSmartUploadDraft({
            userId,
            kind,
            scopeId,
            clientSubmissionId:
              clientSubmissionId || newSubmissionId(kind),
            sessionId: resumeSessionId,
            details: { ...detailsRef.current, smart_upload_grouping_method: serverGrouping.groupingMethod || "black_divider" },
            stage,
            files: uniqueFiles.map((file) => ({
              fileId: file.fileId,
              name: file.name,
              type: file.mimeType,
              size: file.size,
              lastModified: 0,
              originalOrder: file.originalOrder,
              // A server-only recovery of an interrupted upload has no local
              // source Blobs and the grouping payload does not identify which
              // individual objects were confirmed. Do not falsely mark every
              // file uploaded; the retry will explain that it must continue in
              // the original browser instead of trying to confirm missing R2
              // objects. Classification/review states have already verified all
              // source files server-side.
              uploaded: stage !== "uploading",
              url: file.url,
            })),
          });
        }
        if (cancelled || !restored) return;
        // Current form details win when a user resumes before upload. Once a
        // session exists the same client submission id keeps server retries safe.
        const resumed: SmartUploadDraft = {
          ...restored,
          details: { ...restored.details, ...detailsRef.current, smart_upload_grouping_method: restored.details.smart_upload_grouping_method || "black_divider" },
          // A browser close can interrupt an in-flight PUT. The server session
          // and confirmed files are reusable, so expose an explicit resume action.
          stage:
            restored.stage === "uploading" && !resumeSessionId
              ? ("failed" as const)
              : restored.stage,
        };
        setDraft(resumed);
        setSelectedOrderAcknowledged(
          resumed.details.smart_upload_order_acknowledged === true ||
            resumed.stage !== "selected"
        );
        const restoredDiagnostic = resumed.details
          ?.smart_upload_order_diagnostic;
        const restoredStrategy = resumed.details?.smart_upload_order_strategy;
        if (
          typeof restoredDiagnostic === "string" &&
          typeof restoredStrategy === "string"
        ) {
          setOrderingReview({
            strategy: restoredStrategy as SmartUploadOrderingStrategy,
            diagnostic: restoredDiagnostic as SmartUploadOrderingDiagnostic,
            changed: resumed.details?.smart_upload_order_changed === true,
            ambiguous: resumed.details?.smart_upload_order_ambiguous === true,
            message:
              String(resumed.details?.smart_upload_order_message || "") ||
              "Review the image sequence before creating the report.",
          });
        }
        setUnplacedDividerIds(
          storedStringArray(
            resumed.details.smart_upload_unplaced_divider_ids
          ).filter((fileId) =>
            resumed.files.some((file) => file.fileId === fileId)
          )
        );
        setSequencePage(0);
        setGroupPage(0);
        setSelectedLotIndex(0);
        setSelectedLotPhotoPage(0);
        if (resumed.sessionId) {
          const completionStatus = resumed.stage === "submitting" ? null
            : await getSmartUploadCompletionStatus(kind, resumed.sessionId).catch(() => null);
          if (cancelled) return;
          if (resumed.stage === "submitting" || completionStatus?.accepted || completionStatus?.status === "preparing") {
            setLoadingDraft(false);
            await runCompletion(resumed.sessionId, false);
            return;
          }
          try {
            const result =
              serverGrouping ||
              (await getSmartUploadGrouping(kind, resumed.sessionId));
            if (!cancelled) {
              setGrouping(result);
              if (
                result.groupingStatus === "review_ready" ||
                result.groupingStatus === "confirmed"
              ) {
                const reviewFiles = attachGroupingUrls(resumed.files, result);
                const reviewDraft = {
                  ...resumed,
                  stage: "review" as const,
                  files: reviewFiles,
                };
                const reviewState = groupingReviewState(reviewDraft, result);
                setUnplacedDividerIds(reviewState.unplacedDividerIds);
                setOrderingReview((current) =>
                  reviewState.ambiguous
                    ? current
                      ? { ...current, ambiguous: true }
                      : serverOrderReview()
                    : current
                      ? { ...current, ambiguous: false }
                      : current
                );
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        stage: "review",
                        files: reviewFiles,
                        details: reviewState.details,
                      }
                    : current
                );
                await updateSmartUploadDraft(
                  userId,
                  kind,
                  {
                    stage: "review",
                    files: reviewFiles,
                    details: reviewState.details,
                  },
                  scopeId
                );
              } else if (result.groupingStatus === "classifying") {
                setDraft((current) =>
                  current ? { ...current, stage: "classifying" } : current
                );
                if (result.groupingMethod === "lot_number") setLoadingDraft(false);
                abortRef.current?.abort();
                const controller = new AbortController();
                abortRef.current = controller;
                const detected = await waitForSmartUploadGrouping({
                  kind,
                  sessionId: resumed.sessionId,
                  signal: controller.signal,
                  onProgress: (next) => {
                    if (!cancelled) setGrouping(next);
                  },
                });
                if (!cancelled) {
                  const reviewFiles = attachGroupingUrls(resumed.files, detected);
                  const reviewDraft = {
                    ...resumed,
                    stage: "review" as const,
                    files: reviewFiles,
                  };
                  const reviewState = groupingReviewState(reviewDraft, detected);
                  setGrouping(detected);
                  setUnplacedDividerIds(reviewState.unplacedDividerIds);
                  setOrderingReview((current) =>
                    reviewState.ambiguous
                      ? current
                        ? { ...current, ambiguous: true }
                        : serverOrderReview()
                      : current
                        ? { ...current, ambiguous: false }
                        : current
                  );
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          stage: "review",
                          files: reviewFiles,
                          details: reviewState.details,
                        }
                      : current
                  );
                  await updateSmartUploadDraft(
                    userId,
                    kind,
                    {
                      stage: "review",
                      files: reviewFiles,
                      details: reviewState.details,
                    },
                    scopeId
                  );
                }
              } else if (result.groupingStatus === "uploading") {
                setDraft((current) =>
                  current ? { ...current, stage: "failed" } : current
                );
                setError(
                  "The previous upload was interrupted. Resume to upload only the remaining images."
                );
                await updateSmartUploadDraft(
                  userId,
                  kind,
                  { stage: "failed" },
                  scopeId
                );
              } else if (result.groupingStatus === "failed") {
                setDraft((current) =>
                  current ? { ...current, stage: "failed" } : current
                );
                setError(
                  result.error ||
                    "Black-image detection failed. Resume to retry the same upload."
                );
                await updateSmartUploadDraft(
                  userId,
                  kind,
                  { stage: "failed" },
                  scopeId
                );
              }
            }
          } catch (resumeError) {
            if (
              !cancelled &&
              (resumeError as { name?: string })?.name !== "AbortError"
            ) {
              setDraft((current) =>
                current ? { ...current, stage: "failed" } : current
              );
              setError(getSmartUploadError(resumeError));
            }
          }
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(getSmartUploadError(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoadingDraft(false);
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      completionLockRef.current = false;
    };
  }, [clientSubmissionId, kind, open, resumeSessionId, runCompletion, scopeId, userId]);

  const active =
    draft?.stage === "uploading" ||
    draft?.stage === "classifying" ||
    checkingCompletion ||
    Boolean(busyFileId);
  // A persisted session and the server's queued job receipt—not the local
  // classifying stage alone—prove that closing cannot interrupt transport.
  const canCloseWhileClassifying = Boolean(
    numbered &&
    !loadingDraft &&
    !checkingCompletion &&
    !busyFileId &&
    draft?.stage === "classifying" &&
    draft.sessionId === grouping?.sessionId &&
    grouping?.groupingMethod === "lot_number" &&
    grouping.groupingStatus === "classifying" &&
    grouping.classificationJobId &&
    grouping.expectedFileCount > 0 &&
    grouping.confirmedFileCount === grouping.expectedFileCount
  );
  const hasUnrecoverableLiveFiles = Boolean(
    draft?.files.some((file) => !file.uploaded && Boolean(file.file))
  );
  const localRecoveryUnavailable =
    draft?.details.smart_upload_local_recovery_available === false &&
    (draft.stage === "selected" ||
      draft.stage === "uploading" ||
      (draft.stage === "failed" && hasUnrecoverableLiveFiles));
  const selectionMustStayOpen =
    draft?.details.smart_upload_local_recovery_available === false &&
    (draft.stage === "selected" ||
      (draft.stage === "failed" && hasUnrecoverableLiveFiles));
  const selectionReviewRequired =
    draft?.stage === "selected" &&
    orderingReview?.ambiguous === true &&
    !selectedOrderAcknowledged;

  const requestClose = useCallback(() => {
    if ((active && !canCloseWhileClassifying) || selectionMustStayOpen) {
      setError(
        selectionMustStayOpen
          ? "This browser could not store a recovery copy. Upload or discard these selected files before closing Smart Upload."
          : numbered
            ? "Keep Lot Number Upload open until every image is uploaded and processing is confirmed."
            : "Smart Upload is still working. Wait for this step to finish before closing."
      );
      return;
    }
    // Stop this window's polling only. Never cancel the durable server job or
    // remove the saved session that the user will reopen for explicit review.
    if (canCloseWhileClassifying) abortRef.current?.abort();
    onClose();
  }, [active, canCloseWhileClassifying, numbered, onClose, selectionMustStayOpen]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!open || ((!active || canCloseWhileClassifying) && !selectionMustStayOpen)) return;
    const preventAccidentalNavigation = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalNavigation);
    return () => {
      window.removeEventListener("beforeunload", preventAccidentalNavigation);
    };
  }, [active, canCloseWhileClassifying, open, selectionMustStayOpen]);

  const fileById = useMemo(
    () => new Map((draft?.files || []).map((item) => [item.fileId, item])),
    [draft?.files]
  );
  const dividerSet = useMemo(
    () => new Set(grouping?.dividerFileIds || []),
    [grouping?.dividerFileIds]
  );
  const serverFileById = useMemo(() => {
    const files = [
      ...(grouping?.files || []),
      ...(grouping?.groups || []).flatMap((group) => group.files || []),
    ];
    return new Map(files.map((file) => [file.fileId, file]));
  }, [grouping]);
  const visibleFiles = useMemo(
    () =>
      (draft?.files || []).slice(
        sequencePage * SEQUENCE_PAGE_SIZE,
        (sequencePage + 1) * SEQUENCE_PAGE_SIZE
      ),
    [draft?.files, sequencePage]
  );
  const visibleGroups = useMemo(
    () =>
      (grouping?.groups || []).slice(
        groupPage * GROUP_PAGE_SIZE,
        (groupPage + 1) * GROUP_PAGE_SIZE
      ),
    [groupPage, grouping?.groups]
  );
  const selectedGroup = grouping?.groups[selectedLotIndex];
  const selectedGroupFiles = useMemo(
    () =>
      (selectedGroup?.fileIds || [])
        .map((fileId) => fileById.get(fileId))
        .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    [fileById, selectedGroup?.fileIds]
  );
  const visibleSelectedGroupFiles = useMemo(
    () =>
      selectedGroupFiles.slice(
        selectedLotPhotoPage * LOT_PHOTO_PAGE_SIZE,
        (selectedLotPhotoPage + 1) * LOT_PHOTO_PAGE_SIZE
      ),
    [selectedGroupFiles, selectedLotPhotoPage]
  );
  const hasIneffectiveDivider = Boolean(
    !numbered && grouping?.warnings.some((warning) =>
      /(first image|last image|consecutive|non-empty lots|cannot separate)/i.test(
        warning
      )
    )
  );
  const unreadableImages = useMemo(
    () =>
      (grouping?.metrics || []).filter(
        (metric) => Boolean(metric.error) && !dividerSet.has(metric.fileId)
      ),
    [dividerSet, grouping?.metrics]
  );

  useEffect(() => {
    const groupCount = grouping?.groups.length || 0;
    setSelectedLotIndex((current) =>
      groupCount ? Math.min(current, groupCount - 1) : 0
    );
    setGroupPage((current) =>
      groupCount
        ? Math.min(current, Math.ceil(groupCount / GROUP_PAGE_SIZE) - 1)
        : 0
    );
  }, [grouping?.groups.length]);

  const confirmSelectedOrder = useCallback(async () => {
    if (!draft || draft.stage !== "selected" || busyFileId) return;
    const nextDetails = withPersistedOrderReview(
      { ...draft.details, smart_upload_order_acknowledged: true },
      unplacedDividerIds,
      unplacedDividerIds.length > 0
    );
    setBusyFileId("order-confirmation");
    setError(null);
    try {
      await updateSmartUploadDraft(
        userId,
        kind,
        { details: nextDetails },
        scopeId
      );
      setSelectedOrderAcknowledged(true);
      setDraft((current) =>
        current ? { ...current, details: nextDetails } : current
      );
      setOrderingReview((current) =>
        current
          ? { ...current, ambiguous: unplacedDividerIds.length > 0 }
          : current
      );
      setGroupingNotice(
        orderingReview?.strategy === "manual"
          ? "Manual image order confirmed for divider detection."
          : "Suggested image order accepted for divider detection."
      );
    } catch (orderError) {
      setError(getSmartUploadError(orderError));
    } finally {
      setBusyFileId(null);
    }
  }, [
    busyFileId,
    draft,
    kind,
    orderingReview?.strategy,
    scopeId,
    unplacedDividerIds,
    userId,
  ]);

  useEffect(() => {
    setSelectedLotPhotoPage(0);
  }, [selectedLotIndex]);

  useEffect(() => {
    const lastPage = Math.max(
      0,
      Math.ceil(selectedGroupFiles.length / LOT_PHOTO_PAGE_SIZE) - 1
    );
    setSelectedLotPhotoPage((current) => Math.min(current, lastPage));
  }, [selectedGroupFiles.length]);

  const moveSelectedFile = useCallback(
    async (fileId: string, direction: -1 | 1) => {
      if (!draft || draft.stage !== "selected" || busyFileId) return;
      const sourceIndex = draft.files.findIndex((file) => file.fileId === fileId);
      const targetIndex = sourceIndex + direction;
      if (
        sourceIndex < 0 ||
        targetIndex < 0 ||
        targetIndex >= draft.files.length
      ) {
        return;
      }

      const reordered = [...draft.files];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      const normalized = reordered.map((file, originalOrder) => ({
        ...file,
        originalOrder,
      }));
      const nextMessage =
        "You changed the sequence manually. Check the numbered thumbnails, then confirm this order before upload.";
      const nextDetails = {
        ...draft.details,
        smart_upload_order_strategy: "manual",
        smart_upload_order_diagnostic: "manual-order-needs-confirmation",
        smart_upload_order_changed: true,
        smart_upload_order_ambiguous: true,
        smart_upload_order_acknowledged: false,
        smart_upload_order_message: nextMessage,
      };
      const storedFiles = normalized.map(({ file: _file, ...descriptor }) =>
        descriptor
      );

      setBusyFileId(fileId);
      setError(null);
      setGroupingNotice(null);
      try {
        await updateSmartUploadDraft(
          userId,
          kind,
          { files: storedFiles, details: nextDetails },
          scopeId
        );
        setDraft((current) =>
          current?.stage === "selected"
            ? { ...current, files: normalized, details: nextDetails }
            : current
        );
        setOrderingReview({
          strategy: "manual",
          diagnostic: "manual-order-needs-confirmation",
          changed: true,
          ambiguous: true,
          message: nextMessage,
        });
        setSelectedOrderAcknowledged(false);
        setSequencePage(Math.floor(targetIndex / SEQUENCE_PAGE_SIZE));
      } catch (orderError) {
        setError(getSmartUploadError(orderError));
      } finally {
        setBusyFileId(null);
      }
    },
    [busyFileId, draft, kind, scopeId, userId]
  );

  const selectFiles = useCallback(
    async (selected: File[]) => {
      if (!selected.length || !userId) return;
      if (selected.length > SMART_UPLOAD_MAX_FILES) {
        setError(
          `Select no more than ${SMART_UPLOAD_MAX_FILES.toLocaleString("en-US")} images in one Smart Upload.`
        );
        return;
      }
      const invalid = selected.find(
        (file) => !isSupportedSmartUploadImage(file)
      );
      if (invalid) {
        setError(
          `${invalid.name} is not a supported JPEG, PNG, WebP, HEIC, or HEIF image.`
        );
        return;
      }
      const empty = selected.find((file) => file.size <= 0);
      if (empty) {
        setError(`${empty.name} is empty. Re-select the original image.`);
        return;
      }
      const oversized = selected.find(
        (file) => file.size > SMART_UPLOAD_MAX_FILE_BYTES
      );
      if (oversized) {
        setError(`${oversized.name} is larger than the 50 MB per-image limit.`);
        return;
      }
      const totalSize = selected.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > SMART_UPLOAD_MAX_TOTAL_BYTES) {
        setError(
          `This selection is larger than the ${formatBytes(SMART_UPLOAD_MAX_TOTAL_BYTES)} Smart Upload limit.`
        );
        return;
      }
      try {
        setError(null);
        setGrouping(null);
        setSelectedOrderAcknowledged(false);
        setSequencePage(0);
        setGroupPage(0);
        const resolvedOrder = resolveSmartUploadFileOrder(selected, { groupingMethod });
        const unresolvedDividerIds = groupingMethod !== "lot_number" && resolvedOrder.ambiguous
          ? resolvedOrder.files.flatMap((file, index) =>
              isLikelySmartUploadDividerName(file.name) ? [`images-${index}`] : []
            )
          : [];
        const orderDetails = {
          ...detailsRef.current,
          smart_upload_order_strategy: resolvedOrder.strategy,
          smart_upload_order_diagnostic: resolvedOrder.diagnostic,
          smart_upload_order_changed: resolvedOrder.changed,
          smart_upload_order_ambiguous: resolvedOrder.ambiguous,
          smart_upload_order_message: resolvedOrder.message,
          smart_upload_unplaced_divider_ids: unresolvedDividerIds,
        };
        const next = await createSmartUploadDraft({
          userId,
          kind,
          scopeId,
          clientSubmissionId: clientSubmissionId || newSubmissionId(kind),
          details: orderDetails,
          files: resolvedOrder.files,
        });
        setOrderingReview({
          strategy: resolvedOrder.strategy,
          diagnostic: resolvedOrder.diagnostic,
          changed: resolvedOrder.changed,
          ambiguous: resolvedOrder.ambiguous,
          message: resolvedOrder.message,
        });
        setUnplacedDividerIds(unresolvedDividerIds);
        setSelectedOrderAcknowledged(!resolvedOrder.ambiguous);
        setDraft(next);
        setProgress({
          uploadedBytes: 0,
          totalBytes: totalSize,
          uploadedFiles: 0,
          totalFiles: selected.length,
        });
      } catch (selectionError) {
        setError(getSmartUploadError(selectionError));
      }
    },
    [clientSubmissionId, groupingMethod, kind, scopeId, userId]
  );

  const runUploadAndDetection = useCallback(async () => {
    if (
      !draft ||
      (draft.stage !== "selected" && draft.stage !== "failed") ||
      uploadLockRef.current
    ) {
      return;
    }
    if (selectionReviewRequired || busyFileId) {
      setError("Review and confirm the numbered image sequence before uploading.");
      return;
    }
    uploadLockRef.current = true;
    try {
      setError(null);
      const session = await createOrResumeSmartUploadSession(draft);
      if (session.alreadyQueued && session.reportId) {
        // Server acceptance is authoritative. A browser storage cleanup error
        // must not strand this workspace or hide a report that is already in
        // the processing queue.
        await deleteSmartUploadDraft(userId, kind, scopeId).catch(
          () => undefined
        );
        setDraft(null);
        setGrouping(null);
        try {
          await onSubmitted({
            message: "This Smart Upload was already accepted.",
            reportId: session.reportId,
            jobId: session.jobId,
          });
        } catch {
          toast.warning(
            "The report was already accepted, but the dashboard did not refresh. Reload the dashboard to see it."
          );
          onClose();
        }
        return;
      }
      if (session.readyToComplete) {
        await runCompletion(session.sessionId, true);
        return;
      }

      const sessionDraft = {
        ...draft,
        sessionId: session.sessionId,
        stage: "uploading" as const,
      };
      setDraft(sessionDraft);
      await updateSmartUploadDraft(
        userId,
        kind,
        {
          sessionId: session.sessionId,
          stage: "uploading",
          details: { ...draft.details, ...detailsRef.current, smart_upload_grouping_method: draft.details.smart_upload_grouping_method || "black_divider" },
        },
        scopeId
      );

      let confirmedFiles = sessionDraft.files.map(
        ({ file: _file, ...descriptor }) => descriptor
      );
      await uploadSmartUploadFiles({
        draft: sessionDraft,
        session,
        onProgress: setProgress,
        onFilesConfirmed: async (files) => {
          confirmedFiles = files;
          await updateSmartUploadDraft(userId, kind, { files }, scopeId);
          const confirmedById = new Map(files.map((file) => [file.fileId, file.uploaded]));
          setDraft((current) =>
            current
              ? {
                  ...current,
                  files: current.files.map((item) => ({
                    ...item,
                    uploaded: confirmedById.get(item.fileId) || false,
                  })),
                }
              : current
          );
        },
      });

      // Once R2 has confirmed every object, the browser no longer needs its
      // high-resolution local copies. Release them before classification and
      // review so they cannot accumulate with decoded thumbnails.
      setDraft((current) =>
        current
          ? { ...current, stage: "classifying", files: confirmedFiles }
          : current
      );
      await updateSmartUploadDraft(
        userId,
        kind,
        { stage: "classifying", files: confirmedFiles },
        scopeId
      );
      await releaseSmartUploadMedia(userId, kind, scopeId).catch(
        () => undefined
      );
      const started = await startSmartUploadDetection(kind, session.sessionId);
      setError(null);
      setGrouping(started);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const detected = await waitForSmartUploadGrouping({
        kind,
        sessionId: session.sessionId,
        signal: controller.signal,
        onProgress: (next) => { if (!controller.signal.aborted) setGrouping(next); },
      });
      if (controller.signal.aborted) return;
      const reviewFiles = attachGroupingUrls(confirmedFiles, detected);
      const reviewDraft = {
        ...sessionDraft,
        stage: "review" as const,
        files: reviewFiles,
      };
      const reviewState = groupingReviewState(reviewDraft, detected);
      setGrouping(detected);
      setUnplacedDividerIds(reviewState.unplacedDividerIds);
      setOrderingReview((current) =>
        reviewState.ambiguous
          ? current
            ? { ...current, ambiguous: true }
            : serverOrderReview()
          : current
            ? { ...current, ambiguous: false }
            : current
      );
      setDraft((current) =>
        current
          ? {
              ...current,
              stage: "review",
              files: reviewFiles,
              details: reviewState.details,
            }
          : current
      );
      await updateSmartUploadDraft(
        userId,
        kind,
        {
          stage: "review",
          files: reviewFiles,
          details: reviewState.details,
        },
        scopeId
      );
    } catch (uploadError) {
      if ((uploadError as { name?: string })?.name === "AbortError") return;
      const message = getSmartUploadError(uploadError);
      setError(message);
      setDraft((current) =>
        current ? { ...current, stage: "failed" } : current
      );
      await updateSmartUploadDraft(
        userId,
        kind,
        { stage: "failed" },
        scopeId
      ).catch(() => undefined);
    } finally {
      uploadLockRef.current = false;
    }
  }, [
    busyFileId,
    draft,
    kind,
    onClose,
    onSubmitted,
    runCompletion,
    scopeId,
    selectionReviewRequired,
    userId,
  ]);

  const refreshLatestGrouping = useCallback(
    async (notice: string, requireReview = false, signal?: AbortSignal) => {
      if (!draft?.sessionId) return false;
      const latest = await getSmartUploadGrouping(kind, draft.sessionId);
      if (signal?.aborted) return false;
      if (requireReview && latest.groupingStatus !== "review_ready" && latest.groupingStatus !== "confirmed") {
        throw new Error("This saved upload is not ready for lot review. Keep the same session and check its status before continuing.");
      }
      const reviewFiles = attachGroupingUrls(draft.files, latest);
      const reviewDraft = {
        ...draft,
        stage: "review" as const,
        files: reviewFiles,
      };
      const reviewState = groupingReviewState(reviewDraft, latest);
      setGrouping(latest);
      setUnplacedDividerIds(reviewState.unplacedDividerIds);
      setOrderingReview((current) =>
        reviewState.ambiguous
          ? current
            ? { ...current, ambiguous: true }
            : serverOrderReview()
          : current
            ? { ...current, ambiguous: false }
            : current
      );
      setDraft((current) =>
        current
          ? {
              ...current,
              stage: "review",
              files: reviewFiles,
              details: reviewState.details,
            }
          : current
      );
      await updateSmartUploadDraft(
        userId,
        kind,
        {
          stage: "review",
          files: reviewFiles,
          details: reviewState.details,
        },
        scopeId
      );
      setPreviousGrouping(null);
      setGroupingNotice(notice);
      return true;
    },
    [draft, kind, scopeId, userId]
  );

  const returnToSavedReview = useCallback(async () => {
    if (!draft?.sessionId || completionLockRef.current || !completionReviewAvailable) return;
    completionLockRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setCheckingCompletion(true);
    try {
      // Another window may have queued this session since the last status check.
      const status = await getSmartUploadCompletionStatus(kind, draft.sessionId, controller.signal);
      if (controller.signal.aborted) return;
      if (status.accepted || status.status !== "ready") {
        setCompletionReviewAvailable(false);
        setCompletionMessage("The upload status changed. Check preview status again before editing its saved lot arrangement.");
        return;
      }
      await refreshLatestGrouping("The same saved lot arrangement is ready to review. No photos were uploaded again.", true, controller.signal);
    } catch (reviewError) {
      if (!controller.signal.aborted) setCompletionMessage(getSmartUploadError(reviewError));
    } finally {
      if (abortRef.current === controller) {
        completionLockRef.current = false;
        if (!controller.signal.aborted) setCheckingCompletion(false);
      }
    }
  }, [completionReviewAvailable, draft?.sessionId, kind, refreshLatestGrouping]);

  const recoverStaleGrouping = useCallback(
    async (updateError: unknown) => {
      if (getSmartUploadErrorCode(updateError) !== "SMART_UPLOAD_GROUPING_STALE") {
        return false;
      }
      try {
        await refreshLatestGrouping(
          "Another Smart Upload window changed these lots. The latest saved arrangement is now shown."
        );
        setError(null);
      } catch (refreshError) {
        setError(
          `The lot arrangement changed elsewhere, and it could not be refreshed: ${getSmartUploadError(
            refreshError
          )}`
        );
      }
      return true;
    },
    [refreshLatestGrouping]
  );

  const toggleDivider = useCallback(
    async (fileId: string) => {
      if (!draft?.sessionId || !grouping || busyFileId) return;
      const next = new Set(grouping.dividerFileIds);
      const adding = !next.has(fileId);
      if (adding) next.add(fileId);
      else next.delete(fileId);
      const edited = editGroupsForDivider({
        draft,
        grouping,
        fileId,
        adding,
      });
      if (!edited) {
        setError(
          adding
            ? "A divider needs report photos on both sides. Select an image between two groups instead."
            : "That divider could not be restored without losing the reviewed lot arrangement."
        );
        return;
      }
      const remaining = unplacedDividerIds.filter(
        (candidate) => candidate !== fileId
      );
      const ambiguous =
        remaining.length > 0 ||
        (orderingReview?.ambiguous === true &&
          !unplacedDividerIds.includes(fileId));
      setBusyFileId(fileId);
      setError(null);
      setPreviousGrouping({
        groups: grouping.groups.map((group) => ({
          ...group,
          fileIds: [...group.fileIds],
        })),
        dividerFileIds: [...grouping.dividerFileIds],
        unplacedDividerIds: [...unplacedDividerIds],
        orderingAmbiguous: orderingReview?.ambiguous === true,
      });
      try {
        const updated = await updateSmartUploadDividers({
          kind,
          sessionId: draft.sessionId,
          dividerFileIds: [...next],
          revision: grouping.revision,
          groups: edited.groups,
          orderReviewRequired: ambiguous,
          unresolvedDividerIds: remaining,
        });
        setGrouping(updated);
        const reviewFiles = attachGroupingUrls(draft.files, updated);
        const provisionalDetails = withPersistedOrderReview(
          draft.details,
          remaining,
          ambiguous
        );
        const reviewState = groupingReviewState(
          { ...draft, files: reviewFiles, details: provisionalDetails },
          updated
        );
        setDraft((current) =>
          current
            ? { ...current, files: reviewFiles, details: reviewState.details }
            : current
        );
        setUnplacedDividerIds(reviewState.unplacedDividerIds);
        setDividerBeingPlaced((current) =>
          current && reviewState.unplacedDividerIds.includes(current)
            ? current
            : null
        );
        setOrderingReview((current) =>
          reviewState.ambiguous
            ? current
              ? { ...current, ambiguous: true }
              : serverOrderReview()
            : current
              ? { ...current, ambiguous: false }
              : current
        );
        setSelectedLotIndex(edited.focusLotIndex);
        setGroupPage(Math.floor(edited.focusLotIndex / GROUP_PAGE_SIZE));
        setGroupingNotice(
          adding
            ? "Lot boundary updated."
            : "Divider removed and the neighbouring lots were joined."
        );
        // The server PATCH is the durable source of truth. A browser quota or
        // IndexedDB failure must not roll back, refetch, or visually resurrect
        // a boundary that the server has already committed.
        await updateSmartUploadDraft(
          userId,
          kind,
          { files: reviewFiles, details: reviewState.details },
          scopeId
        ).catch(() => {
          toast.warning(
            "The lot change was saved on the server, but this browser could not update its recovery copy. Keep this window open or resume from My Reports."
          );
        });
      } catch (updateError) {
        if (!(await recoverStaleGrouping(updateError))) {
          setPreviousGrouping(null);
          setError(getSmartUploadError(updateError));
        }
      } finally {
        setBusyFileId(null);
      }
    },
    [
      busyFileId,
      draft,
      grouping,
      kind,
      orderingReview?.ambiguous,
      recoverStaleGrouping,
      scopeId,
      unplacedDividerIds,
      userId,
    ]
  );

  const saveAuthoritativeGroups = useCallback(
    async (
      nextGroups: string[][],
      notice: string,
      focusLotIndex: number,
      options: {
        lotNumbers?: Array<string | undefined>;
        resolvedDividerId?: string;
        dividerFileIds?: string[];
        confirmOrder?: boolean;
        recordUndo?: boolean;
        restoreUnplacedDividerIds?: string[];
        restoreOrderingAmbiguous?: boolean;
      } = {}
    ) => {
      if (!draft?.sessionId || !grouping || busyFileId) return;
      setBusyFileId("grouping");
      setError(null);
      setGroupingNotice(null);
      if (options.recordUndo !== false) {
        setPreviousGrouping({
          groups: grouping.groups.map((group) => ({
            ...group,
            fileIds: [...group.fileIds],
          })),
          dividerFileIds: [...grouping.dividerFileIds],
          unplacedDividerIds: [...unplacedDividerIds],
          orderingAmbiguous: orderingReview?.ambiguous === true,
        });
      }
      const nextUnplacedDividerIds =
        options.restoreUnplacedDividerIds !== undefined
          ? [...options.restoreUnplacedDividerIds]
          : options.resolvedDividerId
            ? unplacedDividerIds.filter(
                (fileId) => fileId !== options.resolvedDividerId
              )
            : [...unplacedDividerIds];
      const nextOrderingAmbiguous =
        options.restoreUnplacedDividerIds !== undefined
          ? options.restoreOrderingAmbiguous === true
          : options.confirmOrder
            ? false
            : options.resolvedDividerId
              ? nextUnplacedDividerIds.length > 0
              : orderingReview?.ambiguous === true ||
                nextUnplacedDividerIds.length > 0;
      const provisionalDetails = withPersistedOrderReview(
        draft.details,
        nextUnplacedDividerIds,
        nextOrderingAmbiguous
      );
      try {
        const updated = await updateSmartUploadDividers({
          kind,
          sessionId: draft.sessionId,
          dividerFileIds:
            options.dividerFileIds || grouping.dividerFileIds,
          revision: grouping.revision,
          groups: numbered ? nextGroups.map((fileIds, index) => ({ fileIds, lotNumber: (options.lotNumbers ? options.lotNumbers[index] : grouping.groups[index]?.lotNumber) ?? "" })) : nextGroups,
          orderReviewRequired: nextOrderingAmbiguous,
          unresolvedDividerIds: nextUnplacedDividerIds,
        });
        setGrouping(updated);
        if (options.lotNumbers) setLotNumberEdit(null);
        const reviewFiles = attachGroupingUrls(draft.files, updated);
        const reviewState = groupingReviewState(
          { ...draft, files: reviewFiles, details: provisionalDetails },
          updated
        );
        setDraft((current) =>
          current
            ? { ...current, files: reviewFiles, details: reviewState.details }
            : current
        );
        setSelectedLotIndex(focusLotIndex);
        setGroupPage(Math.floor(focusLotIndex / GROUP_PAGE_SIZE));
        setUnplacedDividerIds(reviewState.unplacedDividerIds);
        setDividerBeingPlaced((current) =>
          current && reviewState.unplacedDividerIds.includes(current)
            ? current
            : null
        );
        setOrderingReview((current) =>
          reviewState.ambiguous
            ? current
              ? { ...current, ambiguous: true }
              : serverOrderReview()
            : current
              ? { ...current, ambiguous: false }
              : current
        );
        setGroupingNotice(notice);
        if (options.recordUndo === false) setPreviousGrouping(null);
        await updateSmartUploadDraft(
          userId,
          kind,
          { files: reviewFiles, details: reviewState.details },
          scopeId
        ).catch(() => {
          toast.warning(
            "The lot change was saved on the server, but this browser could not update its recovery copy. Keep this window open or resume from My Reports."
          );
        });
      } catch (groupError) {
        if (!(await recoverStaleGrouping(groupError))) {
          if (options.recordUndo !== false) setPreviousGrouping(null);
          setError(getSmartUploadError(groupError));
        }
      } finally {
        setBusyFileId(null);
      }
    },
    [
      busyFileId,
      draft,
      grouping,
      kind,
      numbered,
      orderingReview?.ambiguous,
      recoverStaleGrouping,
      scopeId,
      unplacedDividerIds,
      userId,
    ]
  );

  const excludeUnreadableImage = useCallback(
    (fileId: string) => {
      if (!grouping) return;
      const sourceLotIndex = grouping.groups.findIndex((group) =>
        group.fileIds.includes(fileId)
      );
      if (sourceLotIndex < 0) return;
      const nextGroups = grouping.groups
        .map((group) => group.fileIds.filter((candidate) => candidate !== fileId))
        .filter((group) => group.length > 0);
      if (!nextGroups.length) {
        setError("A report needs at least one readable image.");
        return;
      }
      const nextDividerIds = Array.from(
        new Set([...grouping.dividerFileIds, fileId])
      );
      void saveAuthoritativeGroups(
        nextGroups,
        `${fileById.get(fileId)?.name || "Unreadable image"} was excluded from the report.`,
        Math.min(sourceLotIndex, nextGroups.length - 1),
        {
          dividerFileIds: nextDividerIds,
          resolvedDividerId: unplacedDividerIds.includes(fileId)
            ? fileId
            : undefined,
        }
      );
    },
    [fileById, grouping, saveAuthoritativeGroups, unplacedDividerIds]
  );

  const splitLotBefore = useCallback(
    (
      lotIndex: number,
      fileIndex: number,
      resolvedDividerId?: string
    ) => {
      if (!grouping || fileIndex <= 0) return;
      const nextGroups = grouping.groups.map((group) => [...group.fileIds]);
      const source = nextGroups[lotIndex];
      if (!source || fileIndex >= source.length) return;
      const nextLot = source.splice(fileIndex);
      nextGroups.splice(lotIndex + 1, 0, nextLot);
      const lotNumbers = grouping.groups.map((group) => group.lotNumber);
      lotNumbers.splice(lotIndex + 1, 0, grouping.metrics.find((metric) => metric.fileId === nextLot[0])?.lotNumber || "");
      void saveAuthoritativeGroups(
        nextGroups,
        `Created Lot ${lotIndex + 2} with ${nextLot.length} photos.`,
        lotIndex + 1,
        { lotNumbers, ...(resolvedDividerId ? { resolvedDividerId } : {}) }
      );
    },
    [grouping, saveAuthoritativeGroups]
  );

  const movePhotoToNeighbour = useCallback(
    (lotIndex: number, fileId: string, direction: -1 | 1) => {
      if (!grouping) return;
      const targetIndex = lotIndex + direction;
      if (targetIndex < 0 || targetIndex >= grouping.groups.length) return;
      const nextGroups = grouping.groups.map((group) => [...group.fileIds]);
      const sourceIndex = nextGroups[lotIndex].indexOf(fileId);
      if (sourceIndex < 0 || nextGroups[lotIndex].length <= 1) return;
      nextGroups[lotIndex].splice(sourceIndex, 1);
      if (direction < 0) nextGroups[targetIndex].push(fileId);
      else nextGroups[targetIndex].unshift(fileId);
      void saveAuthoritativeGroups(
        nextGroups,
        `Moved the photo to Lot ${targetIndex + 1}.`,
        targetIndex
      );
    },
    [grouping, saveAuthoritativeGroups]
  );

  const placeUnresolvedDividerAfter = useCallback(
    (fileId: string) => {
      if (!draft || !grouping) return;
      const dividerIndex = draft.files.findIndex((file) => file.fileId === fileId);
      if (dividerIndex < 0) return;
      const candidateId = draft.files
        .slice(dividerIndex + 1)
        .find((file) => !grouping.dividerFileIds.includes(file.fileId))?.fileId;
      if (!candidateId) {
        setGroupingNotice(
          "This divider is at the end of the recovered sequence. In the mixed lot, choose the first photo that belongs to the next lot and select Start new lot here."
        );
        return;
      }
      const lotIndex = grouping.groups.findIndex((group) =>
        group.fileIds.includes(candidateId)
      );
      const fileIndex = grouping.groups[lotIndex]?.fileIds.indexOf(candidateId);
      if (lotIndex > 0 && fileIndex === 0) {
        void saveAuthoritativeGroups(
          grouping.groups.map((group) => [...group.fileIds]),
          `Confirmed the existing boundary before Lot ${lotIndex + 1}.`,
          lotIndex,
          { resolvedDividerId: fileId }
        );
        return;
      }
      if (lotIndex < 0 || fileIndex <= 0) {
        setGroupingNotice(
          "The folder placed this divider at an unusable edge. In the mixed lot, choose the first photo that belongs to the next lot and select Start new lot here."
        );
        return;
      }
      splitLotBefore(lotIndex, fileIndex, fileId);
    },
    [draft, grouping, saveAuthoritativeGroups, splitLotBefore]
  );

  const undoGroupingChange = useCallback(() => {
    if (!previousGrouping || !grouping) return;
    const snapshot = previousGrouping;
    void saveAuthoritativeGroups(
      snapshot.groups.map((group) => [...group.fileIds]),
      "Previous lot arrangement restored.",
      0,
      {
        recordUndo: false,
        dividerFileIds: snapshot.dividerFileIds,
        lotNumbers: snapshot.groups.map((group) => group.lotNumber),
        restoreUnplacedDividerIds: snapshot.unplacedDividerIds,
        restoreOrderingAmbiguous: snapshot.orderingAmbiguous,
      }
    );
  }, [grouping, previousGrouping, saveAuthoritativeGroups]);

  const createPreview = useCallback(async () => {
    if (!draft?.sessionId || !grouping || completionLockRef.current) return;
    if (
      !grouping.groups.length ||
      grouping.groups.some((group) => group.overLimit || !group.fileIds.length) ||
      grouping.metrics.some(
        (metric) => Boolean(metric.error) && !dividerSet.has(metric.fileId)
      ) ||
      (!numbered && grouping.warnings.some((warning) =>
        /(first image|last image|consecutive|non-empty lots|cannot separate)/i.test(
          warning
        )
      )) ||
      grouping.orderReviewRequired ||
      grouping.unresolvedDividerIds.length > 0 ||
      orderingReview?.ambiguous === true ||
      unplacedDividerIds.length > 0
      || (numbered && (acknowledgedRevision !== grouping.revision || grouping.warnings.length > 0 || grouping.groups.some((group) => !group.lotNumber?.trim())))
      || hasUnsavedLotNumber
    ) {
      setError("Resolve every image and lot-order warning before creating the preview.");
      return;
    }
    completionLockRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setCheckingCompletion(true);
    try {
      setError(null);
      setDraft((current) =>
        current ? { ...current, stage: "submitting" } : current
      );
      await updateSmartUploadDraft(
        userId,
        kind,
        { stage: "submitting" },
        scopeId
      );
      if (controller.signal.aborted) return;
      if (grouping.groupingStatus !== "confirmed") {
        const confirmed = await updateSmartUploadDividers({
          kind,
          sessionId: draft.sessionId,
          dividerFileIds: grouping.dividerFileIds,
          revision: grouping.revision,
          groups: grouping.groups.map((group) => numbered ? { fileIds: group.fileIds, lotNumber: group.lotNumber } : group.fileIds),
          acknowledgeLotNumberReview: numbered && acknowledgedRevision === grouping.revision,
          orderReviewRequired: false,
          unresolvedDividerIds: [],
          confirm: true,
        });
        if (controller.signal.aborted) return;
        setGrouping(confirmed);
      }
    } catch (submitError) {
      if (controller.signal.aborted) return;
      const message = getSmartUploadError(submitError);
      try {
        await refreshLatestGrouping(
          "The saved lot arrangement was recovered. Select Create preview again to retry safely."
        );
      } catch {
        setDraft((current) =>
          current ? { ...current, stage: "review" } : current
        );
        await updateSmartUploadDraft(
          userId,
          kind,
          { stage: "review" },
          scopeId
        ).catch(() => undefined);
      }
      setError(message);
      completionLockRef.current = false;
      setCheckingCompletion(false);
      return;
    }
    completionLockRef.current = false;
    await runCompletion(draft.sessionId, true);
  }, [
    draft?.sessionId,
    dividerSet,
    grouping,
    kind,
    numbered,
    acknowledgedRevision,
    hasUnsavedLotNumber,
    orderingReview?.ambiguous,
    refreshLatestGrouping,
    runCompletion,
    scopeId,
    unplacedDividerIds.length,
    userId,
  ]);

  const discard = useCallback(async () => {
    if (!draft || discarding || draft.stage === "submitting") return;
    setDiscarding(true);
    setError(null);
    try {
      abortRef.current?.abort();
      if (draft.sessionId) {
        await cancelSmartUpload(kind, draft.sessionId);
      }
      await deleteSmartUploadDraft(userId, kind, scopeId).catch((cleanupError) => {
        if (!draft.sessionId) throw cleanupError;
        // Once the server session is cancelled it cannot create a report. Do
        // not trap the user in a dead draft solely because local recovery
        // storage failed to delete.
        toast.warning(
          "The upload was cancelled, but this browser could not remove its local recovery copy."
        );
      });
      setDraft(null);
      setGrouping(null);
      setProgress(null);
    } catch (discardError) {
      setError(getSmartUploadError(discardError));
    } finally {
      setDiscarding(false);
    }
  }, [discarding, draft, kind, scopeId, userId]);

  if (!mounted || !open) return null;

  const totalBytes =
    progress?.totalBytes ||
    draft?.files.reduce((sum, item) => sum + item.size, 0) ||
    0;
  const uploadedBytes =
    progress?.uploadedBytes ||
    draft?.files.reduce(
      (sum, item) => sum + (item.uploaded ? item.size : 0),
      0
    ) ||
    0;
  const uploadPercent = totalBytes
    ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
    : 0;
  const stagePercent =
    draft?.stage === "classifying"
      ? grouping?.progressPercent || 0
      : draft?.stage === "review"
        ? 100
        : uploadPercent;
  const hasInvalidGroups =
    !grouping?.groups.length ||
    grouping.groups.some((group) => group.overLimit) ||
    hasIneffectiveDivider ||
    unreadableImages.length > 0 ||
    grouping.orderReviewRequired ||
    grouping.unresolvedDividerIds.length > 0 ||
    orderingReview?.ambiguous === true ||
    unplacedDividerIds.length > 0 ||
    (numbered && (acknowledgedRevision !== grouping?.revision || Boolean(grouping?.warnings.length) || grouping?.groups.some((group) => !group.lotNumber?.trim()) || hasUnsavedLotNumber));

  return createPortal(
    <div
      className="fixed inset-0 z-[1400] flex flex-col bg-[var(--app-bg)] text-[var(--app-text)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`smart-upload-${kind}-title`}
    >
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={requestClose}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-panel)] hover:bg-[var(--app-panel-alt)]"
            aria-label={`Close ${workspaceTitle}`}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h2
              id={`smart-upload-${kind}-title`}
              className="truncate text-lg font-bold sm:text-xl"
            >
              {workspaceTitle}
            </h2>
            <p className="truncate text-xs text-[var(--app-text-muted)] sm:text-sm">
              {numbered ? "A lot-number photo starts each lot and stays with its photos." : "Black images separate Bundle lots automatically."}
            </p>
          </div>
        </div>
        {draft ? (
          <button
            type="button"
            onClick={() => void discard()}
            disabled={active || discarding || draft.stage === "submitting"}
            aria-label="Discard upload"
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--app-danger-border)] px-3 text-sm font-semibold text-[var(--app-danger)] disabled:opacity-50"
          >
            {discarding ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Discard upload</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={requestClose}
            className="grid h-10 w-10 place-items-center rounded-md border border-[var(--app-control-border)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-5 sm:px-6 sm:py-6">
          {error ? (
            <div
              className="flex items-start justify-between gap-4 rounded-md border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-3 text-sm text-[var(--app-danger)]"
              role="alert"
            >
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {localRecoveryUnavailable ? (
            <div
              className="rounded-md border border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
              role="status"
            >
              <strong>Keep Smart Upload open until every image is uploaded.</strong>{" "}
              This browser does not have enough local storage for a recovery copy,
              but the current upload can continue safely from the selected files.
            </div>
          ) : null}

          {groupingNotice ? (
            <div
              className="flex items-center justify-between gap-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
              role="status"
              aria-live="polite"
            >
              <span>{groupingNotice}</span>
              {previousGrouping ? (
                <button
                  type="button"
                  onClick={undoGroupingChange}
                  disabled={Boolean(busyFileId)}
                  className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-emerald-400 px-3 font-bold disabled:opacity-50"
                >
                  <Undo2 className="h-4 w-4" />
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}

          {loadingDraft ? (
            <div className="grid min-h-[50vh] place-items-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--app-accent)]" />
                <p className="mt-3 text-sm text-[var(--app-text-muted)]">
                  Restoring Smart Upload...
                </p>
              </div>
            </div>
          ) : !draft ? (
            <section
              className={`grid min-h-[58vh] place-items-center rounded-lg border border-dashed px-5 py-12 text-center transition ${
                dragActive
                  ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)]"
                  : "border-[var(--app-control-border)] bg-[var(--app-panel)]"
              }`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                void selectFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <div className="max-w-xl">
                <div className="mx-auto grid h-16 w-16 place-items-center rounded-lg bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
                  <UploadCloud className="h-8 w-8" />
                </div>
                <h3 className="mt-5 text-2xl font-bold">Drop all lot images here</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--app-text-muted)]">
                  {numbered ? "Start every lot with its lot-number sign. All photos, including the signs, are kept. Review and correct lot numbers and boundaries before creating a preview. " : "Keep one black image between lots. "}Upload suggests an order
                  when a computer returns files in folder order, then asks you to
                  confirm anything that cannot be proved safely.
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                  multiple
                  hidden
                  onChange={(event) => {
                    void selectFiles(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-on-accent)] hover:brightness-95"
                >
                  <CloudUpload className="h-5 w-5" />
                  Select images
                </button>
                <p className="mt-4 text-xs text-[var(--app-text-muted)]">
                  JPEG, PNG, WebP, HEIC, and HEIF. Up to {SMART_UPLOAD_MAX_FILES.toLocaleString("en-US")} images, 50 MB
                  each, 20 GB total, and 200 report photos per detected lot.
                </p>
              </div>
            </section>
          ) : (
            <>
              <section className="grid gap-4 border-b border-[var(--app-border)] pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-2 rounded-md bg-[var(--app-accent-soft)] px-2.5 py-1 text-xs font-bold text-[var(--app-accent)]">
                      {active ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : draft.stage === "review" ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <ScanLine className="h-3.5 w-3.5" />
                      )}
                      {progressLabel(draft.stage, numbered)}
                    </span>
                    <span className="text-sm text-[var(--app-text-muted)]">
                      {draft.files.length ? `${draft.files.length.toLocaleString()} images - ${formatBytes(totalBytes)}` : "Saved server upload"}
                    </span>
                  </div>
                  <div
                    className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--app-control-border)]"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={draft.stage === "submitting" ? undefined : Math.round(stagePercent)}
                    aria-label={draft.stage === "submitting" ? "Preview request status" : "Upload progress"}
                  >
                    <div
                      className="h-full bg-[var(--app-accent)] transition-[width] duration-300"
                      style={{ width: `${Math.max(0, Math.min(100, stagePercent))}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-[var(--app-text-muted)]">
                    {draft.stage === "uploading"
                      ? `${progress?.uploadedFiles || 0} of ${draft.files.length} files confirmed - ${uploadPercent}% by bytes`
                      : draft.stage === "classifying"
                        ? `${Math.round(grouping?.progressPercent || 0)}% classified`
                        : draft.stage === "review"
                          ? `${grouping?.groups.length || 0} lots detected - ${numbered ? "all images retained" : `${grouping?.dividerFileIds.length || 0} dividers excluded`}`
                          : draft.stage === "submitting"
                            ? "Images uploaded. Waiting for preview processing to be confirmed."
                          : selectionReviewRequired
                            ? "Check the suggested image order before uploading"
                            : "Ready to upload in the confirmed order"}
                  </p>
                </div>
                {draft.stage === "selected" || draft.stage === "failed" ? (
                  <button
                    type="button"
                    onClick={() => void runUploadAndDetection()}
                    disabled={selectionReviewRequired || Boolean(busyFileId)}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-on-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ScanLine className="h-5 w-5" />
                    {draft.stage === "failed" ? "Resume upload" : "Upload & detect lots"}
                  </button>
                ) : null}
              </section>

              {canCloseWhileClassifying ? (
                <section aria-label="Background lot processing" className="flex flex-col gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm leading-6">
                    <p className="font-semibold">All images are uploaded. Lot-number processing will continue safely on the server.</p>
                    <p className="text-[var(--app-text-muted)]">You can close this window and reopen this saved upload from Drafts. Review the lots before creating a preview; it will not submit automatically.</p>
                  </div>
                  <button type="button" onClick={requestClose} className="min-h-11 shrink-0 rounded-md border border-[var(--app-control-border)] px-4 text-sm font-bold">Close and keep processing</button>
                </section>
              ) : null}

              {draft.stage === "submitting" ? (
                <section aria-label="Preview creation status" className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] p-4 sm:p-5">
                  <h3 className="text-lg font-bold">{checkingCompletion ? "Confirming preview creation" : "Preview status not yet confirmed"}</h3>
                  <p role="status" aria-live="polite" className="mt-2 text-sm leading-6 text-[var(--app-text-muted)]">
                    {completionMessage || "Saving the confirmed lot arrangement before queueing your preview."}
                  </p>
                  <p className="mt-2 text-sm leading-6">Keep this saved upload. Do not select or upload the same photos again. Your report will appear in the processing queue once accepted.</p>
                  {!checkingCompletion ? (
                    <>
                      <p className="mt-2 text-sm text-[var(--app-text-muted)]">You can close this window and return to the same Smart Upload to continue checking.</p>
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <button type="button" onClick={() => draft.sessionId && void runCompletion(draft.sessionId, false)} className="min-h-11 rounded-md bg-[var(--app-accent)] px-4 text-sm font-bold text-[var(--app-on-accent)]">Check preview status</button>
                        <button type="button" onClick={() => draft.sessionId && void runCompletion(draft.sessionId, true)} className="min-h-11 rounded-md border border-[var(--app-control-border)] px-4 text-sm font-bold">Retry preview creation</button>
                        {completionReviewAvailable ? <button type="button" onClick={() => void returnToSavedReview()} className="min-h-11 rounded-md border border-[var(--app-control-border)] px-4 text-sm font-bold">Return to saved review</button> : null}
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}

              {draft.stage !== "submitting" ? <>
              {orderingReview ? (
                <section
                  className={`rounded-md border px-4 py-3 ${
                    orderingReview.ambiguous
                      ? "border-amber-400 bg-amber-50 text-amber-950"
                      : "border-[var(--app-border)] bg-[var(--app-panel)]"
                  }`}
                  aria-label="Image order check"
                >
                  <div className="flex items-start gap-3">
                    <Clock className="mt-0.5 h-5 w-5 shrink-0" />
                    <div>
                      <p className="font-bold">
                        {orderingReview.ambiguous
                          ? "Confirm the lot boundary"
                          : orderingReview.changed
                            ? "Image order restored"
                            : "Image order preserved"}
                      </p>
                      <p className="mt-1 text-sm leading-6">
                        {orderingReview.message}
                      </p>
                      {selectionReviewRequired ? (
                        <button
                          type="button"
                          onClick={() => void confirmSelectedOrder()}
                          disabled={Boolean(busyFileId)}
                          className="mt-3 min-h-10 rounded-md border border-amber-500 px-3 text-sm font-bold"
                        >
                          {orderingReview.strategy === "manual"
                            ? "Confirm this image order"
                            : "Use this suggested order"}
                        </button>
                      ) : null}
                      {orderingReview.ambiguous &&
                      draft.stage === "review" &&
                      grouping &&
                      unplacedDividerIds.length === 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            void saveAuthoritativeGroups(
                              grouping.groups.map((group) => [
                                ...group.fileIds,
                              ]),
                              "Lot order confirmed.",
                              selectedLotIndex,
                              { confirmOrder: true }
                            )
                          }
                          disabled={Boolean(busyFileId)}
                          className="mt-3 min-h-10 rounded-md border border-amber-500 px-3 text-sm font-bold"
                        >
                          I checked the lot order
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {unreadableImages.length > 0 ? (
                <section
                  className="rounded-md border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-3 text-[var(--app-danger)]"
                  role="alert"
                >
                  <p className="font-bold">
                    {unreadableImages.length === 1
                      ? "One image could not be checked"
                      : `${unreadableImages.length} images could not be checked`}
                  </p>
                  <p className="mt-1 text-sm leading-6">
                    {numbered ? "One or more originals could not be read. Keep your original files and replace unreadable images before starting a new upload; no image will be silently removed." : "Smart Upload will not put an unreadable image into a report. Exclude it below, or discard this upload and re-select a replacement image."}
                  </p>
                  <ul className="mt-3 grid gap-2 text-sm">
                    {unreadableImages.slice(0, 10).map((metric) => (
                      <li
                        key={metric.fileId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--app-danger-border)] bg-[var(--app-panel)] px-3 py-2"
                      >
                        <span className="min-w-0 break-all font-semibold">
                          {fileById.get(metric.fileId)?.name || metric.fileId}
                        </span>
                        {!numbered ? <button
                          type="button"
                          onClick={() => excludeUnreadableImage(metric.fileId)}
                          disabled={Boolean(busyFileId)}
                          className="min-h-10 shrink-0 rounded-md border border-[var(--app-danger-border)] px-3 font-bold disabled:opacity-50"
                        >
                          Exclude from report
                        </button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {draft.stage === "selected" ? (
                <section aria-labelledby="selected-sequence-heading">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3
                        id="selected-sequence-heading"
                        className="text-lg font-bold"
                      >
                        Check upload sequence
                      </h3>
                      <p className="mt-1 text-sm text-[var(--app-text-muted)]">
                        The numbers below are the exact order Smart Upload will use.
                        Move any misplaced photo or divider, then confirm the final
                        sequence above.
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-[var(--app-text-muted)]">
                      {draft.files.length} image{draft.files.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                    {visibleFiles.map((item) => {
                      const absoluteIndex = draft.files.findIndex(
                        (file) => file.fileId === item.fileId
                      );
                      const isBusy = busyFileId === item.fileId;
                      return (
                        <article
                          key={item.fileId}
                          className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-panel)]"
                        >
                          <div className="relative aspect-square bg-[var(--app-panel-alt)]">
                            <ImagePreview
                              file={item.file}
                              url={item.url}
                              recoveryDraft={draft}
                              recoveryFile={item}
                              alt={item.name}
                              className="h-full w-full object-cover"
                            />
                            <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-xs font-bold text-white">
                              {absoluteIndex + 1}
                            </span>
                            {isLikelySmartUploadDividerName(item.name) ? (
                              <span className="absolute inset-x-1 top-1 rounded bg-amber-500 px-1 py-1 text-center text-[10px] font-bold uppercase text-black">
                                Possible divider
                              </span>
                            ) : null}
                            {isBusy ? (
                              <span className="absolute inset-0 grid place-items-center bg-black/45 text-white">
                                <Loader2 className="h-5 w-5 animate-spin" />
                              </span>
                            ) : null}
                          </div>
                          <p className="truncate px-2 pt-2 text-xs" title={item.name}>
                            {item.name}
                          </p>
                          <div className="grid grid-cols-2 gap-1 p-2">
                            <button
                              type="button"
                              onClick={() => void moveSelectedFile(item.fileId, -1)}
                              disabled={Boolean(busyFileId) || absoluteIndex <= 0}
                              className="inline-flex min-h-9 items-center justify-center gap-1 rounded border border-[var(--app-control-border)] px-2 text-xs font-semibold disabled:opacity-40"
                              aria-label={`Move ${item.name} earlier`}
                            >
                              <ArrowLeft className="h-3.5 w-3.5" />
                              Earlier
                            </button>
                            <button
                              type="button"
                              onClick={() => void moveSelectedFile(item.fileId, 1)}
                              disabled={
                                Boolean(busyFileId) ||
                                absoluteIndex >= draft.files.length - 1
                              }
                              className="inline-flex min-h-9 items-center justify-center gap-1 rounded border border-[var(--app-control-border)] px-2 text-xs font-semibold disabled:opacity-40"
                              aria-label={`Move ${item.name} later`}
                            >
                              Later
                              <ArrowRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {draft.files.length > SEQUENCE_PAGE_SIZE ? (
                    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setSequencePage((current) => Math.max(0, current - 1))
                        }
                        disabled={sequencePage === 0 || Boolean(busyFileId)}
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Previous images
                      </button>
                      <span className="text-center text-[var(--app-text-muted)]">
                        Images {sequencePage * SEQUENCE_PAGE_SIZE + 1}-
                        {Math.min(
                          (sequencePage + 1) * SEQUENCE_PAGE_SIZE,
                          draft.files.length
                        )} of {draft.files.length}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSequencePage((current) =>
                            Math.min(
                              Math.ceil(draft.files.length / SEQUENCE_PAGE_SIZE) - 1,
                              current + 1
                            )
                          )
                        }
                        disabled={
                          Boolean(busyFileId) ||
                          (sequencePage + 1) * SEQUENCE_PAGE_SIZE >=
                            draft.files.length
                        }
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Next images
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {grouping?.groups.length ? (
                <section aria-labelledby="detected-lots-heading">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 id="detected-lots-heading" className="text-lg font-bold">
                        Detected lots
                      </h3>
                      <p className="mt-1 text-sm text-[var(--app-text-muted)]">
                        Select a lot to inspect its photos and boundaries.
                      </p>
                    </div>
                    <span className="text-sm font-semibold">
                      {grouping.groups.length} lot
                      {grouping.groups.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleGroups.map((group) => {
                      const coverFileId =
                        group.coverFileId ||
                        group.fileIds?.[0] ||
                        group.files?.[0]?.fileId;
                      const item = coverFileId ? fileById.get(coverFileId) : undefined;
                      const serverFile = coverFileId
                        ? serverFileById.get(coverFileId)
                        : undefined;
                      return (
                        <button
                          key={group.groupIndex}
                          type="button"
                          onClick={() => {
                            if (hasUnsavedLotNumber) { setError("Save the edited lot number before switching lots."); return; }
                            setSelectedLotIndex(group.groupIndex);
                          }}
                          aria-pressed={selectedLotIndex === group.groupIndex}
                          className={`w-full overflow-hidden rounded-md border bg-[var(--app-panel)] text-left ${
                            group.overLimit
                              ? "border-[var(--app-danger)]"
                              : selectedLotIndex === group.groupIndex
                                ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent-ring)]"
                                : "border-[var(--app-border)]"
                          }`}
                        >
                          <div className="h-28 bg-[var(--app-panel-alt)]">
                            {item || serverFile ? (
                              <ImagePreview
                                file={item?.file}
                                url={item?.url || serverFile?.url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : null}
                          </div>
                          <div className="flex items-center justify-between gap-3 px-3 py-3">
                            <div>
                              <p className="font-bold">Lot {numbered ? group.lotNumber || "— number needed" : group.groupIndex + 1}</p>
                              <p className="text-xs text-[var(--app-text-muted)]">
                                {group.imageCount} photos - Bundle
                              </p>
                            </div>
                            {group.overLimit ? (
                              <span className="rounded bg-[var(--app-danger-soft)] px-2 py-1 text-xs font-bold text-[var(--app-danger)]">
                                Split lot
                              </span>
                            ) : (
                              <Check className="h-5 w-5 text-emerald-600" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {grouping.groups.length > GROUP_PAGE_SIZE ? (
                    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setGroupPage((current) => Math.max(0, current - 1))}
                        disabled={groupPage === 0}
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Previous lots
                      </button>
                      <span className="text-[var(--app-text-muted)]">
                        Lots {groupPage * GROUP_PAGE_SIZE + 1}-
                        {Math.min((groupPage + 1) * GROUP_PAGE_SIZE, grouping.groups.length)} of{" "}
                        {grouping.groups.length}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setGroupPage((current) =>
                            Math.min(
                              Math.ceil(grouping.groups.length / GROUP_PAGE_SIZE) - 1,
                              current + 1
                            )
                          )
                        }
                        disabled={(groupPage + 1) * GROUP_PAGE_SIZE >= grouping.groups.length}
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Next lots
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {grouping && selectedGroup ? (
                <section
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4 sm:p-5"
                  aria-labelledby="selected-lot-heading"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 id="selected-lot-heading" className="text-lg font-bold">
                        Lot {numbered ? selectedGroup.lotNumber || "— number needed" : selectedLotIndex + 1} - {selectedGroup.imageCount} photos
                      </h3>
                      <p className="mt-1 text-sm text-[var(--app-text-muted)]">
                        {numbered ? "The first photo starts this lot. Correct boundaries by splitting or joining lots; image order is preserved." : "Check this lot only. If a neighbour photo slipped across the boundary, move it with one tap."}
                      </p>
                    </div>
                    <span className="rounded-md bg-[var(--app-accent-soft)] px-3 py-1 text-xs font-bold text-[var(--app-accent)]">
                      Reviewing {selectedLotIndex + 1} of {grouping.groups.length}
                    </span>
                  </div>
                  {numbered ? <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <label className="grid gap-1 text-sm font-semibold" htmlFor="smart-lot-number">Lot number
                      <input id="smart-lot-number" maxLength={32} className="app-field min-h-11 w-full sm:w-48"
                        value={lotNumberEdit?.key === selectedGroup.fileIds[0] ? lotNumberEdit.value : selectedGroup.lotNumber || ""}
                        placeholder="Enter the sign number" disabled={Boolean(busyFileId)}
                        onChange={(event) => setLotNumberEdit({ key: selectedGroup.fileIds[0], value: event.target.value })} />
                    </label>
                    <button type="button" disabled={Boolean(busyFileId) || lotNumberEdit?.key !== selectedGroup.fileIds[0]}
                      className="min-h-11 rounded-md border border-[var(--app-control-border)] px-3 text-sm font-semibold disabled:opacity-40"
                      onClick={() => {
                        const lotNumbers = grouping.groups.map((group, index) => index === selectedLotIndex ? lotNumberEdit?.value.trim() || "" : group.lotNumber);
                        void saveAuthoritativeGroups(grouping.groups.map((group) => [...group.fileIds]), "Lot number saved. Review the updated arrangement before creating the preview.", selectedLotIndex, { lotNumbers });
                      }}>Save lot number</button>
                    {selectedLotIndex > 0 ? <button type="button" disabled={Boolean(busyFileId) || hasUnsavedLotNumber || selectedGroup.imageCount + grouping.groups[selectedLotIndex - 1].imageCount > 200}
                      className="min-h-11 rounded-md border border-[var(--app-control-border)] px-3 text-sm font-semibold disabled:opacity-40"
                      onClick={() => {
                        const groups = grouping.groups.map((group) => [...group.fileIds]);
                        const lotNumbers = grouping.groups.map((group) => group.lotNumber);
                        groups[selectedLotIndex - 1].push(...groups[selectedLotIndex]);
                        groups.splice(selectedLotIndex, 1);
                        lotNumbers.splice(selectedLotIndex, 1);
                        void saveAuthoritativeGroups(groups, "Joined with the previous lot. All images were retained.", selectedLotIndex - 1, { lotNumbers });
                      }}>Join previous lot</button> : null}
                  </div> : null}
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {visibleSelectedGroupFiles.map((item, visibleFileIndex) => {
                      const fileIndex =
                        selectedLotPhotoPage * LOT_PHOTO_PAGE_SIZE +
                        visibleFileIndex;
                      return (
                      <article
                        key={item.fileId}
                        className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)]"
                      >
                        <div className="aspect-square">
                          <ImagePreview
                            file={item.file}
                            url={item.url || serverFileById.get(item.fileId)?.url}
                            alt={`Lot ${selectedLotIndex + 1}, photo ${fileIndex + 1}`}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="grid gap-2 p-2">
                          {fileIndex > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                splitLotBefore(
                                  selectedLotIndex,
                                  fileIndex,
                                  dividerBeingPlaced ||
                                    (unplacedDividerIds.length === 1
                                      ? unplacedDividerIds[0]
                                      : undefined)
                                )
                              }
                              disabled={Boolean(busyFileId) || hasUnsavedLotNumber}
                              className="min-h-10 rounded-md border border-[var(--app-control-border)] px-2 text-xs font-bold disabled:opacity-50"
                            >
                              Start new lot here
                            </button>
                          ) : null}
                          {!numbered ? <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                movePhotoToNeighbour(
                                  selectedLotIndex,
                                  item.fileId,
                                  -1
                                )
                              }
                              disabled={
                                Boolean(busyFileId) ||
                                selectedLotIndex === 0 ||
                                (grouping.groups[selectedLotIndex - 1]?.imageCount || 0) >=
                                  200 ||
                                selectedGroup.fileIds.length <= 1
                              }
                              className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-[var(--app-control-border)] px-2 text-xs font-bold disabled:opacity-40"
                              aria-label={`Move photo ${fileIndex + 1} to previous lot`}
                            >
                              <ArrowLeft className="h-3.5 w-3.5" />
                              Previous
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                movePhotoToNeighbour(
                                  selectedLotIndex,
                                  item.fileId,
                                  1
                                )
                              }
                              disabled={
                                Boolean(busyFileId) ||
                                selectedLotIndex >= grouping.groups.length - 1 ||
                                (grouping.groups[selectedLotIndex + 1]?.imageCount || 0) >=
                                  200 ||
                                selectedGroup.fileIds.length <= 1
                              }
                              className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-[var(--app-control-border)] px-2 text-xs font-bold disabled:opacity-40"
                              aria-label={`Move photo ${fileIndex + 1} to next lot`}
                            >
                              Next
                              <ArrowRight className="h-3.5 w-3.5" />
                            </button>
                          </div> : null}
                        </div>
                      </article>
                      );
                    })}
                  </div>
                  {selectedGroupFiles.length > LOT_PHOTO_PAGE_SIZE ? (
                    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedLotPhotoPage((current) =>
                            Math.max(0, current - 1)
                          )
                        }
                        disabled={selectedLotPhotoPage === 0}
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-3 font-semibold disabled:opacity-40"
                      >
                        Previous photos
                      </button>
                      <span className="text-center text-[var(--app-text-muted)]">
                        Photos {selectedLotPhotoPage * LOT_PHOTO_PAGE_SIZE + 1}-
                        {Math.min(
                          (selectedLotPhotoPage + 1) * LOT_PHOTO_PAGE_SIZE,
                          selectedGroupFiles.length
                        )} of {selectedGroupFiles.length}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedLotPhotoPage((current) =>
                            Math.min(
                              Math.ceil(
                                selectedGroupFiles.length / LOT_PHOTO_PAGE_SIZE
                              ) - 1,
                              current + 1
                            )
                          )
                        }
                        disabled={
                          (selectedLotPhotoPage + 1) * LOT_PHOTO_PAGE_SIZE >=
                          selectedGroupFiles.length
                        }
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-3 font-semibold disabled:opacity-40"
                      >
                        Next photos
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {unplacedDividerIds.length && grouping ? (
                <section className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-amber-950">
                  <h3 className="font-bold">
                    {unplacedDividerIds.length === 1
                      ? "One boundary needs your confirmation"
                      : `${unplacedDividerIds.length} boundaries need your confirmation`}
                  </h3>
                  <p className="mt-1 text-sm leading-6">
                    The browser could not prove this file sequence. If a detected
                    boundary is already correct, confirm its current position. If two
                    lots are mixed, choose the first photo belonging to the next lot
                    above and use <strong>Start new lot here</strong>.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {unplacedDividerIds.map((fileId) => (
                      <div key={fileId} className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => placeUnresolvedDividerAfter(fileId)}
                          disabled={Boolean(busyFileId)}
                          className="min-h-10 rounded-md border border-amber-500 px-3 text-sm font-bold disabled:opacity-50"
                        >
                          Confirm current position: {fileById.get(fileId)?.name || fileId}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDividerBeingPlaced(fileId);
                            setGroupingNotice(
                              `Choose the first report photo after ${fileById.get(fileId)?.name || fileId}, then select Start new lot here.`
                            );
                          }}
                          disabled={Boolean(busyFileId)}
                          aria-pressed={dividerBeingPlaced === fileId}
                          className={`min-h-10 rounded-md border px-3 text-sm font-bold disabled:opacity-50 ${
                            dividerBeingPlaced === fileId
                              ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-on-accent)]"
                              : "border-amber-500"
                          }`}
                        >
                          {dividerBeingPlaced === fileId
                            ? "Placing this boundary"
                            : "Place this boundary manually"}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {!numbered && (grouping?.groupingStatus === "review_ready" ||
              grouping?.groupingStatus === "confirmed") ? (
                <section aria-labelledby="sequence-heading">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <h3 id="sequence-heading" className="text-lg font-bold">
                        Upload sequence
                      </h3>
                      <p className="mt-1 text-sm text-[var(--app-text-muted)]">
                        Black dividers are removed from the report.
                      </p>
                    </div>
                    <Split className="h-5 w-5 text-[var(--app-text-muted)]" />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-10">
                    {visibleFiles.map((item) => {
                      const isDivider = dividerSet.has(item.fileId);
                      const isBusy = busyFileId === item.fileId;
                      return (
                        <button
                          key={item.fileId}
                          type="button"
                          onClick={() => void toggleDivider(item.fileId)}
                          disabled={Boolean(busyFileId)}
                          className={`group relative aspect-square overflow-hidden rounded-md border bg-[var(--app-panel-alt)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-ring)] ${
                            isDivider
                              ? "border-[var(--app-accent)]"
                              : "border-transparent"
                          }`}
                          aria-pressed={isDivider}
                          aria-label={`${item.name}. ${
                            isDivider ? "Remove divider" : "Use as divider"
                          }`}
                        >
                          <ImagePreview
                            file={item.file}
                            url={item.url || serverFileById.get(item.fileId)?.url}
                            alt=""
                            className={`h-full w-full object-cover transition ${
                              isDivider ? "opacity-35" : ""
                            }`}
                          />
                          <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {item.originalOrder + 1}
                          </span>
                          {isDivider ? (
                            <span className="absolute inset-x-1 top-1 rounded bg-[var(--app-accent)] px-1 py-1 text-[10px] font-bold uppercase text-[var(--app-on-accent)]">
                              Divider
                            </span>
                          ) : null}
                          {isBusy ? (
                            <span className="absolute inset-0 grid place-items-center bg-black/45 text-white">
                              <Loader2 className="h-5 w-5 animate-spin" />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  {draft.files.length > SEQUENCE_PAGE_SIZE ? (
                    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setSequencePage((current) => Math.max(0, current - 1))
                        }
                        disabled={sequencePage === 0}
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Previous images
                      </button>
                      <span className="text-[var(--app-text-muted)]">
                        Images {sequencePage * SEQUENCE_PAGE_SIZE + 1}-
                        {Math.min(
                          (sequencePage + 1) * SEQUENCE_PAGE_SIZE,
                          draft.files.length
                        )} of {draft.files.length}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSequencePage((current) =>
                            Math.min(
                              Math.ceil(draft.files.length / SEQUENCE_PAGE_SIZE) - 1,
                              current + 1
                            )
                          )
                        }
                        disabled={
                          (sequencePage + 1) * SEQUENCE_PAGE_SIZE >= draft.files.length
                        }
                        className="min-h-10 rounded-md border border-[var(--app-control-border)] px-4 font-semibold disabled:opacity-50"
                      >
                        Next images
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              {numbered && grouping && draft.stage === "review" ? <section className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] p-4" aria-label="Lot-number review">
                <h3 className="font-bold">Confirm lot numbers and boundaries</h3>
                {grouping.warnings.length ? <div role="alert" className="mt-2 text-sm text-[var(--app-danger)]"><ul className="list-disc pl-5">{grouping.warnings.slice(0, 10).map((warning, index) => <li key={index}>{warning}</li>)}</ul>{grouping.warnings.length > 10 ? <p>{grouping.warnings.length - 10} more warnings. Review the remaining lots.</p> : null}</div> : null}
                <p className="mt-2 text-sm leading-6 text-[var(--app-text-muted)]">Every sign photo remains the first photo of its lot. Check each number, and use Start new lot here or Join previous lot to correct boundaries. No photos are discarded.</p>
                {(grouping.unresolvedLotNumberFileIds?.length || 0) > 0 ? <p role="status" className="mt-2 text-sm text-[var(--app-warning)]">{grouping.unresolvedLotNumberFileIds?.length} photos could not be confidently classified. Review their surrounding lots: {grouping.unresolvedLotNumberFileIds?.slice(0, 10).map((id) => fileById.get(id)?.name || id).join(", ")}{(grouping.unresolvedLotNumberFileIds?.length || 0) > 10 ? "…" : ""}</p> : null}
                <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold">
                  <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={Boolean(busyFileId)} checked={acknowledgedRevision === grouping.revision}
                    onChange={(event) => setAcknowledgedRevision(event.target.checked ? grouping.revision : null)} />
                  I checked every lot number and boundary, including uncertain photos. Keep all photos in the reviewed lots.
                </label>
              </section> : null}
              </> : null}
            </>
          )}
        </div>
      </main>

      {draft?.stage === "review" && grouping ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 sm:px-6">
          <p
            className={`text-sm ${
              hasInvalidGroups
                ? "font-semibold text-[var(--app-danger)]"
                : "text-[var(--app-text-muted)]"
            }`}
          >
            {hasInvalidGroups
              ? unplacedDividerIds.length
                ? "Confirm where the next lot starts before creating the preview."
                : orderingReview?.ambiguous
                  ? "Check the detected lots and confirm the image order before creating the preview."
                  : numbered ? "Save every lot number and confirm the reviewed boundaries." : grouping.warnings?.[0] || "Keep at least one report image."
              : `${grouping.groups.length} Bundle lots are ready for preview.`}
          </p>
          <button
            type="button"
            onClick={() => void createPreview()}
            disabled={hasInvalidGroups || Boolean(busyFileId)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-on-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-5 w-5" />
            Create preview
          </button>
        </footer>
      ) : null}
    </div>,
    document.body
  );
}
