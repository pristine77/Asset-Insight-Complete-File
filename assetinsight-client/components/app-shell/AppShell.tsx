"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  LogOut,
  Menu,
  Moon,
  Search,
  Sun,
  X,
  ArrowLeftRight,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import BrandLockup from "@/components/auth/BrandLockup";
import { useColorMode } from "@/components/providers/ColorModeProvider";
import { UserAvatar } from "@/components/user/UserAvatar";
import { useAuthContext } from "@/context/AuthContext";
import { AuctioneerService } from "@/services/auctioneer";
import { useWorkspaceMode } from "./useWorkspaceMode";
import { ListingActivitySync } from "./ListingActivitySync";
import { UploadBar } from "@/components/uploads/UploadBar";
import { backgroundUploads } from "@/services/backgroundUploadManager";
import { pathMatches } from "@/lib/workspace";
import {
  notificationCacheKey,
  NotificationsService,
} from "@/services/notifications";
import {
  isNavItemActive,
  pageTitle,
  CRM_NAVIGATION,
  PRIMARY_NAVIGATION,
  SECONDARY_NAVIGATION,
  type NavItem,
} from "./navigation";
import styles from "./AppShell.module.css";

const InputsHistoryModal = dynamic(
  () => import("@/components/modals/InputsHistoryModal"),
  { ssr: false }
);

const NotificationModal = dynamic(
  () => import("@/components/notifications/NotificationModal"),
  { ssr: false }
);

const COLLAPSED_KEY = "cv-sidebar-collapsed";

function navSummaryFetcher() {
  return Promise.all([
    AuctioneerService.getStatus(),
    AuctioneerService.getIncomingSummary(),
  ]).then(([status, summary]) => ({
    availableCount: summary.availableCount,
    showBadge: status.enabled && status.configured,
  }));
}

function visibleRefreshInterval() {
  if (typeof document === "undefined") return 60_000;
  return document.visibilityState === "visible" && navigator.onLine
    ? 60_000
    : 0;
}

function NavLink({
  item,
  active,
  badge,
  collapsed,
  closeMobile,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  collapsed: boolean;
  closeMobile: () => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        className={styles.navLink}
        data-active={active}
        href={item.href}
        title={collapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        onClick={closeMobile}
      >
        <span className={styles.navIconFrame} aria-hidden>
          <Icon className={styles.navIcon} strokeWidth={1.8} />
        </span>
        <span className={styles.navText}>{item.label}</span>
        {typeof badge === "number" && badge > 0 ? (
          <span className={styles.badge} aria-label={`${badge} available`}>
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading, loggingOut, deviceAccess } = useAuthContext();
  const ownerId = user?._id || user?.id;
  /*
     Bind the upload line to the signed-in account. This lives here, above the
     shell's early returns, so it also runs for sign-out and for /workspaces:
     an account change empties the line without writing, while an ordinary
     navigation that unmounts the shell leaves a running upload alone.
  */
  useEffect(() => {
    backgroundUploads.setOwner(!loading && !loggingOut && !deviceAccess ? ownerId || null : null);
  }, [ownerId, loading, loggingOut, deviceAccess]);
  useEffect(() => backgroundUploads.onAccepted((event) => {
    if (event.ownerId === ownerId && !loading && !loggingOut && !deviceAccess) {
      window.dispatchEvent(new Event("cv:report-created"));
    }
  }), [ownerId, loading, loggingOut, deviceAccess]);
  if (loading || loggingOut || deviceAccess || !ownerId) return <div className="app-page" role="status">Opening workspace…</div>;
  if (pathname === "/workspaces") return <>{children}</>;
  if (pathMatches(pathname, "/crm") && user?.isCrmAgent !== true) return (
    <div className="app-page"><section className="app-surface app-section"><h1>CRM access required</h1><p>CRM is available only to assigned CRM users. Contact an administrator if you need access.</p><Link className="app-button app-button--primary" href="/dashboard">Open Listings</Link></section></div>
  );
  return <AuthorizedShell key={ownerId} ownerId={ownerId}>{children}</AuthorizedShell>;
}

function AuthorizedShell({ children, ownerId }: { children: React.ReactNode; ownerId: string }) {
  const pathname = usePathname();
  const { user, logout, loggingOut } = useAuthContext();
  const mode = useWorkspaceMode(pathname, ownerId, user?.isCrmAgent === true);
  const isCrm = mode === "crm";
  const { resolvedTheme, setMode, toggleMode } = useColorMode();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  const { data: summary } = useSWR(
    mode === "listings" ? ["auctioneer/navigation-summary", ownerId] : null,
    navSummaryFetcher,
    {
      keepPreviousData: false,
      refreshInterval: visibleRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
    }
  );
  const { data: notificationSummary } = useSWR(
    mode ? notificationCacheKey(1, 10, ownerId) : null,
    () => NotificationsService.list(1, 10),
    {
      refreshInterval: visibleRefreshInterval,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
    }
  );

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "true");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
    setShowDrafts(false);
    setShowNotifications(false);
  }, [pathname, mode]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  const visiblePrimary = useMemo(
    () =>
      (isCrm ? CRM_NAVIGATION : PRIMARY_NAVIGATION).filter((item) =>
        item.visible ? item.visible(user) : true
      ),
    [user, isCrm]
  );
  const workspaceNavigation = useMemo(
    () =>
      visiblePrimary.filter(
        (item) => item.href !== "/approvals" && item.href !== "/releases"
      ),
    [visiblePrimary]
  );
  const reviewNavigation = useMemo(
    () =>
      visiblePrimary.filter(
        (item) => item.href === "/approvals" || item.href === "/releases"
      ),
    [visiblePrimary]
  );
  const title = pageTitle(pathname);
  const userLabel = user?.username || user?.email || "Loading account";
  const closeMobile = () => setMobileOpen(false);
  const toggleDesktopNavigation = () => setCollapsed((value) => !value);

  if (!mode) return <div className="app-page" role="status">Opening workspace…</div>;

  return (
    <div
      className={styles.shell}
      data-collapsed={collapsed}
      data-mobile-open={mobileOpen}
      data-workspace={mode}
    >
      <button
        className={styles.mobileBackdrop}
        aria-label="Close navigation"
        onClick={closeMobile}
      />

      <aside
        className={styles.sidebar}
        aria-label="Primary navigation"
      >
        <div className={styles.brandRow}>
          <Link className={styles.brand} href={isCrm ? "/crm" : "/dashboard"} onClick={closeMobile}>
            <span className={styles.brandLogo}>
              <BrandLockup compact />
            </span>
            <span className="sr-only">Enterprise workspace</span>
          </Link>
          <button
            className={styles.collapseButton}
            onClick={() => {
              if (window.innerWidth < 1024) closeMobile();
              else toggleDesktopNavigation();
            }}
            aria-label={
              mobileOpen
                ? "Close navigation"
                : collapsed
                  ? "Expand navigation"
                  : "Collapse navigation"
            }
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={mobileOpen || !collapsed}
          >
            {mobileOpen ? (
              <X size={18} aria-hidden />
            ) : collapsed ? (
              <ChevronRight size={17} aria-hidden />
            ) : (
              <ChevronLeft size={17} aria-hidden />
            )}
          </button>
        </div>

        <div className={styles.navScroll}>
          {user?.isCrmAgent === true ? <Link href="/workspaces" className={styles.workspaceSwitch} onClick={closeMobile} title={collapsed ? "Switch workspace" : undefined} aria-label={`Switch workspace, current ${isCrm ? "CRM" : "Listings"}`}>
            <ArrowLeftRight size={18} aria-hidden />
            <span className={styles.navText}><strong>{isCrm ? "CRM" : "Listings"}</strong><small>Switch workspace</small></span>
          </Link> : null}
          <nav className={styles.navGroup}>
            <p className={styles.navLabel}>{isCrm ? "CRM workspace" : "Workspace"}</p>
            <ul className={styles.navList}>
              {workspaceNavigation.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isNavItemActive(item, pathname)}
                  badge={
                    item.href === "/incoming" && summary?.showBadge
                      ? summary.availableCount
                      : undefined
                  }
                  collapsed={collapsed}
                  closeMobile={closeMobile}
                />
              ))}
              {!isCrm ? <li>
                <button
                  className={`${styles.navLink} ${styles.actionButton}`}
                  title={collapsed ? "Drafts" : undefined}
                  onClick={() => {
                    closeMobile();
                    setShowDrafts(true);
                  }}
                >
                  <span className={styles.navIconFrame} aria-hidden>
                    <Clock3 className={styles.navIcon} strokeWidth={1.8} />
                  </span>
                  <span className={styles.navText}>Drafts</span>
                </button>
              </li> : null}
            </ul>
          </nav>

          {reviewNavigation.length > 0 ? <nav className={styles.navGroup}>
            <p className={styles.navLabel}>Review</p>
            <ul className={styles.navList}>
              {reviewNavigation.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isNavItemActive(item, pathname)}
                  collapsed={collapsed}
                  closeMobile={closeMobile}
                />
              ))}
            </ul>
          </nav> : null}

          <nav className={styles.navGroup}>
            <p className={styles.navLabel}>Account</p>
            <ul className={styles.navList}>
              {SECONDARY_NAVIGATION.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isNavItemActive(item, pathname)}
                  collapsed={collapsed}
                  closeMobile={closeMobile}
                />
              ))}
            </ul>
          </nav>
        </div>

        <div className={styles.footer}>
          <Link
            href="/settings"
            className={styles.profile}
            title={collapsed ? userLabel : undefined}
            onClick={closeMobile}
          >
            <UserAvatar user={user || { username: userLabel }} size={38} />
            <span className={styles.profileCopy}>
              <span className={styles.profileName}>{userLabel}</span>
              <span className={styles.profileEmail}>{user?.email ?? "Secure workspace"}</span>
            </span>
            <ChevronDown
              className={styles.profileChevron}
              size={17}
              strokeWidth={1.8}
              aria-hidden
            />
          </Link>
          <div
            className={styles.themeSwitch}
            role="group"
            aria-label="Color theme"
          >
            <button
              type="button"
              className={styles.themeOption}
              data-active={resolvedTheme === "light"}
              onClick={() => setMode("light")}
              aria-label="Light theme"
              aria-pressed={resolvedTheme === "light"}
            >
              <Sun size={18} strokeWidth={1.8} aria-hidden />
              <span>Light</span>
            </button>
            <button
              type="button"
              className={styles.themeOption}
              data-active={resolvedTheme === "dark"}
              onClick={() => setMode("dark")}
              aria-label="Dark theme"
              aria-pressed={resolvedTheme === "dark"}
            >
              <Moon size={18} strokeWidth={1.8} aria-hidden />
              <span>Dark</span>
            </button>
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.desktopTopbar}>
          <button
            className={styles.topbarMenu}
            onClick={toggleDesktopNavigation}
            aria-label="Toggle navigation width"
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
          >
            <Menu size={22} strokeWidth={1.8} aria-hidden />
          </button>
          {isCrm ? <span className={styles.workspaceTitle}>CRM workspace</span> : null}

          <div className={styles.topbarActions}>
            {!isCrm ? <form
              className={styles.searchForm}
              action="/reports"
              method="get"
              role="search"
            >
              <label className="sr-only" htmlFor="workspace-search">
                Search reports, lots, and clients
              </label>
              <input
                id="workspace-search"
                className={styles.searchInput}
                type="search"
                name="search"
                placeholder="Search reports, lots, clients..."
                autoComplete="off"
              />
              <button
                className={styles.searchButton}
                type="submit"
                aria-label="Submit workspace search"
              >
                <Search size={19} strokeWidth={1.8} aria-hidden />
              </button>
            </form> : null}

            <button
              type="button"
              className={styles.topbarIcon}
              onClick={() => setShowNotifications(true)}
              aria-label="Open notifications"
              title="Notifications"
            >
              <Bell size={21} strokeWidth={1.8} aria-hidden />
              {(notificationSummary?.unreadCount || 0) > 0 ? (
                <span className={styles.notificationBadge} aria-label={`${notificationSummary?.unreadCount} unread notifications`}>
                  {(notificationSummary?.unreadCount || 0) > 99 ? "99+" : notificationSummary?.unreadCount}
                </span>
              ) : null}
            </button>
            <Link
              className={styles.topbarIcon}
              href="/support"
              aria-label="Contact support"
              title="Help and support"
            >
              <CircleHelp size={21} strokeWidth={1.8} aria-hidden />
            </Link>
            <button
              className={styles.topbarIcon}
              onClick={() => void logout()}
              aria-label="Sign out"
              title="Sign out"
              disabled={loggingOut}
            >
              <LogOut size={21} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </header>

        <header className={styles.mobileHeader}>
          <button
            className={styles.mobileMenuButton}
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
          >
            <Menu size={19} aria-hidden />
          </button>
          <div className={styles.mobileHeading}>
            <span className={styles.mobileEyebrow}>Asset Insight</span>
            <span className={styles.mobileTitle}>{title}</span>
          </div>
          <div className={styles.mobileActions}>
            <button
              type="button"
              className={styles.mobileIconButton}
              onClick={() => setShowNotifications(true)}
              aria-label="Open notifications"
            >
              <Bell size={18} aria-hidden />
              {(notificationSummary?.unreadCount || 0) > 0 ? (
                <span className={styles.notificationBadge}>
                  {(notificationSummary?.unreadCount || 0) > 99 ? "99+" : notificationSummary?.unreadCount}
                </span>
              ) : null}
            </button>
            <Link
              className={styles.mobileIconButton}
              href={isCrm ? "/crm/tasks" : "/reports"}
              aria-label={isCrm ? "Search CRM tasks" : "Search reports"}
            >
              <Search size={18} aria-hidden />
            </Link>
            <button
              className={styles.mobileIconButton}
              onClick={toggleMode}
              aria-label={
                resolvedTheme === "dark" ? "Use light theme" : "Use dark theme"
              }
            >
              {resolvedTheme === "dark" ? (
                <Sun size={18} aria-hidden />
              ) : (
                <Moon size={18} aria-hidden />
              )}
            </button>
          </div>
        </header>
        <div className={styles.content}>
          {mode === "listings" ? <ListingActivitySync ownerId={ownerId} /> : null}
          {children}
          {/* Report uploads belong to Listings; the CRM workspace never queues one. */}
          {mode === "listings" ? <UploadBar ownerId={ownerId} /> : null}
        </div>
      </main>

      {showDrafts && !isCrm ? (
        <InputsHistoryModal
          isOpen
          onClose={() => setShowDrafts(false)}
          onLoadInput={() => undefined}
        />
      ) : null}
      {showNotifications ? (
        <NotificationModal onClose={() => setShowNotifications(false)} />
      ) : null}
    </div>
  );
}
