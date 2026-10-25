"use client";

import { Bug, Lightbulb, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import BottomDrawer from "@/components/BottomDrawer";
import { toast } from "@/components/ui/toast";
import { collectSafeSupportDiagnostics } from "@/lib/supportDiagnostics";
import {
  SupportService,
  type SupportCategory,
  type SupportConversation,
} from "@/services/support";
import SupportFilePicker from "./SupportFilePicker";
import styles from "./Support.module.css";

const CATEGORY_OPTIONS: Array<{
  value: SupportCategory;
  label: string;
  description: string;
}> = [
  {
    value: "error",
    label: "Something is not working",
    description: "Report an error, unexpected result, or blocked workflow.",
  },
  {
    value: "feature",
    label: "Feature request",
    description: "Suggest an improvement or a new workflow capability.",
  },
  {
    value: "question",
    label: "How-to question",
    description: "Ask for guidance using Asset Insight.",
  },
  {
    value: "other",
    label: "Other request",
    description: "Start a conversation about anything else.",
  },
];

function createClientMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function NewSupportRequest({
  open,
  initialCategory = "error",
  onClose,
  onCreated,
}: {
  open: boolean;
  initialCategory?: SupportCategory;
  onClose: () => void;
  onCreated: (conversation: SupportConversation) => Promise<void> | void;
}) {
  const [category, setCategory] = useState<SupportCategory>(initialCategory);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) return;
    setCategory(initialCategory);
  }, [initialCategory, open]);

  const reset = () => {
    setCategory(initialCategory);
    setSubject("");
    setDescription("");
    setIncludeDiagnostics(true);
    setFiles([]);
    setError(null);
    setProgress(0);
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (submitting) return;
    const cleanSubject = subject.trim();
    const cleanDescription = description.trim();
    if (!cleanSubject || !cleanDescription) {
      setError("Add a subject and a description so the support team can help.");
      return;
    }

    setSubmitting(true);
    setError(null);
    let created: SupportConversation | null = null;
    try {
      created = await SupportService.createConversation({
        subject: cleanSubject,
        category,
        message: cleanDescription,
        diagnostics: includeDiagnostics
          ? collectSafeSupportDiagnostics()
          : undefined,
      });

      let attachmentWarning: string | null = null;
      if (files.length) {
        const upload = await SupportService.uploadAttachments(
          created.id,
          files,
          setProgress
        );
        if (upload.attachmentIds.length) {
          await SupportService.sendMessage(created.id, {
            body: "Files attached to the original request.",
            attachmentIds: upload.attachmentIds,
            clientMessageId: createClientMessageId(),
          });
        }
        if (upload.failures.length) {
          attachmentWarning = `${upload.failures.length} attachment${
            upload.failures.length === 1 ? "" : "s"
          } could not be uploaded.`;
        }
      }

      await onCreated(created);
      reset();
      onClose();
      if (attachmentWarning) {
        toast.warning(`Request created. ${attachmentWarning}`);
      } else {
        toast.success("Support request created.");
      }
    } catch (reason) {
      if (created) {
        await onCreated(created);
        reset();
        onClose();
        toast.warning(
          "Your request was created, but its attachments could not be linked. Open the request to try again."
        );
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "The support request could not be created. Try again."
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCategory = CATEGORY_OPTIONS.find(
    (option) => option.value === category
  );

  return (
    <BottomDrawer
      open={open}
      title="New support request"
      description="Start a private conversation with the Asset Insight support team."
      onClose={close}
      closeDisabled={submitting}
      dismissOnBackdrop={!submitting}
    >
      <form
        className={styles.newRequestForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error ? (
          <div className="app-alert app-alert--error" role="alert">
            {error}
          </div>
        ) : null}

        <fieldset className={styles.categoryFieldset} disabled={submitting}>
          <legend>What can we help with?</legend>
          <div className={styles.categoryGrid}>
            {CATEGORY_OPTIONS.map((option) => {
              const Icon =
                option.value === "error"
                  ? Bug
                  : option.value === "feature"
                    ? Lightbulb
                    : MessageCircleQuestion;
              return (
                <label key={option.value} data-selected={category === option.value}>
                  <input
                    type="radio"
                    name="support-category"
                    value={option.value}
                    checked={category === option.value}
                    onChange={() => setCategory(option.value)}
                  />
                  <Icon size={18} aria-hidden />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="app-label">
          <label htmlFor="support-request-subject">Subject</label>
          <input
            id="support-request-subject"
            className="app-field"
            value={subject}
            maxLength={160}
            required
            autoFocus
            disabled={submitting}
            placeholder={
              category === "feature"
                ? "A short name for the improvement"
                : "A short summary of the issue"
            }
            onChange={(event) => {
              setSubject(event.target.value);
              setError(null);
            }}
          />
        </div>

        <div className="app-label">
          <label htmlFor="support-request-description">Description</label>
          <textarea
            id="support-request-description"
            className={`app-field ${styles.descriptionField}`}
            value={description}
            rows={7}
            maxLength={12_000}
            required
            disabled={submitting}
            placeholder="Tell us what you expected, what happened, and any steps that help reproduce it. Do not include passwords or access tokens."
            onChange={(event) => {
              setDescription(event.target.value);
              setError(null);
            }}
          />
          <span className={styles.characterCount}>{description.length.toLocaleString()} / 12,000</span>
        </div>

        <div className={styles.attachmentsField}>
          <span className="app-label">Screenshots or recordings</span>
          <SupportFilePicker
            files={files}
            disabled={submitting}
            onChange={setFiles}
            onError={setError}
          />
        </div>

        <label className={styles.diagnosticsConsent}>
          <input
            type="checkbox"
            checked={includeDiagnostics}
            disabled={submitting}
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
          />
          <ShieldCheck size={19} aria-hidden />
          <span>
            <strong>Include safe technical context</strong>
            <small>
              Shares the current route, app build, browser/device identifier, and display size.
              It never includes URL query values, cookies, passwords, tokens, or form contents.
            </small>
          </span>
        </label>

        {submitting && files.length ? (
          <div className={styles.uploadProgress} role="status" aria-live="polite">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
            <small>Securing attachments… {Math.round(progress * 100)}%</small>
          </div>
        ) : null}

        <footer className={styles.formActions}>
          <div>
            <strong>{selectedCategory?.label}</strong>
            <small>Replies will appear in this support workspace.</small>
          </div>
          <button
            type="button"
            className="app-button app-button--secondary"
            onClick={close}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="app-button app-button--primary"
            disabled={submitting || !subject.trim() || !description.trim()}
          >
            {submitting ? "Creating request…" : "Create request"}
          </button>
        </footer>
      </form>
    </BottomDrawer>
  );
}
