"use client";

import {
  Check,
  Images,
  RotateCcw,
  X,
} from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  MAX_ASSET_COVER_IMAGES,
  normalizeAssetCoverImageUrls,
} from "@/lib/assetCoverImages";

type AssetCoverImagePickerProps = {
  candidateUrls: string[];
  value: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
};

const uniqueUrls = (urls: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of urls) {
    const url = typeof value === "string" ? value.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output;
};

const sameOrderedUrls = (left: string[], right: string[]) =>
  left.length === right.length && left.every((url, index) => url === right[index]);

function CoverThumbnail({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className: string;
}) {
  return (
    <img
      src={url}
      alt={alt}
      width={320}
      height={240}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      className={className}
    />
  );
}

export const AssetCoverImagePicker = memo(function AssetCoverImagePicker({
  candidateUrls,
  value,
  onChange,
  disabled = false,
}: AssetCoverImagePickerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<string[]>([]);

  const candidates = useMemo(() => uniqueUrls(candidateUrls), [candidateUrls]);
  const selectedUrls = useMemo(
    () => normalizeAssetCoverImageUrls(value, candidates),
    [candidates, value]
  );
  const selectedIndexByUrl = useMemo(
    () => new Map(draftSelection.map((url, index) => [url, index])),
    [draftSelection]
  );
  const hasCandidates = candidates.length > 0;

  const closeWithoutApplying = useCallback(() => {
    setOpen(false);
  }, []);

  const openPicker = () => {
    if (disabled || !hasCandidates) return;
    setDraftSelection(selectedUrls);
    setOpen(true);
  };

  const toggleCandidate = (url: string) => {
    setDraftSelection((current) => {
      if (current.includes(url)) {
        return current.filter((selectedUrl) => selectedUrl !== url);
      }
      if (current.length >= MAX_ASSET_COVER_IMAGES) return current;
      return [...current, url];
    });
  };

  const applySelection = () => {
    const normalizedDraft = normalizeAssetCoverImageUrls(
      draftSelection,
      candidates
    );
    if (!sameOrderedUrls(normalizedDraft, selectedUrls)) {
      onChange(normalizedDraft);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>(
        '[data-cover-selected="true"], [data-cover-candidate="true"], button'
      );
      preferred?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeWithoutApplying();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture Escape before a parent fullscreen drawer can handle the same key.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
    };
  }, [closeWithoutApplying, open]);

  useEffect(() => {
    if (!open) return;
    setDraftSelection((current) =>
      normalizeAssetCoverImageUrls(current, candidates)
    );
  }, [candidates, open]);

  const pickerDialog = open && typeof document !== "undefined" ? (
    <div
      className="fixed inset-0 z-[10000] flex items-end justify-center bg-[var(--app-overlay)] p-0 sm:items-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWithoutApplying();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[calc(100dvh-0.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-t-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-modal)] sm:max-h-[min(90dvh,860px)] sm:rounded-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-bold text-[var(--app-text-strong)] sm:text-lg">
              Select cover images
            </h3>
            <p id={descriptionId} className="mt-1 text-xs leading-5 text-[var(--app-text-muted)] sm:text-sm">
              Choose up to {MAX_ASSET_COVER_IMAGES} images. Their selection order is used on the appraiser DOCX cover.
            </p>
          </div>
          <button
            type="button"
            onClick={closeWithoutApplying}
            className="app-button app-button--secondary app-button--icon shrink-0"
            aria-label="Close cover image picker"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--app-bg)] px-3 py-4 sm:px-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-[var(--app-text)]" role="status" aria-live="polite">
              {draftSelection.length} of {MAX_ASSET_COVER_IMAGES} selected
            </p>
            {draftSelection.length >= MAX_ASSET_COVER_IMAGES ? (
              <p className="text-xs text-[var(--app-warning)]">
                Remove a selected image before choosing another.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {candidates.map((url, index) => {
              const selectedIndex = selectedIndexByUrl.get(url);
              const selected = selectedIndex !== undefined;
              const selectionFull =
                !selected && draftSelection.length >= MAX_ASSET_COVER_IMAGES;
              return (
                <button
                  key={url}
                  type="button"
                  data-cover-candidate="true"
                  data-cover-selected={selected ? "true" : "false"}
                  onClick={() => toggleCandidate(url)}
                  disabled={selectionFull}
                  aria-pressed={selected}
                  aria-label={
                    selected
                      ? `Remove cover image ${index + 1}, selected position ${(selectedIndex ?? 0) + 1}`
                      : `Select cover image ${index + 1}`
                  }
                  className={`group relative min-w-0 overflow-hidden rounded-lg border bg-[var(--app-panel)] text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:0_150px] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent)] focus:ring-offset-2 focus:ring-offset-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-45 ${
                    selected
                      ? "border-[var(--app-accent)] ring-1 ring-[var(--app-accent)]"
                      : "border-[var(--app-border)] hover:border-[var(--app-control-border-hover)]"
                  }`}
                >
                  <div className="relative aspect-[4/3] overflow-hidden bg-[var(--app-panel-alt)]">
                    <CoverThumbnail
                      url={url}
                      alt={`Report image ${index + 1}`}
                      className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
                    />
                    {selected ? (
                      <span className="absolute right-2 top-2 inline-flex min-h-7 items-center gap-1 rounded-full bg-[var(--app-accent)] px-2 text-[11px] font-bold text-[var(--app-on-accent)] shadow-[var(--app-shadow-control)]">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        {(selectedIndex ?? 0) + 1}
                      </span>
                    ) : null}
                  </div>
                  <span className="block truncate px-2 py-1.5 text-[11px] font-medium text-[var(--app-text-muted)]">
                    Image {index + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <button
            type="button"
            onClick={() => setDraftSelection([])}
            disabled={draftSelection.length === 0}
            className="app-button app-button--secondary"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset to automatic
          </button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              type="button"
              onClick={closeWithoutApplying}
              className="app-button app-button--secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applySelection}
              className="app-button app-button--primary"
            >
              Apply cover images
            </button>
          </div>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <section
      aria-label="Appraiser document cover images"
      className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3 shadow-[var(--app-shadow-card)] sm:p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Images className="h-4 w-4 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
            <h4 className="text-sm font-bold text-[var(--app-text-strong)]">
              Appraiser DOCX cover
            </h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--app-text-muted)]">
            {selectedUrls.length
              ? `${selectedUrls.length} of ${MAX_ASSET_COVER_IMAGES} cover images selected.`
              : "Automatic selection will use the first suitable report images."}
          </p>
        </div>

        <button
          ref={triggerRef}
          type="button"
          onClick={openPicker}
          disabled={disabled || !hasCandidates}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="app-button app-button--secondary shrink-0"
        >
          <Images className="h-4 w-4" aria-hidden="true" />
          {selectedUrls.length ? "Edit cover images" : "Select cover images"}
        </button>
      </div>

      {selectedUrls.length ? (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {selectedUrls.map((url, index) => (
            <div
              key={url}
              className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)]"
            >
              <CoverThumbnail
                url={url}
                alt={`Selected cover image ${index + 1}`}
                className="h-full w-full object-cover"
              />
              <span className="absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--app-accent)] px-1 text-[10px] font-bold text-[var(--app-on-accent)]">
                {index + 1}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {!hasCandidates ? (
        <p className="mt-2 text-xs text-[var(--app-warning)]">
          No active report images are available for the cover.
        </p>
      ) : null}

      {pickerDialog ? createPortal(pickerDialog, document.body) : null}
    </section>
  );
});

export default AssetCoverImagePicker;
