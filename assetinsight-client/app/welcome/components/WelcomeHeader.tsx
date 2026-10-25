import Link from "next/link";
import BrandLockup from "@/components/auth/BrandLockup";
import { navItems } from "../data/constants";

export default function WelcomeHeader() {
  return (
    <header className="border-b border-[var(--app-border)] bg-[var(--app-panel)]">
      <div className="mx-auto flex h-[94px] w-full max-w-[1536px] items-center justify-between gap-6 px-5 sm:px-8 md:grid md:grid-cols-[240px_minmax(0,1fr)_auto] lg:px-[60px]">
        <Link
          href="/welcome"
          aria-label="Asset Insight home"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          <BrandLockup />
        </Link>

        <nav aria-label="Welcome navigation" className="hidden items-center gap-14 pl-8 text-base text-[var(--app-text)] md:flex">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-sm transition-colors hover:text-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-4 sm:gap-7">
          <Link
            href="/login"
            className="hidden rounded-md px-2 py-2 text-sm font-medium text-[var(--app-text)] transition-colors hover:text-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-12 items-center justify-center rounded-lg bg-[var(--app-accent)] px-6 text-sm font-semibold text-[var(--app-panel)] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-panel)]"
          >
            Start now
          </Link>
        </div>
      </div>
    </header>
  );
}
