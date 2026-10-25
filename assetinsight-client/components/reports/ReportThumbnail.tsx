"use client";

import { useState } from "react";
import { FileImage } from "lucide-react";

type ReportThumbnailProps = {
  src?: string | null;
  title: string;
  size?: "card" | "table";
};

export function ReportThumbnail({
  src,
  title,
  size = "table",
}: ReportThumbnailProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = Boolean(src && failedSrc === src);
  const hasImage = Boolean(src && !failed);
  const frameSize =
    size === "card"
      ? "h-[4.5rem] w-24"
      : "h-12 w-16";

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] ${frameSize}`}
      style={{ contain: "layout paint" }}
      aria-label={
        !src || failed ? `No preview image available for ${title}` : undefined
      }
    >
      <FileImage
        aria-hidden="true"
        className="size-5 text-[var(--app-text-muted)]"
      />
      {hasImage ? (
        <img
          src={src || undefined}
          alt={`Preview image for ${title}`}
          width={size === "card" ? 96 : 64}
          height={size === "card" ? 72 : 48}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailedSrc(src || null)}
        />
      ) : null}
    </div>
  );
}
