"use client";

import Link from "next/link";
import { Check, LoaderCircle } from "lucide-react";
import BrandLockup from "@/components/auth/BrandLockup";
import ThemeToggle from "@/components/auth/ThemeToggle";

export const AUTH_LABEL_CLASS =
  "mb-2.5 block text-sm font-semibold text-[var(--app-text)]";

export const AUTH_INPUT_CLASS =
  "h-[52px] w-full rounded-[10px] border border-[var(--app-control-border)] bg-[var(--app-panel)] px-4 text-[0.95rem] text-[var(--app-text)] shadow-[var(--app-shadow-control)] outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-60";

export const AUTH_TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-[10px] border border-[var(--app-control-border)] bg-[var(--app-panel)] px-4 py-3 text-[0.95rem] text-[var(--app-text)] shadow-[var(--app-shadow-control)] outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-60";

export const AUTH_PRIMARY_BUTTON_CLASS =
  "inline-flex h-14 items-center justify-center gap-2 rounded-[10px] bg-[var(--app-accent)] px-6 text-sm font-semibold text-[var(--app-on-accent)] shadow-[var(--app-shadow-control)] transition-[background-color,box-shadow,transform] duration-150 hover:bg-[var(--app-accent-hover)] hover:shadow-[var(--app-shadow-shell)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-panel)] disabled:cursor-not-allowed disabled:opacity-60";

export const AUTH_SECONDARY_BUTTON_CLASS =
  "inline-flex h-12 items-center justify-center gap-2 rounded-[10px] border border-[var(--app-control-border)] bg-[var(--app-panel)] px-5 text-sm font-semibold text-[var(--app-text)] shadow-[var(--app-shadow-control)] transition-[border-color,background-color,color] duration-150 hover:border-[var(--app-border-strong)] hover:bg-[var(--app-panel-alt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-60";

export function AuthFormHeading({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--app-accent)]">
        {label}
      </p>
      <h2 className="mt-4 text-[2.3rem] font-semibold leading-[1.08] tracking-[-0.045em] text-[var(--app-text)] sm:text-[2.75rem]">
        {title}
      </h2>
      <p className="mt-4 max-w-xl text-base leading-7 text-[var(--app-text-muted)]">
        {description}
      </p>
    </div>
  );
}

export function AuthNotice({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] text-[var(--app-danger)]"
      : tone === "success"
        ? "border-[var(--app-success-border)] bg-[var(--app-success-soft)] text-[var(--app-success)]"
        : "border-[var(--app-info-border)] bg-[var(--app-info-soft)] text-[var(--app-info)]";

  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm leading-6 ${toneClass}`}>
      {children}
    </div>
  );
}

export function AuthSpinner({ className = "h-4 w-4" }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`${className} animate-spin`} />;
}

export default function AuthLightShell({
  title,
  description,
  features,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  features: string[];
  children: React.ReactNode;
}) {
  const supportEmail =
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@assetinsightvaluation.com";

  return (
    <main className="min-h-screen bg-[var(--app-panel)] text-[var(--app-text)]">
      <header className="flex h-20 items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-panel)] px-5 sm:px-8 lg:px-10">
        <Link
          href="/welcome"
          aria-label="Asset Insight home"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          <BrandLockup />
        </Link>
        <ThemeToggle />
      </header>

      <div className="grid min-h-[calc(100vh-80px)] lg:grid-cols-[minmax(360px,39%)_minmax(0,61%)]">
        <aside className="relative hidden overflow-hidden border-r border-[#173958] bg-[#071d36] px-10 pb-16 pt-[132px] text-white lg:flex lg:items-start xl:px-16">
          <span className="absolute inset-y-0 left-0 w-1 bg-[#1670ff]" aria-hidden />
          <div className="max-w-[520px]">
            <h1 className="text-[2.55rem] font-semibold leading-[1.18] tracking-[-0.045em] xl:text-[2.9rem]">
              {title}
            </h1>
            <p className="mt-6 max-w-lg whitespace-pre-line text-[1.05rem] leading-7 text-slate-300">
              {description}
            </p>
            <ul className="mt-12 space-y-6">
              {features.map((feature) => (
                <li key={feature} className="flex items-center gap-4 text-base font-medium text-slate-100">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#2f70c8] bg-[#0d2b4d] text-[#6da5ff]">
                    <Check className="h-4 w-4" strokeWidth={2.2} />
                  </span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col bg-[var(--app-panel)]">
          <div className="flex flex-1 items-start px-5 pb-12 pt-14 sm:px-10 lg:px-16 lg:pt-16 xl:px-[5.5rem]">
            <div className="mx-auto w-full max-w-[680px]">{children}</div>
          </div>
          <footer className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 px-5 pb-10 text-sm text-[var(--app-text-muted)]">
            <Link className="transition-colors hover:text-[var(--app-text)]" href="/privacy">
              Privacy
            </Link>
            <span aria-hidden="true" className="h-5 w-px bg-[var(--app-border)]" />
            <Link className="transition-colors hover:text-[var(--app-text)]" href="/account-deletion">
              Account deletion
            </Link>
            <span aria-hidden="true" className="h-5 w-px bg-[var(--app-border)]" />
            <a className="transition-colors hover:text-[var(--app-text)]" href={`mailto:${supportEmail}`}>
              Support
            </a>
          </footer>
        </section>
      </div>
    </main>
  );
}
