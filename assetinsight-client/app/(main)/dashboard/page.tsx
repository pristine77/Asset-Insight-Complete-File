"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Building2,
  CarFront,
  ChevronRight,
  FilePlus2,
  FileText,
  Inbox,
  Layers3,
  MoreHorizontal,
  Tag,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import BottomDrawer from "@/components/BottomDrawer";
import Loading from "@/components/common/Loading";
import { WorkspaceClock } from "@/components/dashboard/WorkspaceClock";
import { ReportThumbnail } from "@/components/reports/ReportThumbnail";
import { useAuthContext } from "@/context/AuthContext";
import { AuctioneerService } from "@/services/auctioneer";
import { salvageStatusPath } from "@/services/salvage";
import {
  DashboardService,
  type DashboardAnalytics,
  type DashboardRange,
} from "@/services/dashboard";
import {
  draftKindForRecord,
  type ReportDraftRecord,
} from "@/services/reportDrafts";
import { navigateToReportForm } from "@/services/reportFormNavigation";
import type { SavedInput } from "@/services/savedInputs";
import {
  ReportsService,
  type PdfReport,
} from "@/services/reports";
import styles from "./Dashboard.module.css";

const RealEstateForm = dynamic(() => import("@/components/forms/RealEstateForm"), {
  ssr: false,
  loading: () => <Loading message="Loading real estate workflow…" />,
});
const SalvageForm = dynamic(() => import("@/components/forms/SalvageForm"), {
  ssr: false,
  loading: () => <Loading message="Loading salvage workflow…" />,
});
const ActivityChart = dynamic(
  () => import("@/components/dashboard/ActivityChart"),
  {
    ssr: false,
    loading: () => <div className={styles.chartLoading}><span className="app-spinner" /></div>,
  }
);
const LeaderboardModal = dynamic(
  () => import("@/components/dashboard/LeaderboardModal"),
  { ssr: false }
);
type DrawerType = "real-estate" | "salvage" | null;

type IncomingSummary = {
  availableCount: number;
  showBadge: boolean;
};

const DRAWER_TITLES: Record<Exclude<DrawerType, null>, string> = {
  "real-estate": "Create real estate report",
  salvage: "Create salvage report",
};

const REPORT_ACTIONS = [
  {
    key: "asset" as const,
    title: "Asset Report",
    icon: FileText,
  },
  {
    key: "lot-listing" as const,
    title: "Lot Listing",
    icon: Tag,
  },
  {
    key: "real-estate" as const,
    title: "Real Estate",
    icon: Building2,
  },
  {
    key: "salvage" as const,
    title: "Salvage",
    icon: CarFront,
  },
] as const;

const REPORT_CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const UPDATED_DATE = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  year: "numeric",
});

function latestReports(values: PdfReport[] = []) {
  const grouped = new Map<string, PdfReport>();

  values.forEach((report) => {
    const key = String(report.report || report._id);
    const existing = grouped.get(key);
    if (
      !existing ||
      new Date(report.createdAt).getTime() >
        new Date(existing.createdAt).getTime()
    ) {
      grouped.set(key, report);
    }
  });

  return Array.from(grouped.values())
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, 5);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function navSummaryFetcher(): Promise<IncomingSummary> {
  return Promise.all([
    AuctioneerService.getStatus(),
    AuctioneerService.getIncomingSummary(),
  ]).then(([status, summary]) => ({
    availableCount: summary.availableCount,
    showBadge: status.enabled && status.configured,
  }));
}

function visibleRefreshInterval() {
  if (
    typeof document === "undefined" ||
    typeof navigator === "undefined"
  ) {
    return 60_000;
  }
  return document.visibilityState === "visible" && navigator.onLine
    ? 60_000
    : 0;
}

function formatReportValue(value?: string) {
  if (!value) return "—";
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? REPORT_CURRENCY.format(parsed) : value;
}

function reportTitle(report: PdfReport) {
  return (
    report.filename?.replace(/\.(pdf|docx?|xlsx)$/i, "") ||
    report.address ||
    report.contract_no ||
    "Untitled report"
  );
}

function reportStatus(report: PdfReport) {
  if (report.downloadable === false) {
    return { label: "Generating", tone: "info" };
  }
  if (report.approvalStatus === "pending") {
    return { label: "In review", tone: "warning" };
  }
  if (report.approvalStatus === "rejected") {
    return { label: "Needs changes", tone: "danger" };
  }
  return { label: "Ready", tone: "success" };
}

function typeLabel(report: PdfReport) {
  const value = String(report.type || report.fileType || "").toLowerCase();
  if (value.includes("real")) return "Real Estate";
  if (value.includes("lot")) return "Lot Listing";
  if (value.includes("salvage")) return "Salvage";
  return "Asset Report";
}

function Metric({
  label,
  value,
  icon: Icon,
  emphasized = false,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  emphasized?: boolean;
}) {
  return (
    <div className={styles.metric} data-emphasized={emphasized}>
      <div>
        <div className={styles.metricLabel}>{label}</div>
        <div className={styles.metricValue}>{value}</div>
      </div>
      <span className={styles.metricIcon}>
        <Icon size={25} strokeWidth={1.75} aria-hidden />
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const { user, sessionPresent } = useAuthContext();
  const userId = user?._id || user?.id;
  const requestOwner = userId || (sessionPresent ? "pending-session" : null);
  const router = useRouter();
  const [drawerType, setDrawerType] = useState<DrawerType>(null);
  const [formUploading, setFormUploading] = useState(false);
  const formUploadingRef = useRef(false);
  const handleFormUploading = useCallback((uploading: boolean) => {
    formUploadingRef.current = uploading;
    setFormUploading(uploading);
  }, []);
  const [greetingLabel] = useState(greeting);
  const [range, setRange] = useState<DashboardRange>(31);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const {
    data: analytics,
    error: analyticsError,
    isLoading: analyticsLoading,
    mutate: mutateAnalytics,
  } = useSWR<DashboardAnalytics>(
    requestOwner ? ["dashboard/activity", requestOwner, range] : null,
    () => DashboardService.getAnalytics(range),
    { keepPreviousData: true, revalidateOnFocus: true }
  );
  const {
    data: allReports,
    error: reportsError,
    isLoading: reportsLoading,
    mutate: mutateReports,
  } = useSWR<PdfReport[]>(
    requestOwner ? ["dashboard/recent-reports", requestOwner] : null,
    ReportsService.getMyReports,
    { keepPreviousData: false }
  );
  const {
    data: incomingSummary,
    error: incomingError,
    isLoading: incomingLoading,
  } = useSWR<IncomingSummary>(
    requestOwner ? ["auctioneer/navigation-summary", requestOwner] : null,
    navSummaryFetcher,
    {
      keepPreviousData: false,
      refreshInterval: visibleRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
    }
  );

  const recent = useMemo(() => latestReports(allReports), [allReports]);

  const refreshDashboard = useCallback(() => {
    void Promise.all([mutateAnalytics(), mutateReports()]);
  }, [mutateAnalytics, mutateReports]);

  useEffect(() => {
    window.addEventListener("cv:report-created", refreshDashboard);
    return () =>
      window.removeEventListener("cv:report-created", refreshDashboard);
  }, [refreshDashboard]);

  useEffect(() => {
    const openAsset = (event: Event) => {
      const savedInput = (event as CustomEvent<SavedInput>).detail;
      if (!savedInput) return;
      navigateToReportForm(router, {
        kind: "asset",
        savedInput,
        returnTo: "/dashboard",
      });
    };
    const openRealEstate = (event: Event) => {
      if ((event as CustomEvent).detail) {
        setDrawerType("real-estate");
      }
    };
    const resumeLocalDraft = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          kind?: "asset" | "lot-listing";
          scopeId?: string;
        }>
      ).detail;
      const kind = detail?.kind;
      if (kind !== "asset" && kind !== "lot-listing") return;
      navigateToReportForm(router, {
        kind,
        resumeLocalDraftScopeId: detail?.scopeId,
        returnTo: "/dashboard",
      });
    };
    const resumeServerDraft = (event: Event) => {
      const draft = (event as CustomEvent<ReportDraftRecord>).detail;
      if (!draft?._id) return;
      const kind = draftKindForRecord(draft);
      navigateToReportForm(router, {
        kind,
        resumeDraft: draft,
        returnTo: "/dashboard",
      });
    };
    window.addEventListener("load-saved-input", openAsset);
    window.addEventListener("load-realestate-input", openRealEstate);
    window.addEventListener("resume-local-draft", resumeLocalDraft);
    window.addEventListener("resume-report-draft", resumeServerDraft);
    return () => {
      window.removeEventListener("load-saved-input", openAsset);
      window.removeEventListener("load-realestate-input", openRealEstate);
      window.removeEventListener("resume-local-draft", resumeLocalDraft);
      window.removeEventListener("resume-report-draft", resumeServerDraft);
    };
  }, [router]);

  useEffect(() => {
    const serialized = window.sessionStorage.getItem("cv:resume-report-draft");
    if (!serialized) return;
    window.sessionStorage.removeItem("cv:resume-report-draft");
    try {
      const draft = JSON.parse(serialized) as ReportDraftRecord;
      if (!draft?._id) return;
      navigateToReportForm(router, {
        kind: draftKindForRecord(draft),
        resumeDraft: draft,
        returnTo: "/dashboard",
      });
    } catch {
      // A malformed navigation handoff must not prevent the dashboard loading.
    }
  }, [router]);

  const closeDrawer = useCallback(() => {
    if (formUploadingRef.current) return;
    setDrawerType(null);
    refreshDashboard();
  }, [refreshDashboard]);

  const error = analyticsError || reportsError;
  const displayName = user?.username || user?.email?.split("@")[0] || "there";
  const incomingCount = incomingSummary?.availableCount ?? 0;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.title} suppressHydrationWarning>
            {greetingLabel}, {displayName}
          </h1>
          <p className={styles.subtitle}>
            <WorkspaceClock />
            <span className={styles.subtitleDivider} aria-hidden>
              •
            </span>
            <span>Keep reporting work moving from one place.</span>
          </p>
        </div>
        <button
          className={styles.createButton}
          onClick={() =>
            navigateToReportForm(router, {
              kind: "asset",
              returnTo: "/dashboard",
            })
          }
        >
          <FilePlus2 size={21} strokeWidth={1.8} aria-hidden />
          Create report
        </button>
      </header>

      {error ? (
        <div className="app-alert app-alert--error" role="alert">
          <span>
            We couldn’t load all dashboard data. Your report workflows are
            still available.
          </span>
          <button className="app-button" onClick={refreshDashboard}>
            Retry
          </button>
        </div>
      ) : null}

      <section className={styles.workflowStrip} aria-label="Create a report">
        {REPORT_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.key}
              className={styles.workflowButton}
              onClick={() => {
                if (action.key === "asset" || action.key === "lot-listing") {
                  navigateToReportForm(router, {
                    kind: action.key,
                    returnTo: "/dashboard",
                  });
                  return;
                }
                setDrawerType(action.key);
              }}
            >
              <Icon size={25} strokeWidth={1.7} aria-hidden />
              <span>{action.title}</span>
            </button>
          );
        })}
      </section>

      <section className={styles.summaryGrid} aria-label="Reporting summary">
        <div className={styles.summaryLeft}>
          <div className={styles.metricGrid}>
            <Metric
              label={`Reports · ${range === 183 ? "6 months" : `${range} days`}`}
              value={analyticsLoading ? "—" : analytics?.totals?.reports ?? 0}
              icon={FileText}
            />
            <Metric
              label={`Lots · ${range === 183 ? "6 months" : `${range} days`}`}
              value={analyticsLoading ? "—" : analytics?.totals?.lots ?? 0}
              icon={Layers3}
              emphasized
            />
          </div>

          <div className={styles.incomingCard}>
            <span className={styles.incomingIcon}>
              <Inbox size={24} strokeWidth={1.75} aria-hidden />
            </span>
            <div className={styles.incomingCopy}>
              <span>Incoming work</span>
              <strong>
                {incomingLoading
                  ? "Loading…"
                  : incomingError
                    ? "Queue unavailable"
                    : incomingSummary?.showBadge
                      ? `${incomingCount} available`
                      : "Integration unavailable"}
              </strong>
            </div>
            <button
              className={styles.textAction}
              onClick={() => router.push("/incoming")}
            >
              Open queue
              <ChevronRight size={17} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </div>

        <div className={styles.activityCard}>
          <div className={styles.activityHeader}>
            <div>
              <p>Reporting activity</p>
              <h2>Lots and reports by date</h2>
            </div>
            <div className={styles.activityControls}>
              <div className={styles.rangeControl} aria-label="Activity range">
                {([7, 31, 183] as DashboardRange[]).map((days) => (
                  <button
                    key={days}
                    type="button"
                    data-active={range === days}
                    onClick={() => setRange(days)}
                  >
                    {days === 183 ? "6M" : `${days}D`}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={styles.leaderboardButton}
                onClick={() => setShowLeaderboard(true)}
                title="Open team leaderboard"
                aria-label="Open team leaderboard"
              >
                <Trophy size={18} aria-hidden />
              </button>
            </div>
          </div>
          {analyticsLoading && !analytics ? (
            <div className={styles.chartLoading}>
              <span className="app-spinner" aria-label="Loading activity" />
            </div>
          ) : (
            <ActivityChart data={analytics?.series ?? []} />
          )}
        </div>
      </section>

      {showLeaderboard && analytics ? (
        <LeaderboardModal
          data={analytics.leaderboard}
          onClose={() => setShowLeaderboard(false)}
        />
      ) : null}

      <section className={styles.recentCard} aria-labelledby="recent-reports">
        <div className={styles.recentHeading}>
          <h2 id="recent-reports">Recent reports</h2>
          <button
            className={styles.viewAllButton}
            onClick={() => router.push("/reports")}
          >
            View all reports
            <ChevronRight size={17} strokeWidth={1.8} aria-hidden />
          </button>
        </div>

        {reportsLoading ? (
          <div className={styles.recentEmpty}>
            <span className="app-spinner" aria-label="Loading recent reports" />
          </div>
        ) : recent.length ? (
          <div className={styles.tableWrap}>
            <table className={`${styles.table} app-table--responsive`}>
              <thead>
                <tr>
                  <th>
                    <span className={styles.sortHeading}>
                      Report
                      <ArrowUpDown size={14} aria-hidden />
                    </span>
                  </th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Status</th>
                  <th>
                    <span className={styles.sortHeading}>
                      Updated
                      <ArrowUpDown size={14} aria-hidden />
                    </span>
                  </th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((report) => {
                  const status = reportStatus(report);
                  const title = reportTitle(report);
                  return (
                    <tr key={report._id}>
                      <td data-label="Report">
                        <div className={styles.reportIdentity}>
                          <ReportThumbnail
                            src={report.thumbnail_url || report.thumbnailUrl}
                            title={title}
                          />
                          <button
                            className={styles.reportLink}
                            onClick={() => router.push("/reports")}
                          >
                            {title}
                          </button>
                        </div>
                      </td>
                      <td data-label="Type">{typeLabel(report)}</td>
                      <td data-label="Value">
                        {formatReportValue(report.fairMarketValue)}
                      </td>
                      <td data-label="Status">
                        <span
                          className={styles.status}
                          data-tone={status.tone}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td data-label="Updated">
                        {UPDATED_DATE.format(new Date(report.createdAt))}
                      </td>
                      <td data-label="Action">
                        <button
                          className={styles.rowAction}
                          aria-label={`Open actions for ${title}`}
                          onClick={() => router.push("/reports")}
                        >
                          <MoreHorizontal size={20} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.recentEmpty}>
            Your generated reports will appear here.
          </div>
        )}

      </section>

      <BottomDrawer
        open={Boolean(drawerType)}
        onClose={closeDrawer}
        title={drawerType ? DRAWER_TITLES[drawerType] : undefined}
        description="Complete the required details, attach supporting media, and save or submit when ready."
        contentScrollable
        closeDisabled={formUploading}
      >
        {drawerType === "real-estate" ? (
          <RealEstateForm onSuccess={closeDrawer} onCancel={closeDrawer} onSubmittingChange={handleFormUploading} />
        ) : drawerType === "salvage" ? (
          <SalvageForm onSuccess={closeDrawer} onCancel={closeDrawer} onSubmittingChange={handleFormUploading} onReportAccepted={(reportId) => {
            closeDrawer();
            router.push(salvageStatusPath(reportId));
          }} />
        ) : null}
      </BottomDrawer>
    </div>
  );
}
