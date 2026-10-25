"use client";

type LoadingProps = {
  message?: string;
  height?: number;
  width?: number;
  className?: string;
};

export default function Loading({
  message = "Loading…",
  className = "",
}: LoadingProps) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      style={{
        minHeight: 160,
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ display: "grid", justifyItems: "center", gap: 12 }}>
        <span className="app-spinner" aria-hidden style={{ width: 26, height: 26 }} />
        {message ? <span className="app-muted" style={{ fontSize: 14 }}>{message}</span> : null}
      </div>
    </div>
  );
}
