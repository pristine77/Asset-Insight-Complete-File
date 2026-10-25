export type SmartUploadOrderingStrategy =
  | "preserved-selection"
  | "file-timestamp"
  | "natural-filename"
  | "manual";

export type SmartUploadOrderingDiagnostic =
  | "selection-order-preserved"
  | "file-timestamp-needs-review"
  | "natural-filename-restored"
  | "divider-position-needs-review"
  | "filesystem-order-needs-review"
  | "manual-order-needs-confirmation";

export type SmartUploadOrderingResult = {
  files: File[];
  strategy: SmartUploadOrderingStrategy;
  diagnostic: SmartUploadOrderingDiagnostic;
  changed: boolean;
  ambiguous: boolean;
  message: string;
};

type IndexedFile = {
  file: File;
  selectionIndex: number;
};

const FILE_TIMESTAMP_MIN_SPAN_MS = 1_000;
const FILE_TIMESTAMP_MIN_UNIQUE_RATIO = 0.75;
const DIVIDER_NAME_PATTERN =
  /(?:^|[^a-z0-9])(black|blank|divider|separator)(?:[^a-z0-9]|$)/i;
const NUMBER_PATTERN = /\d+/;

const naturalFilenameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const lexicalFilenameCollator = new Intl.Collator("en", {
  numeric: false,
  sensitivity: "base",
});

export function isLikelySmartUploadDividerName(name: string) {
  return DIVIDER_NAME_PATTERN.test(name);
}

function compareNames(
  left: IndexedFile,
  right: IndexedFile,
  collator: Intl.Collator
) {
  const collated = collator.compare(left.file.name, right.file.name);
  if (collated) return collated;
  if (left.file.name !== right.file.name) {
    return left.file.name < right.file.name ? -1 : 1;
  }
  return left.selectionIndex - right.selectionIndex;
}

function isSorted(
  entries: IndexedFile[],
  compare: (left: IndexedFile, right: IndexedFile) => number
) {
  let ascending = true;
  let descending = true;
  for (let index = 1; index < entries.length; index += 1) {
    const result = compare(entries[index - 1], entries[index]);
    if (result > 0) ascending = false;
    if (result < 0) descending = false;
    if (!ascending && !descending) return false;
  }
  return true;
}

function looksFilesystemSorted(entries: IndexedFile[]) {
  return (
    isSorted(entries, (left, right) =>
      compareNames(left, right, naturalFilenameCollator)
    ) ||
    isSorted(entries, (left, right) =>
      compareNames(left, right, lexicalFilenameCollator)
    )
  );
}

function filenameSeriesKey(name: string) {
  const normalized = name.normalize("NFKC").toLocaleLowerCase("en");
  const extensionIndex = normalized.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? normalized.slice(0, extensionIndex) : normalized;
  const extension =
    extensionIndex > 0 ? normalized.slice(extensionIndex) : "";
  return `${basename
    .replace(/\b(?:copy|duplicate)\b/g, "")
    .replace(/\(\d+\)/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[\s._-]+/g, "-")
    .replace(/-+/g, "-")}${extension}`;
}

function isHomogeneousFilenameSeries(entries: IndexedFile[]) {
  if (
    !entries.length ||
    !entries.every(({ file }) => NUMBER_PATTERN.test(file.name))
  ) {
    return false;
  }
  const keys = new Set(entries.map(({ file }) => filenameSeriesKey(file.name)));
  return keys.size === 1;
}

function hasUsefulFileTimestamps(entries: IndexedFile[]) {
  const fileTimestamps = entries.map(({ file }) => Number(file.lastModified));
  if (
    fileTimestamps.some(
      (fileTimestamp) => !Number.isFinite(fileTimestamp) || fileTimestamp <= 0
    )
  ) {
    return false;
  }
  const uniqueTimes = new Set(fileTimestamps);
  const minimumUniqueTimes = Math.max(
    2,
    Math.ceil(entries.length * FILE_TIMESTAMP_MIN_UNIQUE_RATIO)
  );
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const fileTimestamp of fileTimestamps) {
    if (fileTimestamp < earliest) earliest = fileTimestamp;
    if (fileTimestamp > latest) latest = fileTimestamp;
  }
  return (
    uniqueTimes.size >= minimumUniqueTimes &&
    latest - earliest >= FILE_TIMESTAMP_MIN_SPAN_MS
  );
}

function sortByFileTimestamp(entries: IndexedFile[]) {
  return [...entries].sort(
    (left, right) =>
      left.file.lastModified - right.file.lastModified ||
      compareNames(left, right, naturalFilenameCollator) ||
      left.selectionIndex - right.selectionIndex
  );
}

function sameOrder(left: IndexedFile[], right: IndexedFile[]) {
  return left.every(
    (entry, index) => entry.selectionIndex === right[index]?.selectionIndex
  );
}

function result(
  original: IndexedFile[],
  ordered: IndexedFile[],
  options: Omit<SmartUploadOrderingResult, "files" | "changed">
): SmartUploadOrderingResult {
  return {
    ...options,
    files: ordered.map(({ file }) => file),
    changed: !sameOrder(original, ordered),
  };
}

/**
 * Resolve the most trustworthy order available from browser File metadata.
 *
 * The File API does not expose multi-select click chronology. Desktop pickers
 * commonly return their current filesystem sort instead. We only replace that
 * order when metadata provides a deterministic alternative. `lastModified` is
 * a filesystem timestamp, not verified camera capture chronology: copies,
 * downloads, and exports can rewrite it. Timestamp-based results therefore
 * remain suggestions that require review. A named divider in a filesystem-
 * sorted selection is also always flagged because metadata cannot prove where
 * a reusable marker was inserted between lots.
 */
export function resolveSmartUploadFileOrder(
  selectedFiles: readonly File[],
  options: { groupingMethod?: "black_divider" | "lot_number" } = {}
): SmartUploadOrderingResult {
  const original = selectedFiles.map((file, selectionIndex) => ({
    file,
    selectionIndex,
  }));

  if (original.length < 2) {
    return result(original, original, {
      strategy: "preserved-selection",
      diagnostic: "selection-order-preserved",
      ambiguous: false,
      message: "The selected image order was preserved.",
    });
  }

  const filesystemSorted = looksFilesystemSorted(original);
  if (!filesystemSorted) {
    return result(original, original, {
      strategy: "preserved-selection",
      diagnostic: "selection-order-preserved",
      ambiguous: false,
      message: "Your intentional image order was preserved.",
    });
  }

  const dividerEntries = original.filter(({ file }) =>
    options.groupingMethod !== "lot_number" && isLikelySmartUploadDividerName(file.name)
  );
  if (dividerEntries.length) {
    const reportPhotos = original.filter(
      ({ file }) => !isLikelySmartUploadDividerName(file.name)
    );
    if (hasUsefulFileTimestamps(original) && reportPhotos.length > 1) {
      let firstReportTime = Number.POSITIVE_INFINITY;
      let lastReportTime = Number.NEGATIVE_INFINITY;
      for (const { file } of reportPhotos) {
        if (file.lastModified < firstReportTime) {
          firstReportTime = file.lastModified;
        }
        if (file.lastModified > lastReportTime) {
          lastReportTime = file.lastModified;
        }
      }
      const everyDividerFallsInsidePhotoTimes = dividerEntries.every(
        ({ file }) =>
          file.lastModified > firstReportTime &&
          file.lastModified < lastReportTime
      );
      if (everyDividerFallsInsidePhotoTimes) {
        return result(original, sortByFileTimestamp(original), {
          strategy: "file-timestamp",
          diagnostic: "divider-position-needs-review",
          ambiguous: true,
          message:
            "A divider position was suggested from file timestamps. Confirm the boundary before upload because copied or exported files can have misleading timestamps.",
        });
      }
    }
    const usefulPhotoTimestamps = hasUsefulFileTimestamps(reportPhotos);
    const orderedPhotos = usefulPhotoTimestamps
      ? sortByFileTimestamp(reportPhotos)
      : reportPhotos;
    let nextPhoto = 0;
    // Retain the divider slots because their true positions cannot be inferred,
    // but still offer a timestamp-based order among the report photos. The
    // review workspace will ask the user to place each unresolved boundary.
    const ordered = original.map((entry) =>
      isLikelySmartUploadDividerName(entry.file.name)
        ? entry
        : orderedPhotos[nextPhoto++]
    );
    return result(original, ordered, {
      strategy: usefulPhotoTimestamps
        ? "file-timestamp"
        : "preserved-selection",
      diagnostic: "divider-position-needs-review",
      ambiguous: true,
      message:
        usefulPhotoTimestamps && !sameOrder(original, ordered)
          ? "A photo order was suggested from file timestamps, but the divider position cannot be inferred safely. Confirm the lot boundary after detection."
          : "This computer returned the divider in folder order. Confirm the lot boundary after detection.",
    });
  }

  if (isHomogeneousFilenameSeries(original)) {
    const ordered = [...original].sort((left, right) =>
      compareNames(left, right, naturalFilenameCollator)
    );
    return result(original, ordered, {
      strategy: "natural-filename",
      diagnostic: "natural-filename-restored",
      ambiguous: false,
      message: "Images were ordered by their numbered filenames.",
    });
  }

  if (hasUsefulFileTimestamps(original)) {
    const ordered = sortByFileTimestamp(original);
    return result(original, ordered, {
      strategy: "file-timestamp",
      diagnostic: "file-timestamp-needs-review",
      ambiguous: true,
      message:
        "An order was suggested from file timestamps. Review it before upload because copied or exported files can have misleading timestamps.",
    });
  }

  return result(original, original, {
    strategy: "preserved-selection",
    diagnostic: "filesystem-order-needs-review",
    ambiguous: true,
    message:
      "This computer returned the files in folder order and there is not enough metadata to recover the intended sequence safely.",
  });
}
