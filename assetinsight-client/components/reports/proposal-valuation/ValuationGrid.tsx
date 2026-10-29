"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Filter, Images } from "lucide-react";
import { toast } from "@/components/ui/toast";
import type { ProposalValuationColumnTotals } from "./calculations";
import { columnTotalsScopeLabel, formatColumnTotal } from "./ColumnTotals";
import {
  buildGridColumns,
  canEditColumn,
  cellEditText,
  cellFormula,
  cellText,
  cellValue,
  compareCellValues,
  EXPORT_FIRST_DATA_ROW,
  filterKey,
  isMoneyColumn,
  isNumericColumn,
  parseCellNumber,
  parseClipboardText,
  sameCellValue,
  toClipboardText,
  type GridCellValue,
  type GridColumn,
} from "./gridColumns";
import { assetLabel, validPictureUrls } from "./rowDisplay";
import type { ProposalValuationEvaluator, ProposalValuationRow } from "./types";

type RowFieldChange = (
  lotId: string,
  key: keyof ProposalValuationRow,
  value: string | number | null
) => void;

type EvaluatorValueChange = (lotId: string, evaluatorId: string, value: number | null) => void;

export type ValuationGridStatus = { selection: string; lots: string };

type Props = {
  /** Hidden mobile grids retain editing state without mounting desktop rows. */
  visible?: boolean;
  /** Lots after the search box, in sheet order. */
  rows: ProposalValuationRow[];
  /** Every lot in sheet order; its position gives the exported workbook's row number. */
  allRows: ProposalValuationRow[];
  evaluators: ProposalValuationEvaluator[];
  currency: string;
  canEditAll: boolean;
  editableEvaluatorId: string | null;
  totals: ProposalValuationColumnTotals | null;
  onRowChange: RowFieldChange;
  onEvaluatorChange: EvaluatorValueChange;
  onOpenGallery: (label: string, urls: string[], opener: HTMLButtonElement) => void;
  onStatusChange: (status: ValuationGridStatus) => void;
};

type CellRef = { lotId: string; columnId: string };
type Editing = CellRef & { draft: string; mode: "enter" | "edit"; origin: "cell" | "bar" };
type Edit = CellRef & { value: GridCellValue };
type UndoEntry = CellRef & { before: GridCellValue; after: GridCellValue };
type Sort = { columnId: string; direction: "asc" | "desc" };
type MenuState = { columnId: string; top: number; left: number };

const ROW_HEIGHT = 28;
const LETTER_ROW_HEIGHT = 20;
const HEADER_ROW_HEIGHT = 40;
const FOOTER_HEIGHT = 40;
const ROW_NUMBER_WIDTH = 44;
const FROZEN_COLUMNS = 2;
const OVERSCAN = 12;
const PAGE_ROWS = 15;
const UNDO_LIMIT = 100;

function cellKey(lotId: string, columnId: string) {
  return `${lotId}\u0000${columnId}`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const GridRow = memo(function GridRow({
  row,
  rowIndex,
  rowNumber,
  columns,
  frozenLeft,
  evaluators,
  currency,
  editable,
  selectedFrom,
  selectedTo,
  activeColumn,
  editingColumn,
  editingDraft,
  onCellInput,
  onOpenGallery,
}: {
  row: ProposalValuationRow;
  rowIndex: number;
  rowNumber: number;
  columns: GridColumn[];
  frozenLeft: number[];
  evaluators: ProposalValuationEvaluator[];
  currency: string;
  editable: boolean[];
  selectedFrom: number;
  selectedTo: number;
  activeColumn: number;
  editingColumn: number;
  editingDraft: string;
  onCellInput: (rowIndex: number, columnIndex: number, value: string) => void;
  onOpenGallery: Props["onOpenGallery"];
}) {
  const label = assetLabel(row);
  const rowSelected = selectedFrom >= 0;

  return (
    <tr style={{ height: ROW_HEIGHT }}>
      <td
        className={`sticky left-0 z-[2] h-7 border-b border-r border-[var(--app-border)] p-0 text-center text-[11px] tabular-nums ${
          rowSelected ? "bg-[var(--app-accent-soft)] font-bold text-[var(--app-accent)]" : "bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]"
        }`}
      >
        {rowNumber}
      </td>
      {columns.map((column, columnIndex) => {
        const active = columnIndex === activeColumn;
        const selected = rowSelected && columnIndex >= selectedFrom && columnIndex <= selectedTo;
        const editingThis = columnIndex === editingColumn;
        const canEdit = editable[columnIndex];
        const frozen = columnIndex < FROZEN_COLUMNS;
        const numeric = isNumericColumn(column);
        // The theme's accent-soft was too faint to show a dragged range on white cells.
        const background = selected && !active
          ? "bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-panel))]"
          : canEdit
            ? "bg-[var(--app-panel)]"
            : "bg-[var(--app-panel-alt)]";
        const text = cellText(row, column, evaluators, currency);
        let content: React.ReactNode;

        if (column.kind === "text" || column.kind === "number" || column.kind === "evaluator") {
          content = (
            <input
              value={editingThis ? editingDraft : text}
              onChange={(event) => onCellInput(rowIndex, columnIndex, event.target.value)}
              readOnly={!editingThis}
              disabled={!canEdit}
              tabIndex={editingThis ? 0 : -1}
              aria-label={column.ariaLabel(label)}
              autoComplete="off"
              spellCheck={false}
              inputMode={numeric ? "decimal" : undefined}
              data-editing={editingThis ? "true" : undefined}
              className={`block h-full w-full min-w-0 bg-transparent px-2 text-xs text-[var(--app-text)] outline-none disabled:cursor-default disabled:text-[var(--app-text)] disabled:opacity-100 ${
                editingThis ? "" : "pointer-events-none truncate"
              } ${numeric ? "text-right tabular-nums" : ""} ${column.kind === "evaluator" ? "font-semibold" : ""}`}
            />
          );
        } else if (column.kind === "pictures") {
          const urls = validPictureUrls(row);
          content = urls.length ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => onOpenGallery(label, urls, event.currentTarget)}
              className="flex h-full w-full items-center gap-1.5 px-2 text-xs font-semibold text-[var(--app-accent)] hover:underline"
              aria-label={`Open ${text} for ${label}`}
            >
              <Images className="size-3.5 shrink-0" />
              <span className="truncate">{text}</span>
            </button>
          ) : (
            <span className="block truncate px-2 text-xs text-[var(--app-text-muted)]">{text}</span>
          );
        } else {
          content = (
            <span
              className={`block truncate px-2 text-xs ${numeric ? "text-right tabular-nums" : ""} ${
                column.kind === "asset"
                  ? "font-bold text-[var(--app-text-strong)]"
                  : column.kind === "assetInsight"
                    ? "font-semibold text-[var(--app-accent)]"
                    : "text-[var(--app-text)]"
              }`}
            >
              {text}
            </span>
          );
        }

        return (
          <td
            key={column.id}
            data-row={rowIndex}
            data-col={columnIndex}
            data-active={active ? "true" : undefined}
            tabIndex={active ? 0 : -1}
            role="gridcell"
            aria-selected={selected || active}
            aria-readonly={!canEdit || undefined}
            title={column.kind === "text" && text.length > 24 ? text : undefined}
            style={{ width: column.width, minWidth: column.width, maxWidth: column.width, left: frozen ? frozenLeft[columnIndex] : undefined }}
            className={`h-7 overflow-hidden border-b border-r border-[var(--app-border)] p-0 align-middle outline-none ${background} ${
              frozen ? "sticky z-[2]" : ""
            } ${columnIndex === FROZEN_COLUMNS - 1 ? "border-r-2 border-r-[var(--app-border-strong)]" : ""} ${
              active ? "shadow-[inset_0_0_0_2px_var(--app-success)]" : ""
            }`}
          >
            {content}
          </td>
        );
      })}
    </tr>
  );
});

function HeaderMenu({
  column,
  menu,
  values,
  sort,
  allowed,
  onSort,
  onFilter,
  onClose,
}: {
  column: GridColumn;
  menu: MenuState;
  values: { key: string; label: string }[];
  sort: Sort | null;
  allowed: string[] | undefined;
  onSort: (direction: Sort["direction"] | null) => void;
  onFilter: (keys: string[] | null) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState(() => new Set(allowed ?? values.map((value) => value.key)));
  const numeric = isNumericColumn(column);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? values.filter((value) => value.label.toLowerCase().includes(term)) : values;
  }, [search, values]);
  const allVisibleChecked = visible.every((value) => checked.has(value.key));

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const sortButton = (direction: Sort["direction"], text: string, Icon: typeof ArrowUp) => (
    <button
      type="button"
      onClick={() => onSort(direction)}
      className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-[var(--app-panel-alt)] ${
        sort?.columnId === column.id && sort.direction === direction ? "font-bold text-[var(--app-accent)]" : "text-[var(--app-text)]"
      }`}
    >
      <Icon className="size-3.5" /> {text}
    </button>
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Sort and filter ${column.label}`}
      style={{ top: menu.top, left: menu.left }}
      className="fixed z-[130] w-64 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow-xl"
    >
      {sortButton("asc", numeric ? "Sort smallest to largest" : "Sort A to Z", ArrowUp)}
      {sortButton("desc", numeric ? "Sort largest to smallest" : "Sort Z to A", ArrowDown)}
      {sort?.columnId === column.id ? (
        <button type="button" onClick={() => onSort(null)} className="flex h-8 w-full items-center rounded px-2 text-left text-xs text-[var(--app-text)] hover:bg-[var(--app-panel-alt)]">
          Clear sort
        </button>
      ) : null}
      <div className="my-2 border-t border-[var(--app-border)]" />
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search values"
        aria-label={`Search ${column.label} values`}
        autoFocus
        className="h-8 w-full rounded border border-[var(--app-control-border)] bg-[var(--app-input)] px-2 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
      />
      <div className="mt-2 max-h-56 overflow-y-auto rounded border border-[var(--app-border)] p-1">
        <label className="flex h-7 items-center gap-2 px-1 text-xs font-semibold text-[var(--app-text)]">
          <input
            type="checkbox"
            checked={allVisibleChecked}
            onChange={() =>
              setChecked((current) => {
                const next = new Set(current);
                for (const value of visible) {
                  if (allVisibleChecked) next.delete(value.key);
                  else next.add(value.key);
                }
                return next;
              })
            }
          />
          (Select all)
        </label>
        {visible.map((value) => (
          <label key={value.key} className="flex h-7 items-center gap-2 px-1 text-xs text-[var(--app-text)]">
            <input
              type="checkbox"
              checked={checked.has(value.key)}
              onChange={() =>
                setChecked((current) => {
                  const next = new Set(current);
                  if (next.has(value.key)) next.delete(value.key);
                  else next.add(value.key);
                  return next;
                })
              }
            />
            <span className="truncate">{value.label}</span>
          </label>
        ))}
        {!visible.length ? <p className="px-1 py-2 text-xs text-[var(--app-text-muted)]">No matching values</p> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onFilter(null)}
          disabled={!allowed}
          className="h-8 rounded px-2 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)] disabled:opacity-40"
        >
          Clear filter
        </button>
        <div className="flex gap-1.5">
          <button type="button" onClick={onClose} className="h-8 rounded border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-text)]">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onFilter(checked.size === values.length ? null : values.filter((value) => checked.has(value.key)).map((value) => value.key))}
            className="h-8 rounded bg-[var(--app-accent)] px-3 text-xs font-bold text-[var(--app-on-accent)]"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ValuationGrid({
  visible = true,
  rows,
  allRows,
  evaluators,
  currency,
  canEditAll,
  editableEvaluatorId,
  totals,
  onRowChange,
  onEvaluatorChange,
  onOpenGallery,
  onStatusChange,
}: Props) {
  const columns = useMemo(() => buildGridColumns(evaluators), [evaluators]);
  const columnIndex = useMemo(() => new Map(columns.map((column, index) => [column.id, index])), [columns]);
  const frozenLeft = useMemo(() => {
    const offsets: number[] = [];
    let left = ROW_NUMBER_WIDTH;
    for (const column of columns.slice(0, FROZEN_COLUMNS)) {
      offsets.push(left);
      left += column.width;
    }
    return offsets;
  }, [columns]);
  const editable = useMemo(
    () => columns.map((column) => canEditColumn(column, canEditAll, editableEvaluatorId)),
    [canEditAll, columns, editableEvaluatorId]
  );
  const rowNumbers = useMemo(
    () => new Map(allRows.map((row, index) => [row.lot_id, EXPORT_FIRST_DATA_ROW + index])),
    [allRows]
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.lot_id, row])), [rows]);

  const [sort, setSort] = useState<Sort | null>(null);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [extent, setExtent] = useState<CellRef | null>(null);
  // Handlers read the selection from here: key repeat can deliver a second key
  // before React has rendered the first move.
  const selectionRef = useRef<{ anchor: CellRef | null; extent: CellRef | null }>({ anchor: null, extent: null });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const barRef = useRef<HTMLInputElement | null>(null);
  const focusPendingRef = useRef(false);
  const draggingRef = useRef(false);
  const undoRef = useRef<UndoEntry[][]>([]);
  // Writes not yet back from the parent; consecutive undos and pastes read these first.
  const pendingValuesRef = useRef(new Map<string, GridCellValue>());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    pendingValuesRef.current.clear();
  }, [rows]);

  // Like Excel, a sort or filter is applied when it is chosen. Editing a value does
  // not move or hide its row; adding or removing lots, or choosing again, re-applies.
  const rowIdsKey = useMemo(() => rows.map((row) => row.lot_id).join("\u0000"), [rows]);
  const order = useMemo(() => {
    const byId = new Map(rowsRef.current.map((row) => [row.lot_id, row]));
    let ids = rowIdsKey ? rowIdsKey.split("\u0000") : [];
    const activeFilters = Object.entries(filters)
      .map(([columnId, keys]) => [columns[columnIndex.get(columnId) ?? -1], new Set(keys)] as const)
      .filter(([column]) => Boolean(column));
    if (activeFilters.length) {
      ids = ids.filter((id) => {
        const row = byId.get(id)!;
        return activeFilters.every(([column, keys]) => keys.has(filterKey(cellText(row, column!, evaluators, currency))));
      });
    }
    const sortColumn = sort ? columns[columnIndex.get(sort.columnId) ?? -1] : undefined;
    if (sort && sortColumn) {
      ids = [...ids].sort((left, right) =>
        compareCellValues(
          cellValue(byId.get(left)!, sortColumn, evaluators),
          cellValue(byId.get(right)!, sortColumn, evaluators),
          sort.direction
        )
      );
    }
    return ids;
  }, [columnIndex, columns, currency, evaluators, filters, rowIdsKey, sort]);
  const displayRows = useMemo(
    () => order.map((id) => rowById.get(id)).filter((row): row is ProposalValuationRow => Boolean(row)),
    [order, rowById]
  );
  const displayIndex = useMemo(() => new Map(displayRows.map((row, index) => [row.lot_id, index])), [displayRows]);
  const rowCount = displayRows.length;
  const lastColumn = columns.length - 1;

  const position = useCallback(
    (cell: CellRef | null) => ({
      row: Math.min(Math.max(0, cell ? displayIndex.get(cell.lotId) ?? 0 : 0), Math.max(0, rowCount - 1)),
      col: Math.min(Math.max(0, cell ? columnIndex.get(cell.columnId) ?? 0 : 0), lastColumn),
    }),
    [columnIndex, displayIndex, lastColumn, rowCount]
  );
  const boxOf = (from: { row: number; col: number }, to: { row: number; col: number }) => ({
    r0: Math.min(from.row, to.row),
    r1: Math.max(from.row, to.row),
    c0: Math.min(from.col, to.col),
    c1: Math.max(from.col, to.col),
  });
  const active = position(anchor);
  const end = position(extent ?? anchor);
  const box = boxOf(active, end);
  const liveRef = useRef(() => ({ active, end, box }));
  liveRef.current = () => {
    const current = selectionRef.current;
    const from = position(current.anchor);
    const to = position(current.extent ?? current.anchor);
    return { active: from, end: to, box: boxOf(from, to) };
  };
  const refAt = useCallback(
    (row: number, col: number): CellRef | null => {
      const target = displayRows[row];
      const column = columns[col];
      return target && column ? { lotId: target.lot_id, columnId: column.id } : null;
    },
    [columns, displayRows]
  );

  const latestValue = useCallback(
    (row: ProposalValuationRow, column: GridColumn) => {
      const key = cellKey(row.lot_id, column.id);
      return pendingValuesRef.current.has(key)
        ? pendingValuesRef.current.get(key)!
        : cellValue(row, column, evaluators);
    },
    [evaluators]
  );

  const scrollIntoView = useCallback(
    (row: number, col: number) => {
      const scroller = scrollerRef.current;
      if (!scroller || !scroller.clientHeight) return;
      const head = LETTER_ROW_HEIGHT + HEADER_ROW_HEIGHT;
      const top = row * ROW_HEIGHT;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + ROW_HEIGHT + head + FOOTER_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = top + ROW_HEIGHT + head + FOOTER_HEIGHT - scroller.clientHeight;
      }
      if (col < FROZEN_COLUMNS) return;
      const frozenWidth = ROW_NUMBER_WIDTH + columns.slice(0, FROZEN_COLUMNS).reduce((sum, column) => sum + column.width, 0);
      const left = ROW_NUMBER_WIDTH + columns.slice(0, col).reduce((sum, column) => sum + column.width, 0);
      const width = columns[col].width;
      if (left < scroller.scrollLeft + frozenWidth) scroller.scrollLeft = left - frozenWidth;
      else if (left + width > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = left + width - scroller.clientWidth;
    },
    [columns]
  );

  const select = useCallback(
    (anchorRow: number, anchorCol: number, extentRow = anchorRow, extentCol = anchorCol, focus = true) => {
      const nextAnchor = refAt(anchorRow, anchorCol);
      if (!nextAnchor) return;
      const nextExtent = refAt(extentRow, extentCol);
      selectionRef.current = { anchor: nextAnchor, extent: nextExtent };
      setAnchor(nextAnchor);
      setExtent(nextExtent);
      if (focus) focusPendingRef.current = true;
      scrollIntoView(extentRow, extentCol);
    },
    [refAt, scrollIntoView]
  );

  const write = useCallback(
    (lotId: string, column: GridColumn, value: GridCellValue) => {
      pendingValuesRef.current.set(cellKey(lotId, column.id), value);
      if (column.kind === "text") onRowChange(lotId, column.field, value === null ? "" : String(value));
      else if (column.kind === "number") onRowChange(lotId, column.field, value === null ? null : Number(value));
      else if (column.kind === "evaluator") onEvaluatorChange(lotId, column.evaluatorId, value === null ? null : Number(value));
    },
    [onEvaluatorChange, onRowChange]
  );

  const applyEdits = useCallback(
    (edits: Edit[], record = true) => {
      const byId = new Map(rowsRef.current.map((row) => [row.lot_id, row]));
      const batch: UndoEntry[] = [];
      let locked = 0;
      for (const edit of edits) {
        const row = byId.get(edit.lotId);
        const index = columnIndex.get(edit.columnId);
        const column = index === undefined ? undefined : columns[index];
        if (!row || !column || index === undefined || !editable[index]) {
          locked += 1;
          continue;
        }
        const before = latestValue(row, column);
        if (sameCellValue(before, edit.value)) continue;
        write(row.lot_id, column, edit.value);
        batch.push({ lotId: row.lot_id, columnId: column.id, before, after: edit.value });
      }
      if (record && batch.length) {
        undoRef.current.push(batch);
        if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
      }
      return { applied: batch.length, locked };
    },
    [columnIndex, columns, editable, latestValue, write]
  );

  /** Turns typed or pasted text into a cell value; numbers accept currency formatting. */
  const parseFor = useCallback((column: GridColumn, text: string) => {
    if (isNumericColumn(column)) return parseCellNumber(text);
    return { ok: true as const, value: text };
  }, []);

  /** Saves the open edit; returns false, keeping it open, when a number is invalid. */
  const commit = useCallback((refocusCell = true) => {
    if (!editing) return true;
    const index = columnIndex.get(editing.columnId);
    const column = index === undefined ? undefined : columns[index];
    if (!column || !rowsRef.current.some((row) => row.lot_id === editing.lotId)) {
      setEditing(null);
      return true;
    }
    const parsed = parseFor(column, editing.draft);
    if (!parsed.ok) {
      toast.error("Enter a number, such as 1200 or $1,200.");
      return false;
    }
    applyEdits([{ lotId: editing.lotId, columnId: editing.columnId, value: parsed.value }]);
    setEditing(null);
    if (refocusCell) focusPendingRef.current = true;
    return true;
  }, [applyEdits, columnIndex, columns, editing, parseFor]);

  const startEdit = useCallback(
    (mode: Editing["mode"], draft?: string, origin: Editing["origin"] = "cell") => {
      const { active } = liveRef.current();
      const target = displayRows[active.row];
      const column = columns[active.col];
      if (!target || !column) return;
      if (!editable[active.col]) {
        if (column.kind === "text" || column.kind === "number" || column.kind === "evaluator") {
          toast.error(canEditAll || editableEvaluatorId ? "You can edit only your own value column." : "This valuation is read-only.");
        }
        return;
      }
      selectionRef.current = { ...selectionRef.current, extent: null };
      setExtent(null);
      setEditing({
        lotId: target.lot_id,
        columnId: column.id,
        draft: draft ?? cellEditText(latestValue(target, column)),
        mode,
        origin,
      });
      if (origin === "cell") focusPendingRef.current = true;
    },
    [canEditAll, columns, displayRows, editable, editableEvaluatorId, latestValue]
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    focusPendingRef.current = true;
  }, []);

  const selectionValues = useCallback(() => {
    const { box } = liveRef.current();
    const values: GridCellValue[][] = [];
    for (let row = box.r0; row <= box.r1; row += 1) {
      const target = displayRows[row];
      if (!target) continue;
      const line: GridCellValue[] = [];
      for (let col = box.c0; col <= box.c1; col += 1) line.push(latestValue(target, columns[col]));
      values.push(line);
    }
    return values;
  }, [columns, displayRows, latestValue]);

  const clearSelection = useCallback(() => {
    const { box } = liveRef.current();
    const edits: Edit[] = [];
    let lockedCells = 0;
    for (let row = box.r0; row <= box.r1; row += 1) {
      for (let col = box.c0; col <= box.c1; col += 1) {
        const ref = refAt(row, col);
        const column = columns[col];
        if (!ref || !(column.kind === "text" || column.kind === "number" || column.kind === "evaluator")) continue;
        if (!editable[col]) lockedCells += 1;
        else edits.push({ ...ref, value: column.kind === "text" ? "" : null });
      }
    }
    applyEdits(edits);
    if (lockedCells && !edits.length) toast.error("You can edit only your own value column.");
  }, [applyEdits, columns, editable, refAt]);

  const paste = useCallback(
    (text: string) => {
      const { box } = liveRef.current();
      const grid = parseClipboardText(text);
      if (!grid.length) return;
      const single = grid.length === 1 && grid[0].length === 1;
      const height = single ? box.r1 - box.r0 + 1 : grid.length;
      const width = single ? box.c1 - box.c0 + 1 : Math.max(...grid.map((line) => line.length));
      const edits: Edit[] = [];
      let lockedCells = 0;
      let invalid = 0;
      for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
        for (let colOffset = 0; colOffset < width; colOffset += 1) {
          const source = single ? grid[0][0] : grid[rowOffset]?.[colOffset];
          const ref = refAt(box.r0 + rowOffset, box.c0 + colOffset);
          if (source === undefined || !ref) continue;
          const col = box.c0 + colOffset;
          const column = columns[col];
          if (!editable[col]) {
            lockedCells += 1;
            continue;
          }
          const parsed = parseFor(column, source);
          if (!parsed.ok) {
            invalid += 1;
            continue;
          }
          edits.push({ ...ref, value: parsed.value });
        }
      }
      applyEdits(edits);
      select(
        box.r0,
        box.c0,
        Math.min(rowCount - 1, box.r0 + height - 1),
        Math.min(lastColumn, box.c0 + width - 1)
      );
      const skipped = [
        invalid ? `${plural(invalid, "value")} that ${invalid === 1 ? "isn't a number was" : "aren't numbers were"} skipped` : "",
        lockedCells ? `${plural(lockedCells, "locked cell")} ${lockedCells === 1 ? "was" : "were"} left unchanged` : "",
      ].filter(Boolean);
      if (skipped.length) toast.error(`Pasted. ${skipped.join("; ")}.`);
    },
    [applyEdits, columns, editable, lastColumn, parseFor, refAt, rowCount, select]
  );

  const undo = useCallback(() => {
    const batch = undoRef.current.pop();
    if (!batch) return;
    const byId = new Map(rowsRef.current.map((row) => [row.lot_id, row]));
    const restore: Edit[] = [];
    let changed = 0;
    for (const entry of batch) {
      const row = byId.get(entry.lotId);
      const index = columnIndex.get(entry.columnId);
      const column = index === undefined ? undefined : columns[index];
      // Restore only cells that still hold this edit, so a value saved since by
      // another evaluator, or by a later edit here, is never overwritten.
      if (!row || !column || index === undefined || !editable[index] || !sameCellValue(latestValue(row, column), entry.after)) {
        changed += 1;
        continue;
      }
      restore.push({ lotId: entry.lotId, columnId: entry.columnId, value: entry.before });
    }
    applyEdits(restore, false);
    const positions = batch
      .map((entry) => ({ row: displayIndex.get(entry.lotId), col: columnIndex.get(entry.columnId) }))
      .filter((cell): cell is { row: number; col: number } => cell.row !== undefined && cell.col !== undefined);
    if (positions.length) {
      select(
        Math.min(...positions.map((cell) => cell.row)),
        Math.min(...positions.map((cell) => cell.col)),
        Math.max(...positions.map((cell) => cell.row)),
        Math.max(...positions.map((cell) => cell.col))
      );
    }
    if (changed) {
      toast.error(`${plural(changed, "cell")} changed after your edit and ${changed === 1 ? "was" : "were"} not undone.`);
    }
  }, [applyEdits, columnIndex, columns, displayIndex, editable, latestValue, select]);

  const openPictures = useCallback(() => {
    const { active } = liveRef.current();
    const target = displayRows[active.row];
    if (!target || columns[active.col]?.kind !== "pictures") return false;
    const button = tableRef.current?.querySelector<HTMLButtonElement>(`td[data-active="true"] button`);
    const urls = validPictureUrls(target);
    if (!button || !urls.length) return false;
    onOpenGallery(assetLabel(target), urls, button);
    return true;
  }, [columns, displayRows, onOpenGallery]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>) => {
    if (menu || !rowCount) return;
    const { active, end } = liveRef.current();
    const key = event.key;
    const shift = event.shiftKey;
    const ctrl = event.ctrlKey || event.metaKey;
    const inEditor = editing?.origin === "cell" && (event.target as HTMLElement).dataset?.editing === "true";

    if (inEditor && editing) {
      const arrow = key === "ArrowUp" || key === "ArrowDown" || ((key === "ArrowLeft" || key === "ArrowRight") && editing.mode === "enter");
      if (key === "Enter" || key === "Tab" || arrow) {
        event.preventDefault();
        if (!commit()) return;
        const step = key === "Enter" ? [shift ? -1 : 1, 0] : key === "Tab" ? [0, shift ? -1 : 1]
          : key === "ArrowUp" ? [-1, 0] : key === "ArrowDown" ? [1, 0] : key === "ArrowLeft" ? [0, -1] : [0, 1];
        select(
          Math.min(rowCount - 1, Math.max(0, active.row + step[0])),
          Math.min(lastColumn, Math.max(0, active.col + step[1]))
        );
      } else if (key === "Escape") {
        // Escape ends the edit only; it must not also close the Proposal Valuation dialog.
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
      return;
    }

    if (event.altKey && key === "ArrowDown") {
      event.preventDefault();
      const button = tableRef.current?.querySelector<HTMLButtonElement>(`button[data-menu-col="${active.col}"]`);
      if (button) openMenu(columns[active.col], button);
      return;
    }

    const move = (rowStep: number, colStep: number) => {
      const from = shift ? end : active;
      const row = ctrl && rowStep ? (rowStep < 0 ? 0 : rowCount - 1) : Math.min(rowCount - 1, Math.max(0, from.row + rowStep));
      const col = ctrl && colStep ? (colStep < 0 ? 0 : lastColumn) : Math.min(lastColumn, Math.max(0, from.col + colStep));
      if (shift) select(active.row, active.col, row, col);
      else select(row, col);
    };

    switch (key) {
      case "ArrowUp": event.preventDefault(); move(-1, 0); return;
      case "ArrowDown": event.preventDefault(); move(1, 0); return;
      case "ArrowLeft": event.preventDefault(); move(0, -1); return;
      case "ArrowRight": event.preventDefault(); move(0, 1); return;
      case "PageUp": event.preventDefault(); move(-PAGE_ROWS, 0); return;
      case "PageDown": event.preventDefault(); move(PAGE_ROWS, 0); return;
      case "Home":
        event.preventDefault();
        select(ctrl ? 0 : active.row, 0);
        return;
      case "End":
        event.preventDefault();
        select(ctrl ? rowCount - 1 : active.row, lastColumn);
        return;
      case "Enter":
        event.preventDefault();
        select(Math.min(rowCount - 1, Math.max(0, active.row + (shift ? -1 : 1))), active.col);
        return;
      case "Tab": {
        const forward = !shift;
        const atEdge = forward
          ? active.row === rowCount - 1 && active.col === lastColumn
          : active.row === 0 && active.col === 0;
        if (atEdge) return; // Let Tab leave the sheet from its first or last cell.
        event.preventDefault();
        if (forward) select(active.col === lastColumn ? active.row + 1 : active.row, active.col === lastColumn ? 0 : active.col + 1);
        else select(active.col === 0 ? active.row - 1 : active.row, active.col === 0 ? lastColumn : active.col - 1);
        return;
      }
      case "F2":
        event.preventDefault();
        startEdit("edit");
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        clearSelection();
        return;
      case " ":
        if (openPictures()) {
          event.preventDefault();
          return;
        }
        break;
    }
    if (ctrl && key.toLowerCase() === "a") {
      event.preventDefault();
      select(0, 0, rowCount - 1, lastColumn);
      return;
    }
    if (ctrl && key.toLowerCase() === "z" && !shift) {
      event.preventDefault();
      undo();
      return;
    }
    if (key.length === 1 && !ctrl && !event.altKey) {
      event.preventDefault();
      startEdit("enter", key);
    }
  };

  const cellFromEvent = (event: React.SyntheticEvent) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("td[data-row]");
    return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : null;
  };

  const onMouseDown = (event: React.MouseEvent<HTMLTableElement>) => {
    if (event.button !== 0) return;
    const cell = cellFromEvent(event);
    if (!cell) return;
    const target = event.target as HTMLElement;
    if (editing && target.dataset.editing === "true") return;
    if (editing && !commit()) return;
    if (!target.closest("button")) event.preventDefault();
    draggingRef.current = true;
    const { active } = liveRef.current();
    if (event.shiftKey) select(active.row, active.col, cell.row, cell.col);
    else select(cell.row, cell.col);
  };

  const onMouseOver = (event: React.MouseEvent<HTMLTableElement>) => {
    if (!draggingRef.current) return;
    const cell = cellFromEvent(event);
    const { active, end } = liveRef.current();
    if (cell && (cell.row !== end.row || cell.col !== end.col)) select(active.row, active.col, cell.row, cell.col);
  };

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const onDoubleClick = (event: React.MouseEvent<HTMLTableElement>) => {
    const cell = cellFromEvent(event);
    if (!cell || (event.target as HTMLElement).closest("button")) return;
    select(cell.row, cell.col);
    const target = displayRows[cell.row];
    const column = columns[cell.col];
    if (!target || !column || !editable[cell.col]) return;
    setEditing({ lotId: target.lot_id, columnId: column.id, draft: cellEditText(latestValue(target, column)), mode: "edit", origin: "cell" });
    focusPendingRef.current = true;
  };

  // Typing into a cell's editor, or a value set on it any other way (autofill,
  // assistive technology, tests), goes through the same edit path. Rows are
  // memoized, so they get one stable callback that reads the latest state.
  const cellInputRef = useRef<(row: number, col: number, value: string) => void>(() => undefined);
  cellInputRef.current = (row, col, value) => {
    const target = displayRows[row];
    const column = columns[col];
    if (!target || !column) return;
    if (editing && editing.lotId === target.lot_id && editing.columnId === column.id) {
      setEditing({ ...editing, draft: value });
      return;
    }
    if (!editable[col]) return;
    const parsed = parseFor(column, value);
    if (parsed.ok) applyEdits([{ lotId: target.lot_id, columnId: column.id, value: parsed.value }]);
  };
  const onCellInput = useCallback((row: number, col: number, value: string) => cellInputRef.current(row, col, value), []);

  const onBlur = (event: React.FocusEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement;
    if (!editing || editing.origin !== "cell" || target.dataset.editing !== "true") return;
    const next = event.relatedTarget as HTMLElement | null;
    if (next && (tableRef.current?.contains(next) || next === barRef.current)) return;
    commit(false);
  };

  useEffect(() => {
    const focusInside = () => Boolean(tableRef.current?.contains(document.activeElement));
    const editingInput = () => (document.activeElement as HTMLElement | null)?.dataset?.editing === "true";
    const onCopy = (event: ClipboardEvent) => {
      if (!focusInside() || editingInput() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", toClipboardText(selectionValues()));
      event.preventDefault();
    };
    const onCut = (event: ClipboardEvent) => {
      if (!focusInside() || editingInput() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", toClipboardText(selectionValues()));
      event.preventDefault();
      clearSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!focusInside() || editingInput() || !event.clipboardData) return;
      event.preventDefault();
      paste(event.clipboardData.getData("text/plain"));
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [clearSelection, paste, selectionValues]);

  useEffect(() => {
    if (!focusPendingRef.current) return;
    const table = tableRef.current;
    const target = editing?.origin === "cell"
      ? table?.querySelector<HTMLInputElement>('input[data-editing="true"]')
      : editing
        ? null
        : table?.querySelector<HTMLElement>('td[data-active="true"]');
    if (!target) return;
    focusPendingRef.current = false;
    target.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement) target.setSelectionRange(target.value.length, target.value.length);
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Draw no desktop rows on mobile; a CSS-hidden scroller has no measured height
  // and must not fall back to rendering the entire report.
  const windowed = viewport.height > 0;
  const firstRow = visible && windowed ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN) : 0;
  const lastRow = !visible ? 0 : windowed
    ? Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN)
    : rowCount;

  const status = useMemo<ValuationGridStatus>(() => {
    const lots = rowCount === rows.length ? plural(rows.length, "lot") : `${rowCount} of ${plural(rows.length, "lot")} shown`;
    if (box.r0 === box.r1 && box.c0 === box.c1) return { selection: "", lots };
    let count = 0;
    let sum = 0;
    let numbers = 0;
    for (let row = box.r0; row <= box.r1; row += 1) {
      const target = displayRows[row];
      if (!target) continue;
      for (let col = box.c0; col <= box.c1; col += 1) {
        const value = cellValue(target, columns[col], evaluators);
        if (value === null || value === "") continue;
        count += 1;
        if (isMoneyColumn(columns[col]) && typeof value === "number") {
          sum += value;
          numbers += 1;
        }
      }
    }
    const money = (value: number) => formatColumnTotal(value, currency);
    return {
      selection: numbers
        ? `Average ${money(sum / numbers)}   Count ${count}   Sum ${money(sum)}`
        : `Count ${count}`,
      lots,
    };
  }, [box.c0, box.c1, box.r0, box.r1, columns, currency, displayRows, evaluators, rowCount, rows.length]);

  useEffect(() => {
    onStatusChange(status);
  }, [onStatusChange, status]);

  const activeRow = displayRows[active.row];
  const activeColumnDef = columns[active.col];
  const activeRowNumber = activeRow ? rowNumbers.get(activeRow.lot_id) ?? EXPORT_FIRST_DATA_ROW : EXPORT_FIRST_DATA_ROW;
  const activeEditable = Boolean(editable[active.col]) && Boolean(activeRow);
  const barValue = !activeRow || !activeColumnDef
    ? ""
    : editing && editing.lotId === activeRow.lot_id && editing.columnId === activeColumnDef.id
      ? editing.draft
      : activeColumnDef.kind === "calc"
        ? cellFormula(activeColumnDef, columns, activeRowNumber, activeRow.buyer_premium_percent || 15) ?? ""
        : cellEditText(latestValue(activeRow, activeColumnDef));

  const menuColumn = menu ? columns[columnIndex.get(menu.columnId) ?? -1] : undefined;
  const menuValues = useMemo(() => {
    if (!menuColumn) return [];
    const seen = new Map<string, GridCellValue>();
    for (const row of rows) {
      const key = filterKey(cellText(row, menuColumn, evaluators, currency));
      if (!seen.has(key)) seen.set(key, cellValue(row, menuColumn, evaluators));
    }
    return [...seen.entries()]
      .sort((left, right) => compareCellValues(left[1], right[1], "asc"))
      .map(([key]) => ({ key, label: key || "(Blanks)" }));
  }, [currency, evaluators, menuColumn, rows]);

  const openMenu = (column: GridColumn, button: HTMLButtonElement) => {
    if (editing && !commit()) return;
    const rect = button.getBoundingClientRect();
    setMenu({
      columnId: column.id,
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.right - 256, window.innerWidth - 264)),
    });
  };

  const closeMenu = useCallback(() => {
    setMenu(null);
    focusPendingRef.current = true;
  }, []);

  const totalFor = (column: GridColumn): { label: string; value: string } | null => {
    if (!totals) return null;
    const money = (value: number) => formatColumnTotal(value, currency);
    if (column.kind === "evaluator") {
      const total = totals.evaluators.find((item) => item.id === column.evaluatorId);
      return { label: `${column.label} total for all lots`, value: money(total?.total ?? 0) };
    }
    if (column.kind === "number") {
      return column.field === "lien_search"
        ? { label: "Lien search total for all lots", value: money(totals.lienSearch) }
        : { label: "Video cost total for all lots", value: money(totals.videoCost) };
    }
    if (column.kind !== "calc") return null;
    switch (column.calc) {
      case "average": return { label: "Average total for all lots", value: money(totals.average) };
      case "low": return { label: "Low total for all lots", value: money(totals.low) };
      case "high": return { label: "High total for all lots", value: money(totals.high) };
      case "buyerPremiumPercent": return { label: "Buyer premium percentages are not summed", value: "—" };
      case "buyerPremiumAmount": return { label: "Buyer premium total for all lots", value: money(totals.buyerPremium) };
      case "totalExpectedGross": return { label: "Total expected gross total for all lots", value: money(totals.totalExpectedGross) };
      case "allocatedValue": return { label: "Allocated value total for all lots", value: money(totals.allocatedValue) };
      case "cleaning": return { label: "Cleaning total for all lots", value: money(totals.cleaning) };
      case "lottingFee": return { label: "Lotting fee total for all lots", value: money(totals.lottingFee) };
      case "advertising": return { label: "Advertising total for all lots", value: money(totals.advertising) };
    }
  };

  const tableWidth = ROW_NUMBER_WIDTH + columns.reduce((sum, column) => sum + column.width, 0);
  const stickyLeft = (index: number) => (index < FROZEN_COLUMNS ? { left: frozenLeft[index] } : undefined);
  const headerCellClass = (index: number) =>
    `border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] ${index < FROZEN_COLUMNS ? "sticky z-[8]" : ""} ${
      index === FROZEN_COLUMNS - 1 ? "border-r-2 border-r-[var(--app-border-strong)]" : ""
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-stretch rounded-t-lg border border-b-0 border-[var(--app-border)] bg-[var(--app-panel)] text-xs">
        <div
          className="grid w-20 shrink-0 place-items-center border-r border-[var(--app-border)] font-bold tabular-nums text-[var(--app-text-strong)]"
          aria-label="Selected cell"
          title="Column letters and row numbers match the exported Excel file."
        >
          {activeRow && activeColumnDef ? `${activeColumnDef.letter}${activeRowNumber}` : ""}
        </div>
        <div className="grid w-9 shrink-0 place-items-center border-r border-[var(--app-border)] font-serif italic text-[var(--app-text-muted)]" aria-hidden="true">
          fx
        </div>
        <input
          ref={barRef}
          value={barValue}
          readOnly={!activeEditable}
          aria-label="Formula bar"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => {
            if (activeEditable && !editing) startEdit("edit", undefined, "bar");
          }}
          onChange={(event) => {
            if (editing) setEditing({ ...editing, draft: event.target.value, origin: "bar" });
          }}
          onKeyDown={(event) => {
            if (!editing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              const { active } = liveRef.current();
              if (commit()) select(Math.min(rowCount - 1, active.row + 1), active.col);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelEdit();
            }
          }}
          onBlur={(event) => {
            if (!editing || editing.origin !== "bar") return;
            if (event.relatedTarget && tableRef.current?.contains(event.relatedTarget as Node)) return;
            commit(false);
          }}
          className={`min-w-0 flex-1 bg-transparent px-3 font-mono text-xs text-[var(--app-text)] outline-none ${
            activeColumnDef?.kind === "calc" ? "text-[var(--app-text-muted)]" : ""
          }`}
        />
      </div>
      <div
        ref={scrollerRef}
        role="region"
        aria-label="Proposal valuation lots table"
        onScroll={(event) => {
          const target = event.currentTarget;
          if (windowed && Math.abs(target.scrollTop - viewport.top) >= ROW_HEIGHT / 2) {
            setViewport({ top: target.scrollTop, height: target.clientHeight });
          }
        }}
        className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-b-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
      >
        <table
          ref={tableRef}
          role="grid"
          aria-label="Proposal valuation lots"
          aria-rowcount={rowCount + 2}
          aria-colcount={columns.length + 1}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onMouseOver={onMouseOver}
          onDoubleClick={onDoubleClick}
          onBlur={onBlur}
          style={{ width: tableWidth }}
          className="table-fixed select-none border-separate border-spacing-0 text-xs"
        >
          <thead>
            <tr style={{ height: LETTER_ROW_HEIGHT }}>
              <th
                className="sticky left-0 top-0 z-[10] border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)]"
                style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
                aria-hidden="true"
              />
              {columns.map((column, index) => (
                <th
                  key={column.id}
                  aria-hidden="true"
                  style={{ width: column.width, minWidth: column.width, ...stickyLeft(index) }}
                  className={`top-0 h-5 p-0 text-center text-[11px] font-normal ${headerCellClass(index)} ${
                    index >= FROZEN_COLUMNS ? "sticky z-[6]" : ""
                  } ${index >= box.c0 && index <= box.c1 ? "!bg-[var(--app-accent-soft)] font-bold text-[var(--app-accent)]" : "text-[var(--app-text-muted)]"}`}
                >
                  {column.letter}
                </th>
              ))}
            </tr>
            <tr style={{ height: HEADER_ROW_HEIGHT }}>
              <th
                className="sticky left-0 z-[10] border-b border-r border-[var(--app-border)] bg-[var(--app-panel-alt)] text-center text-[11px] font-normal tabular-nums text-[var(--app-text-muted)]"
                style={{ top: LETTER_ROW_HEIGHT }}
                aria-hidden="true"
              >
                {EXPORT_FIRST_DATA_ROW - 1}
              </th>
              {columns.map((column, index) => {
                const filtered = Boolean(filters[column.id]);
                const sorted = sort?.columnId === column.id ? sort.direction : null;
                const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : filtered ? Filter : ChevronDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-label={column.label}
                    style={{ top: LETTER_ROW_HEIGHT, ...stickyLeft(index) }}
                    className={`h-10 px-2 text-left text-[10px] font-bold uppercase leading-tight tracking-[0.03em] text-[var(--app-text-muted)] ${headerCellClass(index)} ${
                      index >= FROZEN_COLUMNS ? "sticky z-[6]" : ""
                    }`}
                  >
                    <div className={`flex items-center gap-1 ${isNumericColumn(column) ? "justify-end" : ""}`}>
                      <span className="line-clamp-2 min-w-0">{column.label}</span>
                      <button
                        type="button"
                        tabIndex={-1}
                        data-menu-col={index}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => openMenu(column, event.currentTarget)}
                        aria-label={`Sort and filter ${column.label}`}
                        title={`Sort and filter (Alt+Down on a ${column.label} cell)`}
                        aria-haspopup="dialog"
                        className={`grid size-5 shrink-0 place-items-center rounded border ${
                          filtered || sorted
                            ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-[var(--app-accent)]"
                            : "border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        <Icon className="size-3" />
                      </button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {firstRow > 0 ? <tr aria-hidden="true" style={{ height: firstRow * ROW_HEIGHT }} /> : null}
            {displayRows.slice(firstRow, lastRow).map((row, offset) => {
              const rowIndex = firstRow + offset;
              const inRange = rowIndex >= box.r0 && rowIndex <= box.r1;
              const editingHere = editing && editing.lotId === row.lot_id ? columnIndex.get(editing.columnId) ?? -1 : -1;
              return (
                <GridRow
                  key={row.lot_id}
                  row={row}
                  rowIndex={rowIndex}
                  rowNumber={rowNumbers.get(row.lot_id) ?? EXPORT_FIRST_DATA_ROW + rowIndex}
                  columns={columns}
                  frozenLeft={frozenLeft}
                  evaluators={evaluators}
                  currency={currency}
                  editable={editable}
                  selectedFrom={inRange ? box.c0 : -1}
                  selectedTo={inRange ? box.c1 : -1}
                  activeColumn={rowIndex === active.row ? active.col : -1}
                  editingColumn={editingHere}
                  editingDraft={editingHere >= 0 && editing ? editing.draft : ""}
                  onCellInput={onCellInput}
                  onOpenGallery={onOpenGallery}
                />
              );
            })}
            {lastRow < rowCount ? <tr aria-hidden="true" style={{ height: (rowCount - lastRow) * ROW_HEIGHT }} /> : null}
            {!rowCount && rows.length ? (
              <tr>
                <td colSpan={columns.length + 1} className="h-16 px-4 text-left text-xs text-[var(--app-text-muted)]">
                  No lots match these filters.{" "}
                  <button type="button" onClick={() => setFilters({})} className="font-bold text-[var(--app-accent)] hover:underline">
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
          {totals ? (
            <tfoot aria-label="All-lot valuation totals" className="text-xs font-bold tabular-nums text-[var(--app-text-strong)]">
              <tr style={{ height: FOOTER_HEIGHT }}>
                <td className="sticky bottom-0 left-0 z-[9] border-t-2 border-r border-t-[var(--app-accent)] border-r-[var(--app-border)] bg-[var(--app-panel-alt)]" aria-hidden="true" />
                {columns.map((column, index) => {
                  const base = `sticky bottom-0 border-r border-t-2 border-r-[var(--app-border)] border-t-[var(--app-accent)] bg-[var(--app-panel-alt)] px-2 ${
                    index < FROZEN_COLUMNS ? "z-[9]" : "z-[5]"
                  } ${index === FROZEN_COLUMNS - 1 ? "border-r-2 border-r-[var(--app-border-strong)]" : ""}`;
                  if (column.kind === "asset") {
                    return <th key={column.id} scope="row" style={stickyLeft(index)} className={`${base} text-left`}>Totals</th>;
                  }
                  if (index === 1) {
                    return (
                      <td
                        key={column.id}
                        style={stickyLeft(index)}
                        title="Sum of entered values for all lots, including those hidden by search or filters"
                        className={`${base} text-left text-[11px] font-medium text-[var(--app-text-muted)]`}
                      >
                        {columnTotalsScopeLabel(totals.lotCount)}
                      </td>
                    );
                  }
                  const total = totalFor(column);
                  return total ? (
                    <td
                      key={column.id}
                      aria-label={total.label}
                      className={`${base} text-right ${column.kind === "calc" && column.calc === "buyerPremiumPercent" ? "text-[var(--app-text-muted)]" : ""}`}
                    >
                      {total.value}
                    </td>
                  ) : (
                    <td key={column.id} aria-hidden="true" className={base} />
                  );
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {menu && menuColumn ? (
        <HeaderMenu
          key={menu.columnId}
          column={menuColumn}
          menu={menu}
          values={menuValues}
          sort={sort}
          allowed={filters[menuColumn.id]}
          onSort={(direction) => {
            setSort(direction ? { columnId: menuColumn.id, direction } : null);
            closeMenu();
          }}
          onFilter={(keys) => {
            setFilters((current) => {
              const next = { ...current };
              if (keys) next[menuColumn.id] = keys;
              else delete next[menuColumn.id];
              return next;
            });
            closeMenu();
          }}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}
