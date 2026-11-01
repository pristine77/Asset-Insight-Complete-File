"use client";

/**
 * One labelled field of the Real Estate form (owner, 2026-11-01: "Make the
 * Real Estate UI professional and easy usability"). The label wraps the
 * control, so clicking the label focuses it and screen readers announce it.
 * Controls use the app's shared `app-field` style; FIELD_CLASS adds the size.
 */
export const FIELD_CLASS = "app-field text-sm";

export default function Field({
  label,
  required = false,
  hint,
  span = 1,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  /** Columns the field spans in its grid; "full" spans the whole row. */
  span?: 1 | 2 | "full";
  children: React.ReactNode;
}) {
  const spanClass = span === "full" ? "col-span-full" : span === 2 ? "sm:col-span-2" : "";
  return (
    <label className={`grid min-w-0 content-start gap-1.5 ${spanClass}`}>
      <span className="text-[13px] font-semibold text-[var(--app-text)]">
        {label}
        {required ? <span aria-hidden="true" className="ml-0.5 text-[var(--app-danger)]">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-[var(--app-text-muted)]">{hint}</span> : null}
    </label>
  );
}
