import { cloneProposalValuationSheet, recalculateProposalValuationSheet } from "./calculations";
import type { ProposalValuationChange, ProposalValuationSheet } from "./types";

export type CellValue = string | number | null;
export type DraftEdit = ProposalValuationChange & { from: CellValue };
export type DraftOverlap = {
  key: string;
  lotId: string | null;
  field: string;
  base: CellValue;
  theirs: CellValue;
  yours: CellValue;
};
export type ActiveDraftInput = { lotId: string; field: string; raw: string; from: CellValue };
export type RetryEnvelope = {
  changes: ProposalValuationChange[];
  request: { baseRevision: number; clientMutationId: string };
};
export type DraftBackup = {
  version: 1;
  actorId: string;
  reportId: string;
  draftId: string;
  lineageId: string;
  savedAt: number;
  revision: number;
  edits: DraftEdit[];
  overlaps: DraftOverlap[];
  dropped: DraftEdit[];
  retryEnvelope?: RetryEnvelope | null;
  activeInput?: ActiveDraftInput | null;
};
export type DraftRebase = {
  sheet: ProposalValuationSheet;
  edits: DraftEdit[];
  overlaps: DraftOverlap[];
  dropped: DraftEdit[];
};

const TEXT_FIELDS = new Set(["asset_category", "year", "make", "model", "serial_number", "cr_details", "condition_score", "location", "notes"]);
const NUMBER_FIELDS = new Set(["lien_search", "video_cost"]);
const MARKET_FIELDS = new Set(["comparable_count", "avg_retail_asking_price", "market_saturation", "market_velocity", "regional_demand", "notes"]);
const SUMMARY_NUMBERS = new Set(["total_risk_weighted_value", "file_risk_multiplier", "commission_percent_no_guarantee", "offer2_nmg_percent", "capped_threshold_percent"]);
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKUP_CHARACTERS = 4_000_000;
const MAX_EDITS = 20_000;

/** Matches the editor's existing pending-change and immutable-envelope key. */
export function cellKey(change: Pick<ProposalValuationChange, "lotId" | "field">): string {
  return `${change.lotId ?? "file"}:${change.field}`;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function scalar(value: unknown): value is CellValue {
  return value === null || (typeof value === "string" && value.length <= 16_000) || (typeof value === "number" && Number.isFinite(value));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fieldKind(change: Pick<ProposalValuationChange, "lotId" | "field">): "text" | "number" | null {
  if (typeof change.field !== "string") return null;
  if (change.lotId === null) {
    if (change.field === "file_summary.buyers_premium_basis") return "text";
    return SUMMARY_NUMBERS.has(change.field.slice("file_summary.".length)) && change.field.startsWith("file_summary.") ? "number" : null;
  }
  if (!safeId(change.lotId)) return null;
  if (TEXT_FIELDS.has(change.field)) return "text";
  if (NUMBER_FIELDS.has(change.field)) return "number";
  if (change.field.startsWith("market_check.") && MARKET_FIELDS.has(change.field.slice("market_check.".length))) return "text";
  if (change.field.startsWith("evaluator_values.")) {
    const id = change.field.slice("evaluator_values.".length);
    return safeId(id) && !["__proto__", "prototype", "constructor"].includes(id) ? "number" : null;
  }
  return null;
}
function normalizeValue(change: Pick<ProposalValuationChange, "lotId" | "field">, value: unknown): CellValue {
  if (fieldKind(change) === "text") return value == null ? "" : String(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Undefined means the target lot/column is gone, never a numeric zero or blank. */
export function readCell(sheet: ProposalValuationSheet, change: Pick<ProposalValuationChange, "lotId" | "field">): CellValue | undefined {
  if (!fieldKind(change)) return undefined;
  if (change.lotId === null) return normalizeValue(change, (sheet.file_summary as unknown as Record<string, unknown>)[change.field.slice("file_summary.".length)]);
  const row = sheet.rows.find(item => item.lot_id === change.lotId);
  if (!row) return undefined;
  if (change.field.startsWith("evaluator_values.")) {
    const id = change.field.slice("evaluator_values.".length);
    if (!sheet.evaluator_columns.some(column => column.id === id)) return undefined;
    return normalizeValue(change, row.evaluator_values[id]);
  }
  if (change.field.startsWith("market_check.")) return normalizeValue(change, (row.market_check as unknown as Record<string, unknown>)[change.field.slice("market_check.".length)]);
  return normalizeValue(change, (row as unknown as Record<string, unknown>)[change.field]);
}

function writeCell(sheet: ProposalValuationSheet, edit: DraftEdit): void {
  const value = normalizeValue(edit, edit.value);
  if (edit.lotId === null) {
    (sheet.file_summary as unknown as Record<string, unknown>)[edit.field.slice("file_summary.".length)] = value;
    return;
  }
  const row = sheet.rows.find(item => item.lot_id === edit.lotId);
  if (!row) return;
  if (edit.field.startsWith("evaluator_values.")) row.evaluator_values[edit.field.slice("evaluator_values.".length)] = value as number | null;
  else if (edit.field.startsWith("market_check.")) (row.market_check as unknown as Record<string, unknown>)[edit.field.slice("market_check.".length)] = value;
  else (row as unknown as Record<string, unknown>)[edit.field] = value;
}

/** Rebase only by stable lot/column identity; unresolved conflicts survive every refresh. */
export function rebaseDraft(latest: ProposalValuationSheet, edits: readonly DraftEdit[], previousOverlaps: readonly DraftOverlap[] = [], previousDropped: readonly DraftEdit[] = []): DraftRebase {
  const sheet = cloneProposalValuationSheet(latest);
  const all = new Map<string, DraftEdit>();
  for (const edit of [...previousDropped, ...edits]) all.set(cellKey(edit), edit);
  const oldOverlaps = new Map(previousOverlaps.map(overlap => [overlap.key, overlap]));
  const pending: DraftEdit[] = [];
  const dropped: DraftEdit[] = [];
  const overlaps: DraftOverlap[] = [];
  for (const [key, edit] of all) {
    const current = readCell(latest, edit);
    if (current === undefined) {
      dropped.push({ lotId: edit.lotId, field: edit.field, value: edit.value, from: edit.from });
      const prior = oldOverlaps.get(key);
      if (prior) overlaps.push({ ...prior });
      continue;
    }
    const yours = normalizeValue(edit, edit.value);
    if (current === yours) continue; // The value is already confirmed remotely.
    const from = normalizeValue(edit, edit.from);
    const previous = oldOverlaps.get(key);
    if (previous || current !== from) overlaps.push({ key, lotId: edit.lotId, field: edit.field, base: previous ? previous.base : from, theirs: current, yours });
    const rebased = { lotId: edit.lotId, field: edit.field, value: edit.value, from: current };
    pending.push(rebased);
    writeCell(sheet, rebased);
  }
  return { sheet: recalculateProposalValuationSheet(sheet), edits: pending, overlaps, dropped };
}

export function draftStoragePrefix(actorId: string, reportId: string): string {
  return `assetinsight:pv-draft:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(reportId)}:`;
}
export function draftStorageKey(actorId: string, reportId: string, draftId: string): string {
  return `${draftStoragePrefix(actorId, reportId)}${encodeURIComponent(draftId)}`;
}
/** Store this pointer in sessionStorage. It is a recovery hint, never a shared writer identity. */
export function draftPointerKey(actorId: string, reportId: string): string {
  return `assetinsight:pv-draft-pointer:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(reportId)}`;
}

function parseChange(value: unknown): ProposalValuationChange | null {
  if (!record(value) || (value.lotId !== null && !safeId(value.lotId)) || typeof value.field !== "string" || !scalar(value.value)) return null;
  const change = { lotId: value.lotId, field: value.field, value: value.value } as ProposalValuationChange;
  const kind = fieldKind(change);
  if (!kind || (kind === "number" && value.value !== null && value.value !== "" && typeof value.value !== "number") || (kind === "text" && typeof value.value !== "string")) return null;
  return change;
}
function parseEdit(value: unknown): DraftEdit | null {
  const change = parseChange(value);
  if (!change || !record(value) || !scalar(value.from)) return null;
  if (fieldKind(change) === "number" && value.from !== null && value.from !== "" && typeof value.from !== "number") return null;
  if (fieldKind(change) === "text" && value.from !== null && typeof value.from !== "string") return null;
  return { ...change, from: value.from };
}
function parseOverlap(value: unknown): DraftOverlap | null {
  if (!record(value) || !scalar(value.base) || !scalar(value.theirs) || !scalar(value.yours)) return null;
  const change = parseChange({ lotId: value.lotId, field: value.field, value: value.yours });
  if (!change || value.key !== cellKey(change)) return null;
  if ([value.base, value.theirs].some(entry => fieldKind(change) === "number"
    ? entry !== null && entry !== "" && typeof entry !== "number"
    : entry !== null && typeof entry !== "string")) return null;
  return { key: value.key as string, lotId: change.lotId, field: change.field, base: value.base, theirs: value.theirs, yours: value.yours };
}
function parseArray<T>(value: unknown, parse: (entry: unknown) => T | null, max = MAX_EDITS): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const values = value.map(parse);
  return values.some(entry => entry === null) ? null : values as T[];
}

/** Untrusted local storage is scoped, bounded and projected onto a credential-free schema. */
export function parseDraftBackup(raw: string | null | undefined, actorId: string, reportId: string, now = Date.now()): DraftBackup | null {
  if (!raw || raw.length > MAX_BACKUP_CHARACTERS) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || value.version !== 1 || value.actorId !== actorId || value.reportId !== reportId || !safeId(value.actorId) || !safeId(value.reportId) || !safeId(value.draftId) || !safeId(value.lineageId)) return null;
  if (typeof value.savedAt !== "number" || !Number.isSafeInteger(value.savedAt) || value.savedAt > now + 5 * 60 * 1000 || now - value.savedAt > DRAFT_TTL_MS || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null;
  const edits = parseArray(value.edits, parseEdit);
  const overlaps = parseArray(value.overlaps, parseOverlap);
  const dropped = parseArray(value.dropped, parseEdit);
  if (!edits || !overlaps || !dropped) return null;
  let activeInput: ActiveDraftInput | null = null;
  if (value.activeInput != null) {
    const active = value.activeInput;
    if (!record(active) || !safeId(active.lotId) || typeof active.field !== "string" || typeof active.raw !== "string" || active.raw.length > 16_000 || !scalar(active.from)) return null;
    const kind = fieldKind({ lotId: active.lotId, field: active.field });
    if (!kind || (kind === "number" && active.from !== null && active.from !== "" && typeof active.from !== "number") || (kind === "text" && active.from !== null && typeof active.from !== "string")) return null;
    activeInput = { lotId: active.lotId, field: active.field, raw: active.raw, from: active.from };
  }
  let retryEnvelope: RetryEnvelope | null = null;
  if (value.retryEnvelope != null) {
    if (!record(value.retryEnvelope) || !record(value.retryEnvelope.request)) return null;
    const request = value.retryEnvelope.request;
    const changes = parseArray(value.retryEnvelope.changes, parseChange, 500);
    if (!changes?.length || !Number.isSafeInteger(request.baseRevision) || Number(request.baseRevision) < 0 || !safeId(request.clientMutationId)) return null;
    retryEnvelope = { changes, request: { baseRevision: Number(request.baseRevision), clientMutationId: request.clientMutationId } };
  }
  return { version: 1, actorId, reportId, draftId: value.draftId, lineageId: value.lineageId, savedAt: value.savedAt, revision: Number(value.revision), edits, overlaps, dropped, retryEnvelope, activeInput };
}

export function serializeDraftBackup(value: DraftBackup): string {
  // Parsing projects only known fields, including the exact mutation request.
  const raw = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new Error("A valuation draft contains an invalid number.");
    return entry;
  });
  const clean = parseDraftBackup(raw, value.actorId, value.reportId, value.savedAt);
  if (!clean) throw new Error("The valuation draft could not be stored safely.");
  return JSON.stringify(clean);
}

export function isEmptyDraft(backup: DraftBackup): boolean {
  return !backup.edits.length && !backup.overlaps.length && !backup.dropped.length && !backup.retryEnvelope && !backup.activeInput;
}
/** Empty latest checkpoints suppress old same-lineage ghosts without deleting any other tab's key. */
export function latestDraftsByLineage(backups: readonly DraftBackup[]): DraftBackup[] {
  const latest = new Map<string, DraftBackup>();
  for (const backup of backups) {
    const key = JSON.stringify([backup.actorId, backup.reportId, backup.lineageId]);
    const previous = latest.get(key);
    if (!previous || backup.savedAt > previous.savedAt || (backup.savedAt === previous.savedAt && isEmptyDraft(backup) && !isEmptyDraft(previous))) latest.set(key, backup);
  }
  return [...latest.values()].sort((a, b) => b.savedAt - a.savedAt);
}
