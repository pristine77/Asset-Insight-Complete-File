/**
 * Unsaved Proposal Valuation edits on the admin page, kept as a list of cell
 * changes so they survive someone else saving the same file.
 *
 * Owner, 2026-11-03, after Jay Francis lost a whole appraisal of file 95099:
 * the page sent the whole sheet on Save, the server refused it because another
 * person had saved in the meantime, and "Reload this page" threw every unsaved
 * number away. Now the page:
 *   1. keeps the edits when a save is refused and re-applies them, cell by
 *      cell, to the latest saved copy;
 *   2. warns before the page is refreshed or closed with unsaved edits;
 *   3. keeps a copy of the edits in this browser, restored on the next visit;
 *   4. shows other people's saved edits live, highlighted.
 *
 * Every edit records the value it replaced ("from") and the value typed
 * ("to"). Re-applying an edit to a newer copy of the sheet has three cases:
 *   - the cell still holds "from": nobody else touched it, so the edit applies;
 *   - the cell already holds "to": the same value was saved, nothing to do;
 *   - anything else: someone else changed that same cell. The typed value is
 *     kept, because it is what this person entered, and the cell is reported as
 *     an overlap so they can see the other value and choose before saving.
 *
 * This file has no runtime imports so the Node test runner can load it as is.
 */
import type {
  AssetAdminScheduleEvaluatorColumn,
  AssetAdminScheduleRow,
  AssetAdminScheduleSheet,
} from "@/app/components/reports/reportPreviewTypes";

/** Row fields the page lets a person type into, with the label shown on the page. */
export const ROW_TEXT_FIELDS = {
  asset_category: "Asset Category",
  year: "Year",
  make: "Make",
  model: "Model",
  serial_number: "Serial Number",
  cr_details: "CR Details",
  condition_score: "Condition (1-5)",
  location: "Location",
  notes: "Notes",
} as const;

export const ROW_NUMBER_FIELDS = {
  lien_search: "Lien Search",
  video_cost: "Video Cost",
} as const;

export const FILE_SUMMARY_FIELDS = {
  buyers_premium_basis: "Buyers Premium Basis",
  total_risk_weighted_value: "Total Risk-Weighted Value ($)",
  file_risk_multiplier: "File Risk Multiplier",
  commission_percent_no_guarantee: "Commission % No Guarantee",
  offer2_nmg_percent: "Offer #2 NMG / Overage %",
  capped_threshold_percent: "Capped Threshold %",
} as const;

type RowTextField = keyof typeof ROW_TEXT_FIELDS;
type RowNumberField = keyof typeof ROW_NUMBER_FIELDS;
type FileSummaryField = keyof typeof FILE_SUMMARY_FIELDS;

export type CellValue = string | number | null;

export type CellEdit = { kind: "cell"; key: string; from: CellValue; to: CellValue };
export type AddColumnEdit = { kind: "add-column"; column: AssetAdminScheduleEvaluatorColumn };
export type RemoveColumnEdit = { kind: "remove-column"; column: AssetAdminScheduleEvaluatorColumn };
export type SheetEdit = CellEdit | AddColumnEdit | RemoveColumnEdit;

/** A cell both this person and someone else changed, to different values. */
export type CellOverlap = { key: string; base: CellValue; theirs: CellValue; yours: CellValue };

export type RebaseResult = {
  /** The newer sheet with this person's edits on top (not yet recalculated). */
  sheet: AssetAdminScheduleSheet;
  /** The edits still unsaved, now relative to the newer sheet. */
  pending: SheetEdit[];
  overlaps: CellOverlap[];
  /** Edits whose lot or evaluator no longer exists in the newer sheet. */
  dropped: SheetEdit[];
};

// ─── Cell keys ───────────────────────────────────────────────────────────────
// One key per editable cell, shared by the merge, the browser copy and the
// table highlight: "row:<lot>:<field>", "eval:<lot>:<column>", "file:<field>".

export function rowCellKey(lotId: string, field: string) {
  return `row:${encodeURIComponent(lotId)}:${encodeURIComponent(field)}`;
}

export function evaluatorCellKey(lotId: string, columnId: string) {
  return `eval:${encodeURIComponent(lotId)}:${encodeURIComponent(columnId)}`;
}

export function fileCellKey(field: string) {
  return `file:${encodeURIComponent(field)}`;
}

type ParsedKey =
  | { kind: "row"; lotId: string; field: RowTextField | RowNumberField }
  | { kind: "eval"; lotId: string; columnId: string }
  | { kind: "file"; field: FileSummaryField };

export function parseCellKey(key: string): ParsedKey | null {
  const parts = String(key).split(":");
  try {
    if (parts[0] === "row" && parts.length === 3) {
      const field = decodeURIComponent(parts[2]);
      if (!Object.hasOwn(ROW_TEXT_FIELDS, field) && !Object.hasOwn(ROW_NUMBER_FIELDS, field)) return null;
      return { kind: "row", lotId: decodeURIComponent(parts[1]), field: field as RowTextField | RowNumberField };
    }
    if (parts[0] === "eval" && parts.length === 3) {
      return { kind: "eval", lotId: decodeURIComponent(parts[1]), columnId: decodeURIComponent(parts[2]) };
    }
    if (parts[0] === "file" && parts.length === 2) {
      const field = decodeURIComponent(parts[1]);
      if (!Object.hasOwn(FILE_SUMMARY_FIELDS, field)) return null;
      return { kind: "file", field: field as FileSummaryField };
    }
  } catch {
    return null;
  }
  return null;
}

// ─── Values ──────────────────────────────────────────────────────────────────
// Compared the way the page recalculates them (assetScheduleSheetUtils), so a
// blank saved as null and a blank typed as "" are the same value.

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(value: unknown, fallback: number) {
  const parsed = numberOrNull(value);
  return parsed === null ? fallback : Math.max(0, Math.min(1, parsed));
}

function normalizeFileValue(field: FileSummaryField, value: unknown): CellValue {
  if (field === "buyers_premium_basis") return value === "capped" ? "capped" : "uncapped";
  if (field === "offer2_nmg_percent") return ratio(value, 0.785);
  if (field === "capped_threshold_percent") return ratio(value, 0.1);
  return numberOrNull(value);
}

function normalize(parsed: ParsedKey, value: unknown): CellValue {
  if (parsed.kind === "eval") return numberOrNull(value);
  if (parsed.kind === "file") return normalizeFileValue(parsed.field, value);
  if (parsed.field in ROW_NUMBER_FIELDS) return numberOrNull(value);
  return value === null || value === undefined ? "" : String(value);
}

function sameValue(a: CellValue, b: CellValue) {
  return a === b;
}

function rowIndex(sheet: AssetAdminScheduleSheet) {
  return new Map(sheet.rows.map((row) => [row.lot_id, row]));
}

/** The value of one cell, or undefined when its lot or evaluator is gone. */
function readCell(
  sheet: AssetAdminScheduleSheet,
  rows: Map<string, AssetAdminScheduleRow>,
  parsed: ParsedKey
): CellValue | undefined {
  if (parsed.kind === "file") {
    return normalizeFileValue(parsed.field, sheet.file_summary?.[parsed.field]);
  }
  const row = rows.get(parsed.lotId);
  if (!row) return undefined;
  if (parsed.kind === "eval") {
    if (!sheet.evaluator_columns.some((column) => column.id === parsed.columnId)) return undefined;
    return normalize(parsed, row.evaluator_values?.[parsed.columnId]);
  }
  return normalize(parsed, row[parsed.field]);
}

export function cellValue(sheet: AssetAdminScheduleSheet, key: string): CellValue | undefined {
  const parsed = parseCellKey(key);
  return parsed ? readCell(sheet, rowIndex(sheet), parsed) : undefined;
}

function writeCell(
  sheet: AssetAdminScheduleSheet,
  rows: Map<string, AssetAdminScheduleRow>,
  parsed: ParsedKey,
  value: CellValue
) {
  if (parsed.kind === "file") {
    (sheet.file_summary as Record<string, unknown>)[parsed.field] = value;
    return;
  }
  const row = rows.get(parsed.lotId);
  if (!row) return;
  if (parsed.kind === "eval") {
    row.evaluator_values = { ...row.evaluator_values, [parsed.columnId]: numberOrNull(value) };
    return;
  }
  (row as Record<string, unknown>)[parsed.field] =
    parsed.field in ROW_NUMBER_FIELDS ? numberOrNull(value) : value === null ? "" : String(value);
}

/** Set one cell in place (used for "Keep theirs"); unknown cells are left alone. */
export function assignCellValue(sheet: AssetAdminScheduleSheet, key: string, value: CellValue) {
  const parsed = parseCellKey(key);
  if (parsed) writeCell(sheet, rowIndex(sheet), parsed, normalize(parsed, value));
  return sheet;
}

/**
 * The cell key of one table cell on the desktop grid. Evaluator columns are
 * "eval_<column id>" there; read-only and calculated columns have no key.
 */
export function tableCellKey(lotId: string, tableColumnId: string): string | null {
  if (tableColumnId in ROW_TEXT_FIELDS || tableColumnId in ROW_NUMBER_FIELDS) return rowCellKey(lotId, tableColumnId);
  if (tableColumnId.startsWith("eval_")) return evaluatorCellKey(lotId, tableColumnId.slice("eval_".length));
  return null;
}

function cloneSheet(sheet: AssetAdminScheduleSheet): AssetAdminScheduleSheet {
  return JSON.parse(JSON.stringify(sheet)) as AssetAdminScheduleSheet;
}

/** Every editable cell of one sheet, keyed, for comparing two copies. */
function editableCells(sheet: AssetAdminScheduleSheet) {
  const cells = new Map<string, CellValue>();
  for (const row of sheet.rows) {
    for (const field of Object.keys(ROW_TEXT_FIELDS) as RowTextField[]) {
      cells.set(rowCellKey(row.lot_id, field), normalize({ kind: "row", lotId: row.lot_id, field }, row[field]));
    }
    for (const field of Object.keys(ROW_NUMBER_FIELDS) as RowNumberField[]) {
      cells.set(rowCellKey(row.lot_id, field), normalize({ kind: "row", lotId: row.lot_id, field }, row[field]));
    }
    for (const column of sheet.evaluator_columns) {
      cells.set(evaluatorCellKey(row.lot_id, column.id), numberOrNull(row.evaluator_values?.[column.id]));
    }
  }
  for (const field of Object.keys(FILE_SUMMARY_FIELDS) as FileSummaryField[]) {
    cells.set(fileCellKey(field), normalizeFileValue(field, sheet.file_summary?.[field]));
  }
  return cells;
}

// ─── Comparing and merging ───────────────────────────────────────────────────

/** What changed between the saved copy a person started from and their page. */
export function sheetEdits(base: AssetAdminScheduleSheet, local: AssetAdminScheduleSheet): SheetEdit[] {
  const edits: SheetEdit[] = [];
  const baseColumns = new Map(base.evaluator_columns.map((column) => [column.id, column]));
  const localColumns = new Map(local.evaluator_columns.map((column) => [column.id, column]));
  for (const column of local.evaluator_columns) {
    if (!baseColumns.has(column.id)) edits.push({ kind: "add-column", column: { ...column } });
  }
  for (const column of base.evaluator_columns) {
    if (!localColumns.has(column.id)) edits.push({ kind: "remove-column", column: { ...column } });
  }

  const before = editableCells(base);
  for (const [key, to] of editableCells(local)) {
    const from = before.has(key) ? before.get(key)! : null;
    // A cell of an evaluator added on this page starts blank.
    if (!sameValue(from, to)) edits.push({ kind: "cell", key, from, to });
  }
  return edits;
}

/** Cells whose saved value differs between two copies: someone else's edits. */
export function changedCellKeys(before: AssetAdminScheduleSheet, after: AssetAdminScheduleSheet): Set<string> {
  const previous = editableCells(before);
  const changed = new Set<string>();
  for (const [key, value] of editableCells(after)) {
    const earlier = previous.has(key) ? previous.get(key)! : null;
    if (!sameValue(earlier, value)) changed.add(key);
  }
  return changed;
}

/**
 * Put unsaved edits on top of a newer saved copy. Column additions and
 * removals go first, so typed values for a newly added evaluator have a
 * column to land in.
 */
export function rebaseEdits(latest: AssetAdminScheduleSheet, edits: readonly SheetEdit[]): RebaseResult {
  const sheet = cloneSheet(latest);
  const pending: SheetEdit[] = [];
  const overlaps: CellOverlap[] = [];
  const dropped: SheetEdit[] = [];
  // Another person may have added the same evaluator meanwhile, under another
  // column id: values typed for this page's column go to theirs.
  const columnAlias = new Map<string, string>();

  for (const edit of edits) {
    if (edit.kind === "add-column") {
      if (sheet.evaluator_columns.some((column) => column.id === edit.column.id)) continue;
      const sameUser = edit.column.user_id
        ? sheet.evaluator_columns.find((column) => column.user_id === edit.column.user_id)
        : undefined;
      if (sameUser) {
        columnAlias.set(edit.column.id, sameUser.id);
        continue;
      }
      sheet.evaluator_columns.push({ ...edit.column });
      for (const row of sheet.rows) {
        row.evaluator_values = { ...row.evaluator_values, [edit.column.id]: null };
      }
      pending.push(edit);
    } else if (edit.kind === "remove-column") {
      const existing = sheet.evaluator_columns.find((column) => column.id === edit.column.id);
      if (!existing) continue;
      sheet.evaluator_columns = sheet.evaluator_columns.filter((column) => column.id !== edit.column.id);
      for (const row of sheet.rows) {
        const values = { ...row.evaluator_values };
        delete values[edit.column.id];
        row.evaluator_values = values;
      }
      pending.push(edit);
    }
  }

  const rows = rowIndex(sheet);
  for (const edit of edits) {
    if (edit.kind !== "cell") continue;
    let parsed = parseCellKey(edit.key);
    if (!parsed) {
      dropped.push(edit);
      continue;
    }
    let key = edit.key;
    if (parsed.kind === "eval" && columnAlias.has(parsed.columnId)) {
      parsed = { ...parsed, columnId: columnAlias.get(parsed.columnId)! };
      key = evaluatorCellKey(parsed.lotId, parsed.columnId);
    }
    const current = readCell(sheet, rows, parsed);
    if (current === undefined) {
      dropped.push(edit);
      continue;
    }
    const to = normalize(parsed, edit.to);
    if (sameValue(current, to)) continue;
    if (!sameValue(current, normalize(parsed, edit.from))) {
      overlaps.push({ key, base: edit.from, theirs: current, yours: to });
    }
    writeCell(sheet, rows, parsed, to);
    pending.push({ kind: "cell", key, from: current, to });
  }

  return { sheet, pending, overlaps, dropped };
}

/** Lot and field names for a cell, as the page shows them. */
export function describeCell(sheet: AssetAdminScheduleSheet, key: string): { lot: string | null; field: string } {
  const parsed = parseCellKey(key);
  if (!parsed) return { lot: null, field: "Unknown field" };
  if (parsed.kind === "file") return { lot: null, field: FILE_SUMMARY_FIELDS[parsed.field] };
  const row = sheet.rows.find((candidate) => candidate.lot_id === parsed.lotId);
  const lot = row?.asset_id || parsed.lotId;
  if (parsed.kind === "eval") {
    const column = sheet.evaluator_columns.find((candidate) => candidate.id === parsed.columnId);
    return { lot, field: column?.name || "Evaluator" };
  }
  return {
    lot,
    field:
      (ROW_TEXT_FIELDS as Record<string, string>)[parsed.field] ||
      (ROW_NUMBER_FIELDS as Record<string, string>)[parsed.field],
  };
}

// ─── The copy kept in this browser ───────────────────────────────────────────

export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type StoredDraft = {
  version: 2;
  actorId: string;
  reportId: string;
  draftId: string;
  lineageId: string;
  revision: number;
  savedAt: string;
  edits: SheetEdit[];
  overlaps: CellOverlap[];
  dropped: SheetEdit[];
};

export function draftStoragePrefix(actorId: string, reportId: string) {
  return `asset-insight:pv-draft:v2:${encodeURIComponent(actorId)}:${encodeURIComponent(reportId)}:`;
}
export function draftStorageKey(actorId: string, reportId: string, draftId: string) {
  return `${draftStoragePrefix(actorId, reportId)}${encodeURIComponent(draftId)}`;
}
export function draftPointerKey(actorId: string, reportId: string) {
  return `${draftStoragePrefix(actorId, reportId)}current`;
}

function isCellValue(value: unknown): value is CellValue {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function isColumn(value: unknown): value is AssetAdminScheduleEvaluatorColumn {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}
function isEdit(edit: unknown): edit is SheetEdit {
  if (!edit || typeof edit !== "object") return false;
  const value = edit as SheetEdit;
  if (value.kind === "cell") return typeof value.key === "string" && !!parseCellKey(value.key) && isCellValue(value.from) && isCellValue(value.to);
  return (value.kind === "add-column" || value.kind === "remove-column") && isColumn(value.column);
}
function isOverlap(value: unknown): value is CellOverlap {
  if (!value || typeof value !== "object") return false;
  const item = value as CellOverlap;
  return typeof item.key === "string" && !!parseCellKey(item.key) && isCellValue(item.base) && isCellValue(item.theirs) && isCellValue(item.yours);
}

/** Rebase without forgetting an unresolved conflict or an edit to a removed row. */
export function rebaseRecovery(latest: AssetAdminScheduleSheet, edits: readonly SheetEdit[],
  previousOverlaps: readonly CellOverlap[] = [], previousDropped: readonly SheetEdit[] = []): RebaseResult {
  const result = rebaseEdits(latest, edits);
  const pending = new Set(result.pending.flatMap(edit => edit.kind === "cell" ? [edit.key] : []));
  const overlaps = new Map<string, CellOverlap>();
  for (const overlap of previousOverlaps) {
    const theirs = cellValue(latest, overlap.key);
    const yours = cellValue(result.sheet, overlap.key);
    if (pending.has(overlap.key) && theirs !== undefined && yours !== undefined && theirs !== yours) {
      overlaps.set(overlap.key, { ...overlap, theirs, yours });
    }
  }
  for (const overlap of result.overlaps) overlaps.set(overlap.key, overlap);
  const dropped = new Map([...previousDropped, ...result.dropped].map(edit => [JSON.stringify(edit), edit]));
  return { ...result, overlaps: [...overlaps.values()], dropped: [...dropped.values()] };
}

/** Unscoped legacy drafts are never attributed to the next signed-in person. */
export function parseStoredDraft(raw: string | null, actorId: string, reportId: string, now = Date.now()): StoredDraft | null {
  if (!raw || raw.length > 8 * 1024 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const draft = value as Partial<StoredDraft>;
  if (!draft || draft.version !== 2 || !actorId || draft.actorId !== actorId || draft.reportId !== reportId ||
      typeof draft.draftId !== "string" || !draft.draftId || !Array.isArray(draft.edits) ||
      !Array.isArray(draft.overlaps) || !Array.isArray(draft.dropped)) return null;
  const savedAt = Date.parse(String(draft.savedAt || ""));
  if (!Number.isFinite(savedAt) || now - savedAt > DRAFT_MAX_AGE_MS || savedAt - now > 60_000) return null;
  const edits = draft.edits.filter(isEdit);
  const overlaps = draft.overlaps.filter(isOverlap);
  const dropped = draft.dropped.filter(isEdit);
  // Empty checkpoints retire earlier copies after a successful save or discard.
  return { version: 2, actorId, reportId, draftId: draft.draftId, lineageId: typeof draft.lineageId === "string" && draft.lineageId ? draft.lineageId : draft.draftId,
    revision: Number.isSafeInteger(draft.revision) && Number(draft.revision) >= 0 ? Number(draft.revision) : 0,
    savedAt: new Date(savedAt).toISOString(), edits, overlaps, dropped };
}
