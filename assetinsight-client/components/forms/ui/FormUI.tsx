"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CloudUpload,
  Info,
  LoaderCircle,
  Save,
  X,
} from "lucide-react";

export function formClassNames(
  ...values: Array<string | false | null | undefined>
) {
  return values.filter(Boolean).join(" ");
}

export const formControlClass =
  "block min-h-11 w-full rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] px-3.5 py-2.5 text-[0.9375rem] leading-5 text-[var(--app-text)] shadow-sm outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--app-text-muted)] hover:border-[var(--app-control-border-hover)] focus:border-[var(--app-accent)] focus:ring-4 focus:ring-[var(--app-accent-ring)] aria-[invalid=true]:border-[var(--app-danger)] aria-[invalid=true]:ring-4 aria-[invalid=true]:ring-[var(--app-danger-ring)] disabled:cursor-not-allowed disabled:bg-[var(--app-panel-alt)] disabled:text-[var(--app-text-muted)] disabled:opacity-70";

export const formSelectClass = formClassNames(
  formControlClass,
  "cursor-pointer pr-10"
);

export const formTextareaClass = formClassNames(
  formControlClass,
  "min-h-28 resize-y leading-6"
);

export const formLabelClass =
  "text-sm font-semibold leading-5 text-[var(--app-text)]";
export const formHintClass =
  "text-xs leading-5 text-[var(--app-text-muted)]";
export const formErrorClass =
  "text-xs font-medium leading-5 text-[var(--app-danger)]";

export const formButtonBaseClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold leading-5 outline-none transition-[background-color,border-color,color,box-shadow,opacity,filter] duration-150 focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50";

export const primaryButtonClass = formClassNames(
  formButtonBaseClass,
  "border border-transparent bg-[var(--app-accent)] text-[var(--app-on-accent)] shadow-sm hover:brightness-95 active:brightness-90 focus-visible:ring-[var(--app-accent-ring)]"
);

export const secondaryButtonClass = formClassNames(
  formButtonBaseClass,
  "border border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-sm hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)] focus-visible:ring-[var(--app-accent-ring)]"
);

export const quietButtonClass = formClassNames(
  formButtonBaseClass,
  "border border-transparent bg-transparent text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] focus-visible:ring-[var(--app-accent-ring)]"
);

export const dangerButtonClass = formClassNames(
  formButtonBaseClass,
  "border border-transparent bg-[var(--app-danger)] text-white shadow-sm hover:brightness-95 active:brightness-90 focus-visible:ring-[var(--app-danger-ring)]"
);

export const iconButtonClass =
  "inline-grid min-h-11 min-w-11 place-items-center rounded-lg border border-[var(--app-control-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] outline-none transition hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] focus-visible:ring-4 focus-visible:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-50";

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-errormessage"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

export type FormFieldProps = {
  id?: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  labelAction?: ReactNode;
  className?: string;
  children: ReactElement<FieldControlProps>;
};

export function FormField({
  id,
  label,
  required = false,
  hint,
  error,
  labelAction,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? children.props.id ?? `form-field-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [
    children.props["aria-describedby"],
    hintId,
    errorId,
  ]
    .filter(Boolean)
    .join(" ");

  const control = isValidElement<FieldControlProps>(children)
    ? cloneElement(children, {
        id: controlId,
        "aria-describedby": describedBy || undefined,
        "aria-errormessage": errorId,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-required": required
          ? true
          : children.props["aria-required"],
      })
    : children;

  return (
    <div className={formClassNames("grid content-start gap-1.5", className)}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <label htmlFor={controlId} className={formLabelClass}>
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-1 text-[var(--app-accent)]">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </label>
        {labelAction ? (
          <span className="shrink-0 text-xs text-[var(--app-text-muted)]">
            {labelAction}
          </span>
        ) : null}
      </div>
      {control}
      {hint ? (
        <p id={hintId} className={formHintClass}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={formErrorClass} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type FormSwitchProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "checked" | "children" | "onChange" | "type"
> & {
  label: ReactNode;
  checked: boolean;
  onChange: NonNullable<InputHTMLAttributes<HTMLInputElement>["onChange"]>;
  description?: ReactNode;
  wrapperClassName?: string;
};

export function FormSwitch({
  id,
  label,
  description,
  wrapperClassName,
  checked,
  onChange,
  disabled,
  ...inputProps
}: FormSwitchProps) {
  const generatedId = useId();
  const controlId = id ?? `form-switch-${generatedId}`;
  const descriptionId = description ? `${controlId}-description` : undefined;

  return (
    <label
      htmlFor={controlId}
      className={formClassNames(
        "flex min-h-11 items-start gap-3",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        wrapperClassName
      )}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          {...inputProps}
          id={controlId}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          aria-describedby={descriptionId}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={formClassNames(
            "flex h-6 w-11 items-center rounded-full border px-0.5 transition-[background-color,border-color,box-shadow] peer-focus-visible:ring-4 peer-focus-visible:ring-[var(--app-accent-ring)]",
            checked
              ? "border-[var(--app-accent)] bg-[var(--app-accent)]"
              : "border-[var(--app-control-border)] bg-[var(--app-control-border)]"
          )}
        >
          <span
            className={formClassNames(
              "h-5 w-5 rounded-full bg-[var(--app-panel)] shadow-sm transition-transform",
              checked ? "translate-x-5" : "translate-x-0"
            )}
          />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-5 text-[var(--app-text)]">
          {label}
        </span>
        {description ? (
          <span
            id={descriptionId}
            className="mt-0.5 block text-xs leading-5 text-[var(--app-text-muted)]"
          >
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export type FormSectionStatus =
  | "default"
  | "complete"
  | "incomplete"
  | "error";

export type FormSectionProps = {
  id: string;
  title: ReactNode;
  sectionNumber?: number | string;
  description?: ReactNode;
  summary?: ReactNode;
  errorSummary?: ReactNode;
  status?: FormSectionStatus;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  autoRevealErrors?: boolean;
  disabled?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

export function FormSection({
  id,
  title,
  sectionNumber,
  description,
  summary,
  errorSummary,
  status = "default",
  open,
  defaultOpen = false,
  onOpenChange,
  autoRevealErrors = true,
  disabled = false,
  className,
  bodyClassName,
  children,
}: FormSectionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const headerId = `${id}-header`;
  const panelId = `${id}-panel`;
  const panelRef = useRef<HTMLDivElement>(null);
  const wasInvalidRef = useRef(false);
  const pendingInvalidFocusRef = useRef(false);
  const hasError = status === "error" || Boolean(errorSummary);
  const resolvedStatus = hasError ? "error" : status;

  const updateOpen = (nextOpen: boolean) => {
    if (!isControlled) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    const becameInvalid = hasError && !wasInvalidRef.current;
    wasInvalidRef.current = hasError;

    if (!autoRevealErrors || !becameInvalid) return;
    pendingInvalidFocusRef.current = true;
    if (!isOpen) updateOpen(true);
  }, [autoRevealErrors, hasError, isOpen]);

  useEffect(() => {
    if (!isOpen || !pendingInvalidFocusRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      const invalidControl = panelRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-invalid="true"]'
      );
      if (invalidControl && !invalidControl.hasAttribute("disabled")) {
        invalidControl.focus({ preventScroll: true });
        invalidControl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      pendingInvalidFocusRef.current = false;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasError, isOpen]);

  const summaryContent = errorSummary ?? summary;

  return (
    <section
      aria-labelledby={headerId}
      data-form-section={id}
      data-invalid={hasError ? "true" : undefined}
      className={formClassNames(
        "overflow-hidden rounded-xl border bg-[var(--app-panel)]",
        hasError
          ? "border-[var(--app-danger)]"
          : "border-[var(--app-control-border)]",
        className
      )}
    >
      <h2 className="m-0">
        <button
          id={headerId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          disabled={disabled}
          onClick={() => updateOpen(!isOpen)}
          className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left outline-none transition hover:bg-[var(--app-panel-alt)] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[var(--app-accent-ring)] disabled:cursor-not-allowed disabled:opacity-60 sm:px-5"
        >
          {sectionNumber !== undefined ? (
            <span
              aria-hidden="true"
              className={formClassNames(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                resolvedStatus === "complete"
                  ? "border-[var(--app-success-border)] bg-[var(--app-success-soft)] text-[var(--app-success)]"
                  : resolvedStatus === "error"
                    ? "border-[var(--app-danger)] bg-[var(--app-danger-soft)] text-[var(--app-danger)]"
                    : "border-[var(--app-control-border)] bg-[var(--app-panel-alt)] text-[var(--app-text)]"
              )}
            >
              {resolvedStatus === "complete" ? (
                <Check className="h-4 w-4" strokeWidth={2.25} />
              ) : (
                sectionNumber
              )}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-5">
            <span className="block text-base font-semibold leading-6 text-[var(--app-text)] sm:text-[1.0625rem]">
              {title}
            </span>
            {summaryContent ? (
              <span
                className={formClassNames(
                  "mt-0.5 block truncate text-sm font-normal leading-5 sm:mt-0",
                  hasError
                    ? "text-[var(--app-danger)]"
                    : "text-[var(--app-text-muted)]"
                )}
              >
                {summaryContent}
              </span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={formClassNames(
              "h-5 w-5 shrink-0 text-[var(--app-text-muted)] transition-transform duration-200",
              isOpen ? "rotate-180" : "rotate-0"
            )}
          />
        </button>
      </h2>
      <div
        ref={panelRef}
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        hidden={!isOpen}
        className={formClassNames(
          "border-t border-[var(--app-border)] px-4 py-5 sm:px-5 sm:py-6",
          bodyClassName
        )}
      >
        {description ? (
          <p className="mb-5 max-w-3xl text-sm leading-6 text-[var(--app-text-muted)]">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export type DraftStatus =
  | "dirty"
  | "saving"
  | "saved"
  | "partial"
  | "error";

const draftStatusConfig: Record<
  DraftStatus,
  { label: string; className: string }
> = {
  dirty: {
    label: "Unsaved changes",
    className: "text-[var(--app-text-muted)]",
  },
  saving: {
    label: "Saving draft…",
    className: "text-[var(--app-text-muted)]",
  },
  saved: {
    label: "Draft saved",
    className: "text-[var(--app-success)]",
  },
  partial: {
    label: "Draft partially saved",
    className: "text-[var(--app-warning)]",
  },
  error: {
    label: "Draft not saved",
    className: "text-[var(--app-danger)]",
  },
};

function DraftStatusIcon({ status }: { status: DraftStatus }) {
  const iconClassName = "h-4 w-4 shrink-0";
  switch (status) {
    case "saving":
      return (
        <LoaderCircle
          aria-hidden="true"
          className={`${iconClassName} animate-spin`}
        />
      );
    case "saved":
      return <CheckCircle2 aria-hidden="true" className={iconClassName} />;
    case "partial":
      return <AlertTriangle aria-hidden="true" className={iconClassName} />;
    case "error":
      return <AlertCircle aria-hidden="true" className={iconClassName} />;
    default:
      return <Circle aria-hidden="true" className={iconClassName} />;
  }
}

export function DraftStatusIndicator({
  status,
  label,
  className,
}: {
  status: DraftStatus;
  label?: ReactNode;
  className?: string;
}) {
  const config = draftStatusConfig[status];
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={formClassNames(
        "inline-flex min-w-0 items-center gap-2 text-sm font-medium",
        config.className,
        className
      )}
    >
      <DraftStatusIcon status={status} />
      <span className="truncate">{label ?? config.label}</span>
    </span>
  );
}

export type FormAlertTone = "info" | "success" | "warning" | "error";

const alertToneClasses: Record<FormAlertTone, string> = {
  info: "border-[var(--app-info-border)] bg-[var(--app-info-soft)] text-[var(--app-info)]",
  success:
    "border-[var(--app-success-border)] bg-[var(--app-success-soft)] text-[var(--app-success)]",
  warning:
    "border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] text-[var(--app-warning)]",
  error:
    "border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] text-[var(--app-danger)]",
};

function FormAlertIcon({ tone }: { tone: FormAlertTone }) {
  const iconClassName = "mt-0.5 h-5 w-5 shrink-0";
  switch (tone) {
    case "success":
      return <CheckCircle2 aria-hidden="true" className={iconClassName} />;
    case "warning":
      return <AlertTriangle aria-hidden="true" className={iconClassName} />;
    case "error":
      return <AlertCircle aria-hidden="true" className={iconClassName} />;
    default:
      return <Info aria-hidden="true" className={iconClassName} />;
  }
}

export function FormAlert({
  tone = "info",
  title,
  children,
  onDismiss,
  className,
}: {
  tone?: FormAlertTone;
  title?: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={formClassNames(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        alertToneClasses[tone],
        className
      )}
    >
      <FormAlertIcon tone={tone} />
      <div className="min-w-0 flex-1 text-[var(--app-text)]">
        {title ? <p className="font-semibold leading-5">{title}</p> : null}
        <div
          className={formClassNames(
            "leading-5 text-[var(--app-text-muted)]",
            title ? "mt-0.5" : undefined
          )}
        >
          {children}
        </div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-current outline-none transition hover:bg-black/5 focus-visible:ring-4 focus-visible:ring-current/20"
          aria-label="Dismiss message"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export type DraftSaveProgressView = {
  phase: "preparing" | "uploading" | "verifying" | "complete";
  percent: number;
  message: string;
  totalFiles: number;
  uploadedFiles: number;
  totalBytes: number;
  uploadedBytes: number;
};

function formatDraftBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DraftSaveProgressPanel({
  progress,
}: {
  progress: DraftSaveProgressView;
}) {
  const complete = progress.phase === "complete";
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={formClassNames(
        "rounded-lg border px-4 py-3 text-sm shadow-sm",
        complete
          ? "border-[var(--app-success-border)] bg-[var(--app-success-soft)]"
          : "border-[var(--app-info-border)] bg-[var(--app-info-soft)]"
      )}
    >
      <div className="flex items-start gap-3">
        {complete ? (
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--app-success)]"
            aria-hidden="true"
          />
        ) : (
          <LoaderCircle
            className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--app-info)]"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-[var(--app-text)]">
              {complete ? "Draft saved to server" : "Saving draft to server"}
            </p>
            <span className="tabular-nums font-semibold text-[var(--app-text)]">
              {percent}%
            </span>
          </div>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--app-control-border)]"
            role="progressbar"
            aria-label="Draft save progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={formClassNames(
                "h-full rounded-full transition-[width] duration-200",
                complete
                  ? "bg-[var(--app-success)]"
                  : "bg-[var(--app-accent)]"
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-[var(--app-text-muted)]">
            <span>{progress.message}</span>
            {progress.totalFiles > 0 ? (
              <span className="tabular-nums">
                {progress.uploadedFiles} of {progress.totalFiles} files -{" "}
                {formatDraftBytes(progress.uploadedBytes)} of{" "}
                {formatDraftBytes(progress.totalBytes)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs font-medium text-[var(--app-text)]">
            {complete
              ? "All draft details and photos are stored on the server."
              : "Keep this form open until saving finishes. Large drafts can take several minutes."}
          </p>
        </div>
      </div>
    </div>
  );
}

export type FormTransferMode = "draft-save" | "report-upload";

export type FormTransferProgressScreenProps = {
  mode: FormTransferMode;
  percent: number;
  message: string;
  totalFiles?: number;
  transferredFiles?: number;
  totalBytes?: number;
  transferredBytes?: number;
  cancelling?: boolean;
  finalizing?: boolean;
  onCancel: () => void;
  className?: string;
};

const transferScreenConfig: Record<
  FormTransferMode,
  {
    eyebrow: string;
    title: string;
    progressLabel: string;
    cancelLabel: string;
    cancellingLabel: string;
    warning: string;
    finalizingLabel: string;
    finalizingWarning: string;
  }
> = {
  "draft-save": {
    eyebrow: "Draft transfer",
    title: "Saving your draft",
    progressLabel: "Draft save progress",
    cancelLabel: "Cancel save",
    cancellingLabel: "Cancelling save…",
    warning:
      "Please wait and keep this page open. If you leave before saving finishes, your latest details and photos cannot be recovered.",
    finalizingLabel: "Finalizing saved draft…",
    finalizingWarning:
      "Your draft was saved. Keep this page open while the workspace finishes updating.",
  },
  "report-upload": {
    eyebrow: "Report submission",
    title: "Uploading your report",
    progressLabel: "Report upload progress",
    cancelLabel: "Stop upload",
    cancellingLabel: "Stopping upload…",
    warning:
      "Please wait and keep this page open. Leaving before the upload finishes can interrupt this submission, and unsaved changes may not be recoverable.",
    finalizingLabel: "Report accepted · finalizing…",
    finalizingWarning:
      "Your report was accepted and can no longer be cancelled. Keep this page open while the workspace is finalized.",
  },
};

function normalizedTransferCount(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(Number(value)));
}

/**
 * Full-viewport, progress-only surface for an in-flight draft save or report
 * upload. The caller owns cancellation and should keep the same draft/upload
 * identity when the user retries a safely interrupted transfer.
 */
export function FormTransferProgressScreen({
  mode,
  percent,
  message,
  totalFiles,
  transferredFiles,
  totalBytes,
  transferredBytes,
  cancelling = false,
  finalizing = false,
  onCancel,
  className,
}: FormTransferProgressScreenProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const canCancelRef = useRef(!cancelling && !finalizing);
  const generatedId = useId();
  const titleId = `form-transfer-title-${generatedId}`;
  const descriptionId = `form-transfer-description-${generatedId}`;
  const warningId = `form-transfer-warning-${generatedId}`;
  const config = transferScreenConfig[mode];
  const safePercent = Math.max(
    0,
    Math.min(100, Number.isFinite(percent) ? Math.round(percent) : 0)
  );
  const safeTotalFiles = normalizedTransferCount(totalFiles);
  const safeTransferredFiles = normalizedTransferCount(transferredFiles);
  const safeTotalBytes = normalizedTransferCount(totalBytes);
  const safeTransferredBytes = normalizedTransferCount(transferredBytes);
  const showFileStats = safeTotalFiles !== undefined && safeTotalFiles > 0;
  const showByteStats = safeTotalBytes !== undefined && safeTotalBytes > 0;
  const TransferIcon = mode === "draft-save" ? Save : CloudUpload;

  onCancelRef.current = onCancel;
  canCancelRef.current = !cancelling && !finalizing;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusTransferControl = () => {
      const cancelButton = cancelButtonRef.current;
      if (canCancelRef.current && cancelButton && !cancelButton.disabled) {
        cancelButton.focus();
        return;
      }
      dialogRef.current?.focus();
    };
    const frame = window.requestAnimationFrame(() => {
      focusTransferControl();
    });
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        focusTransferControl();
      } else if (event.key === "Escape" && canCancelRef.current) {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    document.addEventListener("keydown", containFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", containFocus);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    if (finalizing || cancelling) dialogRef.current?.focus();
  }, [cancelling, finalizing]);

  return (
    <section
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${descriptionId} ${warningId}`}
      aria-busy="true"
      className={formClassNames(
        "fixed inset-0 z-[1500] flex min-h-[100dvh] overflow-y-auto overscroll-contain bg-[var(--app-bg)] px-3 py-4 text-[var(--app-text)] sm:px-6 sm:py-8",
        className
      )}
      style={{
        paddingTop: "max(1rem, env(safe-area-inset-top))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
        paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
      }}
    >
      <div className="m-auto w-full max-w-xl rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-[var(--app-shadow-modal)] sm:p-6">
        <div className="flex items-start gap-3 sm:gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--app-info-border)] bg-[var(--app-info-soft)] text-[var(--app-info)]">
            <TransferIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--app-accent)]">
              {config.eyebrow}
            </p>
            <h2
              id={titleId}
              className="mt-1 text-lg font-bold leading-6 text-[var(--app-text-strong)] sm:text-xl"
            >
              {config.title}
            </h2>
            <p
              id={descriptionId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="mt-1 break-words text-sm leading-5 text-[var(--app-text-muted)]"
            >
              {finalizing
                ? config.finalizingLabel
                : cancelling
                  ? config.cancellingLabel
                  : message}
            </p>
          </div>
          <span className="shrink-0 text-lg font-bold tabular-nums text-[var(--app-text-strong)]">
            {safePercent}%
          </span>
        </div>

        <div
          className="mt-5 h-2.5 overflow-hidden rounded-full bg-[var(--app-control-border)]"
          role="progressbar"
          aria-label={config.progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safePercent}
          aria-valuetext={`${safePercent}% - ${
            finalizing
              ? config.finalizingLabel
              : cancelling
                ? config.cancellingLabel
                : message
          }`}
        >
          <div
            className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${safePercent}%` }}
          />
        </div>

        {showFileStats || showByteStats ? (
          <dl className="mt-4 grid grid-cols-1 gap-2 min-[390px]:grid-cols-2">
            {showFileStats ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2.5">
                <dt className="text-xs font-medium text-[var(--app-text-muted)]">
                  Files
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--app-text)]">
                  {safeTransferredFiles === undefined
                    ? `${safeTotalFiles} total`
                    : `${Math.min(safeTransferredFiles, safeTotalFiles)} of ${safeTotalFiles}`}
                </dd>
              </div>
            ) : null}
            {showByteStats ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2.5">
                <dt className="text-xs font-medium text-[var(--app-text-muted)]">
                  Data
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--app-text)]">
                  {safeTransferredBytes === undefined
                    ? formatDraftBytes(safeTotalBytes)
                    : `${formatDraftBytes(
                        Math.min(safeTransferredBytes, safeTotalBytes)
                      )} of ${formatDraftBytes(safeTotalBytes)}`}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <div
          id={warningId}
          className="mt-4 flex items-start gap-2.5 rounded-lg border border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] px-3 py-3 text-sm leading-5"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-warning)]"
            aria-hidden="true"
          />
          <p className="font-medium text-[var(--app-text)]">
            {finalizing ? config.finalizingWarning : config.warning}
          </p>
        </div>

        <div className="mt-5 flex justify-stretch sm:justify-end">
          {finalizing ? (
            <div
              aria-hidden="true"
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--app-info-border)] bg-[var(--app-info-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--app-info)] sm:w-auto"
            >
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {config.finalizingLabel}
            </div>
          ) : (
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className={formClassNames(
                secondaryButtonClass,
                "w-full border-[var(--app-danger-border)] text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] sm:w-auto"
              )}
            >
              {cancelling ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <X className="h-4 w-4" aria-hidden="true" />
              )}
              {cancelling ? config.cancellingLabel : config.cancelLabel}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function FormActionBar({
  children,
  className,
  ariaLabel = "Form actions",
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <footer
      aria-label={ariaLabel}
      className={formClassNames(
        "sticky bottom-0 z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-4 sm:px-6",
        className
      )}
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {children}
    </footer>
  );
}

export type ConfirmDialogTone = "default" | "warning" | "danger";

export type ConfirmDialogProps = {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: ConfirmDialogTone;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const generatedId = useId();
  const titleId = `confirm-title-${generatedId}`;
  const descriptionId = description
    ? `confirm-description-${generatedId}`
    : undefined;
  const destructive = tone === "danger";

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="app-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="app-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
      <div
        className="app-dialog__header"
        style={{ display: "flex", alignItems: "flex-start", gap: 12 }}
      >
        {tone !== "default" ? (
          <span
            className={formClassNames(
              "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg",
              destructive
                ? "bg-[var(--app-danger-soft)] text-[var(--app-danger)]"
                : "bg-[var(--app-warning-soft)] text-[var(--app-warning)]"
            )}
          >
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
        ) : null}
        <h2
          id={titleId}
          className="min-w-0 flex-1 text-lg font-semibold leading-7 text-[var(--app-text)]"
        >
          {title}
        </h2>
        <button
          type="button"
          aria-label="Close confirmation"
          onClick={onCancel}
          disabled={busy}
          className={iconButtonClass}
          style={{ minWidth: 36, minHeight: 36 }}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="app-dialog__body">
        {description ? (
          <p
            id={descriptionId}
            className="text-sm leading-6 text-[var(--app-text-muted)]"
          >
            {description}
          </p>
        ) : null}
        {children ? (
          <div className={description ? "mt-4" : undefined}>{children}</div>
        ) : null}
      </div>
      <div className="app-dialog__footer">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          autoFocus
          className={secondaryButtonClass}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          className={destructive ? dangerButtonClass : primaryButtonClass}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
      </div>
    </div>
  );
}
