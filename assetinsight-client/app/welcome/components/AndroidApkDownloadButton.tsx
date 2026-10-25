import { Download } from "lucide-react";

const SERVER_BASE = (
  process.env.NEXT_PUBLIC_SERVER_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://api.assetinsightvaluator.com"
)
  .replace(/\/api\/?$/, "")
  .replace(/\/+$/, "");

export default function AndroidApkDownloadButton({
  variant = "solid",
}: {
  variant?: "solid" | "outline" | "link";
}) {
  const className =
    variant === "link"
      ? "inline-flex h-14 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-[var(--app-accent)] transition-colors hover:bg-[var(--app-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
      : variant === "outline"
        ? "inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] px-5 text-sm font-semibold text-[var(--app-text)] transition-colors hover:bg-[var(--app-panel-alt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        : "inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-[var(--app-accent)] px-5 text-sm font-semibold text-[var(--app-panel)] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]";

  return (
    <a
      href={`${SERVER_BASE}/api/app-version/android/latest/download`}
      className={className}
      aria-label="Download Android APK"
    >
      <Download className="h-5 w-5" strokeWidth={1.8} />
      <span>Download Android APK</span>
    </a>
  );
}
