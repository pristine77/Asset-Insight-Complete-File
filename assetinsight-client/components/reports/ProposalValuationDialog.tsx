"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Images,
  Info,
  RefreshCw,
  Save,
  Search,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  ProposalValuationAccessLost,
  ProposalValuationRevisionConflict,
  ProposalValuationService,
  ProposalValuationStreamAuthenticationError,
} from "@/services/proposalValuation";
import {
  buildProposalValuationCalculations,
  cloneProposalValuationSheet,
  deriveProposalValuationSummary,
  formatMoney,
  formatPercent,
  proposalValuationColumnTotals,
  proposalValuationTotals,
  recalculateProposalValuationSheet,
  rowValuationAmounts,
} from "./proposal-valuation/calculations";
import EvaluatorPicker from "./proposal-valuation/EvaluatorPicker";
import FormulaDetailsDialog from "./proposal-valuation/FormulaDetailsDialog";
import ProposalValuationExcelButton from "./proposal-valuation/ProposalValuationExcelButton";
import { ColumnTotalsFooter, MobileColumnTotals } from "./proposal-valuation/ColumnTotals";
import type {
  ProposalValuationCalculation,
  ProposalValuationCandidate,
  ProposalValuationChange,
  ProposalValuationEvaluator,
  ProposalValuationPayload,
  ProposalValuationRow,
  ProposalValuationSheet,
} from "./proposal-valuation/types";

type Props = {
  open: boolean;
  reportId: string;
  onClose?: () => void;
  onSaved?: () => void;
  pageMode?: boolean;
};

const LEGACY_OWNER_PERMISSIONS = {
  canManageEvaluators: true,
  canEditAll: true,
  evaluatorColumnId: null,
  canRegenerateFiles: true,
} as const;

type RowChange = (
  lotId: string,
  key: keyof ProposalValuationRow,
  value: string | number | null
) => void;

type EvaluatorChange = (
  lotId: string,
  evaluatorId: string,
  value: number | null
) => void;

type FileSummaryChange = <K extends keyof ProposalValuationSheet["file_summary"]>(
  key: K,
  value: ProposalValuationSheet["file_summary"][K]
) => void;

type PictureGalleryState = {
  label: string;
  urls: string[];
  index: number;
};

type DraftMutationEnvelope = {
  changes: ProposalValuationChange[];
  request: {
    baseRevision: number;
    clientMutationId: string;
  };
};

type OpenPictureGallery = (
  label: string,
  urls: string[],
  opener: HTMLButtonElement
) => void;

function parseNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function draftChangeKey(change: ProposalValuationChange) {
  return `${change.lotId ?? "file"}:${change.field}`;
}

function applyDraftChanges(
  source: ProposalValuationSheet,
  changes: ProposalValuationChange[]
) {
  const next = cloneProposalValuationSheet(source);
  for (const change of changes) {
    if (change.lotId === null && change.field.startsWith("file_summary.")) {
      const key = change.field.slice("file_summary.".length) as keyof ProposalValuationSheet["file_summary"];
      (next.file_summary as Record<string, unknown>)[key] = change.value;
      continue;
    }
    const row = next.rows.find((candidate) => candidate.lot_id === change.lotId);
    if (!row) continue;
    if (change.field.startsWith("evaluator_values.")) {
      const evaluatorId = change.field.slice("evaluator_values.".length);
      row.evaluator_values[evaluatorId] = change.value as number | null;
    } else {
      (row as unknown as Record<string, unknown>)[change.field] = change.value;
    }
  }
  return recalculateProposalValuationSheet(next);
}

const textControlClass =
  "w-full rounded border border-[var(--app-control-border)] bg-[var(--app-input)] px-2 py-1 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]";
const numericControlClass = `${textControlClass} text-right font-semibold tabular-nums`;

function assetLabel(row: ProposalValuationRow) {
  return row.asset_id || row.lot_id || "asset";
}

function validPictureUrls(row: ProposalValuationRow) {
  return (row.picture_urls || [])
    .map((url) => String(url || "").trim())
    .filter(Boolean);
}

function pictureCount(row: ProposalValuationRow, urls = validPictureUrls(row)) {
  return urls.length || Math.max(0, Math.trunc(Number(row.pictures) || 0));
}

function rowDisplayValues(
  row: ProposalValuationRow,
  evaluators: ProposalValuationEvaluator[]
) {
  const { average, low, high, premium, gross } = rowValuationAmounts(row, evaluators);

  return {
    average: average ?? 0,
    low,
    high,
    buyerPremiumPercent: row.buyer_premium_percent || 15,
    buyerPremiumAmount: premium,
    totalExpectedGross: gross,
    allocatedValue: gross,
    cleaning: high === null ? null : high * 0.01,
    lottingFee: high === null ? null : high * 0.01,
    advertising: high === null ? null : high * 0.01,
  };
}

function ScheduleTextField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  multiline = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
}) {
  if (multiline) {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        className={`${textControlClass} min-h-14 resize-y leading-5 disabled:cursor-default disabled:opacity-75`}
      />
    );
  }

  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoComplete="off"
      disabled={disabled}
      className={`${textControlClass} h-8 disabled:cursor-default disabled:opacity-75`}
    />
  );
}

function ScheduleNumberField({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      value={value ?? ""}
      onChange={(event) => onChange(parseNumber(event.target.value))}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${numericControlClass} h-8 disabled:cursor-default disabled:opacity-75`}
    />
  );
}

function ReadOnlyScheduleValue({
  value,
  accent = false,
  align = "right",
}: {
  value: string | number;
  accent?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div
      className={`min-h-8 rounded border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 py-1.5 text-xs font-semibold tabular-nums ${
        accent ? "text-[var(--app-accent)]" : "text-[var(--app-text)]"
      } ${align === "right" ? "text-right" : "text-left"}`}
    >
      {value}
    </div>
  );
}

function PictureSummary({
  row,
  onOpen,
  thumbnailOnly = false,
}: {
  row: ProposalValuationRow;
  onOpen: OpenPictureGallery;
  thumbnailOnly?: boolean;
}) {
  const label = assetLabel(row);
  const urls = validPictureUrls(row);
  const count = pictureCount(row, urls);
  const countLabel = `${count} picture${count === 1 ? "" : "s"}`;

  if (thumbnailOnly) {
    if (!urls.length) {
      return (
        <div
          className="grid size-16 place-items-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)]"
          aria-label={`No pictures available for ${label}`}
        >
          <Images className="size-7 text-[var(--app-text-muted)]" />
        </div>
      );
    }

    return (
      <button
        type="button"
        onClick={(event) => onOpen(label, urls, event.currentTarget)}
        className="size-16 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] transition-colors hover:border-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)]"
        aria-label={`Open ${countLabel} for ${label}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={urls[0]} alt="" loading="lazy" className="size-full object-cover" />
      </button>
    );
  }

  if (!urls.length) {
    return <ReadOnlyScheduleValue value={countLabel} align="left" />;
  }

  return (
    <button
      type="button"
      onClick={(event) => onOpen(label, urls, event.currentTarget)}
      className="group flex min-h-10 w-full items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-1.5 text-left text-sm font-semibold text-[var(--app-text)] transition-colors hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)]"
      aria-label={`Open ${countLabel} for ${label}`}
    >
      <span className="size-8 shrink-0 overflow-hidden rounded border border-[var(--app-border)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={urls[0]} alt="" loading="lazy" className="size-full object-cover" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate">{countLabel}</span>
        <span className="block text-[10px] font-medium text-[var(--app-text-muted)] group-hover:text-[var(--app-accent)]">
          View
        </span>
      </span>
    </button>
  );
}

const ValuationRow = memo(function ValuationRow({
  row,
  evaluators,
  currency,
  canEditAll,
  editableEvaluatorId,
  onChange,
  onEvaluatorChange,
  onOpenGallery,
}: {
  row: ProposalValuationRow;
  evaluators: ProposalValuationEvaluator[];
  currency: string;
  canEditAll: boolean;
  editableEvaluatorId: string | null;
  onChange: RowChange;
  onEvaluatorChange: EvaluatorChange;
  onOpenGallery: OpenPictureGallery;
}) {
  const display = rowDisplayValues(row, evaluators);
  const label = assetLabel(row);

  return (
    <tr
      className="border-b border-[var(--app-border)] align-top last:border-0"
      style={{ contentVisibility: "auto", containIntrinsicSize: "72px" }}
    >
      <td className="sticky left-0 z-[2] min-w-[92px] bg-[var(--app-panel)] px-1.5 py-2 text-xs font-bold text-[var(--app-text-strong)]">
        {label}
      </td>
      <td className="min-w-[184px] px-2 py-3">
        <ScheduleTextField value={row.asset_category} onChange={(value) => onChange(row.lot_id, "asset_category", value)} ariaLabel={`Asset category for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[104px] px-2 py-3">
        <ScheduleTextField value={row.year} onChange={(value) => onChange(row.lot_id, "year", value)} ariaLabel={`Year for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[136px] px-2 py-3">
        <ScheduleTextField value={row.make} onChange={(value) => onChange(row.lot_id, "make", value)} ariaLabel={`Make for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[152px] px-2 py-3">
        <ScheduleTextField value={row.model} onChange={(value) => onChange(row.lot_id, "model", value)} ariaLabel={`Model for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[184px] px-2 py-3">
        <ScheduleTextField value={row.serial_number} onChange={(value) => onChange(row.lot_id, "serial_number", value)} ariaLabel={`Serial number for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[280px] px-2 py-3">
        <ScheduleTextField value={row.cr_details} onChange={(value) => onChange(row.lot_id, "cr_details", value)} ariaLabel={`CR details for ${label}`} multiline disabled={!canEditAll} />
      </td>
      <td className="min-w-[144px] px-2 py-3">
        <ScheduleTextField value={row.condition_score} onChange={(value) => onChange(row.lot_id, "condition_score", value)} ariaLabel={`Condition for ${label}`} placeholder="1-5" disabled={!canEditAll} />
      </td>
      <td className="min-w-[220px] px-2 py-3">
        <ScheduleTextField value={row.location} onChange={(value) => onChange(row.lot_id, "location", value)} ariaLabel={`Location for ${label}`} placeholder="City, State/Prov" disabled={!canEditAll} />
      </td>
      <td className="min-w-[120px] px-2 py-3">
        <PictureSummary row={row} onOpen={onOpenGallery} />
      </td>
      <td className="min-w-[176px] px-2 py-3">
        <ReadOnlyScheduleValue value={row.asset_insight || "-"} accent align="left" />
      </td>
      {evaluators.map((column) => (
        <td key={column.id} className="min-w-[152px] px-2 py-3">
          <ScheduleNumberField value={row.evaluator_values?.[column.id] ?? null} onChange={(value) => onEvaluatorChange(row.lot_id, column.id, value)} ariaLabel={`${column.name} valuation for ${label}`} disabled={!canEditAll && editableEvaluatorId !== column.id} />
        </td>
      ))}
      <td className="min-w-[144px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.average, currency)} /></td>
      <td className="min-w-[160px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.low, currency)} /></td>
      <td className="min-w-[160px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.high, currency)} /></td>
      <td className="min-w-[128px] px-2 py-3"><ReadOnlyScheduleValue value={`${display.buyerPremiumPercent}%`} /></td>
      <td className="min-w-[152px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.buyerPremiumAmount, currency)} /></td>
      <td className="min-w-[176px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.totalExpectedGross, currency)} /></td>
      <td className="min-w-[152px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.allocatedValue, currency)} /></td>
      <td className="min-w-[220px] px-2 py-3">
        <ScheduleTextField value={row.notes} onChange={(value) => onChange(row.lot_id, "notes", value)} ariaLabel={`Notes for ${label}`} placeholder="Notes" multiline disabled={!canEditAll} />
      </td>
      <td className="min-w-[120px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.cleaning, currency)} /></td>
      <td className="min-w-[136px] px-2 py-3">
        <ScheduleNumberField value={row.lien_search} onChange={(value) => onChange(row.lot_id, "lien_search", value)} ariaLabel={`Lien search cost for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[136px] px-2 py-3">
        <ScheduleNumberField value={row.video_cost} onChange={(value) => onChange(row.lot_id, "video_cost", value)} ariaLabel={`Video cost for ${label}`} disabled={!canEditAll} />
      </td>
      <td className="min-w-[132px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.lottingFee, currency)} /></td>
      <td className="min-w-[132px] px-2 py-3"><ReadOnlyScheduleValue value={formatMoney(display.advertising, currency)} /></td>
    </tr>
  );
});

function MobileSection({
  title,
  children,
  initiallyOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
    >
      <summary className="cursor-pointer select-none px-3 py-3 text-sm font-bold text-[var(--app-text-strong)]">
        {title}
      </summary>
      <div className="border-t border-[var(--app-border)] p-3">{children}</div>
    </details>
  );
}

function MobileLabeledValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold text-[var(--app-text-muted)]">{label}</p>
      <ReadOnlyScheduleValue value={value} align="left" />
    </div>
  );
}

const MobileValuationCard = memo(function MobileValuationCard({
  row,
  evaluators,
  currency,
  canEditAll,
  editableEvaluatorId,
  onChange,
  onEvaluatorChange,
  onOpenGallery,
}: {
  row: ProposalValuationRow;
  evaluators: ProposalValuationEvaluator[];
  currency: string;
  canEditAll: boolean;
  editableEvaluatorId: string | null;
  onChange: RowChange;
  onEvaluatorChange: EvaluatorChange;
  onOpenGallery: OpenPictureGallery;
}) {
  const display = rowDisplayValues(row, evaluators);
  const label = assetLabel(row);
  const count = pictureCount(row);

  return (
    <article
      className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3"
      style={{ contentVisibility: "auto", containIntrinsicSize: "640px" }}
    >
      <div className="flex gap-3">
        <div className="shrink-0">
          <PictureSummary row={row} onOpen={onOpenGallery} thumbnailOnly />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-[var(--app-text-strong)]">
            {label}
          </h3>
          <p className="mt-1 line-clamp-2 text-xs text-[var(--app-text-muted)]">
            {[row.year, row.make, row.model].filter(Boolean).join(" ") || row.asset_category}
          </p>
          <p className="mt-2 text-lg font-bold tabular-nums text-[var(--app-accent)]">
            {formatMoney(display.average, currency)}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--app-text-muted)]">{count} picture{count === 1 ? "" : "s"}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        <MobileSection title="Asset details" initiallyOpen>
          <div className="grid grid-cols-2 gap-2">
            {([
              ["Asset Category", "asset_category"],
              ["Year", "year"],
              ["Make", "make"],
              ["Model", "model"],
              ["Serial Number", "serial_number"],
              ["Condition (1-5)", "condition_score"],
            ] as const).map(([fieldLabel, key]) => (
              <label key={key} className="min-w-0 text-xs font-semibold text-[var(--app-text-muted)]">
                {fieldLabel}
                <span className="mt-1 block">
                  <ScheduleTextField value={row[key]} onChange={(value) => onChange(row.lot_id, key, value)} ariaLabel={`${fieldLabel} for ${label}`} disabled={!canEditAll} />
                </span>
              </label>
            ))}
          </div>
          <label className="mt-3 block text-xs font-semibold text-[var(--app-text-muted)]">
            CR Details
            <span className="mt-1 block"><ScheduleTextField value={row.cr_details} onChange={(value) => onChange(row.lot_id, "cr_details", value)} ariaLabel={`CR details for ${label}`} multiline disabled={!canEditAll} /></span>
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--app-text-muted)]">
            Location (City, State/Prov)
            <span className="mt-1 block"><ScheduleTextField value={row.location} onChange={(value) => onChange(row.lot_id, "location", value)} ariaLabel={`Location for ${label}`} placeholder="City, State/Prov" disabled={!canEditAll} /></span>
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MobileLabeledValue label="Pictures" value={`${count} picture${count === 1 ? "" : "s"}`} />
            <MobileLabeledValue label="Asset Insight" value={row.asset_insight || "-"} />
          </div>
        </MobileSection>

        <MobileSection title="Evaluator values">
          <div className="grid grid-cols-2 gap-2">
            {evaluators.map((column) => (
              <label key={column.id} className="min-w-0 text-xs font-semibold text-[var(--app-text-muted)]">
                {column.name}
                <span className="mt-1 block"><ScheduleNumberField value={row.evaluator_values?.[column.id] ?? null} onChange={(value) => onEvaluatorChange(row.lot_id, column.id, value)} ariaLabel={`${column.name} valuation for ${label}`} disabled={!canEditAll && editableEvaluatorId !== column.id} /></span>
              </label>
            ))}
            <MobileLabeledValue label="Average" value={formatMoney(display.average, currency)} />
          </div>
        </MobileSection>

        <MobileSection title="Estimated values">
          <div className="grid grid-cols-2 gap-2">
            <MobileLabeledValue label="Low Est. Sale Value" value={formatMoney(display.low, currency)} />
            <MobileLabeledValue label="High Est. Sale Value" value={formatMoney(display.high, currency)} />
            <MobileLabeledValue label="Buyer Premium %" value={`${display.buyerPremiumPercent}%`} />
            <MobileLabeledValue label="Buyer Premium" value={formatMoney(display.buyerPremiumAmount, currency)} />
            <MobileLabeledValue label="Total Expected Gross" value={formatMoney(display.totalExpectedGross, currency)} />
            <MobileLabeledValue label="Allocated Value" value={formatMoney(display.allocatedValue, currency)} />
          </div>
        </MobileSection>

        <MobileSection title="Costs & notes">
          <div className="grid grid-cols-2 gap-2">
            <MobileLabeledValue label="Cleaning" value={formatMoney(display.cleaning, currency)} />
            <MobileLabeledValue label="Lotting Fee" value={formatMoney(display.lottingFee, currency)} />
            <MobileLabeledValue label="Advertising" value={formatMoney(display.advertising, currency)} />
            <label className="min-w-0 text-xs font-semibold text-[var(--app-text-muted)]">Lien Search<span className="mt-1 block"><ScheduleNumberField value={row.lien_search} onChange={(value) => onChange(row.lot_id, "lien_search", value)} ariaLabel={`Lien search cost for ${label}`} disabled={!canEditAll} /></span></label>
            <label className="min-w-0 text-xs font-semibold text-[var(--app-text-muted)]">Video Cost<span className="mt-1 block"><ScheduleNumberField value={row.video_cost} onChange={(value) => onChange(row.lot_id, "video_cost", value)} ariaLabel={`Video cost for ${label}`} disabled={!canEditAll} /></span></label>
          </div>
          <label className="mt-3 block text-xs font-semibold text-[var(--app-text-muted)]">Notes<span className="mt-1 block"><ScheduleTextField value={row.notes} onChange={(value) => onChange(row.lot_id, "notes", value)} ariaLabel={`Notes for ${label}`} multiline disabled={!canEditAll} /></span></label>
        </MobileSection>
      </div>
    </article>
  );
});

type SummaryDisplayRow = {
  label: string;
  value: React.ReactNode;
  calculation?: ProposalValuationCalculation;
  note?: string;
};

function SummaryTable({
  title,
  rows,
  onShowCalculation,
}: {
  title: string;
  rows: SummaryDisplayRow[];
  onShowCalculation: (calculation: ProposalValuationCalculation) => void;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]">
      <h3 className="border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2 text-xs font-bold text-[var(--app-text-strong)]">
        {title}
      </h3>
      <div className="divide-y divide-[var(--app-border)]">
        {rows.map((row) => (
          <div key={row.label} className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-[var(--app-text-muted)]">
              <span className="truncate">{row.label}</span>
              {row.note ? (
                <span
                  className="shrink-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--app-text-muted)]"
                  title={row.note}
                >
                  Reference only
                </span>
              ) : null}
              {row.calculation ? (
                <button
                  type="button"
                  onClick={() => onShowCalculation(row.calculation!)}
                  className="grid size-6 shrink-0 place-items-center rounded text-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
                  aria-label={`How ${row.label} is calculated`}
                  title={`How ${row.label} is calculated`}
                >
                  <Info className="size-3.5" />
                </button>
              ) : null}
            </span>
            <strong className="max-w-48 text-right font-bold tabular-nums text-[var(--app-text-strong)]">
              {row.value}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ProposalValuationDialog({
  open,
  reportId,
  onClose,
  onSaved,
  pageMode = false,
}: Props) {
  const [payload, setPayload] = useState<ProposalValuationPayload | null>(null);
  const [sheet, setSheet] = useState<ProposalValuationSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"lots" | "summary">("lots");
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [syncing, setSyncing] = useState(false);
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState("");
  const [liveRefreshMessage, setLiveRefreshMessage] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [formulaDetails, setFormulaDetails] = useState<ProposalValuationCalculation | null>(null);
  const [pictureGallery, setPictureGallery] = useState<PictureGalleryState | null>(null);
  const galleryPanelRef = useRef<HTMLElement | null>(null);
  const galleryOpenerRef = useRef<HTMLButtonElement | null>(null);
  const restoreGalleryFocusRef = useRef(false);
  const pendingChangesRef = useRef<Map<string, ProposalValuationChange>>(new Map());
  const retryEnvelopeRef = useRef<DraftMutationEnvelope | null>(null);
  const revisionRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const flushChangesRef = useRef<() => Promise<void>>(async () => undefined);
  const syncingRef = useRef(false);
  const autosavePausedRef = useRef(false);
  const conflictRetriesRef = useRef<Set<string>>(new Set());
  const terminalRef = useRef(false);
  const liveControllerRef = useRef<AbortController | null>(null);
  const resyncInFlightRef = useRef<Promise<ProposalValuationPayload> | null>(null);
  const resyncRequestedRef = useRef(false);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const currency = payload?.currencyCode || "CAD";
  const permissions = payload?.permissions || LEGACY_OWNER_PERMISSIONS;
  const ownerUserId = payload?.participants?.find((participant) => participant.isOwner === true)?.id;
  const workspaceCanEditAll =
    permissions.canEditAll && !terminalMessage && !assigning && !saving;
  const workspaceEvaluatorColumnId = terminalMessage || assigning || saving
    ? null
    : permissions.evaluatorColumnId;
  const liveReady =
    !loading && !terminalMessage && payload?.reportId === reportId;

  const stopForTerminalError = useCallback((message: string) => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    autosavePausedRef.current = true;
    resyncRequestedRef.current = false;
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    liveControllerRef.current?.abort();
    liveControllerRef.current = null;
    setTerminalMessage(message);
    setLiveRefreshMessage("");
    setError("");
    setSaveBlocked(false);
    setLiveStatus("offline");
  }, []);

  const openPictureGallery = useCallback<OpenPictureGallery>(
    (label, urls, opener) => {
      const availableUrls = urls
        .map((url) => String(url || "").trim())
        .filter(Boolean);
      if (!availableUrls.length) return;
      galleryOpenerRef.current = opener;
      restoreGalleryFocusRef.current = false;
      setPictureGallery({ label, urls: availableUrls, index: 0 });
    },
    []
  );

  const closePictureGallery = useCallback(() => {
    restoreGalleryFocusRef.current = true;
    setPictureGallery(null);
  }, []);

  const movePictureGallery = useCallback((offset: number) => {
    setPictureGallery((current) => {
      if (!current || current.urls.length <= 1) return current;
      const index =
        (current.index + offset + current.urls.length) % current.urls.length;
      return { ...current, index };
    });
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await ProposalValuationService.get(reportId, signal);
      setLiveRefreshMessage("");
      setPayload(response);
      setSheet(cloneProposalValuationSheet(response.assetScheduleSheet));
      revisionRef.current = response.revision ?? 0;
      setDirty(false);
    } catch (loadError) {
      if (signal?.aborted) return;
      if (loadError instanceof ProposalValuationAccessLost) {
        stopForTerminalError(loadError.message);
      } else {
        setError(loadError instanceof Error ? loadError.message : "Unable to load Proposal Valuation.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [reportId, stopForTerminalError]);

  const resyncWithPending = useCallback(async () => {
    if (resyncInFlightRef.current) {
      resyncRequestedRef.current = true;
      return resyncInFlightRef.current;
    }
    const run = async () => {
      let latest: ProposalValuationPayload | null = null;
      do {
        resyncRequestedRef.current = false;
        const response = await ProposalValuationService.get(reportId);
        setLiveRefreshMessage("");
        latest = response;
        const responseRevision = response.revision ?? revisionRef.current;
        if (!terminalRef.current && responseRevision >= revisionRef.current) {
          const localChanges = new Map<string, ProposalValuationChange>();
          for (const change of retryEnvelopeRef.current?.changes ?? []) {
            localChanges.set(draftChangeKey(change), change);
          }
          for (const change of pendingChangesRef.current.values()) {
            localChanges.set(draftChangeKey(change), change);
          }
          const pending = [...localChanges.values()];
          revisionRef.current = responseRevision;
          setPayload(response);
          setSheet(
            pending.length
              ? applyDraftChanges(response.assetScheduleSheet, pending)
              : cloneProposalValuationSheet(response.assetScheduleSheet)
          );
          setDirty(pending.length > 0);
        }
      } while (resyncRequestedRef.current && !terminalRef.current);
      return latest!;
    };
    const request = run().finally(() => {
      resyncInFlightRef.current = null;
    });
    resyncInFlightRef.current = request;
    return request;
  }, [reportId]);

  const flushChanges = useCallback(async () => {
    if (
      !pageMode ||
      syncingRef.current ||
      terminalRef.current ||
      autosavePausedRef.current ||
      (!retryEnvelopeRef.current && !pendingChangesRef.current.size)
    ) return;
    syncingRef.current = true;
    setSyncing(true);
    const envelope = retryEnvelopeRef.current ?? {
      changes: [...pendingChangesRef.current.values()],
      request: {
        baseRevision: revisionRef.current,
        clientMutationId: ProposalValuationService.newMutationId("pv-draft"),
      },
    };
    if (!retryEnvelopeRef.current) pendingChangesRef.current.clear();
    retryEnvelopeRef.current = envelope;
    const { changes: batch, request } = envelope;
    let retryDelay = 3000;
    try {
      const response = await ProposalValuationService.patchChanges(
        reportId,
        batch,
        request
      );
      retryEnvelopeRef.current = null;
      const responseRevision = response.revision ?? request.baseRevision + 1;
      const remaining = [...pendingChangesRef.current.values()];
      if (responseRevision >= revisionRef.current) {
        revisionRef.current = responseRevision;
        setPayload(response);
        setSheet(
          remaining.length
            ? applyDraftChanges(response.assetScheduleSheet, remaining)
            : cloneProposalValuationSheet(response.assetScheduleSheet)
        );
      } else {
        resyncRequestedRef.current = true;
      }
      setDirty(remaining.length > 0);
      for (const change of batch) {
        conflictRetriesRef.current.delete(draftChangeKey(change));
      }
      setSaveBlocked(false);
      onSaved?.();
    } catch (saveError) {
      setDirty(true);
      if (saveError instanceof ProposalValuationAccessLost) {
        stopForTerminalError(saveError.message);
      } else if (saveError instanceof ProposalValuationRevisionConflict) {
        retryEnvelopeRef.current = null;
        for (const change of batch) {
          if (!pendingChangesRef.current.has(draftChangeKey(change))) {
            pendingChangesRef.current.set(draftChangeKey(change), change);
          }
        }
        const repeatedConflict = batch.some((change) =>
          conflictRetriesRef.current.has(draftChangeKey(change))
        );
        try {
          await resyncWithPending();
          if (repeatedConflict) {
            autosavePausedRef.current = true;
            setSaveBlocked(true);
            toast.error(
              "This valuation changed again while merging. Your draft is still visible; retry when ready."
            );
          } else {
            for (const change of batch) {
              conflictRetriesRef.current.add(draftChangeKey(change));
            }
            retryDelay = 350;
          }
        } catch (reloadError) {
          if (reloadError instanceof ProposalValuationAccessLost) {
            stopForTerminalError(reloadError.message);
          } else {
            toast.error(
              reloadError instanceof Error
                ? reloadError.message
                : "Unable to reconcile collaborative changes."
            );
          }
        }
      } else {
        toast.error(
          saveError instanceof Error
            ? saveError.message
            : "Unable to save Proposal Valuation."
        );
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (resyncRequestedRef.current && !terminalRef.current) {
        void resyncWithPending().catch((resyncError) => {
          if (resyncError instanceof ProposalValuationAccessLost) {
            stopForTerminalError(resyncError.message);
          } else {
            toast.error(
              resyncError instanceof Error
                ? resyncError.message
                : "Unable to refresh collaborative changes."
            );
          }
        });
      }
      if (
        (retryEnvelopeRef.current || pendingChangesRef.current.size) &&
        !autosavePausedRef.current
      ) {
        if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = window.setTimeout(
          () => void flushChangesRef.current(),
          retryEnvelopeRef.current ? retryDelay : 500
        );
      }
    }
  }, [onSaved, pageMode, reportId, resyncWithPending, stopForTerminalError]);

  useEffect(() => {
    flushChangesRef.current = flushChanges;
  }, [flushChanges]);

  const queueDraftChange = useCallback(
    (change: ProposalValuationChange) => {
      if (!pageMode || terminalRef.current) return;
      pendingChangesRef.current.set(draftChangeKey(change), change);
      setDirty(true);
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = window.setTimeout(
        () => void flushChangesRef.current(),
        500
      );
    },
    [pageMode]
  );

  const retryBlockedSave = useCallback(() => {
    autosavePausedRef.current = false;
    conflictRetriesRef.current.clear();
    setSaveBlocked(false);
    void flushChangesRef.current();
  }, []);

  const retryLiveRefresh = useCallback(() => {
    if (terminalRef.current) return;
    setLiveStatus("connecting");
    void resyncWithPending()
      .then(() => setLiveStatus("live"))
      .catch((resyncError) => {
        if (resyncError instanceof ProposalValuationAccessLost) {
          stopForTerminalError(resyncError.message);
        } else {
          setLiveStatus("offline");
          setLiveRefreshMessage(
            resyncError instanceof Error
              ? resyncError.message
              : "Unable to refresh collaborative changes."
          );
        }
      });
  }, [resyncWithPending, stopForTerminalError]);

  useEffect(() => {
    terminalRef.current = false;
    autosavePausedRef.current = false;
    conflictRetriesRef.current.clear();
    pendingChangesRef.current.clear();
    retryEnvelopeRef.current = null;
    resyncRequestedRef.current = false;
    resyncInFlightRef.current = null;
    setTerminalMessage("");
    setLiveRefreshMessage("");
    setSaveBlocked(false);
  }, [reportId]);

  useEffect(() => {
    if (!pageMode || !open || !liveReady) return;
    const controller = new AbortController();
    liveControllerRef.current = controller;
    let reconnectTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let reconnectAttempt = 0;
    let connecting = false;

    const canConnect = () =>
      !controller.signal.aborted &&
      navigator.onLine !== false &&
      document.visibilityState !== "hidden";

    const scheduleReconnect = () => {
      if (!canConnect() || reconnectTimer !== null) return;
      const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
      reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (!canConnect() || connecting) return;
      connecting = true;
      setLiveStatus("connecting");
      try {
        await ProposalValuationService.streamEvents(
          reportId,
          revisionRef.current,
          controller.signal,
          (event) => {
            if (stabilityTimer === null) {
              stabilityTimer = window.setTimeout(() => {
                reconnectAttempt = 0;
                stabilityTimer = null;
              }, 30_000);
            }
            setLiveStatus("live");
            if (
              event.type === "resync" &&
              event.reason === "access-changed"
            ) {
              stopForTerminalError(
                "Your evaluator access to this Proposal Valuation was removed."
              );
              return;
            }
            const remoteRevision = Number(event.revision);
            const requiresResync =
              event.type === "resync" ||
              (Number.isFinite(remoteRevision) &&
                remoteRevision > revisionRef.current);
            if (requiresResync) {
              if (syncingRef.current) {
                resyncRequestedRef.current = true;
              } else {
                void resyncWithPending().catch((resyncError) => {
                  if (resyncError instanceof ProposalValuationAccessLost) {
                    stopForTerminalError(resyncError.message);
                  } else {
                    setLiveStatus("offline");
                    setLiveRefreshMessage(
                      resyncError instanceof Error
                        ? resyncError.message
                        : "Unable to refresh collaborative changes."
                    );
                  }
                });
              }
            }
          }
        );
        if (!controller.signal.aborted) {
          setLiveStatus("offline");
          scheduleReconnect();
        }
      } catch (streamError) {
        if (!controller.signal.aborted) {
          if (
            streamError instanceof ProposalValuationAccessLost ||
            streamError instanceof ProposalValuationStreamAuthenticationError
          ) {
            stopForTerminalError(streamError.message);
          } else {
            setLiveStatus("offline");
            scheduleReconnect();
          }
        }
      } finally {
        if (stabilityTimer !== null) {
          window.clearTimeout(stabilityTimer);
          stabilityTimer = null;
        }
        connecting = false;
      }
    };

    const resumeWhenAvailable = () => {
      if (!canConnect()) {
        setLiveStatus("offline");
        return;
      }
      if (!connecting && reconnectTimer === null) void connect();
    };

    window.addEventListener("online", resumeWhenAvailable);
    document.addEventListener("visibilitychange", resumeWhenAvailable);
    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (stabilityTimer) window.clearTimeout(stabilityTimer);
      window.removeEventListener("online", resumeWhenAvailable);
      document.removeEventListener("visibilitychange", resumeWhenAvailable);
      if (liveControllerRef.current === controller) {
        liveControllerRef.current = null;
      }
    };
  }, [
    liveReady,
    open,
    pageMode,
    reportId,
    resyncWithPending,
    stopForTerminalError,
  ]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      if (pendingChangesRef.current.size || retryEnvelopeRef.current) {
        void flushChangesRef.current();
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, open]);

  useEffect(() => {
    if (!open || pageMode) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, pageMode]);

  const close = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved Proposal Valuation changes?")) return;
    restoreGalleryFocusRef.current = false;
    galleryOpenerRef.current = null;
    setPictureGallery(null);
    onClose?.();
  }, [dirty, onClose]);

  useEffect(() => {
    if (pictureGallery || !restoreGalleryFocusRef.current) return;
    restoreGalleryFocusRef.current = false;
    galleryOpenerRef.current?.focus({ preventScroll: true });
  }, [pictureGallery]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (formulaDetails) return;
      if (event.key === "Escape") {
        if (pictureGallery) {
          closePictureGallery();
        } else if (!pageMode) {
          close();
        }
        return;
      }
      if (!pictureGallery) return;
      if (event.key === "Tab") {
        const panel = galleryPanelRef.current;
        if (!panel) return;
        const focusable = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (!focusable.length) {
          event.preventDefault();
          panel.focus({ preventScroll: true });
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const focusIsOutside = !panel.contains(active);
        if (event.shiftKey && (active === first || focusIsOutside)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (active === last || focusIsOutside)) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        movePictureGallery(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        movePictureGallery(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    close,
    closePictureGallery,
    formulaDetails,
    movePictureGallery,
    open,
    pageMode,
    pictureGallery,
  ]);

  const filteredRows = useMemo(() => {
    if (!sheet) return [];
    if (!deferredQuery) return sheet.rows;
    return sheet.rows.filter((row) =>
      [row.asset_id, row.asset_category, row.year, row.make, row.model, row.serial_number, row.location]
        .join(" ")
        .toLowerCase()
        .includes(deferredQuery)
    );
  }, [deferredQuery, sheet]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const pagedRows = useMemo(
    () => filteredRows.slice((page - 1) * pageSize, page * pageSize),
    [filteredRows, page, pageSize]
  );

  useEffect(() => {
    setPage(1);
  }, [deferredQuery, pageSize, reportId]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const localSummary = useMemo(
    () => (sheet ? deriveProposalValuationSummary(sheet) : null),
    [sheet]
  );
  const columnTotals = useMemo(
    () => (sheet && localSummary ? proposalValuationColumnTotals(sheet, localSummary) : null),
    [sheet, localSummary]
  );
  const summary = !dirty && payload?.summary ? payload.summary : localSummary;
  const calculations = useMemo(() => {
    if (!sheet || !summary) return [];
    const local = buildProposalValuationCalculations(sheet, summary, currency);
    if (dirty || !payload?.calculations?.length) return local;
    const merged = new Map(local.map((item) => [item.key, item]));
    for (const item of payload.calculations) merged.set(item.key, item);
    return [...merged.values()];
  }, [currency, dirty, payload?.calculations, sheet, summary]);
  const calculationMap = useMemo(
    () => new Map(calculations.map((item) => [item.key, item])),
    [calculations]
  );
  const totals = useMemo(
    () => (sheet ? proposalValuationTotals(sheet) : null),
    [sheet]
  );

  const updateRow = useCallback<RowChange>((lotId, key, value) => {
    if (!permissions.canEditAll || terminalRef.current) return;
    setSheet((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) =>
              row.lot_id === lotId ? { ...row, [key]: value } : row
            ),
          }
        : current
    );
    setDirty(true);
    queueDraftChange({ lotId, field: String(key), value });
  }, [permissions.canEditAll, queueDraftChange]);

  const updateEvaluatorValue = useCallback<EvaluatorChange>(
    (lotId, evaluatorId, value) => {
      if (
        terminalRef.current ||
        !permissions.canEditAll &&
        permissions.evaluatorColumnId !== evaluatorId
      ) {
        return;
      }
      setSheet((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row) =>
                row.lot_id === lotId
                  ? {
                      ...row,
                      evaluator_values: {
                        ...row.evaluator_values,
                        [evaluatorId]: value,
                      },
                    }
                  : row
              ),
            }
          : current
      );
      setDirty(true);
      queueDraftChange({
        lotId,
        field: `evaluator_values.${evaluatorId}`,
        value,
      });
    },
    [permissions.canEditAll, permissions.evaluatorColumnId, queueDraftChange]
  );

  const updateLinkedEvaluators = useCallback(
    async (evaluatorUserIds: string[]) => {
      if (
        terminalRef.current ||
        !permissions.canManageEvaluators ||
        assigning ||
        syncingRef.current ||
        dirty ||
        retryEnvelopeRef.current !== null ||
        pendingChangesRef.current.size > 0
      ) return;
      setAssigning(true);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const baseRevision = revisionRef.current;
            const response = await ProposalValuationService.updateEvaluators(
              reportId,
              evaluatorUserIds.filter((id) => id !== ownerUserId),
              {
                baseRevision,
                clientMutationId:
                  ProposalValuationService.newMutationId("pv-evaluators"),
              }
            );
            const responseRevision = response.revision ?? baseRevision + 1;
            if (responseRevision >= revisionRef.current) {
              const localChanges = new Map<string, ProposalValuationChange>();
              for (const change of pendingChangesRef.current.values()) {
                localChanges.set(draftChangeKey(change), change);
              }
              const pending = [...localChanges.values()];
              revisionRef.current = responseRevision;
              setPayload(response);
              setSheet(
                pending.length
                  ? applyDraftChanges(response.assetScheduleSheet, pending)
                  : cloneProposalValuationSheet(response.assetScheduleSheet)
              );
              setDirty(pending.length > 0);
            } else {
              resyncRequestedRef.current = true;
              await resyncWithPending();
            }
            toast.success("Evaluator access updated.");
            return;
          } catch (assignmentError) {
            if (
              attempt === 0 &&
              assignmentError instanceof ProposalValuationRevisionConflict
            ) {
              await resyncWithPending();
              continue;
            }
            throw assignmentError;
          }
        }
      } catch (assignmentError) {
        if (assignmentError instanceof ProposalValuationAccessLost) {
          stopForTerminalError(assignmentError.message);
        } else {
          toast.error(
            assignmentError instanceof Error
              ? assignmentError.message
              : "Unable to update evaluators."
          );
        }
      } finally {
        setAssigning(false);
      }
    },
    [
      assigning,
      dirty,
      permissions.canManageEvaluators,
      ownerUserId,
      reportId,
      resyncWithPending,
      stopForTerminalError,
    ]
  );

  const addLinkedEvaluator = useCallback(
    (candidate: ProposalValuationCandidate) => {
      if (!sheet || candidate.id === ownerUserId) return;
      const ids = sheet.evaluator_columns
        .map((column) => column.user_id)
        .filter((id): id is string => Boolean(id) && id !== ownerUserId);
      if (!ids.includes(candidate.id) && ids.length < 4) {
        void updateLinkedEvaluators([...ids, candidate.id]);
      }
    },
    [sheet, ownerUserId, updateLinkedEvaluators]
  );

  const removeLinkedEvaluator = useCallback(
    (userId: string) => {
      if (!sheet || userId === ownerUserId) return;
      const ids = sheet.evaluator_columns
        .map((column) => column.user_id)
        .filter((id): id is string => Boolean(id) && id !== userId && id !== ownerUserId);
      void updateLinkedEvaluators(ids);
    },
    [sheet, ownerUserId, updateLinkedEvaluators]
  );

  const updateFileSummary = useCallback<FileSummaryChange>((key, value) => {
    if (!permissions.canEditAll || terminalRef.current) return;
    setSheet((current) =>
      current
        ? {
            ...current,
            file_summary: { ...current.file_summary, [key]: value },
          }
        : current
    );
    setDirty(true);
    queueDraftChange({ lotId: null, field: `file_summary.${String(key)}`, value });
  }, [permissions.canEditAll, queueDraftChange]);

  const regenerateFiles = useCallback(async () => {
    if (
      terminalRef.current ||
      !permissions.canRegenerateFiles ||
      saving ||
      syncingRef.current ||
      dirty ||
      retryEnvelopeRef.current !== null ||
      pendingChangesRef.current.size > 0
    ) return;
    setSaving(true);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await ProposalValuationService.regenerate(reportId, {
            baseRevision: revisionRef.current,
            clientMutationId: ProposalValuationService.newMutationId("pv-files"),
          });
          const responseRevision = response.revision ?? revisionRef.current;
          if (responseRevision >= revisionRef.current) {
            revisionRef.current = responseRevision;
          } else {
            resyncRequestedRef.current = true;
            await resyncWithPending();
          }
          toast.success(
            response.coalesced
              ? "Changes saved. The current file update will include them."
              : "Changes saved. Updated report files are being generated."
          );
          onSaved?.();
          return;
        } catch (regenerateError) {
          if (
            attempt === 0 &&
            regenerateError instanceof ProposalValuationRevisionConflict
          ) {
            await resyncWithPending();
            continue;
          }
          throw regenerateError;
        }
      }
    } catch (regenerateError) {
      if (regenerateError instanceof ProposalValuationAccessLost) {
        stopForTerminalError(regenerateError.message);
      } else {
        toast.error(
          regenerateError instanceof Error
            ? regenerateError.message
            : "Unable to update report files."
        );
      }
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    onSaved,
    permissions.canRegenerateFiles,
    reportId,
    resyncWithPending,
    saving,
    stopForTerminalError,
  ]);

  const calculationFor = (key: string) => calculationMap.get(key);
  const metricRows: SummaryDisplayRow[] = sheet && summary
    ? [
        {
          label: "Buyers Premium Basis",
          value: (
            <select
              aria-label="Buyer premium basis"
              value={sheet.file_summary.buyers_premium_basis}
              disabled={!workspaceCanEditAll}
              onChange={(event) =>
                updateFileSummary(
                  "buyers_premium_basis",
                  event.target.value === "capped" ? "capped" : "uncapped"
                )
              }
              className="h-8 rounded border border-[var(--app-control-border)] bg-[var(--app-input)] px-2 text-xs text-[var(--app-text)]"
            >
              <option value="uncapped">Uncapped</option>
              <option value="capped">Capped</option>
            </select>
          ),
        },
        { label: "Total Asset Value", value: formatMoney(summary.total_asset_value, currency), calculation: calculationFor("total_asset_value") },
        { label: "Estimated Range", value: `${formatMoney(summary.total_low_est_value, currency)} – ${formatMoney(summary.total_high_est_value, currency)}`, calculation: calculationFor("estimated_range") },
        {
          label: "Total Risk-Weighted Value",
          value: <ScheduleNumberField value={sheet.file_summary.total_risk_weighted_value} onChange={(value) => updateFileSummary("total_risk_weighted_value", value)} ariaLabel="Total risk-weighted value" disabled={!workspaceCanEditAll} />,
          note: "Reference only; not used in calculated totals.",
        },
        {
          label: "File Risk Multiplier",
          value: <ScheduleNumberField value={sheet.file_summary.file_risk_multiplier} onChange={(value) => updateFileSummary("file_risk_multiplier", value)} ariaLabel="File risk multiplier" disabled={!workspaceCanEditAll} />,
          note: "Reference only; not used in calculated totals.",
        },
        { label: "% Low Risk Value", value: formatPercent(summary.low_risk_percent), calculation: calculationFor("low_risk_percent") },
        { label: "% Medium Risk Value", value: formatPercent(summary.medium_risk_percent), calculation: calculationFor("medium_risk_percent") },
        { label: "% High Risk Value", value: formatPercent(summary.high_risk_percent), calculation: calculationFor("high_risk_percent") },
        { label: "Weighted Average Risk Score", value: new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(summary.weighted_average_risk_score), calculation: calculationFor("weighted_average_risk_score") },
        { label: "Overall File Risk Rating", value: summary.overall_file_risk_rating, calculation: calculationFor("overall_file_risk_rating") },
        { label: "NMG", value: formatMoney(summary.selected_nmg, currency), calculation: calculationFor("selected_nmg") },
        { label: "Cash Purchase Price", value: formatMoney(summary.selected_cash_purchase_price, currency), calculation: calculationFor("selected_cash_purchase_price") },
        { label: "Commission Basis Value", value: formatMoney(summary.selected_commission_basis_value, currency), calculation: calculationFor("selected_commission_basis_value") },
        { label: "Total Projected Costs", value: formatMoney(summary.total_projected_costs, currency), calculation: calculationFor("total_projected_costs") },
        {
          label: "Commission % No Guarantee",
          value: <ScheduleNumberField value={sheet.file_summary.commission_percent_no_guarantee} onChange={(value) => updateFileSummary("commission_percent_no_guarantee", value)} ariaLabel="Commission percent with no guarantee" disabled={!workspaceCanEditAll} />,
          note: "Reference only; not used in calculated totals.",
        },
        {
          label: "Offer #2 NMG / Overage %",
          value: <ScheduleNumberField value={sheet.file_summary.offer2_nmg_percent * 100} onChange={(value) => updateFileSummary("offer2_nmg_percent", Math.max(0, Math.min(100, value ?? 0)) / 100)} ariaLabel="Offer 2 NMG percent" disabled={!workspaceCanEditAll} />,
        },
        {
          label: "Capped Threshold %",
          value: <ScheduleNumberField value={sheet.file_summary.capped_threshold_percent * 100} onChange={(value) => updateFileSummary("capped_threshold_percent", Math.max(0, Math.min(100, value ?? 0)) / 100)} ariaLabel="Capped threshold percent" disabled={!workspaceCanEditAll} />,
        },
      ]
    : [];
  const uncappedRows: SummaryDisplayRow[] = summary
    ? [
        ["Get", "get"], ["Costs", "costs"], ["Get After Costs", "get_after_costs"], ["Adjusted Get", "adjusted_get"], ["15% B.P.", "bp_15"], ["Potential Get", "potential_get"], ["Adjusted Potential Get", "adjusted_potential_get"], ["Potential 15% B.P.", "potential_bp_15"], ["Offer #1 Cash Offer (90%)", "offer1_cash_offer"], ["Offer #1 Total Costs", "offer1_total_costs"], ["Offer #1 McD Take", "offer1_mcd_take"], ["Offer #1 ROI", "offer1_roi"], ["Offer #1 Risk", "offer1_risk"], ["Offer #2 NMG", "offer2_nmg"], ["Offer #2 Threshold", "offer2_threshold"], ["Offer #2 Upper Value", "offer2_upper_value"], ["Offer #2 Total Costs", "offer2_total_costs"], ["Offer #2 Aquajet's Take", "offer2_aquajets_take"], ["Offer #2 Overage", "offer2_overage"], ["Offer #2 McD Take", "offer2_mcd_take"], ["Offer #2 ROI", "offer2_roi"], ["Offer #2 Risk", "offer2_risk"], ["Aquajet's Potential Take", "aquajets_potential_take"], ["McD Potential Take", "mcd_potential_take"], ["Potential ROI", "potential_roi"], ["Offer #3 Commission", "offer3_mcd_take"],
      ].map(([label, key]) => ({
        label,
        value: key.endsWith("roi")
          ? formatPercent(summary.uncapped[key as keyof typeof summary.uncapped] as number | null)
          : formatMoney(summary.uncapped[key as keyof typeof summary.uncapped] as number | null, currency),
        calculation: calculationFor(`uncapped.${key}`),
      }))
    : [];
  const cappedRows: SummaryDisplayRow[] = summary
    ? [
        ["AVG", "avg"], ["HIGH", "high"], ["LOW", "low"], ["BP", "bp"], ["Sale Total Inc BP", "sale_total_inc_bp"], ["Ads", "ads"], ["SVR", "svr"], ["Refurb", "refurb"], ["Total Cost", "total_cost"], ["NMG", "nmg"], ["Threshold", "threshold"], ["Risk", "risk"],
      ].map(([label, key]) => ({
        label,
        value: key === "risk"
          ? formatPercent(summary.capped.risk)
          : formatMoney(summary.capped[key as keyof typeof summary.capped] as number | null, currency),
        calculation: calculationFor(`capped.${key}`),
      }))
    : [];

  if (!open) return null;

  return (
    <>
    <div
      className={pageMode
        ? "flex h-[calc(100dvh-56px)] min-h-[480px] w-full bg-[var(--app-bg)] lg:h-[calc(100dvh-60px)]"
        : "fixed inset-0 z-[120] flex bg-black/55 p-0 backdrop-blur-sm sm:p-3 lg:p-5"}
      role={pageMode ? undefined : "dialog"}
      aria-modal={pageMode || pictureGallery || formulaDetails ? undefined : true}
      aria-label="Proposal Valuation"
      aria-hidden={pictureGallery || formulaDetails ? true : undefined}
      inert={pictureGallery || formulaDetails ? true : undefined}
    >
      <section className={`flex min-h-0 w-full flex-col overflow-hidden bg-[var(--app-bg)] ${pageMode ? "" : "shadow-2xl sm:rounded-xl sm:border sm:border-[var(--app-border)]"}`}>
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
                <BarChart3 className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-bold text-[var(--app-text-strong)] sm:text-lg">Proposal Valuation</h2>
                <p className="truncate text-xs text-[var(--app-text-muted)]">{payload?.title || "Asset report"}</p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {pageMode ? (
              <span className={`hidden items-center gap-1 text-[11px] font-semibold sm:inline-flex ${terminalMessage ? "text-[var(--app-danger)]" : liveStatus === "live" ? "text-[var(--app-success)]" : "text-[var(--app-text-muted)]"}`} aria-live="polite">
                {terminalMessage || liveStatus !== "live" ? <WifiOff className="size-3.5" /> : <Wifi className="size-3.5" />}
                {terminalMessage ? "Access ended" : syncing ? "Saving…" : liveStatus === "live" ? "Live" : "Reconnecting"}
              </span>
            ) : null}
            {pageMode ? (
              <ProposalValuationExcelButton
                reportId={reportId}
                title={payload?.title || "Proposal Valuation"}
                disabled={
                  !sheet ||
                  loading ||
                  saving ||
                  syncing ||
                  dirty ||
                  saveBlocked ||
                  Boolean(terminalMessage)
                }
              />
            ) : null}
            {permissions.canRegenerateFiles ? (
              <button
                type="button"
                onClick={() => void regenerateFiles()}
                disabled={!sheet || saving || syncing || dirty || Boolean(terminalMessage)}
                aria-label="Update report files"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--app-accent)] px-2.5 text-xs font-bold text-[var(--app-on-accent)] transition-colors hover:bg-[var(--app-accent-hover)] disabled:opacity-45"
              >
                {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                <span className="hidden sm:inline">Update report files</span>
                <span className="sm:hidden">Update files</span>
              </button>
            ) : null}
            {!pageMode ? (
              <button type="button" onClick={close} className="grid size-9 place-items-center rounded-md border border-[var(--app-border)] text-[var(--app-text)] hover:bg-[var(--app-panel-alt)]" aria-label="Close Proposal Valuation">
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </header>

        {loading ? (
          <div className="grid min-h-0 flex-1 place-items-center">
            <div className="text-center">
              <RefreshCw className="mx-auto size-7 animate-spin text-[var(--app-accent)]" />
              <p className="mt-3 text-sm font-semibold text-[var(--app-text)]">Loading Proposal Valuation...</p>
            </div>
          </div>
        ) : terminalMessage && !sheet ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6" role="alert">
            <div className="max-w-md rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] p-5 text-center">
              <AlertCircle className="mx-auto size-7 text-[var(--app-danger)]" />
              <h3 className="mt-3 font-bold text-[var(--app-danger)]">Proposal Valuation access ended</h3>
              <p className="mt-1 text-sm text-[var(--app-text)]">{terminalMessage}</p>
              <p className="mt-2 text-xs text-[var(--app-text-muted)]">Live updates and automatic requests have stopped.</p>
            </div>
          </div>
        ) : error && !sheet ? (
          <div className="grid min-h-0 flex-1 place-items-center p-6">
            <div className="max-w-md rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] p-5 text-center">
              <AlertCircle className="mx-auto size-7 text-[var(--app-danger)]" />
              <p className="mt-3 text-sm font-semibold text-[var(--app-danger)]">{error}</p>
              <button type="button" onClick={() => void load()} className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-[var(--app-danger-border)] px-3 text-sm font-bold text-[var(--app-danger)]">
                <RefreshCw className="size-4" /> Retry
              </button>
            </div>
          </div>
        ) : sheet && totals ? (
          <>
            {terminalMessage ? (
              <div className="shrink-0 border-b border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-2" role="alert">
                <div className="flex items-start gap-2 text-xs">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--app-danger)]" />
                  <div>
                    <p className="font-bold text-[var(--app-danger)]">Proposal Valuation access ended</p>
                    <p className="text-[var(--app-text)]">{terminalMessage} Your current draft remains visible for reference, but editing and live syncing have stopped.</p>
                  </div>
                </div>
              </div>
            ) : null}
            {liveRefreshMessage && !terminalMessage ? (
              <div
                className="shrink-0 border-b border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] px-3 py-2"
                role="status"
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex min-w-0 items-center gap-2 text-[var(--app-text)]">
                    <WifiOff className="size-4 shrink-0 text-[var(--app-warning)]" />
                    <span className="truncate">
                      Live refresh paused: {liveRefreshMessage} Your current workspace and draft are unchanged.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={retryLiveRefresh}
                    className="shrink-0 rounded border border-[var(--app-warning-border)] px-2 py-1 font-bold text-[var(--app-text)] hover:bg-[var(--app-panel)]"
                  >
                    Retry live refresh
                  </button>
                </div>
              </div>
            ) : null}
            <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {[
                  ["Assets", String(sheet.rows.length)],
                  ["Total asset value", formatMoney(totals.evaluatorTotal, currency)],
                  ["Estimated range", `${formatMoney(totals.lowTotal, currency)} - ${formatMoney(totals.highTotal, currency)}`],
                  ["Projected costs", formatMoney(totals.projectedCosts, currency)],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2.5 py-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--app-text-muted)]">{label}</p>
                    <p className="mt-0.5 truncate text-sm font-bold tabular-nums text-[var(--app-text-strong)] sm:text-base">{value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-0.5">
                  <button type="button" onClick={() => setTab("lots")} className={`h-8 rounded px-3 text-xs font-bold ${tab === "lots" ? "bg-[var(--app-panel)] text-[var(--app-accent)] shadow-sm" : "text-[var(--app-text-muted)]"}`}>Lots</button>
                  <button type="button" onClick={() => setTab("summary")} className={`h-8 rounded px-3 text-xs font-bold ${tab === "summary" ? "bg-[var(--app-panel)] text-[var(--app-accent)] shadow-sm" : "text-[var(--app-text-muted)]"}`}>File summary</button>
                </div>
                {terminalMessage ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-danger)]">
                    <AlertCircle className="size-3.5" /> Access ended · draft retained
                  </span>
                ) : saveBlocked ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-danger)]">
                    <AlertCircle className="size-3.5" /> Draft merge paused
                    <button
                      type="button"
                      onClick={retryBlockedSave}
                      className="rounded border border-[var(--app-danger-border)] px-2 py-1 font-bold hover:bg-[var(--app-danger-soft)]"
                    >
                      Retry save
                    </button>
                  </span>
                ) : dirty || syncing ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-warning)]">
                    <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Saving draft" : "Draft queued"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-success)]">
                    <CheckCircle2 className="size-3.5" /> Saved · revision {payload?.revision ?? revisionRef.current}
                  </span>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {tab === "lots" ? (
                <div className="flex h-full min-h-0 flex-col p-2">
                  <div className="mb-2 flex shrink-0 flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1.5 flex items-center gap-2 text-xs font-bold text-[var(--app-text-muted)]"><Users className="size-3.5" /> Evaluators</div>
                      <EvaluatorPicker
                        reportId={reportId}
                        evaluators={sheet.evaluator_columns}
                        ownerUserId={ownerUserId}
                        disabled={
                          !permissions.canManageEvaluators ||
                          dirty ||
                          syncing ||
                          assigning ||
                          saving ||
                          saveBlocked ||
                          Boolean(terminalMessage)
                        }
                        saving={assigning}
                        onAdd={addLinkedEvaluator}
                        onRemove={removeLinkedEvaluator}
                      />
                    </div>
                    <label className="relative block w-full lg:w-72">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--app-text-muted)]" />
                      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assets" className="h-8 w-full rounded border border-[var(--app-control-border)] bg-[var(--app-input)] pl-9 pr-3 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)]" />
                    </label>
                  </div>

                  <div tabIndex={0} role="region" aria-label="Proposal valuation lots table" className="hidden min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] overscroll-contain focus-visible:outline-2 focus-visible:outline-[var(--app-accent)] focus-visible:outline-offset-2 md:block">
                    <table className="w-max min-w-full border-separate border-spacing-0">
                      <thead className="bg-[var(--app-panel-alt)] text-left text-[10px] font-bold uppercase tracking-[0.04em] text-[var(--app-text-muted)]">
                        <tr>
                          <th colSpan={2} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Identity</th>
                          <th colSpan={9} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Asset details</th>
                          <th colSpan={sheet.evaluator_columns.length + 1} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Evaluator values</th>
                          <th colSpan={2} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Estimated sale values</th>
                          <th colSpan={2} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Buyer premium</th>
                          <th colSpan={2} className="sticky top-0 z-[6] h-8 border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Totals</th>
                          <th colSpan={6} className="sticky top-0 z-[6] h-8 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-2 text-center">Costs &amp; notes</th>
                        </tr>
                        <tr className="[&>th]:sticky [&>th]:top-8 [&>th]:z-[7] [&>th]:h-10 [&>th]:border-b [&>th]:border-[var(--app-border)] [&>th]:bg-[var(--app-panel-alt)] [&>th]:px-2 [&>th]:py-1.5">
                          <th className="left-0 !z-[9] min-w-[92px]">Asset ID</th>
                          <th className="min-w-[184px] px-2 py-2.5">Asset Category</th>
                          <th className="min-w-[104px] px-2 py-2.5">Year</th>
                          <th className="min-w-[136px] px-2 py-2.5">Make</th>
                          <th className="min-w-[152px] px-2 py-2.5">Model</th>
                          <th className="min-w-[184px] px-2 py-2.5">Serial Number</th>
                          <th className="min-w-[280px] px-2 py-2.5">CR Details</th>
                          <th className="min-w-[144px] px-2 py-2.5">Condition (1-5)</th>
                          <th className="min-w-[220px] px-2 py-2.5">Location (City, State/Prov)</th>
                          <th className="min-w-[120px] px-2 py-2.5">Pictures</th>
                          <th className="min-w-[176px] px-2 py-2.5">Asset Insight</th>
                          {sheet.evaluator_columns.map((column) => <th key={column.id} className="min-w-[152px] px-2 py-2.5 text-right">{column.name}</th>)}
                          <th className="min-w-[144px] px-2 py-2.5 text-right">Average</th>
                          <th className="min-w-[160px] px-2 py-2.5 text-right">Low Est. Sale Value ($)</th>
                          <th className="min-w-[160px] px-2 py-2.5 text-right">High Est. Sale Value ($)</th>
                          <th className="min-w-[128px] px-2 py-2.5 text-right">Buyer Premium %</th>
                          <th className="min-w-[152px] px-2 py-2.5 text-right">Buyer Premium ($)</th>
                          <th className="min-w-[176px] px-2 py-2.5 text-right">Total Expected Gross ($)</th>
                          <th className="min-w-[152px] px-2 py-2.5 text-right">Allocated Value ($)</th>
                          <th className="min-w-[220px] px-2 py-2.5">Notes</th>
                          <th className="min-w-[120px] px-2 py-2.5 text-right">Cleaning</th>
                          <th className="min-w-[136px] px-2 py-2.5 text-right">Lien Search</th>
                          <th className="min-w-[136px] px-2 py-2.5 text-right">Video Cost</th>
                          <th className="min-w-[132px] px-2 py-2.5 text-right">Lotting Fee</th>
                          <th className="min-w-[132px] px-2 py-2.5 text-right">Advertising</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((row) => <ValuationRow key={row.lot_id} row={row} evaluators={sheet.evaluator_columns} currency={currency} canEditAll={workspaceCanEditAll} editableEvaluatorId={workspaceEvaluatorColumnId} onChange={updateRow} onEvaluatorChange={updateEvaluatorValue} onOpenGallery={openPictureGallery} />)}
                      </tbody>
                      {columnTotals ? <ColumnTotalsFooter totals={columnTotals} currency={currency} /> : null}
                    </table>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto md:hidden">
                    <div className="grid gap-2">
                    {pagedRows.map((row) => <MobileValuationCard key={row.lot_id} row={row} evaluators={sheet.evaluator_columns} currency={currency} canEditAll={workspaceCanEditAll} editableEvaluatorId={workspaceEvaluatorColumnId} onChange={updateRow} onEvaluatorChange={updateEvaluatorValue} onOpenGallery={openPictureGallery} />)}
                    </div>
                    {columnTotals ? <MobileColumnTotals totals={columnTotals} currency={currency} /> : null}
                  </div>
                  {!filteredRows.length ? <div className="rounded-lg border border-dashed border-[var(--app-border)] p-10 text-center text-sm text-[var(--app-text-muted)]">No assets match this search.</div> : null}
                  {filteredRows.length ? (
                    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs">
                      <span className="text-[var(--app-text-muted)]">
                        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filteredRows.length)} of {filteredRows.length}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <label className="flex items-center gap-1 text-[var(--app-text-muted)]">
                          Rows
                          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} className="h-7 rounded border border-[var(--app-control-border)] bg-[var(--app-input)] px-1.5 text-[var(--app-text)]" aria-label="Rows per page">
                            <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
                          </select>
                        </label>
                        <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} className="grid size-7 place-items-center rounded border border-[var(--app-border)]" aria-label="Previous assets page"><ChevronLeft className="size-3.5" /></button>
                        <span className="min-w-16 text-center tabular-nums">{page} / {totalPages}</span>
                        <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages} className="grid size-7 place-items-center rounded border border-[var(--app-border)]" aria-label="Next assets page"><ChevronRight className="size-3.5" /></button>
                      </div>
                    </footer>
                  ) : null}
                </div>
              ) : (
                <div className="h-full overflow-y-auto p-2">
                  <div className="grid items-start gap-2 md:grid-cols-2 2xl:grid-cols-3">
                    <SummaryTable title="Metric" rows={metricRows} onShowCalculation={setFormulaDetails} />
                    <SummaryTable title="Uncapped Buyers Premium Scenario" rows={uncappedRows} onShowCalculation={setFormulaDetails} />
                    <SummaryTable title="Capped Buyers Premium Scenario" rows={cappedRows} onShowCalculation={setFormulaDetails} />
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </section>
    </div>
      {formulaDetails ? (
        <FormulaDetailsDialog
          calculation={formulaDetails}
          currency={currency}
          onClose={() => setFormulaDetails(null)}
        />
      ) : null}
      {pictureGallery ? (
        <div
          className="fixed inset-0 z-[140] grid place-items-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Pictures for ${pictureGallery.label}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePictureGallery();
          }}
        >
          <section
            ref={galleryPanelRef}
            tabIndex={-1}
            className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-white/15 bg-[#080b12] text-white shadow-2xl"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/15 px-4 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold sm:text-base">
                  Pictures for {pictureGallery.label}
                </h3>
                <p className="mt-0.5 text-xs text-white/65" aria-live="polite">
                  {pictureGallery.index + 1} of {pictureGallery.urls.length}
                </p>
              </div>
              <button
                type="button"
                onClick={closePictureGallery}
                autoFocus
                className="grid size-10 shrink-0 place-items-center rounded-md border border-white/20 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Close picture gallery"
              >
                <X className="size-5" />
              </button>
            </header>
            <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-black p-2 sm:p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pictureGallery.urls[pictureGallery.index]}
                alt={`${pictureGallery.label} picture ${pictureGallery.index + 1}`}
                className="max-h-[calc(100vh-10rem)] max-w-full object-contain"
              />
              {pictureGallery.urls.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => movePictureGallery(-1)}
                    className="absolute left-3 grid size-11 place-items-center rounded-full border border-white/25 bg-black/65 text-white shadow-lg transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:left-5"
                    aria-label="Previous picture"
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePictureGallery(1)}
                    className="absolute right-3 grid size-11 place-items-center rounded-full border border-white/25 bg-black/65 text-white shadow-lg transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:right-5"
                    aria-label="Next picture"
                  >
                    <ChevronRight className="size-6" />
                  </button>
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
