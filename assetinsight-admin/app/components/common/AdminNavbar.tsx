"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export default function AdminNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        let res = await fetch("/api/admin/me", { cache: "no-store" });
        if (res.status === 401) {
          // Try silent refresh once
          const r = await fetch("/api/admin/refresh", {
            method: "POST",
            cache: "no-store",
          });
          if (r.ok) {
            res = await fetch("/api/admin/me", { cache: "no-store" });
          }
        }
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!mounted) return;
        setRole(data?.user?.role || null);
      } catch {}
    })();

    // Periodic refresh every 20 minutes (buffer before 30m expiry)
    const id = setInterval(() => {
      fetch("/api/admin/refresh", { method: "POST", cache: "no-store" }).catch(
        () => {}
      );
    }, 20 * 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function onLogout() {
    try {
      setLoggingOut(true);
      await fetch("/api/admin/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      setLoggingOut(false);
    }
  }

  const roleLabel =
    role === "superadmin"
      ? "Super Admin"
      : role === "admin"
      ? "Admin"
      : role === "user"
      ? "User"
      : "Loading";
  const homeHref = role === "superadmin" || role === "admin" ? "/dashboard" : "/reports";

  const linkBase =
    "inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium transition-all duration-200 cursor-pointer shrink-0";
  const inactive =
    "text-slate-700 bg-white/80 border border-rose-200/80 hover:bg-rose-50 hover:border-rose-300 shadow-sm hover:shadow";
  const active =
    "text-white bg-gradient-to-r from-rose-600 to-pink-600 border border-rose-500 shadow-md shadow-rose-200";

  function NavLink({
    href,
    label,
    icon,
    onClick,
  }: {
    href: string;
    label: string;
    icon?: React.ReactNode;
    onClick?: () => void;
  }) {
    const isActive = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        href={href}
        onClick={onClick}
        aria-current={isActive ? "page" : undefined}
        className={`${linkBase} ${isActive ? active : inactive}`}
      >
        {icon}
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{label}</span>
      </Link>
    );
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-rose-100/90 bg-gradient-to-r from-white/95 via-rose-50/85 to-white/95 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
        <div className="flex min-h-[70px] items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href={homeHref}
            className="group flex items-center gap-2 rounded-2xl border border-rose-100/80 bg-white/80 px-2.5 py-1.5 shadow-sm transition-all duration-200 hover:border-rose-200 hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 text-sm font-bold text-white shadow-md shadow-rose-300/60 ring-1 ring-rose-300/70 transition-transform duration-200 group-hover:scale-105">
              CV
            </div>
            <div className="leading-tight">
              <div className="text-[11px] font-medium tracking-wide text-slate-500">Asset Insight</div>
              <div className="text-sm font-bold text-slate-900">Admin Console</div>
            </div>
          </Link>
        </div>
        {/* Hamburger (mobile) */}
        <button
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-controls="admin-mobile-nav"
          onClick={() => setMenuOpen((m) => !m)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-rose-200 bg-white/90 text-rose-700 shadow-sm transition-all hover:border-rose-300 hover:bg-rose-50 active:bg-rose-100 md:hidden"
        >
          {menuOpen ? (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>

        {/* Desktop links */}
        <div className="hidden min-w-0 flex-1 items-center gap-2 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex">
          {/* User role sees only Reports */}
          {role === "user" ? (
            <>
              <NavLink
                href="/reports"
                label="Approved Reports"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                }
              />
            </>
          ) : (role === "superadmin" || role === "admin") ? (
            <>
              <NavLink
                href="/dashboard"
                label="Dashboard"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 12l2-2 4 4 8-8 4 4" />
                  </svg>
                }
              />
              <NavLink
                href="/reports"
                label="Approved Reports"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                }
              />
              <NavLink
                href="/users"
                label="Users"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M7 21v-2a 4 4 0 0 1 3-3.87" />
                    <circle cx="10" cy="7" r="4" />
                  </svg>
                }
              />
              <NavLink
                href="/crm"
                label="CRM"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Z" />
                    <path d="M19 21v-2a7 7 0 0 0-14 0v2" />
                    <circle cx="19" cy="8" r="3" />
                  </svg>
                }
              />
              <NavLink
                href="/approvals"
                label="Released Appraisals"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                }
              />
              {role === "superadmin" && (
              <NavLink
                href="/admins"
                label="Admins"
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M7 21v-2a4 4 0 0 1 3-3.87" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M19 8a4 4 0 1 1-4-4" />
                  </svg>
                }
              />
              )}
            </>
          ) : null}
        </div>
        {/* Desktop logout */}
        <div className="hidden md:flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3 py-1 text-xs font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {roleLabel}
          </span>
          <button
            onClick={onLogout}
            disabled={loggingOut}
            className="cursor-pointer inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-gradient-to-r from-white to-rose-50 px-3 py-2 font-semibold text-rose-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-rose-400 hover:shadow-md active:translate-y-0 disabled:opacity-60"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {loggingOut ? "Logging out..." : "Logout"}
          </button>
        </div>
        </div>
      </div>

      {/* Mobile panel */}
      {menuOpen && (
        <div id="admin-mobile-nav" className="md:hidden border-t border-rose-100/80 bg-white/95 px-4 pb-4 pt-3 shadow-inner backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
            <div className="flex items-center justify-between rounded-2xl border border-rose-100 bg-gradient-to-r from-rose-50 to-white px-3 py-2 shadow-sm">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {roleLabel}
              </span>
              <Link
                href={homeHref}
                onClick={() => setMenuOpen(false)}
                className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700"
              >
                Home
              </Link>
            </div>
            {/* User role sees only Reports */}
            {role === "user" ? (
              <>
                <NavLink
                  href="/reports"
                  label="Approved Reports"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  }
                />
              </>
            ) : (role === "superadmin" || role === "admin") ? (
              <>
                <NavLink
                  href="/dashboard"
                  label="Dashboard"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 12l2-2 4 4 8-8 4 4" />
                    </svg>
                  }
                />
                <NavLink
                  href="/reports"
                  label="Approved Reports"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  }
                />
                <NavLink
                  href="/users"
                  label="Users"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M7 21v-2a4 4 0 0 1 3-3.87" />
                      <circle cx="10" cy="7" r="4" />
                    </svg>
                  }
                />
                <NavLink
                  href="/crm"
                  label="CRM"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Z" />
                      <path d="M19 21v-2a7 7 0 0 0-14 0v2" />
                      <circle cx="19" cy="8" r="3" />
                    </svg>
                  }
                />
                <NavLink
                  href="/approvals"
                  label="Released Appraisals"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  }
                />
                {role === "superadmin" && (
                <NavLink
                  href="/admins"
                  label="Admins"
                  onClick={() => setMenuOpen(false)}
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M7 21v-2a4 4 0 0 1 3-3.87" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M19 8a4 4 0 1 1-4-4" />
                    </svg>
                  }
                />
                )}
              </>
            ) : null}
            <button
              onClick={() => {
                setMenuOpen(false);
                onLogout();
              }}
              disabled={loggingOut}
              className="mt-1 cursor-pointer inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300 bg-gradient-to-r from-white to-rose-50 px-3 py-2 font-semibold text-rose-700 shadow-sm transition-all hover:border-rose-400 hover:shadow-md active:bg-rose-100 disabled:opacity-60"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              {loggingOut ? "Logging out..." : "Logout"}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
