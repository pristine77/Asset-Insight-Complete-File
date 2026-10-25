"use client";

import { AlertCircle, Inbox, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import {
  createSupportClientMessageId,
  getSupportConstraints,
  getSupportConversation,
  listSupportConversations,
  listSupportMessages,
  markSupportConversationRead,
  sendSupportMessage,
  SupportApiError,
  supportUploadAttachment,
} from "@/lib/support/client";
import type {
  SupportConversation,
  SupportCursorPage,
  SupportMessage,
  SupportStatus,
  SupportUploadConstraints,
} from "@/lib/support/types";
import { ConversationList } from "./ConversationList";
import { MessageThread, type PreparedFile } from "./MessageThread";
import { NewSupportRequest } from "./NewSupportRequest";
import styles from "./support.module.css";

type ResourceState<T> = {
  key: string | null;
  data: T | null;
  error: Error | null;
  loading: boolean;
};

type CursorTail<T> = {
  key: string;
  items: T[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
};

const DEFAULT_CONSTRAINTS: SupportUploadConstraints = {
  imageContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
  videoContentTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 250 * 1024 * 1024,
  maxAttachmentsPerMessage: 8,
  maxPendingUploads: 8,
};

function usePollingResource<T>(
  key: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
) {
  const [state, setState] = useState<ResourceState<T>>({ key, data: null, error: null, loading: Boolean(key) });
  const activeKey = useRef(key);
  const requestSequence = useRef(0);
  const inFlight = useRef<{ key: string; controller: AbortController; promise: Promise<void> } | null>(null);
  activeKey.current = key;

  const load = useCallback((showLoading = false): Promise<void> => {
    if (!key) return Promise.resolve();
    if (inFlight.current?.key === key) return inFlight.current.promise;
    inFlight.current?.controller.abort();
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    if (showLoading) {
      setState((current) => current.key === key
        ? { ...current, loading: current.data === null }
        : { key, data: null, error: null, loading: true });
    }

    const promise = loader(controller.signal)
      .then((data) => {
        if (activeKey.current !== key || requestSequence.current !== sequence) return;
        setState({ key, data, error: null, loading: false });
      })
      .catch((reason) => {
        if (controller.signal.aborted || activeKey.current !== key || requestSequence.current !== sequence) return;
        setState((current) => ({
          key,
          data: current.key === key ? current.data : null,
          error: reason instanceof Error ? reason : new Error("The support service could not be reached."),
          loading: false,
        }));
      })
      .finally(() => {
        if (inFlight.current?.controller === controller) inFlight.current = null;
      });
    inFlight.current = { key, controller, promise };
    return promise;
  }, [key, loader]);

  useEffect(() => {
    if (!key) return;
    void load(true);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void load(false);
    };
    const timer = intervalMs ? window.setInterval(refreshWhenVisible, intervalMs) : null;
    if (intervalMs) document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      if (intervalMs) document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (inFlight.current?.key === key) {
        inFlight.current.controller.abort();
        inFlight.current = null;
      }
      requestSequence.current += 1;
    };
  }, [intervalMs, key, load]);

  const refresh = useCallback(() => load(false), [load]);
  const current = state.key === key ? state : { key, data: null, error: null, loading: Boolean(key) };
  return { ...current, refresh };
}

function mergeUniqueById<T extends { id: string }>(...groups: T[][]): T[] {
  const seen = new Set<string>();
  return groups.flatMap((group) => group.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }));
}

function supportError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function updateRequestUrl(requestId: string | null) {
  const url = new URL(window.location.href);
  if (requestId) url.searchParams.set("request", requestId);
  else url.searchParams.delete("request");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function SupportInbox({ initialRequest = null }: { initialRequest?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(initialRequest);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | SupportStatus>("active");
  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PreparedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [conversationTail, setConversationTail] = useState<CursorTail<SupportConversation>>({ key: "root", items: [], nextCursor: null, loaded: false, loading: false, error: null });
  const [messageHead, setMessageHead] = useState<CursorTail<SupportMessage>>({ key: "", items: [], nextCursor: null, loaded: false, loading: false, error: null });
  const retryClientMessageId = useRef<string | null>(null);
  const readReceipt = useRef("");

  const listLoader = useCallback((signal: AbortSignal) => listSupportConversations(undefined, signal), []);
  const detailLoader = useCallback((signal: AbortSignal) => getSupportConversation(selectedId!, signal), [selectedId]);
  const messagesLoader = useCallback((signal: AbortSignal) => listSupportMessages(selectedId!, undefined, signal), [selectedId]);
  const constraintsLoader = useCallback((signal: AbortSignal) => getSupportConstraints(signal), []);

  const listResource = usePollingResource<SupportCursorPage<SupportConversation>>("root", listLoader, 30_000);
  const conversationResource = usePollingResource<SupportConversation>(selectedId, detailLoader, 30_000);
  const messagesResource = usePollingResource<SupportCursorPage<SupportMessage>>(selectedId, messagesLoader, 12_000);
  const constraintsResource = usePollingResource<SupportUploadConstraints>("constraints", constraintsLoader, 0);

  const activeConversationTail = conversationTail.key === "root" ? conversationTail : null;
  const conversations = useMemo(
    () => mergeUniqueById(listResource.data?.items || [], activeConversationTail?.items || []),
    [activeConversationTail?.items, listResource.data?.items],
  );
  const conversationNextCursor = activeConversationTail?.loaded
    ? activeConversationTail.nextCursor
    : listResource.data?.nextCursor || null;

  const activeMessageHead = messageHead.key === selectedId ? messageHead : null;
  const messages = useMemo(
    () => mergeUniqueById(activeMessageHead?.items || [], messagesResource.data?.items || []),
    [activeMessageHead?.items, messagesResource.data?.items],
  );
  const messageNextCursor = activeMessageHead?.loaded
    ? activeMessageHead.nextCursor
    : messagesResource.data?.nextCursor || null;

  const selectedSummary = conversations.find((conversation) => conversation.id === selectedId) || null;
  const conversation = conversationResource.data || selectedSummary;
  const constraints = constraintsResource.data || DEFAULT_CONSTRAINTS;

  const visibleConversations = useMemo(() => conversations.filter((candidate) => {
    const active = candidate.status !== "resolved" && candidate.status !== "closed";
    const statusMatches = statusFilter === "all"
      || (statusFilter === "active" ? active : candidate.status === statusFilter);
    const searchMatches = !deferredQuery
      || candidate.subject.toLowerCase().includes(deferredQuery)
      || candidate.lastMessage?.preview.toLowerCase().includes(deferredQuery)
      || candidate.category.toLowerCase().includes(deferredQuery);
    return statusMatches && searchMatches;
  }), [conversations, deferredQuery, statusFilter]);

  const openCount = conversations.filter((candidate) => candidate.status !== "resolved" && candidate.status !== "closed").length;

  useEffect(() => {
    setMessageHead({ key: selectedId || "", items: [], nextCursor: null, loaded: false, loading: false, error: null });
    setPendingFiles([]);
    retryClientMessageId.current = null;
    readReceipt.current = "";
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !(conversationResource.error instanceof SupportApiError) || conversationResource.error.status !== 404) return;
    setNotice("That support request is unavailable or does not belong to this account.");
    setSelectedId(null);
    updateRequestUrl(null);
  }, [conversationResource.error, selectedId]);

  useEffect(() => {
    if (!selectedId || !conversation?.unread.user || !messagesResource.data) return;
    const latestDeveloperReply = messages.findLast((message) => message.senderRole === "agent")?.id || conversation.updatedAt;
    const receipt = `${selectedId}:${latestDeveloperReply}`;
    if (readReceipt.current === receipt) return;
    readReceipt.current = receipt;
    void markSupportConversationRead(selectedId)
      .then(() => Promise.allSettled([listResource.refresh(), conversationResource.refresh()]))
      .catch(() => { readReceipt.current = ""; });
  }, [conversation?.unread.user, conversation?.updatedAt, conversationResource, listResource, messages, messagesResource.data, selectedId]);

  function selectConversation(id: string) {
    if (sending || id === selectedId) return;
    setSelectedId(id);
    setNotice("");
    updateRequestUrl(id);
  }

  function closeConversation() {
    if (sending) return;
    setSelectedId(null);
    setNotice("");
    updateRequestUrl(null);
  }

  async function loadMoreConversations() {
    if (!conversationNextCursor || activeConversationTail?.loading) return;
    const cursor = conversationNextCursor;
    setConversationTail((current) => ({ ...current, key: "root", loading: true, error: null }));
    try {
      const page = await listSupportConversations(cursor);
      setConversationTail((current) => ({
        key: "root",
        items: mergeUniqueById(current.items, page.items),
        nextCursor: page.nextCursor,
        loaded: true,
        loading: false,
        error: null,
      }));
    } catch (reason) {
      setConversationTail((current) => ({ ...current, loading: false, error: reason instanceof Error ? reason : new Error("Older requests could not be loaded.") }));
    }
  }

  async function loadOlderMessages() {
    if (!selectedId || !messageNextCursor || activeMessageHead?.loading) return;
    const conversationId = selectedId;
    const cursor = messageNextCursor;
    setMessageHead((current) => ({
      key: conversationId,
      items: current.key === conversationId ? current.items : [],
      nextCursor: current.key === conversationId ? current.nextCursor : null,
      loaded: current.key === conversationId ? current.loaded : false,
      loading: true,
      error: null,
    }));
    try {
      const page = await listSupportMessages(conversationId, cursor);
      setMessageHead((current) => current.key !== conversationId ? current : {
        key: conversationId,
        items: mergeUniqueById(page.items, current.items),
        nextCursor: page.nextCursor,
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (reason) {
      setMessageHead((current) => current.key !== conversationId ? current : {
        ...current,
        loading: false,
        error: reason instanceof Error ? reason : new Error("Older messages could not be loaded."),
      });
    }
  }

  function addFiles(incoming: File[]) {
    retryClientMessageId.current = null;
    const attachmentLimit = Math.min(constraints.maxAttachmentsPerMessage, constraints.maxPendingUploads);
    const next = [...pendingFiles];
    let validationError = "";
    for (const file of incoming) {
      const isImage = constraints.imageContentTypes.includes(file.type);
      const isVideo = constraints.videoContentTypes.includes(file.type);
      if (!isImage && !isVideo) {
        validationError = `${file.name} is not a supported image or video.`;
        continue;
      }
      const sizeLimit = isImage ? constraints.maxImageBytes : constraints.maxVideoBytes;
      if (file.size > sizeLimit) {
        validationError = `${file.name} exceeds the ${Math.round(sizeLimit / 1024 / 1024)} MB limit.`;
        continue;
      }
      if (next.length >= attachmentLimit) {
        validationError = `A reply can contain up to ${attachmentLimit} attachments.`;
        break;
      }
      const duplicate = next.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
      if (!duplicate) next.push({ id: crypto.randomUUID(), file, progress: 0, state: "queued" });
    }
    setPendingFiles(next);
    setNotice(validationError);
  }

  async function uploadPreparedFile(conversationId: string, prepared: PreparedFile): Promise<string> {
    if (prepared.attachmentId) return prepared.attachmentId;
    setPendingFiles((current) => current.map((item) => item.id === prepared.id ? { ...item, error: undefined, progress: 0, state: "uploading" } : item));
    try {
      const uploaded = await supportUploadAttachment(conversationId, prepared.file, (progress) => {
        setPendingFiles((current) => current.map((item) => item.id === prepared.id ? { ...item, progress, state: "uploading" } : item));
      });
      setPendingFiles((current) => current.map((item) => item.id === prepared.id ? { ...item, attachmentId: uploaded.attachment.id, progress: 100, state: "ready" } : item));
      return uploaded.attachment.id;
    } catch (reason) {
      setPendingFiles((current) => current.map((item) => item.id === prepared.id ? { ...item, error: supportError(reason, `Upload failed for ${prepared.file.name}.`), state: "error" } : item));
      throw reason;
    }
  }

  async function sendMessage(body: string): Promise<boolean> {
    if (!selectedId || sending) return false;
    setSending(true);
    setNotice("");
    try {
      retryClientMessageId.current ||= createSupportClientMessageId();
      const uploadResults = await Promise.allSettled([...pendingFiles].map((file) => uploadPreparedFile(selectedId, file)));
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
      const attachmentIds = uploadResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      await sendSupportMessage(selectedId, {
        body,
        attachmentIds,
        clientMessageId: retryClientMessageId.current,
      });
      setPendingFiles([]);
      retryClientMessageId.current = null;
      await Promise.allSettled([messagesResource.refresh(), conversationResource.refresh(), listResource.refresh()]);
      return true;
    } catch (reason) {
      setNotice(supportError(reason, "Your reply could not be sent. Try again."));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function handleCreated(created: SupportConversation, warning?: string) {
    setSelectedId(created.id);
    updateRequestUrl(created.id);
    setNotice(warning || "Your request was sent to the developer team.");
    setConversationTail({ key: "root", items: [], nextCursor: null, loaded: false, loading: false, error: null });
    await listResource.refresh();
  }

  return (
    <div className={`${styles.supportPage} ${selectedId ? styles.threadOpen : ""}`}>
      <h1 className="sr-only">Asset Insight support</h1>
      <header className={styles.pageHeader}>
        <div>
          <h2>Support</h2>
          <p>Get help from the Asset Insight developer team.</p>
        </div>
        <div className={styles.pageHeaderActions}>
          <button className={styles.iconButton} type="button" onClick={() => void listResource.refresh()} aria-label="Refresh your support requests" title="Refresh requests">
            <RefreshCw size={17} aria-hidden="true" />
          </button>
          <button className={styles.button} type="button" onClick={() => setNewRequestOpen(true)}>
            <Plus size={17} aria-hidden="true" />New request
          </button>
        </div>
      </header>

      <section className={styles.workspace} aria-label="Your support workspace">
        <aside className={styles.conversationRail} aria-label="Your support requests">
          <div className={styles.listHeader}>
            <div><h2>My requests</h2><span>{openCount} active</span></div>
          </div>
          <div className={styles.inboxFilters}>
            <label className={styles.searchWrap}>
              <span className="sr-only">Search your requests</span>
              <Search className={styles.searchIcon} size={16} aria-hidden="true" />
              <input className={styles.search} type="search" placeholder="Search requests" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label>
              <span className="sr-only">Filter your requests by status</span>
              <select className={styles.select} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                <option value="active">Active</option>
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="waiting_on_user">Waiting for you</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </label>
          </div>
          <div className={styles.conversationListScroller}>
            {listResource.error && !conversations.length ? (
              <div className={styles.errorState} role="alert">
                <AlertCircle size={22} aria-hidden="true" />
                <strong>Requests unavailable</strong>
                <span>{supportError(listResource.error, "Your requests could not be loaded.")}</span>
                <button type="button" onClick={() => void listResource.refresh()}>Try again</button>
              </div>
            ) : !listResource.loading && !conversations.length ? (
              <div className={styles.emptyList}>
                <Inbox size={25} aria-hidden="true" />
                <strong>No support requests yet</strong>
                <span>Create one when you need help, want to report a problem, or have an idea.</span>
                <button className={styles.button} type="button" onClick={() => setNewRequestOpen(true)}>Create request</button>
              </div>
            ) : (
              <ConversationList
                conversations={visibleConversations}
                selectedId={selectedId}
                loading={listResource.loading}
                loadingMore={Boolean(activeConversationTail?.loading)}
                loadMoreError={activeConversationTail?.error ? supportError(activeConversationTail.error, "Older requests could not be loaded.") : null}
                hasMore={Boolean(conversationNextCursor)}
                disabled={sending}
                onSelect={selectConversation}
                onLoadMore={() => void loadMoreConversations()}
              />
            )}
          </div>
        </aside>

        <section className={styles.threadPanel} aria-label="Selected developer conversation">
          {selectedId && !conversation && conversationResource.error ? (
            <div className={styles.threadPlaceholder} role="alert">
              <AlertCircle size={25} aria-hidden="true" />
              <h2>Request unavailable</h2>
              <p>{supportError(conversationResource.error, "This request could not be loaded.")}</p>
              <button className={styles.buttonSecondary} type="button" onClick={() => void conversationResource.refresh()}>Try again</button>
            </div>
          ) : (
            <MessageThread
              key={conversation?.id || "empty-thread"}
              conversation={conversation}
              messages={messages}
              loading={conversationResource.loading || messagesResource.loading}
              messagesError={messagesResource.error ? supportError(messagesResource.error, "Messages could not be loaded.") : null}
              olderMessagesError={activeMessageHead?.error ? supportError(activeMessageHead.error, "Older messages could not be loaded.") : null}
              hasOlderMessages={Boolean(messageNextCursor)}
              loadingOlderMessages={Boolean(activeMessageHead?.loading)}
              pendingFiles={pendingFiles}
              acceptedTypes={[...constraints.imageContentTypes, ...constraints.videoContentTypes].join(",")}
              sending={sending}
              onBack={closeConversation}
              onFiles={addFiles}
              onRemoveFile={(id) => {
                retryClientMessageId.current = null;
                setPendingFiles((current) => current.filter((item) => item.id !== id));
              }}
              onDraftChanged={() => { retryClientMessageId.current = null; }}
              onRetryMessages={() => void messagesResource.refresh()}
              onLoadOlderMessages={() => void loadOlderMessages()}
              onSend={sendMessage}
              onCreateRequest={() => setNewRequestOpen(true)}
            />
          )}
        </section>
      </section>

      <NewSupportRequest
        open={newRequestOpen}
        constraints={constraints}
        onClose={() => setNewRequestOpen(false)}
        onCreated={handleCreated}
      />

      {notice ? (
        <div className={styles.notice} role="status" aria-live="polite">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}
