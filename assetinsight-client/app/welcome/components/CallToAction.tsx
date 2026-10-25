import Link from "next/link";
import BrandLockup from "@/components/auth/BrandLockup";
import AndroidApkDownloadButton from "./AndroidApkDownloadButton";

export default function CallToAction() {
  return (
    <>
      <section className="border-y border-[var(--app-border)] bg-[var(--app-panel)]">
        <div className="mx-auto flex w-full max-w-[1536px] flex-col gap-8 px-5 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-[60px]">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-semibold tracking-[-0.035em] text-[var(--app-text)] sm:text-4xl">
              Give every client file a stronger first impression.
            </h2>
            <p className="mt-4 text-base leading-7 text-[var(--app-text-muted)]">
              Bring valuation reports, salvage records, property files, and auction lots into one professional workflow.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-[var(--app-accent)] px-6 text-sm font-semibold text-[var(--app-panel)] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
              Start now
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] px-6 text-sm font-semibold text-[var(--app-text)] transition-colors hover:bg-[var(--app-panel-alt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
              Sign in
            </Link>
            <AndroidApkDownloadButton variant="outline" />
          </div>
        </div>
      </section>

      <footer className="bg-[var(--app-bg)]">
        <div className="mx-auto flex w-full max-w-[1536px] flex-col gap-5 px-5 py-8 text-sm text-[var(--app-text-muted)] sm:px-8 md:flex-row md:items-center md:justify-between lg:px-[60px]">
          <BrandLockup compact />
          <div className="flex items-center gap-6">
            <Link href="/privacy" className="hover:text-[var(--app-text)]">Privacy</Link>
            <Link href="/login" className="hover:text-[var(--app-text)]">Sign in</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
