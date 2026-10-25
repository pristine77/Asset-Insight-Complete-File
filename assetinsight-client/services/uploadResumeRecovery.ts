import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import { AssetService } from "./asset";
import { createLotListing } from "./lotListing";
import type { BackgroundUploadRequest } from "./backgroundUploadManager";
import { loadResumableDraft, type UploadResumeRecord, type UploadStoreGuard } from "./uploadResumeStore";
import { describeOrderedFiles, orderedSubmissionFiles, submissionFilesFromLots, submissionFilesMatchManifest, type SubmissionLotMedia } from "./uploadJobFiles";
import { safeReportOperationError } from "./reportTransferErrors";

export type ResumeOutcome =
  | { status: "ready"; request: BackgroundUploadRequest }
  | { status: "draft-missing" }
  | { status: "media-missing"; missing: number }
  | { status: "changed"; reason: "count" | "identity" }
  | { status: "error"; message: string };

/** Explicit recovery uses the immutable submitted snapshot, not draft autosave. */
export async function prepareResumeFromRecord(record: UploadResumeRecord, options?: UploadStoreGuard): Promise<ResumeOutcome> {
  const session = captureAuthSession();
  const current = () => isAuthSessionCurrent(session) && !options?.signal?.aborted && options?.isCurrent?.() !== false;
  try {
    const loaded = await loadResumableDraft(record, { ...options, isCurrent: current });
    if (!current()) return { status: "error", message: "The account changed. Sign in again and choose this upload from your own account." };
    if (!loaded) return { status: "draft-missing" };
    const saved = loaded.record;
    if (saved.needsForm) return { status: "error", message: "This saved upload needs review before it can continue. Choose Review saved report; the original photos are retained." };
    const envelope = loaded.envelope as { lots?: SubmissionLotMedia[]; data?: { lots?: SubmissionLotMedia[] } };
    const lots = saved.kind === "lot-listing" ? envelope.data?.lots : envelope.lots;
    if (!Array.isArray(lots) || lots.length === 0) return { status: "draft-missing" };
    const match = submissionFilesMatchManifest(describeOrderedFiles(orderedSubmissionFiles(saved.kind, lots)), saved.files);
    if (!match.matches) return { status: "changed", reason: match.reason };
    return { status: "ready", request: {
      ownerId: saved.ownerId, kind: saved.kind, scopeId: saved.scopeId, endpoint: saved.endpoint,
      title: saved.title, totalFiles: saved.totalFiles, clientSubmissionId: saved.clientSubmissionId,
      details: saved.details, files: saved.files, media: loaded.media, draftSnapshot: loaded.envelope,
      skipPersist: true,
      upload: (onProgress, signal) => {
        if (saved.kind === "lot-listing") return createLotListing(saved.details, lots, { onUploadProgress: onProgress, signal });
        const { images, videos } = submissionFilesFromLots(lots);
        return AssetService.create(saved.details as never, images, videos, { onUploadProgress: onProgress, signal });
      },
    } };
  } catch (error) {
    return { status: "error", message: safeReportOperationError(error, "The saved upload could not be read. Keep it and retry on this browser; check Reports before creating a separate submission.") };
  }
}
export function describeResumeOutcome(outcome: ResumeOutcome): string | null {
  switch (outcome.status) {
    case "ready": return null;
    case "draft-missing": return "This saved upload is no longer available on this browser. Check Reports before creating it again — the earlier upload may already have been accepted.";
    case "media-missing": return `This saved upload is missing ${outcome.missing} original media file${outcome.missing === 1 ? "" : "s"}. Keep this record and check Reports before starting again.`;
    case "changed": return "The saved upload no longer matches its original media order. Keep it and check Reports before creating a separate submission.";
    case "error": return outcome.message;
  }
}
