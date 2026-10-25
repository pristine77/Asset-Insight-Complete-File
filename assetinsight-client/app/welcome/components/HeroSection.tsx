import Link from "next/link";
import { heroHighlights } from "../data/constants";
import AndroidApkDownloadButton from "./AndroidApkDownloadButton";

export default function HeroSection() {
  return (
    <section className="border-b border-[var(--app-border)] bg-[var(--app-panel)]">
      <div className="mx-auto grid min-h-[602px] w-full max-w-[1536px] items-center gap-12 px-5 py-12 sm:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:gap-16 lg:px-[60px] lg:pb-7 lg:pt-10">
        <div className="max-w-[650px]">
          <h1 className="text-[2.9rem] font-semibold leading-[1.15] tracking-[-0.045em] text-[var(--app-text)] sm:text-[3.65rem]">
            Client-ready valuation packages, without the workflow clutter.
          </h1>
          <p className="mt-5 max-w-[500px] text-lg leading-7 text-[var(--app-text-muted)]">
            Capture appraisal work, organize every report, and move client files from field input to final delivery in one clear workspace.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              href="/signup"
              className="inline-flex h-14 min-w-[182px] items-center justify-center rounded-lg bg-[var(--app-accent)] px-6 text-base font-semibold text-[var(--app-panel)] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-panel)]"
            >
              Start now
            </Link>
            <Link
              href="/login"
              className="inline-flex h-14 min-w-[158px] items-center justify-center rounded-lg border border-[var(--app-accent)] bg-transparent px-6 text-base font-semibold text-[var(--app-accent)] transition-colors hover:bg-[var(--app-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
              Sign in
            </Link>
            <AndroidApkDownloadButton variant="link" />
          </div>

          <p className="mt-8 flex flex-wrap gap-x-3 gap-y-2 text-sm text-[var(--app-text-muted)]">
            {heroHighlights.map((item, index) => (
              <span key={item} className="inline-flex items-center gap-3">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                {item}
              </span>
            ))}
          </p>
        </div>

        <figure className="min-w-0">
          <picture>
            <source srcSet="/images/appraiser-hero.avif" type="image/avif" />
            <source srcSet="/images/appraiser-hero.webp" type="image/webp" />
            <img
              src="/images/appraiser-hero.webp"
              alt="Asset appraiser reviewing valuation details on a tablet beside excavation equipment"
              width={1200}
              height={820}
              fetchPriority="high"
              className="aspect-[1.46] w-full rounded-lg border border-[var(--app-border)] object-cover"
            />
          </picture>
          <figcaption className="mt-3 text-sm text-[var(--app-text-muted)]">
            Field capture to client-ready files
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
