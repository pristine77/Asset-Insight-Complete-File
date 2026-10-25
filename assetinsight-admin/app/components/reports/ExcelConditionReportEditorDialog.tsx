"use client";

import {
  createElement,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import FormatAlignCenterRoundedIcon from "@mui/icons-material/FormatAlignCenterRounded";
import FormatAlignLeftRoundedIcon from "@mui/icons-material/FormatAlignLeftRounded";
import FormatAlignRightRoundedIcon from "@mui/icons-material/FormatAlignRightRounded";
import FormatBoldRoundedIcon from "@mui/icons-material/FormatBoldRounded";
import FormatClearRoundedIcon from "@mui/icons-material/FormatClearRounded";
import HorizontalRuleRoundedIcon from "@mui/icons-material/HorizontalRuleRounded";
import FormatItalicRoundedIcon from "@mui/icons-material/FormatItalicRounded";
import FormatListBulletedRoundedIcon from "@mui/icons-material/FormatListBulletedRounded";
import FormatListNumberedRoundedIcon from "@mui/icons-material/FormatListNumberedRounded";
import FormatUnderlinedRoundedIcon from "@mui/icons-material/FormatUnderlinedRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TableChartRoundedIcon from "@mui/icons-material/TableChartRounded";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import RedoRoundedIcon from "@mui/icons-material/RedoRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import { excelConditionReportDescription, excelConditionReportTitleHelp } from "@/lib/excelConditionReportDescription";

type BidValue = 5 | 25 | 100 | 1000 | null;

type ExcelCrDisclaimers = {
  smallsOnsite: boolean;
  smallsOffsite: boolean;
  rollingStockOnsite: boolean;
  rollingStockOffsite: boolean;
  customText: string;
  unreserved: boolean;
  closingDate: string | null;
  closingTime: string | null;
  closingTimePeriod: "AM" | "PM" | null;
  bidIncrement: BidValue;
  openingBid: BidValue;
};

type ExcelCrSpec = {
  editorId: string;
  field: string;
  value: string;
  type?: string;
  required?: boolean;
  options?: string[];
  custom?: boolean;
  deleted?: boolean;
};

type ExcelCrRow = {
  rowKey: string;
  disclaimerLotKey: string;
  lotNumber: string;
  title: string;
  description?: string;
  descriptionScope?: "lot" | "item";
  category: string;
  imageUrls: string[];
  specs: ExcelCrSpec[];
  damageEligible: boolean;
  damagePolicyEligible: boolean;
  damageAnalysis: string;
  disclaimers: ExcelCrDisclaimers;
  normalizationWarnings: Array<{ removedField: string; keptField: string }>;
};

type ExcelCrPayload = {
  reportType: "Asset" | "LotListing" | string;
  revision: string;
  filesBusy: boolean;
  fileJobStatus?: string;
  fileJobError?: string;
  masterDamageEnabled: boolean;
  rows: ExcelCrRow[];
};

type Feedback = {
  severity: "success" | "warning" | "error" | "info";
  message: string;
};

export type ExcelConditionReportEditorDialogProps = {
  open: boolean;
  reportId: string | null;
  reportTitle?: string;
  onClose: () => void;
  onSaved?: (result: { regenerated: boolean; message: string }) => void | Promise<void>;
};

const emptyDisclaimers: ExcelCrDisclaimers = {
  smallsOnsite: false,
  smallsOffsite: false,
  rollingStockOnsite: false,
  rollingStockOffsite: false,
  customText: "",
  unreserved: false,
  closingDate: null,
  closingTime: null,
  closingTimePeriod: null,
  bidIncrement: null,
  openingBid: null,
};

const bidOptions = [5, 25, 100, 1000] as const;

const disclaimerOptions: Array<{
  key: keyof Pick<
    ExcelCrDisclaimers,
    "smallsOnsite" | "smallsOffsite" | "rollingStockOnsite" | "rollingStockOffsite"
  >;
  label: string;
}> = [
  { key: "smallsOnsite", label: "Smalls — notice on every lot (onsite)" },
  { key: "smallsOffsite", label: "Smalls — notice on every lot (offsite)" },
  { key: "rollingStockOnsite", label: "Rolling stock — damage disclaimer (onsite)" },
  { key: "rollingStockOffsite", label: "Rolling stock — damage disclaimer (offsite)" },
];

const richEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    blockquote: false,
    codeBlock: false,
    bulletList: { keepMarks: true },
    orderedList: { keepMarks: true },
  }),
  TextAlign.configure({
    types: ["heading", "paragraph"],
    alignments: ["left", "center", "right"],
  }),
];

function normalisePayload(input: ExcelCrPayload): ExcelCrPayload {
  return {
    ...input,
    rows: Array.isArray(input?.rows)
      ? input.rows.map((row, index) => {
          const rowKey = String(row?.rowKey || `row-${index}`);
          return {
            ...row,
            rowKey,
            disclaimerLotKey: String(
              row?.disclaimerLotKey || `lot-number:${String(row?.lotNumber || index).trim().toLowerCase()}`
            ),
            lotNumber: String(row?.lotNumber || ""),
            title: String(row?.title || ""),
            ...excelConditionReportDescription(row),
            descriptionScope: row.descriptionScope === "lot" || row.descriptionScope === "item"
              ? row.descriptionScope
              : undefined,
            category: String(row?.category || ""),
            imageUrls: Array.isArray(row?.imageUrls) ? row.imageUrls.filter(Boolean) : [],
            specs: Array.isArray(row?.specs)
              ? row.specs.map((spec, specIndex) => ({
                  ...spec,
                  editorId: String(spec?.editorId || `${rowKey}:spec:${specIndex}`),
                  field: String(spec?.field || ""),
                  value: String(spec?.value || ""),
                  options: Array.isArray(spec?.options) ? spec.options.map(String) : [],
                }))
              : [],
            damageAnalysis: String(row?.damageAnalysis || ""),
            damageEligible: Boolean(row?.damageEligible),
            damagePolicyEligible: row?.damagePolicyEligible !== false,
            disclaimers: { ...emptyDisclaimers, ...(row?.disclaimers || {}) },
            normalizationWarnings: Array.isArray(row?.normalizationWarnings)
              ? row.normalizationWarnings
              : [],
          };
        })
      : [],
  };
}

function rowsSnapshot(rows: ExcelCrRow[]) {
  return JSON.stringify(rows);
}

function extractError(json: unknown, fallback: string) {
  if (json && typeof json === "object" && "message" in json) {
    const message = String((json as { message?: unknown }).message || "").trim();
    if (message) return message;
  }
  return fallback;
}

function isDamagePolicyEligible(lotNumber: string) {
  const compact = String(lotNumber || "").replace(/,/g, "");
  const match = compact.match(/\d+/);
  if (!match) return true;
  const number = Number(match[0]);
  return !Number.isFinite(number) || number <= 1000;
}

function isCheckedSpec(value: string) {
  return ["true", "yes", "1", "checked"].includes(String(value || "").trim().toLowerCase());
}

function formatMoneyOption(value: BidValue) {
  return value ? `$${value.toLocaleString()}` : "Not set";
}

function timeInputValue(settings: ExcelCrDisclaimers) {
  const match = String(settings.closingTime || "").match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  if (settings.closingTimePeriod === "PM" && hour < 12) hour += 12;
  if (settings.closingTimePeriod === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function fromTimeInput(value: string): Pick<ExcelCrDisclaimers, "closingTime" | "closingTimePeriod"> {
  if (!value) return { closingTime: null, closingTimePeriod: null };
  const [hourText, minute = "00"] = value.split(":");
  const hour24 = Number(hourText);
  const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return { closingTime: `${hour12}:${minute}`, closingTimePeriod: period };
}

function SafeRichPreview({ html }: { html: string }) {
  const nodes = useMemo(() => {
    if (!html || typeof window === "undefined") return [] as ReactNode[];
    const parsed = new DOMParser().parseFromString(html, "text/html");
    let key = 0;
    const allowed = new Set(["p", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "br", "hr"]);
    const convert = (node: ChildNode): ReactNode => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return null;
      const element = node as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const children = Array.from(element.childNodes).map(convert);
      if (!allowed.has(tag)) return createElement("span", { key: `safe-rich-${key++}` }, children);
      if (tag === "br" || tag === "hr") return createElement(tag, { key: `safe-rich-${key++}` });
      return createElement(tag, { key: `safe-rich-${key++}` }, children);
    };
    return Array.from(parsed.body.childNodes).map(convert);
  }, [html]);

  if (!nodes.length) {
    return <Typography sx={{ color: "#8a8e8a", fontSize: 12.5 }}>No custom note.</Typography>;
  }

  return (
    <Box
      sx={{
        color: "#2b2e2b",
        fontSize: 12.5,
        lineHeight: 1.55,
        overflowWrap: "anywhere",
        "& p": { my: 0.5 },
        "& h1, & h2, & h3": { color: "#17191d", my: 0.75, lineHeight: 1.25 },
        "& h1": { fontSize: 18 },
        "& h2": { fontSize: 16 },
        "& h3": { fontSize: 14 },
        "& ul, & ol": { my: 0.5, pl: 2.5 },
        "& hr": { my: 1, border: 0, borderTop: "1px solid #d7d9d7" },
      }}
    >
      {nodes}
    </Box>
  );
}

function RichNoteEditor({
  activeRowKey,
  value,
  disabled,
  onChange,
}: {
  activeRowKey: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [, forceToolbarRefresh] = useState(0);
  const onChangeRef = useRef(onChange);
  const activeRowKeyRef = useRef(activeRowKey);
  onChangeRef.current = onChange;
  activeRowKeyRef.current = activeRowKey;

  const editor = useEditor({
    extensions: richEditorExtensions,
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      onChangeRef.current(activeEditor.isEmpty ? "" : activeEditor.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    const next = value || "";
    if (next !== editor.getHTML()) editor.commands.setContent(next, { emitUpdate: false });
  }, [activeRowKey, editor, value]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => forceToolbarRefresh((current) => current + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
    };
  }, [editor]);

  const toolbarButton = (
    label: string,
    icon: ReactNode,
    active: boolean,
    action: () => void,
    unavailable = false
  ) => (
    <Tooltip title={label} key={label}>
      <span>
        <IconButton
          size="small"
          aria-label={label}
          disabled={disabled || !editor || unavailable}
          onClick={action}
          sx={{
            width: 30,
            height: 30,
            borderRadius: 0.75,
            color: active ? "#fff" : "#414541",
            bgcolor: active ? "#df111b" : "transparent",
            "&:hover": { bgcolor: active ? "#c91019" : "#e9ebea" },
          }}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );

  return (
    <Box sx={{ overflow: "hidden", border: "1px solid #d7d9d7", borderRadius: 1, bgcolor: "#fff" }}>
      <Stack
        direction="row"
        spacing={0.25}
        useFlexGap
        flexWrap="wrap"
        sx={{ borderBottom: "1px solid #d7d9d7", bgcolor: "#f6f7f7", p: 0.75 }}
      >
        {toolbarButton("Undo", <UndoRoundedIcon fontSize="small" />, false, () => editor?.chain().focus().undo().run(), !editor?.can().undo())}
        {toolbarButton("Redo", <RedoRoundedIcon fontSize="small" />, false, () => editor?.chain().focus().redo().run(), !editor?.can().redo())}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.4 }} />
        {toolbarButton("Bold", <FormatBoldRoundedIcon fontSize="small" />, Boolean(editor?.isActive("bold")), () => editor?.chain().focus().toggleBold().run())}
        {toolbarButton("Italic", <FormatItalicRoundedIcon fontSize="small" />, Boolean(editor?.isActive("italic")), () => editor?.chain().focus().toggleItalic().run())}
        {toolbarButton("Underline", <FormatUnderlinedRoundedIcon fontSize="small" />, Boolean(editor?.isActive("underline")), () => editor?.chain().focus().toggleUnderline().run())}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.4 }} />
        {toolbarButton("Bullet list", <FormatListBulletedRoundedIcon fontSize="small" />, Boolean(editor?.isActive("bulletList")), () => editor?.chain().focus().toggleBulletList().run())}
        {toolbarButton("Numbered list", <FormatListNumberedRoundedIcon fontSize="small" />, Boolean(editor?.isActive("orderedList")), () => editor?.chain().focus().toggleOrderedList().run())}
        {toolbarButton("Horizontal rule", <HorizontalRuleRoundedIcon fontSize="small" />, false, () => editor?.chain().focus().setHorizontalRule().run(), !editor?.can().setHorizontalRule())}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.4 }} />
        {toolbarButton("Align left", <FormatAlignLeftRoundedIcon fontSize="small" />, Boolean(editor?.isActive({ textAlign: "left" })), () => editor?.chain().focus().setTextAlign("left").run())}
        {toolbarButton("Align center", <FormatAlignCenterRoundedIcon fontSize="small" />, Boolean(editor?.isActive({ textAlign: "center" })), () => editor?.chain().focus().setTextAlign("center").run())}
        {toolbarButton("Align right", <FormatAlignRightRoundedIcon fontSize="small" />, Boolean(editor?.isActive({ textAlign: "right" })), () => editor?.chain().focus().setTextAlign("right").run())}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.4 }} />
        {toolbarButton("Clear formatting", <FormatClearRoundedIcon fontSize="small" />, false, () => editor?.chain().focus().unsetAllMarks().clearNodes().run())}
      </Stack>
      <EditorContent
        editor={editor}
        aria-label="Custom condition report note"
        className="excel-cr-rich-editor"
      />
      <Box
        component="style"
        suppressHydrationWarning
      >{`
        .excel-cr-rich-editor .tiptap { min-height: 144px; padding: 14px 16px; outline: none; color: #252825; font-size: 14px; line-height: 1.55; }
        .excel-cr-rich-editor .tiptap p { margin: 0 0 8px; }
        .excel-cr-rich-editor .tiptap h1 { font-size: 22px; line-height: 1.25; margin: 8px 0; }
        .excel-cr-rich-editor .tiptap h2 { font-size: 19px; line-height: 1.3; margin: 8px 0; }
        .excel-cr-rich-editor .tiptap h3 { font-size: 16px; line-height: 1.35; margin: 8px 0; }
        .excel-cr-rich-editor .tiptap ul, .excel-cr-rich-editor .tiptap ol { padding-left: 24px; }
        .excel-cr-rich-editor .tiptap hr { margin: 14px 0; border: 0; border-top: 1px solid #aeb2ae; }
      `}</Box>
    </Box>
  );
}

function SpecValueControl({
  spec,
  disabled,
  onChange,
}: {
  spec: ExcelCrSpec;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(spec.value || "");
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraftValue(spec.value || "");
  }, [spec.value]);

  const updateValue = (value: string) => {
    setDraftValue(value);
    onChange(value);
  };

  if (spec.type === "checkbox") {
    return (
      <FormControlLabel
        sx={{ m: 0, minHeight: 40, "& .MuiFormControlLabel-label": { fontSize: 13 } }}
        control={
          <Checkbox
            size="small"
            disabled={disabled}
            checked={isCheckedSpec(spec.value)}
            onChange={(event) => onChange(event.target.checked ? "Yes" : "No")}
          />
        }
        label={isCheckedSpec(spec.value) ? "Yes" : "No"}
      />
    );
  }

  if (Array.isArray(spec.options) && spec.options.length > 0) {
    return (
      <Autocomplete<string, false, false, true>
        freeSolo
        fullWidth
        options={spec.options}
        value={null}
        inputValue={draftValue}
        disabled={disabled}
        clearOnBlur={false}
        selectOnFocus
        handleHomeEndKeys
        onChange={(_event, value) => updateValue(String(value || ""))}
        onInputChange={(_event, value, reason) => {
          if (reason === "input" || reason === "clear") updateValue(value);
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            placeholder="Choose or type a value"
            onFocus={() => {
              focusedRef.current = true;
            }}
            onBlur={() => {
              focusedRef.current = false;
            }}
          />
        )}
        sx={{
          "& .MuiInputBase-root": { bgcolor: "#fff", fontSize: 13 },
          "& .MuiAutocomplete-input": { minWidth: "80px !important" },
        }}
      />
    );
  }

  return (
    <TextField
      fullWidth
      size="small"
      value={draftValue}
      disabled={disabled}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
      }}
      onChange={(event) => updateValue(event.target.value)}
      inputProps={spec.type === "number" ? { inputMode: "decimal" } : undefined}
      placeholder="Enter value"
      sx={{ "& .MuiInputBase-root": { bgcolor: "#fff", fontSize: 13 } }}
    />
  );
}

type VisibleSpecEntry = {
  spec: ExcelCrSpec;
  index: number;
};

function SortableSpecRow({
  entry,
  visibleIndex,
  total,
  disabled,
  onChange,
  onMove,
  onDelete,
}: {
  entry: VisibleSpecEntry;
  visibleIndex: number;
  total: number;
  disabled: boolean;
  onChange: (index: number, patch: Partial<ExcelCrSpec>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (index: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.spec.editorId,
    disabled,
  });

  return (
    <Box
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: "relative",
        zIndex: isDragging ? 2 : "auto",
      }}
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr auto", sm: "minmax(150px, 0.8fr) minmax(180px, 1.2fr) auto" },
        alignItems: "center",
        gap: 1,
        border: "1px solid",
        borderColor: isDragging ? "#df111b" : "#e2e4e2",
        bgcolor: "#fafbfa",
        p: 1,
        boxShadow: isDragging ? "0 10px 24px rgba(23,25,29,0.16)" : "none",
      }}
    >
      <TextField
        size="small"
        label="Field"
        value={entry.spec.field}
        disabled={disabled}
        required={Boolean(entry.spec.required)}
        onChange={(event) => onChange(entry.index, { field: event.target.value })}
        sx={{ gridColumn: { xs: "1", sm: "auto" }, "& .MuiInputBase-root": { bgcolor: "#fff", fontSize: 13 } }}
      />
      <Box sx={{ gridColumn: { xs: "1 / -1", sm: "auto" }, gridRow: { xs: 2, sm: "auto" } }}>
        <SpecValueControl
          spec={entry.spec}
          disabled={disabled}
          onChange={(value) => onChange(entry.index, { value })}
        />
      </Box>
      <Stack direction="row" spacing={0.25} sx={{ gridColumn: { xs: 2, sm: "auto" }, gridRow: { xs: 1, sm: "auto" } }}>
        <Tooltip title="Drag to reorder">
          <span>
            <IconButton
              size="small"
              aria-label={`Drag ${entry.spec.field} to reorder`}
              disabled={disabled}
              {...attributes}
              {...listeners}
              sx={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            >
              <DragIndicatorRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Move up"><span><IconButton size="small" aria-label={`Move ${entry.spec.field} up`} disabled={disabled || visibleIndex === 0} onClick={() => onMove(entry.index, -1)}><ArrowUpwardRoundedIcon fontSize="small" /></IconButton></span></Tooltip>
        <Tooltip title="Move down"><span><IconButton size="small" aria-label={`Move ${entry.spec.field} down`} disabled={disabled || visibleIndex === total - 1} onClick={() => onMove(entry.index, 1)}><ArrowDownwardRoundedIcon fontSize="small" /></IconButton></span></Tooltip>
        <Tooltip title="Delete specification"><span><IconButton size="small" color="error" aria-label={`Delete ${entry.spec.field}`} disabled={disabled} onClick={() => onDelete(entry.index)}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton></span></Tooltip>
      </Stack>
    </Box>
  );
}

function SortableSpecsList({
  entries,
  disabled,
  onChange,
  onMove,
  onDelete,
  onReorder,
}: {
  entries: VisibleSpecEntry[];
  disabled: boolean;
  onChange: (index: number, patch: Partial<ExcelCrSpec>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = entries.find((entry) => entry.spec.editorId === event.active.id);
    const to = entries.find((entry) => entry.spec.editorId === event.over?.id);
    if (!from || !to) return;
    onReorder(from.index, to.index);
  }, [entries, onReorder]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={entries.map((entry) => entry.spec.editorId)} strategy={verticalListSortingStrategy}>
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {entries.map((entry, visibleIndex) => (
            <SortableSpecRow
              key={entry.spec.editorId}
              entry={entry}
              visibleIndex={visibleIndex}
              total={entries.length}
              disabled={disabled}
              onChange={onChange}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </Stack>
      </SortableContext>
    </DndContext>
  );
}

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <Box>
      <Typography component="h3" sx={{ color: "#17191d", fontSize: 15, fontWeight: 750, lineHeight: 1.3 }}>
        {title}
      </Typography>
      {description ? (
        <Typography sx={{ mt: 0.25, color: "#737773", fontSize: 12.5, lineHeight: 1.45 }}>
          {description}
        </Typography>
      ) : null}
    </Box>
  );
}

export default function ExcelConditionReportEditorDialog({
  open,
  reportId,
  reportTitle,
  onClose,
  onSaved,
}: ExcelConditionReportEditorDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [payload, setPayload] = useState<ExcelCrPayload | null>(null);
  const [rows, setRows] = useState<ExcelCrRow[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState("");
  const [selectedRowKey, setSelectedRowKey] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [applyAllSource, setApplyAllSource] = useState<{
    lotNumber: string;
    disclaimers: ExcelCrDisclaimers;
  } | null>(null);
  const [previewImage, setPreviewImage] = useState<{ url: string; label: string } | null>(null);
  const deferredSearch = useDeferredValue(search);

  const dirty = Boolean(payload) && rowsSnapshot(rows) !== initialSnapshot;

  const loadEditor = useCallback(async (signal?: AbortSignal) => {
    if (!reportId) return;
    setLoading(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/reports/${reportId}/excel-condition-reports`, {
        cache: "no-store",
        signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(extractError(json, "Failed to load Excel Condition Reports"));
      const next = normalisePayload((json as { data: ExcelCrPayload }).data);
      setPayload(next);
      setRows(next.rows);
      setInitialSnapshot(rowsSnapshot(next.rows));
      setSelectedRowKey(next.rows[0]?.rowKey || "");
      if (next.rows.length === 0) {
        setFeedback({ severity: "info", message: "This report has no Excel condition report rows to edit." });
      }
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") {
        setFeedback({ severity: "error", message: error instanceof Error ? error.message : "Failed to load Excel Condition Reports" });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    if (!open || !reportId) {
      setApplyAllSource(null);
      return;
    }
    const controller = new AbortController();
    setPayload(null);
    setRows([]);
    setInitialSnapshot("");
    setSelectedRowKey("");
    setSearch("");
    setConfirmCloseOpen(false);
    setApplyAllSource(null);
    void loadEditor(controller.signal);
    return () => controller.abort();
  }, [loadEditor, open, reportId]);

  useEffect(() => {
    if (!open || !reportId || !payload?.filesBusy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminal = false;

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/admin/reports/${reportId}/excel-condition-reports`,
          { cache: "no-store" }
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok) return;
        const next = (json as { data?: ExcelCrPayload }).data;
        if (!next || next.filesBusy || stopped) return;

        terminal = true;
        setPayload((current) =>
          current
            ? {
                ...current,
                filesBusy: false,
                fileJobStatus: next.fileJobStatus,
                fileJobError: next.fileJobError,
              }
            : current
        );
        const failed = next.fileJobStatus === "error";
        const message = failed
          ? `File regeneration failed. ${next.fileJobError || "Please try again."}`
          : "Excel, CR PDF, and CR DOCX regeneration finished.";
        setFeedback({ severity: failed ? "error" : "success", message });
        await onSaved?.({ regenerated: !failed, message });
      } catch {
        // A transient polling failure should not turn a healthy worker job into
        // a UI error. The next poll will reconcile the persisted report state.
      } finally {
        if (!stopped && !terminal) timer = setTimeout(poll, 5000);
      }
    };

    timer = setTimeout(poll, 4000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [onSaved, open, payload?.filesBusy, reportId]);

  useEffect(() => {
    if (!open || !dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, open]);

  const filteredRows = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => {
      const searchable = [
        row.lotNumber,
        row.title,
        row.category,
        ...row.specs.flatMap((spec) => [spec.field, spec.value]),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [deferredSearch, rows]);

  useEffect(() => {
    if (filteredRows.length > 0 && !filteredRows.some((row) => row.rowKey === selectedRowKey)) {
      setSelectedRowKey(filteredRows[0].rowKey);
    }
  }, [filteredRows, selectedRowKey]);

  const activeRow = useMemo(
    () => rows.find((row) => row.rowKey === selectedRowKey) || null,
    [rows, selectedRowKey]
  );

  const updateRow = useCallback((rowKey: string, updater: (row: ExcelCrRow) => ExcelCrRow) => {
    setRows((current) => current.map((row) => (row.rowKey === rowKey ? updater(row) : row)));
  }, []);

  const updateActiveRow = useCallback((updater: (row: ExcelCrRow) => ExcelCrRow) => {
    if (!selectedRowKey) return;
    updateRow(selectedRowKey, updater);
  }, [selectedRowKey, updateRow]);

  const updateDisclaimers = useCallback((patch: Partial<ExcelCrDisclaimers>) => {
    if (!activeRow) return;
    const matchingLotKey = activeRow.disclaimerLotKey;
    setRows((current) => current.map((row) => (
      row.disclaimerLotKey === matchingLotKey
        ? { ...row, disclaimers: { ...row.disclaimers, ...patch } }
        : row
    )));
  }, [activeRow]);

  const disclaimerLotCount = useMemo(
    () => new Set(rows.map((row) => row.disclaimerLotKey)).size,
    [rows]
  );

  const applyActiveCrNotesToAllLots = useCallback(() => {
    if (!applyAllSource) return;
    const sourceDisclaimers: ExcelCrDisclaimers = {
      ...emptyDisclaimers,
      ...applyAllSource.disclaimers,
    };
    setRows((current) => current.map((row) => ({
      ...row,
      disclaimers: { ...sourceDisclaimers },
    })));
    setApplyAllSource(null);
    setFeedback({
      severity: "success",
      message: `CR Notes from Lot ${applyAllSource.lotNumber || "—"} were applied to ${disclaimerLotCount} lots. Save changes to keep them.`,
    });
  }, [applyAllSource, disclaimerLotCount]);

  const updateSpec = useCallback((specIndex: number, patch: Partial<ExcelCrSpec>) => {
    updateActiveRow((row) => ({
      ...row,
      specs: row.specs.map((spec, index) => (index === specIndex ? { ...spec, ...patch } : spec)),
    }));
  }, [updateActiveRow]);

  const moveSpec = useCallback((specIndex: number, direction: -1 | 1) => {
    updateActiveRow((row) => {
      const visibleIndexes = row.specs
        .map((spec, index) => (spec.deleted ? -1 : index))
        .filter((index) => index >= 0);
      const visiblePosition = visibleIndexes.indexOf(specIndex);
      const targetIndex = visibleIndexes[visiblePosition + direction];
      if (visiblePosition < 0 || targetIndex === undefined) return row;
      const next = [...row.specs];
      [next[specIndex], next[targetIndex]] = [next[targetIndex], next[specIndex]];
      return { ...row, specs: next };
    });
  }, [updateActiveRow]);

  const reorderSpec = useCallback((fromIndex: number, toIndex: number) => {
    updateActiveRow((row) => {
      const visibleIndexes = row.specs
        .map((spec, index) => (spec.deleted ? -1 : index))
        .filter((index) => index >= 0);
      const fromPosition = visibleIndexes.indexOf(fromIndex);
      const toPosition = visibleIndexes.indexOf(toIndex);
      if (fromPosition < 0 || toPosition < 0 || fromPosition === toPosition) return row;

      // Reorder only visible rows so deleted-field history retains its original slots.
      const reorderedVisibleSpecs = arrayMove(
        visibleIndexes.map((index) => row.specs[index]),
        fromPosition,
        toPosition
      );
      const next = [...row.specs];
      visibleIndexes.forEach((index, position) => {
        next[index] = reorderedVisibleSpecs[position];
      });
      return { ...row, specs: next };
    });
  }, [updateActiveRow]);

  const addSpec = useCallback(() => {
    updateActiveRow((row) => ({
      ...row,
      specs: [
        ...row.specs,
        {
          editorId: `${row.rowKey}:spec:new:${globalThis.crypto?.randomUUID?.() || Date.now()}`,
          field: "New specification",
          value: "",
          type: "text",
          required: false,
          options: [],
          custom: true,
        },
      ],
    }));
  }, [updateActiveRow]);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty) {
      setConfirmCloseOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, saving]);

  const save = useCallback(async (regenerate: boolean) => {
    if (!reportId || !payload) return;
    setSaving(true);
    setFeedback(null);
    let savedPayload = payload;
    let savedChanges = false;
    const editorBody = {
      revision: payload.revision,
      rows: rows.map((row) => ({
        rowKey: row.rowKey,
        lotNumber: row.lotNumber,
        title: row.title,
        ...excelConditionReportDescription(row),
        category: row.category,
        specs: row.specs.map((spec) => ({
          field: spec.field,
          value: spec.value,
          deleted: Boolean(spec.deleted),
        })),
        damageAnalysis: row.damageEligible ? row.damageAnalysis : "",
        disclaimers: row.disclaimers,
      })),
    };
    const acceptSavedEditor = (value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const next = normalisePayload(value as ExcelCrPayload);
      setPayload(next);
      setRows(next.rows);
      setInitialSnapshot(rowsSnapshot(next.rows));
      savedPayload = next;
      savedChanges = true;
      return true;
    };
    try {
      if (savedPayload.filesBusy) {
        throw new Error("This report is generating files. Wait until it finishes before saving more changes.");
      }

      if (!regenerate) {
        const response = await fetch(`/api/admin/reports/${reportId}/excel-condition-reports`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editorBody),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(extractError(json, "Failed to save Excel Condition Reports"));
        if (!acceptSavedEditor((json as { data?: ExcelCrPayload }).data)) {
          throw new Error("The server did not return the saved report snapshot.");
        }
        const message = "Changes saved.";
        setFeedback({ severity: "success", message });
        await onSaved?.({ regenerated: false, message });
        return;
      }

      const response = await fetch(`/api/admin/reports/${reportId}/rerun-excel-cr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editorBody),
      });
      const json = await response.json().catch(() => ({}));
      const responseData = (json as {
        data?: { editor?: ExcelCrPayload; saved?: boolean; queued?: boolean };
      }).data;
      if (responseData?.editor) acceptSavedEditor(responseData.editor);
      if (!response.ok) {
        const detail = extractError(json, "Excel, CR PDF, and CR DOCX regeneration failed");
        if (responseData?.saved || savedChanges) {
          const message = `Changes saved; file regeneration failed. ${detail}`;
          setFeedback({ severity: "warning", message });
          await onSaved?.({ regenerated: false, message: "Changes saved; file regeneration failed." });
          return;
        }
        throw new Error(detail);
      }
      if (!savedChanges) {
        throw new Error("The server queued file regeneration without confirming the saved editor snapshot.");
      }
      if (responseData?.queued || response.status === 202) {
        setPayload((current) => (current ? { ...current, filesBusy: true } : current));
        const message = "Changes saved. Excel, CR PDF, and CR DOCX regeneration is queued.";
        setFeedback({ severity: "success", message });
        await onSaved?.({ regenerated: false, message });
        return;
      }
      const message = "Changes saved and Excel, CR PDF, and CR DOCX regenerated.";
      setFeedback({ severity: "success", message });
      await onSaved?.({ regenerated: true, message });
    } catch (error) {
      setFeedback({ severity: "error", message: error instanceof Error ? error.message : "Failed to save Excel Condition Reports" });
    } finally {
      setSaving(false);
    }
  }, [onSaved, payload, reportId, rows]);

  const visibleSpecs = activeRow?.specs
    .map((spec, index) => ({ spec, index }))
    .filter(({ spec }) => !spec.deleted) || [];
  const masterDamageEnabled = Boolean(payload?.masterDamageEnabled);

  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        fullScreen={fullScreen}
        fullWidth
        maxWidth={false}
        aria-labelledby="excel-condition-report-editor-title"
        PaperProps={{
          sx: {
            width: { xs: "100%", sm: "calc(100vw - 32px)" },
            maxWidth: 1680,
            height: { xs: "100%", sm: "calc(100vh - 32px)" },
            m: { xs: 0, sm: 2 },
            borderRadius: { xs: 0, sm: 1.5 },
            overflow: "hidden",
            bgcolor: "#fff",
            color: "#17191d",
            colorScheme: "light",
            "& .MuiInputBase-root": { bgcolor: "#fff", color: "#17191d" },
            "& .MuiInputBase-input.Mui-disabled": {
              WebkitTextFillColor: "#737773",
            },
            "& .MuiInputLabel-root, & .MuiFormLabel-root": { color: "#5d615d" },
            "& .MuiFormHelperText-root": { color: "#5d615d" },
            "& .MuiFormControlLabel-label": { color: "#2b2e2b" },
            "& .MuiSelect-icon": { color: "#5d615d" },
          },
        }}
      >
        <DialogTitle
          id="excel-condition-report-editor-title"
          sx={{ flex: "0 0 auto", borderBottom: "1px solid #dedfe1", bgcolor: "#fff", px: { xs: 1.5, sm: 2.5 }, py: 1.5 }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
              <Box sx={{ display: "grid", width: 38, height: 38, flexShrink: 0, placeItems: "center", bgcolor: "#df111b", color: "#fff", borderRadius: 1 }}>
                <TableChartRoundedIcon fontSize="small" />
              </Box>
              <Box minWidth={0}>
                <Typography component="h2" sx={{ color: "#17191d", fontSize: { xs: 16, sm: 18 }, fontWeight: 750, lineHeight: 1.25 }}>
                  Edit Excel Condition Reports
                </Typography>
                <Typography noWrap sx={{ color: "#737773", fontSize: 12.5 }}>
                  {reportTitle || "Approved report"} · {payload?.reportType || "Asset report"}
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={0.5} alignItems="center">
              {dirty ? <Chip size="small" label="Unsaved changes" color="warning" variant="outlined" /> : null}
              <Tooltip title="Close editor">
                <span>
                  <IconButton aria-label="Close Excel Condition Report editor" disabled={saving} onClick={requestClose}>
                    <CloseRoundedIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
        </DialogTitle>

        <DialogContent sx={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column", overflow: "hidden", bgcolor: "#f4f5f5", p: "0 !important" }}>
          {loading ? (
            <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ flex: 1, minHeight: 260 }}>
              <CircularProgress size={34} />
              <Typography sx={{ color: "#5d615d", fontSize: 13 }}>Loading structured Excel rows…</Typography>
            </Stack>
          ) : (
            <Box
              sx={{
                display: "grid",
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "260px minmax(0, 1fr)", xl: "260px minmax(0, 1fr) 340px" },
                gridTemplateRows: { xs: "auto minmax(0, 1fr)", md: "minmax(0, 1fr)" },
                overflow: { xs: "auto", md: "hidden" },
              }}
            >
              <Box
                component="aside"
                aria-label="Excel condition report rows"
                sx={{
                  display: "flex",
                  minWidth: 0,
                  minHeight: 0,
                  maxHeight: { xs: 250, md: "none" },
                  flexDirection: "column",
                  borderRight: { md: "1px solid #dedfe1" },
                  borderBottom: { xs: "1px solid #dedfe1", md: 0 },
                  bgcolor: "#fff",
                }}
              >
                <Box sx={{ p: 1.5, borderBottom: "1px solid #eceeed" }}>
                  <TextField
                    fullWidth
                    size="small"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search lot, title or spec"
                    inputProps={{ "aria-label": "Search Excel condition report rows" }}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start"><SearchRoundedIcon sx={{ color: "#737773", fontSize: 19 }} /></InputAdornment>
                      ),
                    }}
                  />
                  <Typography sx={{ mt: 0.8, color: "#737773", fontSize: 11.5 }}>
                    {filteredRows.length} of {rows.length} Excel rows
                  </Typography>
                </Box>
                <Stack role="listbox" aria-label="Condition report rows" sx={{ minHeight: 0, overflowY: "auto", py: 0.5 }}>
                  {filteredRows.map((row, index) => {
                    const selected = row.rowKey === selectedRowKey;
                    const specCount = row.specs.filter((spec) => !spec.deleted).length;
                    return (
                      <Box
                        component="button"
                        type="button"
                        role="option"
                        aria-selected={selected}
                        key={row.rowKey}
                        onClick={() => setSelectedRowKey(row.rowKey)}
                        sx={{
                          width: "100%",
                          border: 0,
                          borderLeft: "3px solid",
                          borderColor: selected ? "#df111b" : "transparent",
                          bgcolor: selected ? "#fff3f3" : "transparent",
                          color: "inherit",
                          p: 1.25,
                          textAlign: "left",
                          cursor: "pointer",
                          "&:hover": { bgcolor: selected ? "#fff0f0" : "#f7f8f8" },
                          "&:focus-visible": { outline: "2px solid #df111b", outlineOffset: -2 },
                        }}
                      >
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <Typography sx={{ minWidth: 22, color: "#989b98", fontSize: 10.5, fontWeight: 700 }}>
                            {String(index + 1).padStart(2, "0")}
                          </Typography>
                          <Box minWidth={0}>
                            <Typography noWrap sx={{ color: "#17191d", fontSize: 13, fontWeight: 750 }}>
                              Lot {row.lotNumber || "—"}
                            </Typography>
                            <Typography noWrap sx={{ mt: 0.2, color: "#4f534f", fontSize: 12 }}>
                              {row.title || "Untitled row"}
                            </Typography>
                            <Typography noWrap sx={{ mt: 0.45, color: "#8a8e8a", fontSize: 10.5 }}>
                              {row.category || "Uncategorised"} · {specCount} specs
                            </Typography>
                          </Box>
                        </Stack>
                      </Box>
                    );
                  })}
                  {filteredRows.length === 0 ? (
                    <Stack alignItems="center" spacing={0.75} sx={{ px: 2, py: 4, color: "#8a8e8a" }}>
                      <SearchRoundedIcon />
                      <Typography sx={{ fontSize: 12.5 }}>No rows match this search.</Typography>
                    </Stack>
                  ) : null}
                </Stack>
              </Box>

              <Box
                component="main"
                sx={{ minWidth: 0, minHeight: 0, overflowY: { xs: "visible", md: "auto" }, p: { xs: 1.5, sm: 2, lg: 2.5 } }}
              >
                {feedback ? (
                  <Alert severity={feedback.severity} sx={{ mb: 2 }} onClose={() => setFeedback(null)}>
                    {feedback.message}
                  </Alert>
                ) : null}
                {payload?.filesBusy ? (
                  <Alert severity="info" icon={<RefreshRoundedIcon />} sx={{ mb: 2 }}>
                    This report is currently generating files. You can keep editing; saving becomes available when regeneration finishes.
                  </Alert>
                ) : null}
                {activeRow ? (
                  <Stack spacing={2}>
                    {disclaimerLotCount > 1 ? (
                      <Box
                        sx={{
                          border: "1px solid #f0c7c9",
                          bgcolor: "#fff7f7",
                          p: { xs: 1.5, sm: 2 },
                        }}
                      >
                        <Stack
                          direction={{ xs: "column", sm: "row" }}
                          spacing={1.25}
                          alignItems={{ xs: "stretch", sm: "center" }}
                          justifyContent="space-between"
                        >
                          <Box>
                            <Typography sx={{ color: "#17191d", fontSize: 14, fontWeight: 800 }}>
                              Apply CR Notes to all lots
                            </Typography>
                            <Typography sx={{ mt: 0.25, color: "#686c68", fontSize: 12.5, lineHeight: 1.45 }}>
                              Use Lot {activeRow.lotNumber || "—"} as the template for all {disclaimerLotCount} lots. Only CR Notes and auction controls are copied.
                            </Typography>
                          </Box>
                          <Button
                            variant="contained"
                            startIcon={<ContentCopyRoundedIcon />}
                            disabled={saving}
                            onClick={() => setApplyAllSource({
                              lotNumber: activeRow.lotNumber,
                              disclaimers: { ...emptyDisclaimers, ...activeRow.disclaimers },
                            })}
                            sx={{
                              flexShrink: 0,
                              alignSelf: { xs: "stretch", sm: "center" },
                              bgcolor: "#df111b",
                              boxShadow: "none",
                              "&:hover": { bgcolor: "#c91019", boxShadow: "none" },
                            }}
                          >
                            Apply to all lots
                          </Button>
                        </Stack>
                      </Box>
                    ) : null}

                    <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <SectionHeading title="Lot details" description="Edit the Title used in generated files, along with the lot number and category." />
                      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "140px minmax(0, 1fr)", lg: "140px minmax(0, 1.4fr) minmax(180px, 0.8fr)" }, gap: 1.25, mt: 1.5 }}>
                        <TextField
                          size="small"
                          label="Lot number"
                          value={activeRow.lotNumber}
                          disabled={saving}
                          onChange={(event) => {
                            const lotNumber = event.target.value;
                            const policyEligible = isDamagePolicyEligible(lotNumber);
                            updateActiveRow((row) => ({
                              ...row,
                              lotNumber,
                              damagePolicyEligible: policyEligible,
                              damageEligible: Boolean(masterDamageEnabled && policyEligible),
                              damageAnalysis: policyEligible && masterDamageEnabled ? row.damageAnalysis : "",
                            }));
                          }}
                        />
                        <TextField
                          size="small"
                          label="Title"
                          helperText={excelConditionReportTitleHelp(activeRow.descriptionScope)}
                          value={activeRow.title}
                          disabled={saving}
                          onChange={(event) => updateActiveRow((row) => ({ ...row, title: event.target.value }))}
                        />
                        <TextField
                          size="small"
                          label="Category"
                          value={activeRow.category}
                          disabled={saving}
                          onChange={(event) => updateActiveRow((row) => ({ ...row, category: event.target.value }))}
                        />
                      </Box>
                    </Box>

                    {activeRow.imageUrls.length > 0 ? (
                      <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                        <SectionHeading title="Lot images" description={`${activeRow.imageUrls.length} reference image${activeRow.imageUrls.length === 1 ? "" : "s"}. Images are not changed by this editor.`} />
                        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))", gap: 1, mt: 1.5 }}>
                          {activeRow.imageUrls.map((url, index) => (
                            <Box
                              component="button"
                              type="button"
                              key={`${activeRow.rowKey}-image-${index}`}
                              aria-label={`Open Lot ${activeRow.lotNumber} image ${index + 1}`}
                              onClick={() => setPreviewImage({ url, label: `Lot ${activeRow.lotNumber} · image ${index + 1}` })}
                              sx={{ overflow: "hidden", border: "1px solid #d7d9d7", borderRadius: 0.75, bgcolor: "#eef0ef", p: 0, aspectRatio: "4 / 3", cursor: "zoom-in" }}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt="" loading="lazy" decoding="async" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
                            </Box>
                          ))}
                        </Box>
                      </Box>
                    ) : null}

                    <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }} justifyContent="space-between">
                        <SectionHeading title="Specifications" description="Edit values, change the display order, or add a clear custom field." />
                        <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} disabled={saving} onClick={addSpec} sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}>
                          Add specification
                        </Button>
                      </Stack>
                      {activeRow.normalizationWarnings.length > 0 ? (
                        <Alert severity="warning" icon={<WarningAmberRoundedIcon />} sx={{ mt: 1.5 }}>
                          {activeRow.normalizationWarnings.map((warning) => `${warning.removedField} was consolidated into ${warning.keptField}`).join(" · ")}
                        </Alert>
                      ) : null}
                      {visibleSpecs.length > 0 ? (
                        <SortableSpecsList
                          entries={visibleSpecs}
                          disabled={saving}
                          onChange={updateSpec}
                          onMove={moveSpec}
                          onDelete={(index) => updateSpec(index, { deleted: true })}
                          onReorder={reorderSpec}
                        />
                      ) : (
                        <Alert severity="info" sx={{ mt: 1.5 }}>No specification rows remain. Add a specification to include one in Excel.</Alert>
                      )}
                    </Box>

                    <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <SectionHeading title="Damage Analysis" description="Damage Analysis is available only when the report switch is enabled and the numeric lot number is 1000 or below." />
                      {activeRow.damageEligible ? (
                        <TextField
                          fullWidth
                          multiline
                          minRows={4}
                          value={activeRow.damageAnalysis}
                          disabled={saving}
                          onChange={(event) => updateActiveRow((row) => ({ ...row, damageAnalysis: event.target.value }))}
                          placeholder="Describe visible damage for this lot"
                          inputProps={{ "aria-label": `Damage Analysis for Lot ${activeRow.lotNumber}` }}
                          sx={{ mt: 1.5, "& .MuiInputBase-root": { bgcolor: "#fff", fontSize: 13.5, lineHeight: 1.55 } }}
                        />
                      ) : (
                        <Alert severity="info" sx={{ mt: 1.5 }}>
                          {!masterDamageEnabled
                            ? "Damage Analysis is disabled by the report-level switch."
                            : "This lot is above 1000, so Damage Analysis is not included. Changing it back to 1000 or below starts with a blank editor."}
                        </Alert>
                      )}
                    </Box>

                    <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <SectionHeading title="Auction controls and disclaimers" description="Controls apply to all Excel rows sharing this lot number." />
                      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 1.4fr) minmax(240px, 0.8fr)" }, gap: 2, mt: 1.5 }}>
                        <Stack spacing={0.5}>
                          {disclaimerOptions.map((option) => (
                            <FormControlLabel
                              key={option.key}
                              sx={{ m: 0, minHeight: 40, border: "1px solid #e2e4e2", px: 1, bgcolor: "#fafbfa", "& .MuiFormControlLabel-label": { fontSize: 12.5, lineHeight: 1.35 } }}
                              control={<Checkbox size="small" disabled={saving} checked={Boolean(activeRow.disclaimers[option.key])} onChange={(event) => updateDisclaimers({ [option.key]: event.target.checked })} />}
                              label={option.label}
                            />
                          ))}
                        </Stack>
                        <Stack spacing={1.25}>
                          <FormControlLabel
                            sx={{ m: 0, minHeight: 40, border: "1px solid #e2e4e2", px: 1, bgcolor: "#fafbfa", "& .MuiFormControlLabel-label": { fontSize: 12.5, fontWeight: 700 } }}
                            control={<Checkbox size="small" disabled={saving} checked={Boolean(activeRow.disclaimers.unreserved)} onChange={(event) => updateDisclaimers({ unreserved: event.target.checked })} />}
                            label="Unreserved auction"
                          />
                          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
                            <TextField
                              size="small"
                              type="date"
                              label="Closing date"
                              InputLabelProps={{ shrink: true }}
                              value={activeRow.disclaimers.closingDate || ""}
                              disabled={saving}
                              onChange={(event) => updateDisclaimers({ closingDate: event.target.value || null })}
                            />
                            <TextField
                              size="small"
                              type="time"
                              label="Closing time"
                              InputLabelProps={{ shrink: true }}
                              value={timeInputValue(activeRow.disclaimers)}
                              disabled={saving}
                              onChange={(event) => updateDisclaimers(fromTimeInput(event.target.value))}
                            />
                          </Box>
                          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
                            <FormControl size="small">
                              <Select displayEmpty value={activeRow.disclaimers.bidIncrement ?? ""} disabled={saving} onChange={(event) => updateDisclaimers({ bidIncrement: event.target.value ? Number(event.target.value) as BidValue : null })} renderValue={(value) => value ? `Bid +$${Number(value).toLocaleString()}` : "Bid increment"}>
                                <MenuItem value="">Not set</MenuItem>
                                {bidOptions.map((value) => <MenuItem value={value} key={`bid-${value}`}>${value.toLocaleString()}</MenuItem>)}
                              </Select>
                            </FormControl>
                            <FormControl size="small">
                              <Select displayEmpty value={activeRow.disclaimers.openingBid ?? ""} disabled={saving} onChange={(event) => updateDisclaimers({ openingBid: event.target.value ? Number(event.target.value) as BidValue : null })} renderValue={(value) => value ? `Open $${Number(value).toLocaleString()}` : "Opening bid"}>
                                <MenuItem value="">Not set</MenuItem>
                                {bidOptions.map((value) => <MenuItem value={value} key={`open-${value}`}>${value.toLocaleString()}</MenuItem>)}
                              </Select>
                            </FormControl>
                          </Box>
                        </Stack>
                      </Box>
                    </Box>

                    <Box sx={{ border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <SectionHeading title="Custom note" description="Format the note visually. HTML tags are never shown in this editor." />
                      <Box sx={{ mt: 1.5 }}>
                        <RichNoteEditor
                          activeRowKey={activeRow.rowKey}
                          value={activeRow.disclaimers.customText}
                          disabled={saving}
                          onChange={(customText) => updateDisclaimers({ customText })}
                        />
                      </Box>
                    </Box>

                    <Box sx={{ display: { xl: "none" }, border: "1px solid #dedfe1", bgcolor: "#fff", p: { xs: 1.5, sm: 2 } }}>
                      <SectionHeading title="Lot content preview" description="Title and condition report details. Generated files use Title as Description; file layouts differ." />
                      <Box sx={{ mt: 1.5 }}><ConditionReportPreview row={activeRow} /></Box>
                    </Box>
                  </Stack>
                ) : payload ? (
                  <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 300, color: "#737773" }}>
                    <DescriptionRoundedIcon />
                    <Typography sx={{ fontSize: 13 }}>Select an Excel row to begin editing.</Typography>
                  </Stack>
                ) : null}
              </Box>

              <Box
                component="aside"
                aria-label="Lot content preview"
                sx={{ display: { xs: "none", xl: "block" }, minHeight: 0, overflowY: "auto", borderLeft: "1px solid #dedfe1", bgcolor: "#fff", p: 2 }}
              >
                <SectionHeading title="Lot content preview" description="Title and condition report details. Generated files use Title as Description; file layouts differ." />
                {activeRow ? <Box sx={{ mt: 1.5 }}><ConditionReportPreview row={activeRow} /></Box> : null}
              </Box>
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ flex: "0 0 auto", justifyContent: "space-between", gap: 1.5, borderTop: "1px solid #dedfe1", bgcolor: "#fff", px: { xs: 1.5, sm: 2.5 }, py: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ display: { xs: "none", md: "flex" } }}>
            <DescriptionRoundedIcon sx={{ color: "#737773", fontSize: 18 }} />
            <Typography sx={{ color: "#5d615d", fontSize: 12.5 }}>
              Regenerates Excel, CR PDF, and CR DOCX. Images ZIP and Asset appraisal DOCX remain unchanged.
            </Typography>
          </Stack>
          <Stack direction={{ xs: "column-reverse", sm: "row" }} spacing={1} sx={{ width: { xs: "100%", md: "auto" }, ml: "auto" }}>
            <Button variant="text" disabled={saving} onClick={requestClose} sx={{ color: "#4f534f" }}>
              Close
            </Button>
            <Button variant="outlined" startIcon={saving ? <CircularProgress size={15} /> : <SaveRoundedIcon />} disabled={saving || loading || !payload || !dirty || Boolean(payload?.filesBusy)} onClick={() => void save(false)}>
              Save changes
            </Button>
            <Button variant="contained" startIcon={saving ? <CircularProgress size={15} color="inherit" /> : <TableChartRoundedIcon />} disabled={saving || loading || !payload || Boolean(payload?.filesBusy)} onClick={() => void save(true)} sx={{ bgcolor: "#df111b", boxShadow: "none", "&:hover": { bgcolor: "#c91019", boxShadow: "none" } }}>
              Save &amp; regenerate files
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmCloseOpen} onClose={() => setConfirmCloseOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Discard unsaved changes?</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: "#5d615d", fontSize: 14, lineHeight: 1.55 }}>
            Your edits have not been saved. Closing now will leave the report files unchanged.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCloseOpen(false)}>Keep editing</Button>
          <Button color="error" variant="contained" onClick={() => { setConfirmCloseOpen(false); onClose(); }}>
            Discard changes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={open && Boolean(applyAllSource)}
        onClose={() => setApplyAllSource(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="apply-cr-notes-to-all-title"
        PaperProps={{
          sx: {
            bgcolor: "#fff",
            color: "#17191d",
            colorScheme: "light",
          },
        }}
      >
        <DialogTitle id="apply-cr-notes-to-all-title">Apply CR Notes to every lot?</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography sx={{ color: "#4f534f", fontSize: 14, lineHeight: 1.6 }}>
              CR Notes and auction controls from <strong>Lot {applyAllSource?.lotNumber || "—"}</strong> will replace the existing CR Notes on all {disclaimerLotCount} lots.
            </Typography>
            <Alert severity="info">
              Specifications, Damage Analysis, lot details, and images will not be changed.
            </Alert>
            <Typography sx={{ color: "#737773", fontSize: 12.5, lineHeight: 1.5 }}>
              The change stays in this editor until you choose Save changes or Save &amp; regenerate files.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApplyAllSource(null)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<ContentCopyRoundedIcon />}
            disabled={!applyAllSource}
            onClick={applyActiveCrNotesToAllLots}
            sx={{ bgcolor: "#df111b", boxShadow: "none", "&:hover": { bgcolor: "#c91019", boxShadow: "none" } }}
          >
            Apply to all lots
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(previewImage)} onClose={() => setPreviewImage(null)} maxWidth="lg" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Stack direction="row" spacing={1} alignItems="center"><ImageRoundedIcon /><Typography component="span" fontWeight={750}>{previewImage?.label}</Typography></Stack>
          <IconButton aria-label="Close image preview" onClick={() => setPreviewImage(null)}><CloseRoundedIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ display: "grid", minHeight: 360, placeItems: "center", bgcolor: "#111311", p: 0 }}>
          {previewImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewImage.url} alt={previewImage.label} style={{ display: "block", width: "100%", maxHeight: "78vh", objectFit: "contain" }} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConditionReportPreview({ row }: { row: ExcelCrRow }) {
  const visibleSpecs = row.specs.filter((spec) => !spec.deleted && spec.value.trim());
  const activeDisclaimers = disclaimerOptions.filter((option) => Boolean(row.disclaimers[option.key]));
  const hasAuction = row.disclaimers.unreserved || row.disclaimers.closingDate || row.disclaimers.closingTime || row.disclaimers.bidIncrement || row.disclaimers.openingBid;
  return (
    <Box sx={{ overflow: "hidden", border: "1px solid #d7d9d7", bgcolor: "#fff" }}>
      <Box sx={{ bgcolor: "#17191d", color: "#fff", px: 1.5, py: 1.25 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 800 }}>Lot {row.lotNumber || "—"}</Typography>
        <Typography sx={{ mt: 0.2, color: "rgba(255,255,255,0.72)", fontSize: 11.5 }}>{row.title || "Untitled lot"}</Typography>
      </Box>
      <Stack divider={<Divider flexItem />}>
        {visibleSpecs.length > 0 ? (
          <Box sx={{ p: 1.5 }}>
            <Typography sx={{ mb: 1, color: "#17191d", fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>Specifications</Typography>
            <Stack spacing={0.6}>
              {visibleSpecs.map((spec, index) => (
                <Box key={`${spec.field}-${index}`} sx={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 1 }}>
                  <Typography sx={{ color: "#555955", fontSize: 11.5, fontWeight: 650 }}>{spec.field}</Typography>
                  <Typography sx={{ color: "#252825", fontSize: 11.5, overflowWrap: "anywhere" }}>{spec.value}</Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        ) : null}
        {row.damageEligible && row.damageAnalysis.trim() ? (
          <Box sx={{ p: 1.5 }}>
            <Typography sx={{ mb: 0.6, color: "#17191d", fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>Damage Analysis</Typography>
            <Typography sx={{ color: "#3c403c", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{row.damageAnalysis}</Typography>
          </Box>
        ) : null}
        {(activeDisclaimers.length > 0 || hasAuction) ? (
          <Box sx={{ p: 1.5 }}>
            <Typography sx={{ mb: 0.75, color: "#17191d", fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>Auction details</Typography>
            <Stack spacing={0.45}>
              {activeDisclaimers.map((option) => <Typography key={option.key} sx={{ color: "#3c403c", fontSize: 11.5 }}>• {option.label}</Typography>)}
              {row.disclaimers.unreserved ? <Typography sx={{ color: "#3c403c", fontSize: 11.5 }}>• Unreserved auction</Typography> : null}
              {row.disclaimers.closingDate || row.disclaimers.closingTime ? <Typography sx={{ color: "#3c403c", fontSize: 11.5 }}>• Closes {row.disclaimers.closingDate || "date not set"}{row.disclaimers.closingTime ? ` at ${row.disclaimers.closingTime} ${row.disclaimers.closingTimePeriod || ""}` : ""}</Typography> : null}
              {row.disclaimers.bidIncrement ? <Typography sx={{ color: "#3c403c", fontSize: 11.5 }}>• Bid increment: {formatMoneyOption(row.disclaimers.bidIncrement)}</Typography> : null}
              {row.disclaimers.openingBid ? <Typography sx={{ color: "#3c403c", fontSize: 11.5 }}>• Opening bid: {formatMoneyOption(row.disclaimers.openingBid)}</Typography> : null}
            </Stack>
          </Box>
        ) : null}
        {row.disclaimers.customText ? (
          <Box sx={{ p: 1.5 }}>
            <Typography sx={{ mb: 0.75, color: "#17191d", fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>Custom note</Typography>
            <SafeRichPreview html={row.disclaimers.customText} />
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}
