"use client";

import { FileImage, FileVideo, Paperclip, X } from "lucide-react";
import { useRef } from "react";
import useSWR from "swr";
import {
  appendSupportFiles,
  DEFAULT_SUPPORT_FILE_LIMITS,
  supportFileAccept,
  supportFileKey,
  supportFileKind,
} from "@/lib/supportFiles";
import { SupportService } from "@/services/support";
import styles from "./Support.module.css";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function SupportFilePicker({
  files,
  disabled = false,
  onChange,
  onError,
  compact = false,
}: {
  files: File[];
  disabled?: boolean;
  onChange: (files: File[]) => void;
  onError: (message: string | null) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: constraints } = useSWR(
    "support/upload-constraints",
    () => SupportService.getUploadConstraints(),
    { revalidateOnFocus: false, revalidateOnReconnect: true }
  );
  const limits = constraints || DEFAULT_SUPPORT_FILE_LIMITS;

  const acceptFiles = (incoming: File[]) => {
    const result = appendSupportFiles(files, incoming, limits);
    onChange(result.files);
    onError(result.error);
  };

  return (
    <div className={styles.filePicker} data-compact={compact}>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept={supportFileAccept(limits)}
        multiple
        disabled={disabled}
        aria-label="Add images or videos"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files || []));
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className={`app-button app-button--secondary ${styles.attachButton}`}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label={compact ? "Attach image or video" : undefined}
        title={compact ? "Attach image or video" : undefined}
      >
        <Paperclip size={16} aria-hidden />
        {compact ? null : "Attach image or video"}
      </button>
      {!compact ? (
        <span className={styles.fileHint}>
          Up to {limits.maxAttachmentsPerMessage} files · images {Math.floor(limits.maxImageBytes / (1024 * 1024))} MiB · videos {Math.floor(limits.maxVideoBytes / (1024 * 1024))} MiB
        </span>
      ) : null}

      {files.length ? (
        <ul className={styles.selectedFiles} aria-label="Selected attachments">
          {files.map((file) => {
            const key = supportFileKey(file);
            const isVideo = supportFileKind(file, limits) === "video";
            return (
              <li key={key}>
                <span className={styles.selectedFileIcon} aria-hidden>
                  {isVideo ? <FileVideo size={16} /> : <FileImage size={16} />}
                </span>
                <span className={styles.selectedFileName}>
                  <strong title={file.name}>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                </span>
                <button
                  type="button"
                  className={styles.removeFile}
                  onClick={() => {
                    onChange(files.filter((candidate) => supportFileKey(candidate) !== key));
                    onError(null);
                  }}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={15} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
