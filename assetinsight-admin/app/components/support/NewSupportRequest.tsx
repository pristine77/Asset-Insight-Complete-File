"use client";

import {
  Bug,
  FileImage,
  FileVideo,
  HelpCircle,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  createSupportClientMessageId,
  createSupportConversation,
  sendSupportMessage,
  supportUploadAttachment,
} from "@/lib/support/client";
import { bytes } from "@/lib/support/format";
import type { SupportCategory, SupportConversation, SupportUploadConstraints } from "@/lib/support/types";
import styles from "./support.module.css";

const CATEGORY_OPTIONS: Array<{
  value: SupportCategory;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    value: "error",
    label: "Report a problem",
    description: "Something is broken, blocked, or producing an unexpected result.",
    icon: Bug,
  },
  {
    value: "feature",
    label: "Request a feature",
    description: "Suggest an improvement or a useful new capability.",
    icon: Lightbulb,
  },
  {
    value: "question",
    label: "Ask a question",
    description: "Get help understanding a workflow or product behavior.",
    icon: HelpCircle,
  },
  {
    value: "other",
    label: "Other",
    description: "Start a private conversation about anything else.",
    icon: MessageSquare,
  },
];

type DraftFile = {
  id: string;
  file: File;
  progress: number;
  state: "queued" | "uploading" | "ready" | "error";
  error?: string;
};

function supportError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function safeDiagnostics(): Record<string, string> {
  return {
    platform: "web",
    route: window.location.pathname,
    screen: `${window.innerWidth}x${window.innerHeight}`,
    occurredAt: new Date().toISOString(),
  };
}

export function NewSupportRequest({
  open,
  constraints,
  onClose,
  onCreated,
}: {
  open: boolean;
  constraints: SupportUploadConstraints;
  onClose: () => void;
  onCreated: (conversation: SupportConversation, warning?: string) => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<SupportCategory>("error");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setCategory("error");
    setSubject("");
    setDescription("");
    setIncludeDiagnostics(true);
    setFiles([]);
    setError("");
  }

  function close() {
    if (submitting) return;
    reset();
    onClose();
  }

  function appendFiles(incoming: File[]) {
    const attachmentLimit = Math.min(constraints.maxAttachmentsPerMessage, constraints.maxPendingUploads);
    const next = [...files];
    let validationError = "";
    for (const file of incoming) {
      const image = constraints.imageContentTypes.includes(file.type);
      const video = constraints.videoContentTypes.includes(file.type);
      if (!image && !video) {
        validationError = `${file.name} is not a supported image or video.`;
        continue;
      }
      const limit = image ? constraints.maxImageBytes : constraints.maxVideoBytes;
      if (file.size > limit) {
        validationError = `${file.name} exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`;
        continue;
      }
      if (next.length >= attachmentLimit) {
        validationError = `You can attach up to ${attachmentLimit} files to one request.`;
        break;
      }
      const duplicate = next.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
      if (!duplicate) next.push({ id: crypto.randomUUID(), file, progress: 0, state: "queued" });
    }
    setFiles(next);
    setError(validationError);
  }

  async function submit() {
    const cleanSubject = subject.trim();
    const cleanDescription = description.trim();
    if (!cleanSubject || !cleanDescription || submitting) {
      if (!cleanSubject || !cleanDescription) setError("Add a subject and description so the developer team can help.");
      return;
    }

    setSubmitting(true);
    setError("");
    let created: SupportConversation | null = null;
    try {
      const result = await createSupportConversation({
        subject: cleanSubject,
        category,
        source: "web",
        message: cleanDescription,
        diagnostics: includeDiagnostics ? safeDiagnostics() : undefined,
      });
      created = result.conversation;

      const uploadResults = await Promise.allSettled(files.map(async (draft) => {
        setFiles((current) => current.map((item) => item.id === draft.id ? { ...item, state: "uploading", progress: 0, error: undefined } : item));
        try {
          const response = await supportUploadAttachment(created!.id, draft.file, (progress) => {
            setFiles((current) => current.map((item) => item.id === draft.id ? { ...item, state: "uploading", progress } : item));
          });
          setFiles((current) => current.map((item) => item.id === draft.id ? { ...item, state: "ready", progress: 100 } : item));
          return response.attachment.id;
        } catch (reason) {
          const message = supportError(reason, `Upload failed for ${draft.file.name}.`);
          setFiles((current) => current.map((item) => item.id === draft.id ? { ...item, state: "error", error: message } : item));
          throw reason;
        }
      }));

      const attachmentIds = uploadResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failedCount = uploadResults.length - attachmentIds.length;
      let warning = failedCount
        ? `${failedCount} attachment${failedCount === 1 ? "" : "s"} could not be uploaded. You can attach them again in the conversation.`
        : undefined;

      if (attachmentIds.length) {
        try {
          await sendSupportMessage(created.id, {
            body: "",
            attachmentIds,
            clientMessageId: createSupportClientMessageId(),
          });
        } catch (reason) {
          warning = supportError(reason, "The request was created, but its attachments could not be linked. Attach them again in the conversation.");
        }
      }

      await onCreated(created, warning);
      reset();
      onClose();
    } catch (reason) {
      if (created) {
        await onCreated(created, "The request was created, but its media could not be attached. Open it to try again.");
        reset();
        onClose();
      } else {
        setError(supportError(reason, "Your request could not be created. Try again."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.requestDialog}
      aria-labelledby="new-support-request-title"
      onCancel={(event) => {
        if (submitting) event.preventDefault();
        else close();
      }}
      onClose={() => {
        if (open && !submitting) close();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className={styles.requestDialogPanel}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <header className={styles.requestDialogHeader}>
          <div>
            <h2 id="new-support-request-title">New support request</h2>
            <p>Start a private conversation with the Asset Insight developer team.</p>
          </div>
          <button className={styles.iconButton} type="button" onClick={close} disabled={submitting} aria-label="Close new request">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.requestDialogBody}>
          {error ? <div className={styles.formError} role="alert">{error}</div> : null}

          <fieldset className={styles.categoryFieldset} disabled={submitting}>
            <legend>What do you need?</legend>
            <div className={styles.categoryGrid}>
              {CATEGORY_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <label key={option.value} data-selected={category === option.value}>
                    <input
                      type="radio"
                      name="support-category"
                      value={option.value}
                      checked={category === option.value}
                      onChange={() => setCategory(option.value)}
                    />
                    <Icon size={18} aria-hidden="true" />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className={styles.formField}>
            <span>Subject</span>
            <input
              autoFocus
              value={subject}
              maxLength={160}
              required
              disabled={submitting}
              placeholder={category === "feature" ? "A short name for the improvement" : "A short summary of your request"}
              onChange={(event) => { setSubject(event.target.value); setError(""); }}
            />
          </label>

          <label className={styles.formField}>
            <span>Description</span>
            <textarea
              value={description}
              rows={6}
              maxLength={12_000}
              required
              disabled={submitting}
              placeholder="Explain what you expected, what happened, and any steps that help reproduce it. Do not include passwords or access tokens."
              onChange={(event) => { setDescription(event.target.value); setError(""); }}
            />
            <small className={styles.characterCount}>{description.length.toLocaleString()} / 12,000</small>
          </label>

          <div className={styles.formField}>
            <span>Images or videos <small>optional</small></span>
            <label className={styles.fileDrop} aria-disabled={submitting}>
              <Paperclip size={18} aria-hidden="true" />
              <span><strong>Attach screenshots or recordings</strong><small>Files upload securely through the authenticated backend.</small></span>
              <input
                className="sr-only"
                type="file"
                accept={[...constraints.imageContentTypes, ...constraints.videoContentTypes].join(",")}
                multiple
                disabled={submitting}
                onChange={(event) => { appendFiles(Array.from(event.target.files || [])); event.target.value = ""; }}
              />
            </label>
            {files.length ? (
              <ul className={styles.newRequestFiles} aria-label="Selected request attachments">
                {files.map((item) => {
                  const FileIcon = item.file.type.startsWith("video/") ? FileVideo : FileImage;
                  return (
                    <li key={item.id} data-state={item.state}>
                      <FileIcon size={16} aria-hidden="true" />
                      <span><strong>{item.file.name}</strong><small>{item.error || `${bytes(item.file.size)} · ${item.state === "uploading" ? `${item.progress}% uploaded` : item.state}`}</small></span>
                      {item.state === "uploading" ? <LoaderCircle className={styles.uploadSpinner} size={16} aria-hidden="true" /> : (
                        <button type="button" onClick={() => setFiles((current) => current.filter((file) => file.id !== item.id))} disabled={submitting} aria-label={`Remove ${item.file.name}`}>
                          <X size={15} aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <label className={styles.diagnosticsConsent}>
            <input type="checkbox" checked={includeDiagnostics} disabled={submitting} onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
            <ShieldCheck size={18} aria-hidden="true" />
            <span>
              <strong>Include safe technical context</strong>
              <small>Shares this screen, time, and display size. It never includes cookies, passwords, tokens, query values, or form contents.</small>
            </span>
          </label>
        </div>

        <footer className={styles.requestDialogFooter}>
          <button className={styles.buttonSecondary} type="button" onClick={close} disabled={submitting}>Cancel</button>
          <button className={styles.button} type="submit" disabled={submitting || !subject.trim() || !description.trim()}>
            {submitting ? "Creating request…" : "Create request"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
