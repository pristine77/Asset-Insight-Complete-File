"use client";

import {
  AlertCircle,
  ArrowLeft,
  FileImage,
  FileVideo,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";

import { bytes, dateTime, requestReference } from "@/lib/support/format";
import type { SupportConversation, SupportMessage, SupportStatus } from "@/lib/support/types";
import { AttachmentCard } from "./AttachmentCard";
import styles from "./support.module.css";

export type PreparedFile = {
  id: string;
  file: File;
  attachmentId?: string;
  error?: string;
  progress: number;
  state: "queued" | "uploading" | "ready" | "error";
};

const STATUS_LABELS: Record<SupportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_user: "Waiting for you",
  resolved: "Resolved",
  closed: "Closed",
};

const CATEGORY_LABELS = {
  error: "Problem",
  feature: "Feature request",
  question: "Question",
  other: "Other",
} as const;

export function MessageThread({
  conversation,
  messages,
  loading,
  messagesError,
  olderMessagesError,
  hasOlderMessages,
  loadingOlderMessages,
  pendingFiles,
  acceptedTypes,
  sending,
  onBack,
  onFiles,
  onRemoveFile,
  onDraftChanged,
  onRetryMessages,
  onLoadOlderMessages,
  onSend,
  onCreateRequest,
}: {
  conversation: SupportConversation | null;
  messages: SupportMessage[];
  loading: boolean;
  messagesError: string | null;
  olderMessagesError: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  pendingFiles: PreparedFile[];
  acceptedTypes: string;
  sending: boolean;
  onBack: () => void;
  onFiles: (files: File[]) => void;
  onRemoveFile: (id: string) => void;
  onDraftChanged: () => void;
  onRetryMessages: () => void;
  onLoadOlderMessages: () => void;
  onSend: (body: string) => Promise<boolean>;
  onCreateRequest: () => void;
}) {
  const [body, setBody] = useState("");
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineSnapshot = useRef<{
    conversationId: string;
    firstId: string | null;
    lastId: string | null;
    scrollHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !conversation) {
      timelineSnapshot.current = null;
      return;
    }
    const firstId = messages[0]?.id || null;
    const lastId = messages.at(-1)?.id || null;
    const previous = timelineSnapshot.current;
    const prependedHistory = previous?.conversationId === conversation.id
      && previous.firstId !== firstId
      && previous.lastId === lastId;

    if (prependedHistory) {
      timeline.scrollTop += timeline.scrollHeight - previous.scrollHeight;
    } else if (!previous || previous.conversationId !== conversation.id || previous.lastId !== lastId) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    timelineSnapshot.current = {
      conversationId: conversation.id,
      firstId,
      lastId,
      scrollHeight: timeline.scrollHeight,
    };
  }, [conversation, messages]);

  if (!conversation) {
    return (
      <div className={styles.threadPlaceholder}>
        <span className={styles.placeholderIcon}><MessageSquareText size={25} aria-hidden="true" /></span>
        <h2>Your developer conversations</h2>
        <p>Select a request to read replies, share more details, or attach a screenshot or recording.</p>
        <button className={styles.button} type="button" onClick={onCreateRequest}>
          Create a request
        </button>
      </div>
    );
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if ((!body.trim() && !pendingFiles.length) || sending) return;
    if (await onSend(body.trim())) setBody("");
  }

  return (
    <>
      <header className={styles.threadHeader}>
        <button className={styles.mobileBack} type="button" onClick={onBack} disabled={sending} aria-label="Back to your requests">
          <ArrowLeft size={19} aria-hidden="true" />
        </button>
        <div className={styles.threadIdentity}>
          <h2>{conversation.subject}</h2>
          <div className={styles.threadMeta}>
            <span>{CATEGORY_LABELS[conversation.category]}</span>
            <span aria-hidden="true">·</span>
            <span data-status={conversation.status}>{STATUS_LABELS[conversation.status]}</span>
            <span aria-hidden="true">·</span>
            <span>{requestReference(conversation.id)}</span>
          </div>
        </div>
      </header>

      <div
        className={styles.messageScroller}
        ref={timelineRef}
        role="log"
        aria-label="Conversation with the developer team"
        aria-live="polite"
        tabIndex={0}
      >
        {loading && !messages.length ? (
          <div className={styles.empty}>Loading conversation…</div>
        ) : messagesError && !messages.length ? (
          <div className={styles.errorState} role="alert">
            <AlertCircle size={22} aria-hidden="true" />
            <span>{messagesError}</span>
            <button type="button" onClick={onRetryMessages}>Try again</button>
          </div>
        ) : (
          <>
            {messagesError || hasOlderMessages || olderMessagesError ? (
              <div className={styles.paginationControls}>
                {messagesError ? <span className={styles.paginationError} role="alert">{messagesError}</span> : null}
                {olderMessagesError ? <span className={styles.paginationError} role="alert">{olderMessagesError}</span> : null}
                {messagesError ? (
                  <button className={styles.buttonSecondary} type="button" onClick={onRetryMessages}>Retry messages</button>
                ) : null}
                {hasOlderMessages ? (
                  <button className={styles.buttonSecondary} type="button" disabled={loadingOlderMessages} onClick={onLoadOlderMessages}>
                    {loadingOlderMessages ? "Loading…" : olderMessagesError ? "Try again" : "Load older messages"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {messages.length ? (
              <ol className={styles.messageList}>
                {messages.map((message) => {
                  const system = message.senderRole === "system" || message.type === "system";
                  const mine = message.senderRole === "user";
                  const displayName = mine ? "You" : system ? "System" : "Asset Insight Developer";
                  return (
                    <li
                      className={`${styles.messageRow} ${mine ? styles.messageMine : ""} ${system ? styles.systemMessage : ""}`}
                      key={message.id}
                    >
                      {!system ? (
                        <span className={styles.messageAvatar} data-sender={mine ? "user" : "developer"} aria-hidden="true">
                          {mine ? "You" : "AI"}
                        </span>
                      ) : null}
                      <div className={styles.messageContent}>
                        <div className={styles.messageByline}>
                          <strong>{displayName}</strong>
                          <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
                        </div>
                        <div className={styles.messageBubble}>
                          {message.body ? <p>{message.body}</p> : null}
                          {message.attachments.length ? (
                            <div className={styles.mediaGrid}>
                              {message.attachments.map((attachment) => (
                                <AttachmentCard attachment={attachment} key={attachment.id} />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className={styles.empty}>No messages have been sent yet.</div>
            )}
          </>
        )}
      </div>

      <form className={styles.composer} onSubmit={(event) => void submit(event)}>
        <div className={styles.composerBox}>
          {pendingFiles.length ? (
            <ul className={styles.uploadList} aria-label="Attachments queued for your reply">
              {pendingFiles.map((item) => {
                const FileIcon = item.file.type.startsWith("video/") ? FileVideo : FileImage;
                return (
                  <li className={`${styles.uploadItem} ${item.state === "error" ? styles.uploadError : ""}`} key={item.id}>
                    <FileIcon size={16} aria-hidden="true" />
                    <span className={styles.uploadFileText}>
                      <span className={styles.uploadFileName}>{item.file.name}</span>
                      <span className={styles.uploadFileMeta}>
                        {bytes(item.file.size)} · {item.state === "ready" ? "Ready" : item.state === "uploading" ? `${item.progress}% uploaded` : item.error || "Queued"}
                      </span>
                      {item.state === "uploading" ? <progress max={100} value={item.progress} aria-label={`Uploading ${item.file.name}`} /> : null}
                    </span>
                    {item.state === "uploading" ? <LoaderCircle className={styles.uploadSpinner} size={16} aria-hidden="true" /> : item.state === "error" ? <AlertCircle size={16} aria-hidden="true" /> : null}
                    <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => onRemoveFile(item.id)} disabled={sending || item.state === "uploading"}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <label className="sr-only" htmlFor="admin-support-reply">Reply to the developer team</label>
          <textarea
            id="admin-support-reply"
            value={body}
            onChange={(event) => { setBody(event.target.value); onDraftChanged(); }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Write a reply to the developer team…"
            maxLength={12_000}
            rows={2}
            disabled={sending}
          />
          <div className={styles.composerToolbar}>
            <label className={styles.composerAction} aria-disabled={sending}>
              <Paperclip size={17} aria-hidden="true" /><span>Attach image or video</span>
              <input
                className="sr-only"
                type="file"
                aria-label="Attach image or video"
                accept={acceptedTypes}
                multiple
                disabled={sending}
                onChange={(event) => { onFiles(Array.from(event.target.files || [])); event.target.value = ""; }}
              />
            </label>
            <span className={styles.composerHint}>Ctrl/⌘ + Enter</span>
            <button className={styles.button} type="submit" disabled={sending || (!body.trim() && !pendingFiles.length)}>
              {sending ? "Sending…" : <><Send size={16} aria-hidden="true" /><span>Send</span></>}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
