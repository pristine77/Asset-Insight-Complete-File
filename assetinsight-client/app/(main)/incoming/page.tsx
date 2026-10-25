"use client";

import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  FileCheck2,
  FileText,
  Inbox,
  ListTree,
  LockKeyhole,
  MapPin,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import Loading from "@/components/common/Loading";
import { useAuthContext } from "@/context/AuthContext";
import AuctioneerService, {
  type AuctioneerContractReopen,
  type AuctioneerIncomingItem,
  type AuctioneerReportType,
} from "@/services/auctioneer";
import { navigateToReportForm } from "@/services/reportFormNavigation";
import AuctioneerReopenAction from "@/components/reports/AuctioneerReopenAction";
import { captureAuthSession } from "@/lib/auth-storage";
import styles from "./Incoming.module.css";

type IncomingData = {
  items: AuctioneerIncomingItem[];
  warning: string | null;
  integrationAvailable: boolean;
};

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function messageFor(error: unknown, fallback: string) {
  const candidate = error as {
    response?: { status?: number; data?: { message?: string; error?: string } };
    message?: string;
  };
  if (candidate.response?.status === 409) {
    return "Another user claimed this contract first. The queue has been refreshed.";
  }
  return (
    candidate.response?.data?.message ||
    candidate.response?.data?.error ||
    candidate.message ||
    fallback
  );
}

function displayDate(value?: string) {
  if (!value) return "Not supplied";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : DATE.format(parsed);
}

function ownerLabel(item: AuctioneerIncomingItem) {
  if (!item.claimedBy) return "another user";
  if (typeof item.claimedBy === "string") return "another user";
  return (
    item.claimedBy.name ||
    item.claimedBy.username ||
    item.claimedBy.email ||
    "another user"
  );
}

function statusLabel(item: AuctioneerIncomingItem, mine: boolean) {
  if (item.status === "sent") return { label: "Sent", tone: "sent" };
  if (item.status === "report_created") {
    return { label: mine ? "Your report" : "Report created", tone: "created" };
  }
  if (item.status === "claimed") {
    return {
      label: mine ? "Claimed by you" : "Claimed",
      tone: mine ? "mine" : "claimed",
    };
  }
  return { label: "Available", tone: "available" };
}

async function incomingFetcher(): Promise<IncomingData> {
  const [incomingResult, statusResult] = await Promise.allSettled([
    AuctioneerService.getIncoming(),
    AuctioneerService.getStatus(),
  ]);
  const items =
    incomingResult.status === "fulfilled" ? incomingResult.value : [];

  if (statusResult.status === "fulfilled") {
    const status = statusResult.value;
    if (!status.enabled || !status.configured) {
      return {
        items: [],
        integrationAvailable: false,
        warning: !status.enabled
          ? "Incoming is currently disabled by your administrator."
          : "Incoming needs an Auctioneer connection before contracts can be loaded.",
      };
    }
    if (status.reachable === false && incomingResult.status === "rejected") {
      throw new Error(status.message || "Auctioneer is temporarily unavailable.");
    }
  }

  if (incomingResult.status === "rejected") throw incomingResult.reason;
  return { items, integrationAvailable: true, warning: null };
}

function visibleRefreshInterval() {
  if (typeof document === "undefined") return 60_000;
  return document.visibilityState === "visible" && navigator.onLine
    ? 60_000
    : 0;
}

export default function IncomingPage() {
  const { user, sessionPresent } = useAuthContext();
  const userId = user?._id || user?.id;
  const requestOwner = userId || (sessionPresent ? "pending-session" : null);
  const router = useRouter();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [reportType, setReportType] =
    useState<AuctioneerReportType>("asset");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const reopenBusy = useRef<symbol | null>(null);
  const sessionRevision = captureAuthSession().revision;
  const onReopenBusyChange = useCallback((busy: boolean, operation: symbol) => {
    if (busy) {
      reopenBusy.current = operation;
      setBusyAction("reopen");
    } else if (reopenBusy.current === operation) {
      reopenBusy.current = null;
      setBusyAction(null);
    }
  }, []);

  const {
    data,
    error: loadError,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<IncomingData>(
    requestOwner ? ["auctioneer/incoming", requestOwner] : null,
    incomingFetcher,
    {
      keepPreviousData: false,
      refreshInterval: visibleRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
    }
  );
  const items = data?.items ?? [];
  const [queueTab, setQueueTab] = useState<"outstanding" | "completed">("outstanding");

  const isMine = useCallback(
    (item: AuctioneerIncomingItem) => {
      if (item.claimedByMe) return true;
      if (!userId || !item.claimedBy) return false;
      if (typeof item.claimedBy === "string") return item.claimedBy === userId;
      return (item.claimedBy._id || item.claimedBy.id) === userId;
    },
    [userId]
  );

  const selected = useMemo(
    () => items.find((item) => item.cycleKey === selectedKey) ?? null,
    [items, selectedKey]
  );
  const availableCount = items.filter(
    (item) => item.status === "available"
  ).length;
  const mineCount = items.filter(isMine).length;

  /*
     WORK STILL TO DO, AND WORK ALREADY SENT BACK.

     Everything assigned to an account stayed in one list, so a contract whose
     report had gone back to Auctioneer sat among the ones still waiting and had
     to be recognised by its status badge. On a queue of nine that is merely
     untidy; the queue is what somebody works down each morning, and the two
     kinds of row want different things from them.

     "sent" is the only finished state — the report has gone back to Auctioneer
     and there is nothing further to do here. Everything else is outstanding,
     including "abandoned": work given up on is not work completed, and leaving
     it in front of somebody is the point.
  */
  const completedItems = items.filter((item) => item.status === "sent");
  const outstandingItems = items.filter((item) => item.status !== "sent");
  const visibleItems = queueTab === "completed" ? completedItems : outstandingItems;

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selected, selectedKey]);

  useEffect(() => {
    if (selected?.selectedReportType) {
      setReportType(selected.selectedReportType);
    } else {
      setReportType("asset");
    }
    setActionError(null);
  }, [selected?.cycleKey, selected?.selectedReportType]);

  const refresh = useCallback(
    async (force = false) => {
      setActionError(null);
      if (force) {
        await mutate(async () => {
          const [items, status] = await Promise.all([
            AuctioneerService.getIncoming(true),
            AuctioneerService.getStatus(),
          ]);
          if (!status.enabled || !status.configured) {
            return {
              items: [],
              integrationAvailable: false,
              warning: !status.enabled
                ? "Incoming is currently disabled by your administrator."
                : "Incoming needs an Auctioneer connection before contracts can be loaded.",
            };
          }
          return { items, integrationAvailable: true, warning: null };
        }, { revalidate: false });
      } else {
        await mutate();
      }
      if (userId) {
        void mutateGlobal(["auctioneer/navigation-summary", userId]);
      }
    },
    [mutate, mutateGlobal, userId]
  );

  const onReopened = useCallback(async (receipt: AuctioneerContractReopen, isCurrent: () => boolean) => {
    // Retain the confirmed revision even if the following queue read fails.
    if (!isCurrent()) return false;
    await mutate((previous) => previous ? {
      ...previous,
      items: previous.items.map((item) => item.contractId === receipt.contractId
        ? { ...item, accessRevision: receipt.accessRevision } : item),
    } : previous, { revalidate: false });
    if (!isCurrent()) return false;
    const refreshed = await AuctioneerService.getIncoming(true);
    if (!isCurrent()) return false;
    const next = refreshed.find((item) => item.contractId === receipt.contractId && item.status !== "sent" &&
      item.accessRevision === receipt.accessRevision);
    if (!next) return false;
    // Adopt the row and its selection together. Publishing the queue first can
    // unmount the completed row and revoke this very handoff before selection.
    setSelectedKey(next.cycleKey);
    setQueueTab("outstanding");
    await mutate({ items: refreshed, integrationAvailable: true, warning: null }, { revalidate: false });
    if (userId) void mutateGlobal(["auctioneer/navigation-summary", userId]);
    return true;
  }, [mutate, mutateGlobal, userId]);

  const openSetup = useCallback(
    async (item: AuctioneerIncomingItem) => {
      if (!item.workItemId || reopenBusy.current) return;
      setBusyAction(`open:${item.workItemId}`);
      setActionError(null);
      try {
        const nextSetup = await AuctioneerService.getSetup(item.workItemId);
        navigateToReportForm(router, {
          kind:
            nextSetup.reportType === "lotListing" ? "lot-listing" : "asset",
          auctioneer: nextSetup,
          returnTo: "/incoming",
        });
      } catch (error) {
        setActionError(messageFor(error, "Unable to resume this contract."));
      } finally {
        setBusyAction(null);
      }
    },
    [router]
  );

  const claim = useCallback(async () => {
    if (!selected || selected.status !== "available" || busyAction || reopenBusy.current) return;
    setBusyAction(`claim:${selected.cycleKey}`);
    setActionError(null);
    try {
      const nextSetup = await AuctioneerService.claim(
        selected.cycleKey,
        reportType
      );
      setSelectedKey(null);
      await refresh();
      navigateToReportForm(router, {
        kind:
          nextSetup.reportType === "lotListing" ? "lot-listing" : "asset",
        auctioneer: nextSetup,
        returnTo: "/incoming",
      });
    } catch (error) {
      const claimError = messageFor(
        error,
        "This contract could not be claimed. Try again."
      );
      await refresh();
      setActionError(claimError);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refresh, reportType, router, selected]);

  const release = useCallback(async () => {
    if (!selected?.workItemId || busyAction || reopenBusy.current) return;
    setBusyAction(`release:${selected.workItemId}`);
    setActionError(null);
    try {
      await AuctioneerService.releaseClaim(selected.workItemId);
      setSelectedKey(null);
      await refresh();
    } catch (error) {
      setActionError(
        messageFor(
          error,
          "The claim could not be released. It may already have a report."
        )
      );
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refresh, selected]);

  const primaryAction = useCallback(() => {
    if (!selected || reopenBusy.current) return;
    const mine = isMine(selected);
    if (
      mine &&
      (selected.status === "report_created" || selected.status === "sent")
    ) {
      /*
         Name the contract, so My Reports can narrow to it. This used to push
         the bare list and leave the reader to find one row among dozens, which
         is indistinguishable from the button doing nothing at all.

         Falling back to the bare list when the number is missing: a queue row
         can render as "Number unavailable", and a link to ?contract= with
         nothing after it would narrow the list to no rows, which is worse than
         showing all of them.
      */
      const contractNo = (selected.contractNo ?? "").trim();
      router.push(
        contractNo ? `/reports?search=${encodeURIComponent(contractNo)}` : "/reports"
      );
      return;
    }
    if (mine && selected.workItemId) {
      void openSetup(selected);
      return;
    }
    if (selected.status === "available") void claim();
  }, [claim, isMine, openSetup, router, selected]);

  if (isLoading) {
    return (
      <div className="app-page">
        <div className="app-surface">
          <Loading message="Loading incoming contracts…" className="min-h-[60vh]" />
        </div>
      </div>
    );
  }

  const visibleError = actionError || (loadError
    ? messageFor(loadError, "Unable to load incoming contracts.")
    : null);
  const selectedMine = selected ? isMine(selected) : false;
  const selectedBlocked =
    Boolean(selected) && selected?.status !== "available" && !selectedMine;
  const canRelease =
    selectedMine &&
    selected?.status === "claimed" &&
    Boolean(selected.workItemId);

  return (
    <div className="app-page app-page-stack">
      <header className={`app-surface ${styles.header}`}>
        <div>
          <span className="app-kicker">Auctioneer workspace</span>
          <h1 className="app-title" style={{ marginTop: 5 }}>
            Incoming
          </h1>
          <p className="app-subtitle">
            Review the Auctioneer lots assigned to you, claim a workflow, and
            continue existing work without losing queue context.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className="app-button app-button--secondary"
            disabled={isValidating}
            onClick={() => void refresh(true)}
          >
            <RefreshCw
              size={16}
              className={isValidating ? "animate-spin" : undefined}
              aria-hidden
            />
            {isValidating ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {visibleError ? (
        <div className="app-alert app-alert--error" role="alert">
          <LockKeyhole size={18} aria-hidden />
          <span style={{ flex: 1 }}>{visibleError}</span>
          <button className="app-button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {data?.warning ? (
        <div className="app-alert app-alert--warning" role="status">
          <PackageOpen size={18} aria-hidden />
          <span>{data.warning}</span>
        </div>
      ) : null}

      <section className={`app-surface ${styles.summary}`} aria-label="Queue summary">
        <div className={styles.summaryItem}>
          Available batches{" "}
          <span className={styles.summaryValue}>{availableCount}</span>
        </div>
        <div className={styles.summaryItem}>
          Claimed by you <span className={styles.summaryValue}>{mineCount}</span>
        </div>
        <div className={styles.summaryItem}>
          Assigned batches{" "}
          <span className={styles.summaryValue}>{items.length}</span>
        </div>
        <div className={styles.live}>
          <span className={styles.liveDot} aria-hidden />
          Updates every minute while this page is visible
        </div>
      </section>

      <section className={styles.workspace}>
        <div className={`app-surface ${styles.tableSurface}`}>
          <div className={styles.tableHeader}>
            <div>
              <h2 className={styles.tableTitle}>Assigned contract queue</h2>
              <p className={styles.tableSubtitle}>
                {queueTab === "completed"
                  ? "Reports already sent back to Auctioneer. Select a contract to check whether more lots can be added."
                  : "Each row contains only the lots assigned to your account."}
              </p>
            </div>
            {/*
              Counts on the tabs rather than only in the summary above, so the
              number of rows on screen is always explained by the tab you are
              standing on.
            */}
            <div className={styles.tabs} role="tablist" aria-label="Queue">
              <button
                type="button"
                role="tab"
                aria-selected={queueTab === "outstanding"}
                onClick={() => {
                  setQueueTab("outstanding");
                  setSelectedKey(null);
                }}
                className={`${styles.tab} ${queueTab === "outstanding" ? styles.tabActive : ""}`}
              >
                Outstanding <span className={styles.tabCount}>{outstandingItems.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={queueTab === "completed"}
                onClick={() => {
                  setQueueTab("completed");
                  setSelectedKey(null);
                }}
                className={`${styles.tab} ${queueTab === "completed" ? styles.tabActive : ""}`}
              >
                Completed <span className={styles.tabCount}>{completedItems.length}</span>
              </button>
            </div>
          </div>

          {!visibleItems.length ? (
            <div className={styles.emptyTable}>
              <div>
                <span className={styles.emptyIcon}>
                  <Inbox size={22} aria-hidden />
                </span>
                <h2 className={styles.emptyTitle}>
                  {data?.integrationAvailable === false
                    ? "Incoming is not configured"
                    : queueTab === "completed"
                      ? "Nothing sent back yet"
                      : items.length
                        ? "Everything assigned is done"
                        : "No assigned lots"}
                </h2>
                <p className={styles.emptyCopy}>
                  {data?.integrationAvailable === false
                    ? "Connect or enable Auctioneer in the server configuration to load this queue."
                    : queueTab === "completed"
                      ? "Reports you send back to Auctioneer will be listed here."
                      : items.length
                        ? "Every contract assigned to you has been sent back to Auctioneer. They are on the Completed tab."
                        : "No Auctioneer lots are currently assigned to your account."}
                </p>
                <button
                  className="app-button app-button--secondary"
                  onClick={() => void refresh(true)}
                >
                  <RefreshCw size={15} aria-hidden />
                  Check again
                </button>
              </div>
            </div>
          ) : (
            <div className="app-table-wrap">
              <table className={`app-table app-table--responsive ${styles.incomingTable}`}>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Description</th>
                    <th>Customer</th>
                    <th>Consignor</th>
                    <th>Salesperson</th>
                    <th>Event</th>
                    <th>Assigned lots</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const mine = isMine(item);
                    const status = statusLabel(item, mine);
                    const blocked = item.status !== "available" && !mine;
                    return (
                      <tr
                        className={styles.row}
                        data-selected={selectedKey === item.cycleKey}
                        key={item.cycleKey}
                        onClick={() => setSelectedKey(item.cycleKey)}
                      >
                        <td className={styles.primaryCell} data-label="Contract">
                          <div className={styles.contractNo}>
                            {item.contractNo || "Number unavailable"}
                          </div>
                          <div className={styles.contractMeta}>
                            {item.location || "Location not supplied"}
                          </div>
                        </td>
                        <td
                          className={styles.descriptionCell}
                          data-label="Description"
                          title={item.description || undefined}
                        >
                          {item.description || "Not supplied"}
                        </td>
                        <td className={styles.contactCell} data-label="Customer">
                          {item.customerName || "Not supplied"}
                        </td>
                        <td className={styles.contactCell} data-label="Consignor">
                          {item.consignorName || "Not supplied"}
                        </td>
                        <td className={styles.contactCell} data-label="Salesperson">
                          {item.salespersonName || "Not supplied"}
                        </td>
                        <td data-label="Event">
                          <div>{item.eventTitle || "Not supplied"}</div>
                          <div className={styles.contractMeta}>
                            {displayDate(item.eventDate)}
                          </div>
                        </td>
                        <td data-label="Assigned lots">
                          {item.lotCount}{" "}
                          <span className={styles.contractMeta}>
                            {item.kind === "scheduleA" ? "Schedule A" : "Unknown"}
                          </span>
                        </td>
                        <td data-label="Status">
                          <span className={styles.status} data-tone={status.tone}>
                            {blocked ? <LockKeyhole size={12} aria-hidden /> : null}
                            {status.label}
                          </span>
                        </td>
                        <td data-label="">
                          <button
                            className={`app-button app-button--icon ${styles.rowAction}`}
                            aria-label={`Review ${item.contractNo || "contract"}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedKey(item.cycleKey);
                            }}
                          >
                            <ArrowRight size={16} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <button
          className={styles.mobilePanelBackdrop}
          data-open={Boolean(selected)}
          aria-label="Close contract details"
          onClick={() => setSelectedKey(null)}
        />
        <aside
          className={`app-surface ${styles.detailPanel}`}
          data-open={Boolean(selected)}
          aria-label="Selected contract"
        >
          {selected ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <h2 className={styles.detailTitle}>
                    {selected.contractNo || "Selected contract"}
                  </h2>
                  <p className={styles.detailSubtitle}>
                    {selectedMine
                      ? "This work item is assigned to you."
                      : selected.status === "available"
                        ? "Choose the report workflow to claim."
                        : `Claimed by ${ownerLabel(selected)}.`}
                  </p>
                </div>
                <button
                  className={`app-button app-button--icon ${styles.closeDetail}`}
                  onClick={() => setSelectedKey(null)}
                  aria-label="Close contract details"
                >
                  <X size={18} aria-hidden />
                </button>
              </div>
              <div className={styles.detailBody}>
                <dl className={styles.detailList}>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <UserRound className={styles.detailIcon} size={17} aria-hidden />
                      <span>Customer</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.customerName || "Not supplied"}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <UserRound className={styles.detailIcon} size={17} aria-hidden />
                      <span>Consignor</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.consignorName || "Not supplied"}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <UserRound className={styles.detailIcon} size={17} aria-hidden />
                      <span>Salesperson</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.salespersonName || "Not supplied"}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <FileText className={styles.detailIcon} size={17} aria-hidden />
                      <span>Description</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.description || "Not supplied"}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <CalendarDays className={styles.detailIcon} size={17} aria-hidden />
                      <span>Event</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.eventTitle || "Not supplied"} ·{" "}
                      {displayDate(selected.eventDate)}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <MapPin className={styles.detailIcon} size={17} aria-hidden />
                      <span>Location</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.location || "Not supplied"}
                    </dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>
                      <ListTree className={styles.detailIcon} size={17} aria-hidden />
                      <span>Assigned scope</span>
                    </dt>
                    <dd className={styles.detailValue}>
                      {selected.lotCount} assigned lots ·{" "}
                      {selected.kind === "scheduleA"
                        ? "Schedule A"
                        : "Unknown lots"}
                    </dd>
                  </div>
                </dl>

                {selected.status === "available" ? (
                  <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className={styles.detailLabel} style={{ marginBottom: 8 }}>
                      Report type
                    </legend>
                    <div className={styles.reportTypes}>
                      <button
                        className={styles.reportType}
                        data-selected={reportType === "asset"}
                        onClick={() => setReportType("asset")}
                        role="radio"
                        aria-checked={reportType === "asset"}
                      >
                        <span className={styles.radio} aria-hidden />
                        <span>
                          <span className={styles.reportTypeTitle}>Asset report</span>
                          <span className={styles.reportTypeHint}>
                            Structured valuation report and media.
                          </span>
                        </span>
                      </button>
                      <button
                        className={styles.reportType}
                        data-selected={reportType === "lotListing"}
                        onClick={() => setReportType("lotListing")}
                        role="radio"
                        aria-checked={reportType === "lotListing"}
                      >
                        <span className={styles.radio} aria-hidden />
                        <span>
                          <span className={styles.reportTypeTitle}>Lot listing</span>
                          <span className={styles.reportTypeHint}>
                            Auction-ready lots and descriptions.
                          </span>
                        </span>
                      </button>
                    </div>
                  </fieldset>
                ) : selectedBlocked ? (
                  <div className="app-alert">
                    <LockKeyhole size={17} aria-hidden />
                    Claimed by {ownerLabel(selected)}. It will remain visible so
                    you can track its status.
                  </div>
                ) : null}

                <div className={styles.detailActions}>
                  {selected.contractId ? (
                    <AuctioneerReopenAction
                      key={`${userId}:${sessionRevision}:${selected.cycleKey}`}
                      item={selected}
                      busy={Boolean(busyAction)}
                      onBusyChange={onReopenBusyChange}
                      onReopened={onReopened}
                    />
                  ) : null}
                  <button
                    className="app-button app-button--primary"
                    disabled={selectedBlocked || Boolean(busyAction)}
                    onClick={primaryAction}
                  >
                    {busyAction ? (
                      <span className="app-spinner" style={{ width: 16, height: 16 }} />
                    ) : selectedMine &&
                      (selected.status === "report_created" ||
                        selected.status === "sent") ? (
                      <FileCheck2 size={16} aria-hidden />
                    ) : selectedMine ? (
                      <ArrowRight size={16} aria-hidden />
                    ) : (
                      <Building2 size={16} aria-hidden />
                    )}
                    {busyAction
                      ? "Working…"
                      : selectedMine &&
                          (selected.status === "report_created" ||
                            selected.status === "sent")
                        ? "Open report"
                        : selectedMine
                          ? "Resume report"
                          : selected.status === "available"
                            ? "Claim and create report"
                            : "Unavailable"}
                  </button>
                  {canRelease ? (
                    <button
                      className="app-button app-button--secondary"
                      disabled={Boolean(busyAction)}
                      onClick={() => void release()}
                    >
                      <RotateCcw size={15} aria-hidden />
                      Release claim
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className={styles.emptyPanel}>
              Select a contract from the queue to review details and available
              actions.
            </div>
          )}
        </aside>
      </section>

    </div>
  );
}
