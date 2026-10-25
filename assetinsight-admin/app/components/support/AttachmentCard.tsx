/* eslint-disable @next/next/no-img-element -- support media comes from runtime R2 URLs. */
"use client";

import { Download, FileWarning } from "lucide-react";
import { useState } from "react";

import { bytes } from "@/lib/support/format";
import type { SupportAttachment } from "@/lib/support/types";
import styles from "./support.module.css";

/** Renders verified R2 media without routing large payloads through Next.js. */
export function AttachmentCard({ attachment }: { attachment: SupportAttachment }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const downloadLabel = `Download ${attachment.originalName}`;

  return (
    <article className={styles.mediaCard}>
      <div className={styles.mediaFrame}>
        {previewFailed ? (
          <div className={styles.mediaFallback} role="status">
            <FileWarning size={22} aria-hidden="true" />
            <span>Preview unavailable</span>
          </div>
        ) : attachment.type === "image" ? (
          <a
            className={styles.mediaPreviewLink}
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${attachment.originalName}`}
          >
            <img
              src={attachment.url}
              alt={attachment.originalName}
              loading="lazy"
              onError={() => setPreviewFailed(true)}
            />
          </a>
        ) : (
          <video
            src={attachment.url}
            controls
            preload="metadata"
            playsInline
            aria-label={attachment.originalName}
            onError={() => setPreviewFailed(true)}
          />
        )}
      </div>
      <div className={styles.mediaMeta}>
        <span className={styles.mediaText}>
          <span className={styles.mediaName}>{attachment.originalName}</span>
          <span className={styles.mediaSize}>{bytes(attachment.sizeBytes)}</span>
        </span>
        <a
          className={styles.mediaDownload}
          href={attachment.url}
          download={attachment.originalName}
          target="_blank"
          rel="noreferrer"
          aria-label={downloadLabel}
          title={downloadLabel}
        >
          <Download size={17} aria-hidden="true" />
        </a>
      </div>
    </article>
  );
}
