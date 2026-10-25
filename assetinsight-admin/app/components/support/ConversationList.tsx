"use client";

import { Bug, HelpCircle, Lightbulb, MessageSquare, type LucideIcon } from "lucide-react";

import { relativeTime, requestReference } from "@/lib/support/format";
import type { SupportCategory, SupportConversation, SupportStatus } from "@/lib/support/types";
import styles from "./support.module.css";

const STATUS_LABELS: Record<SupportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_user: "Waiting for you",
  resolved: "Resolved",
  closed: "Closed",
};

const CATEGORY_META: Record<SupportCategory, { label: string; icon: LucideIcon }> = {
  error: { label: "Problem", icon: Bug },
  feature: { label: "Feature", icon: Lightbulb },
  question: { label: "Question", icon: HelpCircle },
  other: { label: "Other", icon: MessageSquare },
};

export function ConversationList({
  conversations,
  selectedId,
  loading,
  loadingMore,
  loadMoreError,
  hasMore,
  disabled = false,
  onSelect,
  onLoadMore,
}: {
  conversations: SupportConversation[];
  selectedId: string | null;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  hasMore: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  if (loading) {
    return (
      <div aria-label="Loading your support requests" aria-busy="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div className={styles.conversationButton} key={index}>
            <span className={`${styles.skeleton} ${styles.requestIcon}`} />
            <span className={styles.conversationMain}>
              <span className={`${styles.skeleton} ${styles.skeletonLine}`} />
              <span className={`${styles.skeleton} ${styles.skeletonLineShort}`} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (!conversations.length) {
    return (
      <div className={styles.emptyList}>
        <MessageSquare size={24} aria-hidden="true" />
        <strong>No matching requests</strong>
        <span>Try a different search or status filter.</span>
      </div>
    );
  }

  return (
    <>
      <ul className={styles.conversationList} aria-busy={loadingMore}>
        {conversations.map((conversation) => {
          const selected = conversation.id === selectedId;
          const category = CATEGORY_META[conversation.category];
          const Icon = category.icon;
          const updatedAt = conversation.lastMessage?.at || conversation.updatedAt;
          return (
            <li key={conversation.id}>
              <button
                className={`${styles.conversationButton} ${selected ? styles.conversationSelected : ""}`}
                type="button"
                onClick={() => onSelect(conversation.id)}
                aria-current={selected ? "true" : undefined}
                disabled={disabled}
              >
                <span className={styles.requestIcon} data-category={conversation.category}>
                  <Icon size={17} aria-hidden="true" />
                </span>
                <span className={styles.conversationMain}>
                  <span className={styles.conversationHeading}>
                    <span className={styles.conversationSubject}>{conversation.subject}</span>
                    {conversation.unread.user ? (
                      <span className={styles.unreadCount} aria-label={`${conversation.unread.user} unread developer replies`}>
                        {conversation.unread.user > 99 ? "99+" : conversation.unread.user}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.conversationMeta}>
                    <span>{category.label}</span>
                    <span aria-hidden="true">·</span>
                    <span data-status={conversation.status}>{STATUS_LABELS[conversation.status]}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={updatedAt}>{relativeTime(updatedAt)}</time>
                  </span>
                  <span className={styles.conversationPreview}>
                    {conversation.lastMessage?.preview || requestReference(conversation.id)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore || loadMoreError ? (
        <div className={styles.paginationControls}>
          {loadMoreError ? <span className={styles.paginationError} role="alert">{loadMoreError}</span> : null}
          {hasMore ? (
            <button
              className={styles.buttonSecondary}
              type="button"
              disabled={disabled || loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "Loading…" : loadMoreError ? "Try again" : "Load older requests"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
