"use client";

import {
  ArrowLeft,
  Bug,
  CheckCircle2,
  Clock3,
  Inbox,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useAuthContext } from "@/context/AuthContext";
import {
  SupportService,
  type SupportCategory,
  type SupportConversation,
  type SupportMessage,
  type SupportPage,
  type SupportStatus,
} from "@/services/support";
import NewSupportRequest from "./NewSupportRequest";
import SupportAttachmentView from "./SupportAttachmentView";
import SupportComposer from "./SupportComposer";
import styles from "./Support.module.css";

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

const STATUS_LABELS: Record<SupportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_user: "Waiting for you",
  resolved: "Resolved",
  closed: "Closed",
};

function visiblePollInterval(interval: number) {
  return () => {
    if (typeof document === "undefined") return interval;
    return document.visibilityState === "visible" && navigator.onLine
      ? interval
      : 0;
  };
}

function formatDate(value?: string, compact = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return (compact ? SHORT_DATE : DATE_TIME).format(date);
}

function statusTone(status: SupportStatus) {
  if (status === "waiting_on_user") return "warning";
  if (status === "resolved") return "success";
  if (status === "closed") return "neutral";
  return "info";
}

function categoryLabel(category: SupportCategory) {
  if (category === "error") return "Problem";
  if (category === "feature") return "Feature";
  if (category === "question") return "Question";
  return "Other";
}

function initials(value: string) {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "AI";
  return `${parts[0]?.[0] || ""}${
    parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : ""
  }`
    .toUpperCase()
    .slice(0, 2);
}

function errorMessage(error: unknown, fallback: string) {
  const response = (error as {
    response?: { data?: { message?: string; error?: string } };
    message?: string;
  })?.response?.data;
  return response?.message || response?.error || (error as Error)?.message || fallback;
}

function mergeMessages(...pages: Array<SupportPage<SupportMessage> | undefined>) {
  const byId = new Map<string, SupportMessage>();
  for (const page of pages) {
    for (const message of page?.items || []) byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

function mergeConversations(
  ...pages: Array<SupportPage<SupportConversation> | undefined>
) {
  const byId = new Map<string, SupportConversation>();
  for (const page of pages) {
    for (const conversation of page?.items || []) {
      if (!byId.has(conversation.id)) byId.set(conversation.id, conversation);
    }
  }
  return Array.from(byId.values());
}

function ConversationRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: SupportConversation;
  active: boolean;
  onSelect: () => void;
}) {
  const when = conversation.lastMessageAt || conversation.updatedAt;
  return (
    <li>
      <button
        type="button"
        className={styles.conversationRow}
        data-active={active}
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
      >
        <span className={styles.rowHeading}>
          <strong>{conversation.subject}</strong>
          <time dateTime={when}>{formatDate(when, true)}</time>
        </span>
        <span className={styles.rowMeta}>
          <span className={styles.category}>{categoryLabel(conversation.category)}</span>
          <span data-tone={statusTone(conversation.status)}>
            {STATUS_LABELS[conversation.status]}
          </span>
          {conversation.unreadCount ? (
            <span className={styles.unread} aria-label={`${conversation.unreadCount} unread replies`}>
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          ) : null}
        </span>
        <span className={styles.preview}>
          {conversation.preview || "No replies yet"}
        </span>
      </button>
    </li>
  );
}

function MessageBubble({
  message,
  userName,
}: {
  message: SupportMessage;
  userName: string;
}) {
  const isUser = message.senderRole === "user";
  const isSystem = message.senderRole === "system";
  const authorName = isUser
    ? message.senderName || userName
    : message.senderName || "Asset Insight Support";
  return (
    <article
      className={styles.messageRow}
      data-sender={message.senderRole}
      aria-label={`${isSystem ? "System" : isUser ? "You" : "Support team"} at ${formatDate(message.createdAt)}`}
    >
      {!isSystem ? (
        <span className={styles.messageAvatar} data-sender={message.senderRole} aria-hidden>
          {isUser ? initials(authorName) : "AI"}
        </span>
      ) : null}
      <div className={styles.messageBubble}>
        {!isSystem ? (
          <div className={styles.messageAuthor}>
            <strong>{authorName}</strong>
            <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
          </div>
        ) : null}
        {message.body ? <p>{message.body}</p> : null}
        {message.attachments.length ? (
          <div className={styles.attachmentGrid}>
            {message.attachments.map((attachment) => (
              <SupportAttachmentView key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {isSystem ? (
          <time className={styles.systemTime} dateTime={message.createdAt}>
            {formatDate(message.createdAt)}
          </time>
        ) : null}
      </div>
    </article>
  );
}

export default function SupportWorkspace() {
  const { user, sessionPresent } = useAuthContext();
  const requestOwner = user?._id || user?.id || (sessionPresent ? "session" : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | SupportStatus>("active");
  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [newRequestCategory, setNewRequestCategory] = useState<SupportCategory>("error");
  const [moreConversationPages, setMoreConversationPages] = useState<
    Array<SupportPage<SupportConversation>>
  >([]);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [moreConversationsError, setMoreConversationsError] = useState<string | null>(null);
  const [olderPages, setOlderPages] = useState<Array<SupportPage<SupportMessage>>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const readReceiptRef = useRef("");

  const {
    data: conversationsPage,
    error: conversationsError,
    isLoading: conversationsLoading,
    isValidating: conversationsRefreshing,
    mutate: mutateConversations,
  } = useSWR(
    requestOwner ? ["support/conversations", requestOwner] : null,
    () => SupportService.listConversations(),
    {
      keepPreviousData: false,
      refreshInterval: visiblePollInterval(30_000),
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );

  const selectedSummary = conversationsPage?.items.find(
    (conversation) => conversation.id === selectedId
  ) || moreConversationPages.flatMap((page) => page.items).find(
    (conversation) => conversation.id === selectedId
  );
  const {
    data: selectedDetail,
    error: detailError,
    mutate: mutateDetail,
  } = useSWR(
    selectedId ? ["support/conversation", selectedId] : null,
    () => SupportService.getConversation(selectedId!),
    { keepPreviousData: false, refreshInterval: visiblePollInterval(30_000) }
  );
  const {
    data: currentMessages,
    error: messagesError,
    isLoading: messagesLoading,
    isValidating: messagesRefreshing,
    mutate: mutateMessages,
  } = useSWR(
    selectedId ? ["support/messages", selectedId] : null,
    () => SupportService.listMessages(selectedId!),
    {
      keepPreviousData: false,
      refreshInterval: visiblePollInterval(12_000),
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );

  const conversation = selectedDetail || selectedSummary;
  const allConversations = useMemo(
    () => mergeConversations(conversationsPage, ...moreConversationPages),
    [conversationsPage, moreConversationPages]
  );
  const nextConversationCursor =
    moreConversationPages.length > 0
      ? moreConversationPages[moreConversationPages.length - 1].nextCursor
      : conversationsPage?.nextCursor;
  const messages = useMemo(
    () => mergeMessages(...olderPages, currentMessages),
    [currentMessages, olderPages]
  );
  const nextOlderCursor =
    olderPages.length > 0
      ? olderPages[olderPages.length - 1].nextCursor
      : currentMessages?.nextCursor;
  const openRequestCount = allConversations.filter(
    (item) => item.status !== "closed" && item.status !== "resolved"
  ).length;
  const userName = user?.username || user?.email || "You";

  const visibleConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allConversations.filter((candidate) => {
      const statusMatches =
        statusFilter === "all" ||
        (statusFilter === "active"
          ? candidate.status !== "closed" && candidate.status !== "resolved"
          : candidate.status === statusFilter);
      const searchMatches =
        !query ||
        candidate.subject.toLowerCase().includes(query) ||
        candidate.preview?.toLowerCase().includes(query) ||
        categoryLabel(candidate.category).toLowerCase().includes(query);
      return statusMatches && searchMatches;
    });
  }, [allConversations, search, statusFilter]);

  useEffect(() => {
    setMoreConversationPages([]);
    setMoreConversationsError(null);
  }, [requestOwner]);

  useEffect(() => {
    setOlderPages([]);
    setOlderError(null);
    readReceiptRef.current = "";
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !messages.length) return;
    const lastMessage = messages[messages.length - 1];
    const receiptKey = `${selectedId}:${lastMessage.id}`;
    if (readReceiptRef.current === receiptKey) return;
    readReceiptRef.current = receiptKey;
    void SupportService.markRead(selectedId)
      .then(() => mutateConversations())
      .catch(() => {
        readReceiptRef.current = "";
      });
  }, [messages, mutateConversations, selectedId]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = messagesRef.current;
    if (!scroller) return;
    scroller.scrollTo?.({ top: scroller.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    // Loading an older cursor page must keep the reader at that history
    // position. Initial/latest pages follow the end of this scroller only;
    // scrolling the marker into view could also move the document itself.
    if (!selectedId || messagesLoading || olderPages.length > 0) return;
    scrollToLatest();
  }, [messages.length, messagesLoading, olderPages.length, scrollToLatest, selectedId]);

  const refreshThread = useCallback(async () => {
    await Promise.all([
      mutateMessages(),
      mutateDetail(),
      mutateConversations(),
    ]);
  }, [mutateConversations, mutateDetail, mutateMessages]);

  const refreshAfterSend = useCallback(async () => {
    await refreshThread();
    window.requestAnimationFrame(() => scrollToLatest("smooth"));
  }, [refreshThread, scrollToLatest]);

  const loadOlder = async () => {
    if (!selectedId || !nextOlderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await SupportService.listMessages(selectedId, nextOlderCursor);
      setOlderPages((current) => [...current, page]);
    } catch (error) {
      setOlderError(errorMessage(error, "Older messages could not be loaded."));
    } finally {
      setLoadingOlder(false);
    }
  };

  const loadMoreConversations = async () => {
    if (!nextConversationCursor || loadingMoreConversations) return;
    setLoadingMoreConversations(true);
    setMoreConversationsError(null);
    try {
      const page = await SupportService.listConversations(nextConversationCursor);
      setMoreConversationPages((current) => [...current, page]);
    } catch (error) {
      setMoreConversationsError(
        errorMessage(error, "More requests could not be loaded.")
      );
    } finally {
      setLoadingMoreConversations(false);
    }
  };

  const openNewRequest = (category: SupportCategory) => {
    setNewRequestCategory(category);
    setNewRequestOpen(true);
  };

  return (
    <div className={`app-page app-page-stack ${styles.page}`}>
      <header className={`app-surface ${styles.pageHeader}`}>
        <div className={styles.pageTitle}>
          <h1 className="app-title">Support</h1>
          <span>
            {openRequestCount} open request{openRequestCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className="app-button app-button--icon"
            onClick={() => {
              setMoreConversationPages([]);
              void mutateConversations();
            }}
            disabled={conversationsRefreshing}
            aria-label="Refresh support requests"
            title="Refresh support requests"
          >
            <RefreshCw
              size={17}
              className={conversationsRefreshing ? styles.spin : undefined}
              aria-hidden
            />
          </button>
          <button
            type="button"
            className="app-button app-button--primary"
            onClick={() => openNewRequest("error")}
          >
            <Plus size={16} aria-hidden />
            New request
          </button>
        </div>
      </header>

      <section
        className={`app-surface ${styles.workspace}`}
        data-thread-open={Boolean(selectedId)}
        aria-label="Support conversations"
      >
        <aside className={styles.conversationPane} aria-label="Your support requests">
          <div className={styles.listFilters}>
            <label className={styles.searchField}>
              <span className="sr-only">Search support requests</span>
              <Search size={16} aria-hidden />
              <input
                type="search"
                value={search}
                placeholder="Search requests"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Filter support requests by status</span>
              <select
                className="app-field"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as typeof statusFilter)
                }
              >
                <option value="active">Active</option>
                <option value="all">All</option>
                <option value="waiting_on_user">Waiting for you</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </label>
          </div>

          <div className={styles.conversationList} data-support-scroll="requests">
            {conversationsLoading ? (
              <div className={styles.listState} role="status">
                <span className="app-spinner" aria-hidden />
                Loading requests…
              </div>
            ) : conversationsError ? (
              <div className={styles.listState} role="alert">
                <Bug size={23} aria-hidden />
                <strong>Requests unavailable</strong>
                <span>{errorMessage(conversationsError, "Try refreshing this workspace.")}</span>
                <button className="app-button app-button--secondary" onClick={() => void mutateConversations()}>
                  Try again
                </button>
              </div>
            ) : visibleConversations.length ? (
              <>
                <ul>
                  {visibleConversations.map((item) => (
                    <ConversationRow
                      key={item.id}
                      conversation={item}
                      active={item.id === selectedId}
                      onSelect={() => setSelectedId(item.id)}
                    />
                  ))}
                </ul>
                {nextConversationCursor ? (
                  <button
                    type="button"
                    className={`app-button ${styles.loadMoreConversations}`}
                    onClick={() => void loadMoreConversations()}
                    disabled={loadingMoreConversations}
                  >
                    {loadingMoreConversations ? "Loading…" : "Load more requests"}
                  </button>
                ) : null}
                {moreConversationsError ? (
                  <div className={styles.paginationError} role="alert">
                    {moreConversationsError}
                  </div>
                ) : null}
              </>
            ) : (
              <div className={styles.listState}>
                <Inbox size={25} aria-hidden />
                  <strong>{allConversations.length ? "No matching requests" : "No support requests"}</strong>
                  <span>
                  {allConversations.length
                    ? "Change the search or status filter."
                    : "Create a request when you need help or want to share an idea."}
                </span>
              </div>
            )}
          </div>
        </aside>

        <section className={styles.threadPane} aria-label="Selected support conversation">
          {!selectedId ? (
            <div className={styles.emptyThread}>
              <span className={styles.emptyThreadIcon}><MessageSquareText size={25} aria-hidden /></span>
              <h2>Select a request</h2>
              <p>Choose a conversation to read replies, add screenshots or video, and message the support team.</p>
              <button className="app-button app-button--primary" onClick={() => openNewRequest("error")}>
                <Plus size={16} aria-hidden />
                Create your first request
              </button>
            </div>
          ) : detailError && !conversation ? (
            <div className={styles.emptyThread} role="alert">
              <Bug size={26} aria-hidden />
              <h2>Conversation unavailable</h2>
              <p>{errorMessage(detailError, "This conversation could not be loaded.")}</p>
              <button className="app-button app-button--secondary" onClick={() => void mutateDetail()}>
                Try again
              </button>
            </div>
          ) : conversation ? (
            <>
              <header className={styles.threadHeader}>
                <button
                  type="button"
                  className={`${styles.mobileBack} app-button app-button--icon`}
                  onClick={() => setSelectedId(null)}
                  aria-label="Back to support requests"
                >
                  <ArrowLeft size={18} aria-hidden />
                </button>
                <div className={styles.threadHeading}>
                  <div className={styles.threadTitleRow}>
                    <h2>{conversation.subject}</h2>
                    <span className={styles.category}>{categoryLabel(conversation.category)}</span>
                    <span data-tone={statusTone(conversation.status)}>{STATUS_LABELS[conversation.status]}</span>
                  </div>
                  <p>Created {formatDate(conversation.createdAt)}</p>
                </div>
                <button
                  type="button"
                  className="app-button app-button--icon"
                  onClick={() => void refreshThread()}
                  disabled={messagesRefreshing}
                  aria-label="Refresh conversation"
                  title="Refresh conversation"
                >
                  <RefreshCw size={17} className={messagesRefreshing ? styles.spin : undefined} aria-hidden />
                </button>
              </header>

              <div
                ref={messagesRef}
                className={styles.messages}
                data-support-scroll="messages"
                aria-live="polite"
                aria-busy={messagesLoading}
              >
                {nextOlderCursor ? (
                  <button
                    type="button"
                    className={`app-button app-button--secondary ${styles.loadOlder}`}
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? <LoaderCircle size={16} className={styles.spin} aria-hidden /> : <Clock3 size={16} aria-hidden />}
                    {loadingOlder ? "Loading…" : "Load older messages"}
                  </button>
                ) : null}
                {olderError ? <div className="app-alert app-alert--error" role="alert">{olderError}</div> : null}
                {messagesLoading ? (
                  <div className={styles.messageLoading} role="status">
                    <span className="app-spinner" aria-hidden />
                    Loading conversation…
                  </div>
                ) : messagesError ? (
                  <div className="app-alert app-alert--error" role="alert">
                    <span style={{ flex: 1 }}>{errorMessage(messagesError, "Messages could not be loaded.")}</span>
                    <button className="app-button" onClick={() => void mutateMessages()}>Try again</button>
                  </div>
                ) : messages.length ? (
                  messages.map((message) => (
                    <MessageBubble key={message.id} message={message} userName={userName} />
                  ))
                ) : (
                  <div className={styles.messageLoading}>
                    <CheckCircle2 size={22} aria-hidden />
                    Your request is ready for a reply.
                  </div>
                )}
              </div>

              <SupportComposer
                key={conversation.id}
                conversationId={conversation.id}
                onSent={refreshAfterSend}
              />
            </>
          ) : (
            <div className={styles.emptyThread} role="status">
              <span className="app-spinner" aria-hidden />
              <p>Loading conversation…</p>
            </div>
          )}
        </section>
      </section>

      <NewSupportRequest
        open={newRequestOpen}
        initialCategory={newRequestCategory}
        onClose={() => setNewRequestOpen(false)}
        onCreated={async (created) => {
          setSelectedId(created.id);
          setMoreConversationPages([]);
          setMoreConversationsError(null);
          await mutateConversations();
        }}
      />
    </div>
  );
}
