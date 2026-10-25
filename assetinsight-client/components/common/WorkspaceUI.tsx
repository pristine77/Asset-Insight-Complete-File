import { ArrowRight, FileText } from "lucide-react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header
      className="app-surface app-section"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
      }}
    >
      <div>
        {eyebrow ? <span className="app-kicker">{eyebrow}</span> : null}
        <h1 className="app-title" style={{ marginTop: eyebrow ? 4 : 0 }}>
          {title}
        </h1>
        {description ? <p className="app-subtitle">{description}</p> : null}
      </div>
      {action ? <div style={{ display: "flex", gap: 8 }}>{action}</div> : null}
    </header>
  );
}

export function SurfaceCard({
  children,
  className = "",
  style,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  sx?: unknown;
}) {
  return (
    <div className={`app-surface ${className}`} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            color: "var(--app-text-strong)",
            fontSize: "1.05rem",
            fontWeight: 720,
          }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p className="app-muted" style={{ margin: "3px 0 0", fontSize: 14 }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  accent: string;
  icon: React.ReactNode;
}) {
  return (
    <SurfaceCard className="app-section">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="app-muted" style={{ fontSize: 13, fontWeight: 650 }}>
            {label}
          </div>
          <div
            style={{
              marginTop: 6,
              color: "var(--app-text-strong)",
              fontSize: "1.8rem",
              fontWeight: 750,
              letterSpacing: "-0.035em",
            }}
          >
            {value}
          </div>
          {hint ? (
            <div className="app-muted" style={{ marginTop: 6, fontSize: 13 }}>
              {hint}
            </div>
          ) : null}
        </div>
        <span
          style={{
            width: 42,
            height: 42,
            display: "grid",
            placeItems: "center",
            border: "1px solid var(--app-border)",
            borderRadius: 8,
            background: "var(--app-panel-alt)",
            color: accent,
          }}
        >
          {icon}
        </span>
      </div>
    </SurfaceCard>
  );
}

export function StatusPill({
  label,
  color,
}: {
  label: string;
  color:
    | "default"
    | "primary"
    | "secondary"
    | "error"
    | "info"
    | "success"
    | "warning";
}) {
  const tone =
    color === "primary"
      ? "accent"
      : color === "error"
        ? "danger"
        : color === "secondary"
          ? "info"
          : color;
  return (
    <span className={`app-chip ${tone !== "default" ? `app-chip--${tone}` : ""}`}>
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <SurfaceCard className="app-section">
      <div
        style={{
          minHeight: 230,
          display: "grid",
          placeItems: "center",
          textAlign: "center",
        }}
      >
        <div>
          <span
            style={{
              width: 48,
              height: 48,
              display: "grid",
              placeItems: "center",
              margin: "0 auto",
              border: "1px solid var(--app-border)",
              borderRadius: 8,
              background: "var(--app-panel-alt)",
              color: "var(--app-accent)",
            }}
          >
            <FileText size={22} aria-hidden />
          </span>
          <h2 style={{ margin: "14px 0 0", fontSize: "1.05rem" }}>{title}</h2>
          <p className="app-muted" style={{ margin: "6px auto 0", maxWidth: 520 }}>
            {description}
          </p>
          {action ? <div style={{ marginTop: 18 }}>{action}</div> : null}
        </div>
      </div>
    </SurfaceCard>
  );
}

export function SectionPanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <SurfaceCard className="app-section">
      <SectionTitle title={title} subtitle={subtitle} action={action} />
      <hr className="app-divider" style={{ margin: "18px 0" }} />
      {children}
    </SurfaceCard>
  );
}

export function InlineAction({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button className="app-button" onClick={onClick}>
      {label}
      <ArrowRight size={16} aria-hidden />
    </button>
  );
}
