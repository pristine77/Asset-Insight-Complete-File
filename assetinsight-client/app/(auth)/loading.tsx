import BrandLockup from "@/components/auth/BrandLockup";

export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--app-bg)] px-5 text-[var(--app-text)]">
      <div className="flex flex-col items-center gap-6">
        <BrandLockup compact />
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
        <p className="text-sm text-[var(--app-text-muted)]">Loading secure access...</p>
      </div>
    </main>
  );
}
