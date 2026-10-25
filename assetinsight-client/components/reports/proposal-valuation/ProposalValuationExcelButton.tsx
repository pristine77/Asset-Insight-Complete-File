"use client";

import { FileSpreadsheet, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { ProposalValuationService } from "@/services/proposalValuation";

type Props = {
  reportId: string;
  title?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
};

function fallbackFilename(title: string | undefined, reportId: string) {
  const source = title?.trim() || reportId;
  const segment = source
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `proposal-valuation-${segment || "export"}.xlsx`;
}

function excelFilename(filename: string | undefined, fallback: string) {
  const selected = filename?.trim() || fallback;
  return /\.xlsx$/i.test(selected) ? selected : `${selected}.xlsx`;
}

export default function ProposalValuationExcelButton({
  reportId,
  title,
  disabled = false,
  compact = false,
  className = "",
}: Props) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const errorId = useId();
  const objectUrlRef = useRef<string | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    if (objectUrlRef.current) {
      window.URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => releaseObjectUrl, [releaseObjectUrl]);

  const exportExcel = async () => {
    if (disabled || exporting) return;
    setExporting(true);
    setError("");
    try {
      const { blob, filename } = await ProposalValuationService.exportExcel(
        reportId
      );
      releaseObjectUrl();
      const objectUrl = window.URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = excelFilename(
        filename,
        fallbackFilename(title, reportId)
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      cleanupTimerRef.current = window.setTimeout(releaseObjectUrl, 500);
      toast.success(`Excel export started: ${anchor.download}`);
    } catch (exportError) {
      const message =
        exportError instanceof Error
          ? exportError.message
          : "Unable to export this Proposal Valuation to Excel.";
      setError(message);
      toast.error(message);
    } finally {
      setExporting(false);
    }
  };

  const accessibleTitle = title?.trim() || "Proposal Valuation";

  return (
    <span className="inline-flex min-w-0 flex-col">
      <button
        type="button"
        onClick={() => void exportExcel()}
        disabled={disabled || exporting}
        aria-label={`Export ${accessibleTitle} to Excel`}
        aria-describedby={error ? errorId : undefined}
        aria-busy={exporting}
        className={`${compact ? "h-8 px-2 text-xs" : "h-8 px-2.5 text-xs"} inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--app-border-strong)] bg-[var(--app-panel)] font-bold text-[var(--app-text)] transition-colors hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)] hover:text-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
      >
        {exporting ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileSpreadsheet className="size-3.5" aria-hidden="true" />
        )}
        <span>
          {exporting ? (
            <>
              <span className="hidden sm:inline">Preparing…</span>
              <span className="sm:hidden">Wait…</span>
            </>
          ) : compact ? (
            "Excel"
          ) : (
            <>
              <span className="hidden sm:inline">Export Excel</span>
              <span className="sm:hidden">Excel</span>
            </>
          )}
        </span>
      </button>
      {error ? (
        <span id={errorId} className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
