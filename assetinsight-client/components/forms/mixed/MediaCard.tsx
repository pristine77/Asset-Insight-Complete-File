"use client";

import React, { memo, useEffect, useState } from "react";
import { Crop, Image as ImageIcon, Trash2 } from "lucide-react";

function useObjectUrl(file: File) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return url;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ImageMediaCardProps = {
  file: File;
  kind: "main" | "extra";
  isCover?: boolean;
  annotationCount?: number;
  onSetCover?: () => void;
  onEditFocus?: () => void;
  onRemove: () => void;
};

export const ImageMediaCard = memo(function ImageMediaCard({
  file,
  kind,
  isCover = false,
  annotationCount = 0,
  onSetCover,
  onEditFocus,
  onRemove,
}: ImageMediaCardProps) {
  const url = useObjectUrl(file);
  const isMain = kind === "main";

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] [content-visibility:auto] [contain-intrinsic-size:0_210px]">
      <div className="relative aspect-[4/3] overflow-hidden bg-[var(--app-panel-alt)]">
        {url ? (

          <img src={url} alt={file.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--app-text-muted)]">
            <ImageIcon className="h-6 w-6" aria-hidden="true" />
          </div>
        )}
        <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {isMain ? (isCover ? "Cover" : "Main") : "Report only"}
          </span>
          {annotationCount > 0 ? (
            <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {annotationCount} focus {annotationCount === 1 ? "area" : "areas"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-1 border-t border-[var(--app-border)] px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-[var(--app-text-muted)]" title={file.name}>
          {formatFileSize(file.size)}
        </span>
        {isMain ? (
          <>
            <button
              type="button"
              onClick={onSetCover}
              disabled={isCover}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] disabled:cursor-default disabled:text-[var(--app-accent)]"
              aria-label={isCover ? `${file.name} is the cover image` : `Set ${file.name} as cover image`}
              title={isCover ? "Cover image" : "Set as cover"}
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onEditFocus}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)]"
              aria-label={`Edit focus areas for ${file.name}`}
              title="Edit focus areas"
            >
              <Crop className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-red-600 transition hover:bg-red-500/10"
          aria-label={`Remove ${file.name}`}
          title="Remove"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
});

type VideoMediaCardProps = {
  file: File;
  onRemove: () => void;
};

export const VideoMediaCard = memo(function VideoMediaCard({
  file,
  onRemove,
}: VideoMediaCardProps) {
  const url = useObjectUrl(file);

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] [content-visibility:auto] [contain-intrinsic-size:0_210px]">
      <video
        src={url || undefined}
        controls
        preload="metadata"
        aria-label={file.name}
        className="aspect-video w-full bg-black object-contain"
      />
      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-[var(--app-border)] px-2 py-1">
        <span className="min-w-0 truncate text-[11px] text-[var(--app-text-muted)]" title={file.name}>
          {formatFileSize(file.size)}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-red-600 transition hover:bg-red-500/10"
          aria-label={`Remove ${file.name}`}
          title="Remove"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
});
