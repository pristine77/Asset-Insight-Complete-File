import { Download, FileWarning, ImageIcon, Video } from "lucide-react";
import type { SupportAttachment } from "@/services/support";
import styles from "./Support.module.css";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export default function SupportAttachmentView({
  attachment,
}: {
  attachment: SupportAttachment;
}) {
  const isImage = attachment.contentType.startsWith("image/");
  const isVideo = attachment.contentType.startsWith("video/");

  if (!attachment.url) {
    return (
      <div className={styles.unavailableAttachment} role="status">
        <FileWarning size={18} aria-hidden />
        <span>
          <strong>{attachment.fileName}</strong>
          <small>Secure preview is temporarily unavailable</small>
        </span>
      </div>
    );
  }

  return (
    <article className={styles.attachmentCard}>
      {isImage ? (
        <a
          className={styles.attachmentMedia}
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`Open ${attachment.fileName} in a new tab`}
        >
          {/* Support URLs are short-lived R2 links and cannot be known at build time. */}
          <img
            src={attachment.url}
            alt={`Attachment: ${attachment.fileName}`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        </a>
      ) : isVideo ? (
        <div className={styles.attachmentMedia}>
          <video
            src={attachment.url}
            controls
            preload="metadata"
            playsInline
            aria-label={`Video attachment: ${attachment.fileName}`}
          />
        </div>
      ) : null}

      <div className={styles.attachmentMeta}>
        <span className={styles.attachmentIcon} aria-hidden>
          {isImage ? <ImageIcon size={16} /> : <Video size={16} />}
        </span>
        <span className={styles.attachmentName}>
          <strong title={attachment.fileName}>{attachment.fileName}</strong>
          <small>{formatBytes(attachment.size)}</small>
        </span>
        <a
          className={styles.downloadLink}
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`Download ${attachment.fileName}`}
          title={`Download ${attachment.fileName}`}
        >
          <Download size={16} aria-hidden />
        </a>
      </div>
    </article>
  );
}
