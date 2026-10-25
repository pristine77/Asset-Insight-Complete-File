import type { DirectUploadFile } from "./directUpload";

/**
 * Rebuilding a resumed submission's file list.
 *
 * `uploadReportFilesDirectToR2` derives each manifest entry's `fileId` from its
 * position in the submitted array (`images-0`, `images-1`, `videos-7`, ...) and
 * the backend keys its stored R2 objects by those ids. A resumed upload must
 * therefore reproduce the identical array, in the identical order, or it would
 * present a different manifest under a submission id the server already holds
 * photographs for — which is what SUBMISSION_MANIFEST_CHANGED rejects.
 *
 * The two report types do *not* assemble that array the same way, and the
 * difference is load-bearing:
 *
 *   Asset       every main and report-only photo first, then all videos, with
 *               one flat running imageIndex.
 *   Lot Listing each lot's main photos, then its report-only photos, then its
 *               videos, before moving to the next lot — so a video can sit at
 *               array position 3 and be `videos-3`, not `videos-0` — and with
 *               lotIndex plus an imageIndex counted within its own bucket.
 *
 * Both orderings live here so the submitting service and the resume path share
 * one definition rather than drifting.
 */

export type SubmissionLotMedia = {
  files?: File[];
  extraFiles?: File[];
  videoFiles?: File[];
};

/**
 * Lot Listing's upload array. Mirrors LotListingForm's own assembly; the form
 * calls this through `LotListingService.create` so there is a single source.
 */
export function lotListingDirectUploadFiles(
  lots: readonly SubmissionLotMedia[] | null | undefined
): DirectUploadFile[] {
  // Array.isArray widens a readonly array to any[]; keep the element type.
  const safe: readonly SubmissionLotMedia[] = Array.isArray(lots) ? lots : [];
  const files: DirectUploadFile[] = [];
  safe.forEach((lot, lotIndex) => {
    (lot.files || []).forEach((file, imageIndex) => {
      files.push({ file, fieldname: "images", lotIndex, imageIndex, role: "main" });
    });
    (lot.extraFiles || []).forEach((file, imageIndex) => {
      files.push({ file, fieldname: "images", lotIndex, imageIndex, role: "extra" });
    });
    (lot.videoFiles || []).forEach((file, imageIndex) => {
      files.push({ file, fieldname: "videos", lotIndex, imageIndex, role: "video" });
    });
  });
  return files;
}

export type SubmissionFiles = {
  images: File[];
  videos: File[];
};

/** One frozen manifest entry, as the hand-off recorded it. */
export type SubmissionFileDescriptor = {
  name: string;
  size: number;
  /** Absent when the browser did not report one, matching the manifest. */
  lastModified?: number;
};

export function submissionFilesFromLots(
  lots: readonly SubmissionLotMedia[] | null | undefined
): SubmissionFiles {
  const safe: readonly SubmissionLotMedia[] = Array.isArray(lots) ? lots : [];
  return {
    images: safe.flatMap((lot) => [...(lot.files || []), ...(lot.extraFiles || [])]),
    videos: safe.flatMap((lot) => lot.videoFiles || []),
  };
}

export function describeSubmissionFile(file: File): SubmissionFileDescriptor {
  return {
    name: file.name || "",
    size: file.size,
    lastModified: Number.isFinite(file.lastModified)
      ? Math.max(0, Math.trunc(file.lastModified))
      : undefined,
  };
}

export function describeOrderedFiles(
  files: readonly File[]
): SubmissionFileDescriptor[] {
  return files.map(describeSubmissionFile);
}

export function describeSubmissionFiles(files: SubmissionFiles): SubmissionFileDescriptor[] {
  return describeOrderedFiles([...files.images, ...files.videos]);
}

/**
 * The exact File order this report type presents to the manifest. Use this for
 * the frozen descriptors recorded at hand-off and for the check on resume, so
 * both sides of the comparison come from one definition.
 */
export function orderedSubmissionFiles(
  kind: "asset" | "lot-listing",
  lots: readonly SubmissionLotMedia[] | null | undefined
): File[] {
  if (kind === "lot-listing") {
    return lotListingDirectUploadFiles(lots).map((item) => item.file);
  }
  const { images, videos } = submissionFilesFromLots(lots);
  return [...images, ...videos];
}

export type SubmissionFileMatch =
  | { matches: true }
  | { matches: false; reason: "count" | "identity" };

/**
 * Confirms rehydrated draft media is the same set, in the same order, that the
 * session was created with. Name, size and lastModified are exactly the fields
 * the manifest carries. This is an identity/order check, not a content hash;
 * resume must use the original immutable blobs, never a newer editable draft.
 *
 * This fails closed on purpose: a mismatch means the draft changed after the
 * upload began, and resuming would silently submit different media under an
 * identity the server has already accepted photographs for.
 */
export function submissionFilesMatchManifest(
  rebuilt: readonly SubmissionFileDescriptor[],
  frozen: readonly SubmissionFileDescriptor[] | null | undefined
): SubmissionFileMatch {
  const expected = Array.isArray(frozen) ? frozen : [];
  if (rebuilt.length !== expected.length) return { matches: false, reason: "count" };
  for (let index = 0; index < expected.length; index += 1) {
    const left = rebuilt[index];
    const right = expected[index];
    if (
      left.name !== right.name ||
      left.size !== right.size ||
      left.lastModified !== right.lastModified
    ) {
      return { matches: false, reason: "identity" };
    }
  }
  return { matches: true };
}
