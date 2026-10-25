"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PhotoLibraryOutlinedIcon from "@mui/icons-material/PhotoLibraryOutlined";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  type PaginationState,
  useReactTable,
} from "@tanstack/react-table";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type {
  AssetAdminScheduleBuyersPremiumBasis,
  AssetAdminScheduleCalculation,
  AssetAdminScheduleEvaluatorColumn,
  AssetAdminScheduleEvaluatorOption,
  AssetAdminScheduleFileSummary,
  AssetAdminScheduleRow,
  AssetAdminScheduleSheet,
  ReportPreviewPayload,
} from "@/app/components/reports/reportPreviewTypes";
import {
  additionalEvaluatorIds,
  canAddEvaluator,
  canRemoveEvaluator,
  cloneAssetScheduleSheet,
  deriveAssetScheduleSummary,
  formatCurrencyCell,
  formatPercentCell,
  getRowAppraiserAverage,
  makeEvaluatorColumnId,
  recalculateAssetScheduleSheet,
} from "@/app/components/reports/assetScheduleSheetUtils";

type AssetScheduleSheetProps = {
  preview: ReportPreviewPayload;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  saveWarning: string | null;
  onSave: (sheet: AssetAdminScheduleSheet) => Promise<boolean>;
  onClose?: () => void;
  pageMode?: boolean;
};

type AssetSheetTab = "scheduleA" | "fileSummary";

type SummaryRow = {
  key: string;
  label: string;
  value: React.ReactNode;
  calculation?: CalculationDetails;
  note?: string;
};

type CalculationDetails = {
  key: string;
  label: string;
  formula: string;
  inputs: Record<string, number | string | null>;
  result: number | string | null;
};

const EMPTY_CALCULATIONS = new Map<string, AssetAdminScheduleCalculation>();

function calculationDetails(
  calculations: Map<string, AssetAdminScheduleCalculation>,
  fallback: CalculationDetails
): CalculationDetails {
  const server =
    calculations.get(fallback.key) || calculations.get(fallback.key.replaceAll(".", "_"));
  if (!server) return fallback;
  return {
    key: server.key,
    label: server.label || fallback.label,
    formula: server.formula || fallback.formula,
    inputs: server.inputs || fallback.inputs,
    result: server.value,
  };
}

function readOnlyValue(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function calculationValue(value: number | string | null) {
  if (value === null || value === "") return "-";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value)
      : "-";
  }
  return value;
}

function formatLabelForCalculation(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function mobileLotNumber(row: AssetAdminScheduleRow, index: number) {
  const match = String(row.lot_id || "").match(/(\d+)$/);
  return match?.[1] || String(index + 1).padStart(3, "0");
}

function proposalValuationExportFilename(
  contentDisposition: string | null,
  reportId: string
) {
  const fallback = `proposal-valuation-${reportId}.xlsx`;
  if (!contentDisposition) return fallback;

  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = contentDisposition.match(/filename="([^"]+)"/i)?.[1];
  const unquoted = contentDisposition.match(/filename=([^;]+)/i)?.[1];
  const candidate = encoded || quoted || unquoted;
  if (!candidate) return fallback;

  try {
    return decodeURIComponent(candidate.trim()).split(/[\\/]/).pop() || fallback;
  } catch {
    return candidate.trim().split(/[\\/]/).pop() || fallback;
  }
}

function CompactReadOnlyCell({
  value,
  align = "left",
  accent = false,
}: {
  value: string | number | null | undefined;
  align?: "left" | "right";
  accent?: boolean;
}) {
  const displayValue = readOnlyValue(value);

  return (
    <Tooltip title={displayValue === "-" ? "" : displayValue} arrow enterDelay={500}>
      <Box
        sx={{
          width: "100%",
          overflow: "hidden",
          color: accent ? "primary.main" : "text.primary",
          fontSize: 13,
          fontWeight: accent ? 650 : 450,
          lineHeight: 1.45,
          textAlign: align,
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {displayValue}
      </Box>
    </Tooltip>
  );
}

function numericDraftValue(value: number | null) {
  return value === null ? "" : String(value);
}

function parseNumericDraft(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized === "-" || normalized === "." || normalized === "-.") return undefined;

  const unsigned = normalized.startsWith("-") ? normalized.slice(1) : normalized;
  const integerPart = unsigned.split(".")[0];
  if (integerPart.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(integerPart)) {
    return undefined;
  }

  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const NumericDraftField = memo(function NumericDraftField({
  value,
  onCommit,
  ariaLabel,
  suffix,
  minWidth = 112,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  ariaLabel: string;
  suffix?: string;
  minWidth?: number | string;
}) {
  const [draft, setDraft] = useState(() => numericDraftValue(value));
  const [focused, setFocused] = useState(false);
  const revertOnBlurRef = useRef(false);

  useEffect(() => {
    if (!focused) setDraft(numericDraftValue(value));
  }, [focused, value]);

  const commitDraft = useCallback(() => {
    setFocused(false);
    if (revertOnBlurRef.current) {
      revertOnBlurRef.current = false;
      setDraft(numericDraftValue(value));
      return;
    }
    const parsed = parseNumericDraft(draft);
    if (parsed === undefined) {
      setDraft(numericDraftValue(value));
      return;
    }
    setDraft(numericDraftValue(parsed));
    if (parsed !== value) onCommit(parsed);
  }, [draft, onCommit, value]);

  return (
    <TextField
      type="text"
      size="small"
      value={draft}
      onFocus={() => {
        revertOnBlurRef.current = false;
        setFocused(true);
      }}
      onChange={(event) => {
        const next = event.target.value;
        if (/^-?[\d,]*(?:\.\d*)?$/.test(next)) setDraft(next);
      }}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          revertOnBlurRef.current = true;
          setDraft(numericDraftValue(value));
          event.currentTarget.blur();
        }
      }}
      placeholder="0.00"
      autoComplete="off"
      inputProps={{
        inputMode: "decimal",
        "aria-label": ariaLabel,
        style: { textAlign: "right" },
      }}
      InputProps={{
        endAdornment: suffix ? (
          <Typography sx={{ ml: 1, color: "text.secondary", fontSize: 12 }}>
            {suffix}
          </Typography>
        ) : undefined,
      }}
      sx={{
        width: "100%",
        minWidth,
        "& .MuiOutlinedInput-root": {
          minHeight: { xs: 44, md: 36 },
          borderRadius: 1,
          bgcolor: "background.paper",
        },
        "& .MuiOutlinedInput-input": {
          px: 1.25,
          py: 1,
          fontSize: { xs: 16, md: 13 },
          fontWeight: 550,
          fontVariantNumeric: "tabular-nums",
        },
      }}
    />
  );
});

function evaluatorOptionLabel(option: AssetAdminScheduleEvaluatorOption) {
  return option.username || option.companyName || option.email;
}

const EvaluatorColumnPill = memo(function EvaluatorColumnPill({
  column,
  onRemove,
  isOwner = false,
}: {
  column: AssetAdminScheduleEvaluatorColumn;
  onRemove: () => void;
  isOwner?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        minWidth: 0,
        height: { xs: 44, md: 38 },
        alignItems: "center",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "background.paper",
      }}
    >
      {column.user_id ? (
        <Avatar
          src={column.avatar_url || undefined}
          alt=""
          sx={{ width: 24, height: 24, ml: 1, mr: 0.75, fontSize: 11 }}
        >
          {column.name.slice(0, 1).toUpperCase()}
        </Avatar>
      ) : null}
      <Box sx={{ minWidth: 0, flex: 1, pl: column.user_id ? 0 : 1.25 }}>
        <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>
          {column.name || "Legacy evaluator"}
        </Typography>
        {column.email ? (
          <Typography noWrap sx={{ color: "text.secondary", fontSize: 10.5 }}>
            {column.email}
          </Typography>
        ) : (
          <Typography noWrap sx={{ color: "text.secondary", fontSize: 10.5 }}>
            Legacy evaluator
          </Typography>
        )}
      </Box>
      {isOwner ? (
        <Typography title="Report owner is included automatically" sx={{ mx: 1, color: "text.secondary", fontSize: 10, fontWeight: 700 }}>
          Report owner
        </Typography>
      ) : column.user_id ? (
        <Tooltip title="Remove evaluator" arrow>
          <IconButton
            aria-label={`Remove ${column.name || "evaluator"}`}
            onClick={onRemove}
            sx={{ width: 36, height: 36, flex: "0 0 auto", borderRadius: 0 }}
          >
            <DeleteOutlineRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <Typography sx={{ mr: 1, color: "text.secondary", fontSize: 10, fontWeight: 700 }}>
          Read-only
        </Typography>
      )}
    </Box>
  );
});

function EvaluatorPicker({
  options,
  loading,
  disabled,
  inputValue,
  onInputChange,
  onSelect,
}: {
  options: AssetAdminScheduleEvaluatorOption[];
  loading: boolean;
  disabled: boolean;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSelect: (option: AssetAdminScheduleEvaluatorOption) => void;
}) {
  return (
    <Autocomplete
      options={options}
      value={null}
      inputValue={inputValue}
      loading={loading}
      disabled={disabled}
      getOptionLabel={evaluatorOptionLabel}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      onChange={(_, option) => {
        if (option) {
          onSelect(option);
          onInputChange("");
        }
      }}
      onInputChange={(_, value, reason) =>
        onInputChange(reason === "reset" ? "" : value)
      }
      noOptionsText="No eligible users"
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.id} sx={{ gap: 1 }}>
          <Avatar src={option.avatarUrl} alt="" sx={{ width: 28, height: 28, fontSize: 12 }}>
            {evaluatorOptionLabel(option).slice(0, 1).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: 13, fontWeight: 650 }}>
              {evaluatorOptionLabel(option)}
            </Typography>
            <Typography noWrap sx={{ color: "text.secondary", fontSize: 11 }}>
              {option.email}
            </Typography>
          </Box>
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Add evaluator"
          placeholder="Search users"
          size="small"
          inputProps={{ ...params.inputProps, "aria-label": "Add evaluator from users" }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress color="inherit" size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
          sx={{
            minWidth: { xs: 0, md: 240 },
            "& .MuiOutlinedInput-root": { minHeight: { xs: 44, md: 38 }, bgcolor: "background.paper" },
          }}
        />
      )}
    />
  );
}

const TextDraftField = memo(function TextDraftField({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  multiline = false,
  minRows = 1,
  minWidth = 0,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  minWidth?: number | string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const revertOnBlurRef = useRef(false);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);

  const commitDraft = useCallback(() => {
    setFocused(false);
    if (revertOnBlurRef.current) {
      revertOnBlurRef.current = false;
      setDraft(value);
      return;
    }

    if (draft !== value) onCommit(draft);
  }, [draft, onCommit, value]);

  return (
    <TextField
      value={draft}
      onFocus={() => {
        revertOnBlurRef.current = false;
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (!multiline && event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          revertOnBlurRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      multiline={multiline}
      minRows={multiline ? minRows : undefined}
      maxRows={multiline ? Math.max(minRows, 4) : undefined}
      placeholder={placeholder}
      size="small"
      fullWidth
      autoComplete="off"
      inputProps={{ "aria-label": ariaLabel }}
      sx={{
        minWidth,
        "& .MuiOutlinedInput-root": {
          minHeight: multiline ? undefined : { xs: 44, md: 36 },
          borderRadius: 1,
          bgcolor: "background.paper",
        },
        "& .MuiOutlinedInput-input": {
          px: 1.25,
          py: 0.9,
          fontSize: { xs: 16, md: 13 },
        },
      }}
    />
  );
});

function useStableEvaluatorColumns(columns: AssetAdminScheduleEvaluatorColumn[]) {
  const stableRef = useRef(columns);
  const current = stableRef.current;
  const unchanged =
    current.length === columns.length &&
    current.every(
      (column, index) =>
        column.id === columns[index]?.id &&
        column.name === columns[index]?.name &&
        column.user_id === columns[index]?.user_id &&
        column.email === columns[index]?.email &&
        column.avatar_url === columns[index]?.avatar_url
    );

  if (!unchanged) stableRef.current = columns.map((column) => ({ ...column }));
  return stableRef.current;
}

function LabeledValue({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component="dt"
        sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}
      >
        {label}
      </Typography>
      <Typography
        component="dd"
        sx={{
          m: 0,
          minHeight: 44,
          px: 1.25,
          py: 1.15,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "action.hover",
          color: "text.primary",
          fontSize: 14,
          lineHeight: 1.4,
          wordBreak: "break-word",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {readOnlyValue(value)}
      </Typography>
    </Box>
  );
}

function MobileSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      component="section"
      sx={{
        px: { xs: 2, sm: 2.5 },
        py: 2,
        borderTop: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography sx={{ mb: 1.5, fontSize: 15, fontWeight: 700 }}>{title}</Typography>
      {children}
    </Box>
  );
}

type UpdateRowField = <T extends keyof AssetAdminScheduleRow>(
  lotId: string,
  key: T,
  value: AssetAdminScheduleRow[T]
) => void;

const MobileLotCard = memo(function MobileLotCard({
  row,
  index,
  evaluatorColumns,
  onUpdateRow,
  onOpenGallery,
}: {
  row: AssetAdminScheduleRow;
  index: number;
  evaluatorColumns: AssetAdminScheduleEvaluatorColumn[];
  onUpdateRow: UpdateRowField;
  onOpenGallery: (title: string, urls: string[]) => void;
}) {
  const pictureCount = row.picture_urls.length || row.pictures;

  return (
    <Accordion
      defaultExpanded={index === 0}
      disableGutters
      elevation={0}
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "8px !important",
        overflow: "hidden",
        bgcolor: "background.paper",
        "&::before": { display: "none" },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreRoundedIcon />}
        sx={{
          minHeight: 68,
          px: 2,
          "& .MuiAccordionSummary-content": { my: 1.25 },
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 17, fontWeight: 700 }}>{row.asset_id || row.lot_id}</Typography>
          <Typography noWrap sx={{ color: "text.secondary", fontSize: 13 }}>
            {row.asset_category || "Uncategorized asset"}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <MobileSection title="Asset details">
          <Box
            component="dl"
            sx={{
              m: 0,
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1.25,
            }}
          >
            {([
              ["Asset Category", "asset_category"],
              ["Year", "year"],
              ["Make", "make"],
              ["Model", "model"],
              ["Serial Number", "serial_number"],
              ["Condition (1-5)", "condition_score"],
            ] as const).map(([label, key]) => (
              <Box key={key} sx={{ minWidth: 0 }}>
                <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
                  {label}
                </Typography>
                <TextDraftField
                  value={row[key]}
                  onCommit={(next) => onUpdateRow(row.lot_id, key, next)}
                  ariaLabel={`${label} for ${row.asset_id || row.lot_id}`}
                />
              </Box>
            ))}
          </Box>
          <Box sx={{ mt: 1.25 }}>
            <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
              CR Details
            </Typography>
            <TextDraftField
              value={row.cr_details}
              onCommit={(next) => onUpdateRow(row.lot_id, "cr_details", next)}
              ariaLabel={`CR details for ${row.asset_id || row.lot_id}`}
              multiline
              minRows={3}
            />
          </Box>
          <Box sx={{ mt: 1.25 }}>
            <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
              Location (City, State/Prov)
            </Typography>
            <TextDraftField
              value={row.location}
              onCommit={(next) => onUpdateRow(row.lot_id, "location", next)}
              placeholder="City, State/Prov"
              ariaLabel={`Location for ${row.asset_id || row.lot_id}`}
            />
          </Box>
          <Button
            variant="outlined"
            color="inherit"
            startIcon={<PhotoLibraryOutlinedIcon />}
            disabled={!row.picture_urls.length}
            onClick={() => onOpenGallery(`Lot ${row.asset_id}`, row.picture_urls)}
            fullWidth
            sx={{ mt: 1.25, minHeight: 44, borderRadius: 1, textTransform: "none" }}
          >
            {pictureCount
              ? `View ${pictureCount} picture${pictureCount === 1 ? "" : "s"}`
              : "No pictures"}
          </Button>
          {row.asset_insight ? (
            <Box sx={{ mt: 1.25 }}>
              <LabeledValue label="Asset Insight" value={row.asset_insight} />
            </Box>
          ) : null}
        </MobileSection>

        <MobileSection title="Evaluator values">
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1.25,
            }}
          >
            {evaluatorColumns.map((column) => (
              <Box key={column.id} sx={{ minWidth: 0 }}>
                <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
                  {column.name || "Evaluator"}
                </Typography>
                <NumericDraftField
                  value={row.evaluator_values[column.id] ?? null}
                  onCommit={(next) =>
                    onUpdateRow(row.lot_id, "evaluator_values", {
                      ...row.evaluator_values,
                      [column.id]: next,
                    })
                  }
                  ariaLabel={`${column.name || "Evaluator"} value for ${row.asset_id || row.lot_id}`}
                  minWidth={0}
                />
              </Box>
            ))}
            <LabeledValue
              label="Average"
              value={formatCurrencyCell(getRowAppraiserAverage(row, evaluatorColumns))}
            />
          </Box>
        </MobileSection>

        <MobileSection title="Estimated values">
          <Box
            component="dl"
            sx={{
              m: 0,
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1.25,
            }}
          >
            <LabeledValue label="Low Est. Sale Value ($)" value={formatCurrencyCell(row.low_est_sale_value)} />
            <LabeledValue label="High Est. Sale Value ($)" value={formatCurrencyCell(row.high_est_sale_value)} />
            <LabeledValue label="Buyer Premium %" value={`${row.buyer_premium_percent}%`} />
            <LabeledValue label="Buyer Premium ($)" value={formatCurrencyCell(row.buyer_premium_amount)} />
            <LabeledValue label="Total Expected Gross ($)" value={formatCurrencyCell(row.total_expected_gross)} />
            <LabeledValue label="Allocated Value ($)" value={formatCurrencyCell(row.allocated_value)} />
          </Box>
        </MobileSection>

        <MobileSection title="Costs & notes">
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 1.25,
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
                Lien Search
              </Typography>
              <NumericDraftField
                value={row.lien_search}
                onCommit={(next) => onUpdateRow(row.lot_id, "lien_search", next)}
                ariaLabel={`Lien search cost for ${row.asset_id || row.lot_id}`}
                minWidth={0}
              />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
                Video Cost
              </Typography>
              <NumericDraftField
                value={row.video_cost}
                onCommit={(next) => onUpdateRow(row.lot_id, "video_cost", next)}
                ariaLabel={`Video cost for ${row.asset_id || row.lot_id}`}
                minWidth={0}
              />
            </Box>
            <LabeledValue label="Cleaning" value={formatCurrencyCell(row.cleaning)} />
            <LabeledValue label="Lotting Fee" value={formatCurrencyCell(row.lotting_fee)} />
            <LabeledValue label="Advertising" value={formatCurrencyCell(row.advertising)} />
          </Box>
          <Box sx={{ mt: 1.25 }}>
            <Typography sx={{ mb: 0.5, color: "text.secondary", fontSize: 12, fontWeight: 600 }}>
              Notes
            </Typography>
            <TextDraftField
              value={row.notes}
              onCommit={(next) => onUpdateRow(row.lot_id, "notes", next)}
              placeholder="Notes"
              ariaLabel={`Notes for ${row.asset_id || row.lot_id}`}
              multiline
              minRows={3}
            />
          </Box>
        </MobileSection>
      </AccordionDetails>
    </Accordion>
  );
});

function SummaryTable({
  title,
  rows,
  onOpenCalculation,
}: {
  title: string;
  rows: SummaryRow[];
  onOpenCalculation: (details: CalculationDetails) => void;
}) {
  return (
    <Paper
      variant="outlined"
      sx={{ minWidth: 0, overflow: "hidden", borderRadius: 1, bgcolor: "background.paper" }}
    >
      <Box
        sx={{
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "action.hover",
        }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{title}</Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell sx={{ width: "52%", px: 1.25, py: 0.8, fontSize: 12.5, fontWeight: 600, borderColor: "divider" }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Box component="span" sx={{ minWidth: 0 }}>{row.label}</Box>
                    {row.note ? (
                      <Tooltip title={row.note} arrow>
                        <Box
                          component="span"
                          sx={{
                            flex: "0 0 auto",
                            border: "1px solid",
                            borderColor: "divider",
                            borderRadius: 0.75,
                            bgcolor: "action.hover",
                            px: 0.65,
                            py: 0.2,
                            color: "text.secondary",
                            fontSize: 9,
                            fontWeight: 750,
                            lineHeight: 1.2,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                          }}
                        >
                          Reference only
                        </Box>
                      </Tooltip>
                    ) : null}
                    {row.calculation ? (
                      <Tooltip title={`Show calculation for ${row.label}`} arrow>
                        <IconButton
                          size="small"
                          aria-label={`Show calculation for ${row.label}`}
                          onClick={() => onOpenCalculation(row.calculation!)}
                          sx={{ width: 28, height: 28, ml: "auto !important", flex: "0 0 auto" }}
                        >
                          <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                  </Stack>
                </TableCell>
                <TableCell sx={{ px: 1.25, py: 0.8, fontSize: 12.5, borderColor: "divider", fontVariantNumeric: "tabular-nums" }}>
                  {row.value}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

function SummaryInput({
  value,
  onChange,
  ariaLabel,
  suffix,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  ariaLabel: string;
  suffix?: string;
}) {
  return (
    <NumericDraftField
      value={value}
      onCommit={onChange}
      ariaLabel={ariaLabel}
      suffix={suffix}
      minWidth={0}
    />
  );
}

export default function AssetScheduleSheet({
  preview,
  saving,
  saveError,
  saveSuccess,
  saveWarning,
  onSave,
  onClose,
  pageMode = false,
}: AssetScheduleSheetProps) {
  const theme = useTheme();
  const isCompactLayout = useMediaQuery(theme.breakpoints.down("lg"), { noSsr: true });
  const isPhoneLayout = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  const [sheet, setSheet] = useState<AssetAdminScheduleSheet | null>(
    preview.assetScheduleSheet ? cloneAssetScheduleSheet(preview.assetScheduleSheet) : null
  );
  const [gallery, setGallery] = useState<{ title: string; urls: string[]; index: number } | null>(null);
  const [activeTab, setActiveTab] = useState<AssetSheetTab>("scheduleA");
  const [selectedMobileLot, setSelectedMobileLot] = useState(0);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [evaluatorOptions, setEvaluatorOptions] = useState<AssetAdminScheduleEvaluatorOption[]>([]);
  const [evaluatorOptionsLoading, setEvaluatorOptionsLoading] = useState(false);
  const [evaluatorOptionsError, setEvaluatorOptionsError] = useState<string | null>(null);
  const [evaluatorQuery, setEvaluatorQuery] = useState("");
  const [debouncedEvaluatorQuery, setDebouncedEvaluatorQuery] = useState("");
  const [calculationDialog, setCalculationDialog] = useState<CalculationDetails | null>(null);
  const [sheetDirty, setSheetDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const sheetRef = useRef(sheet);
  const reportIdRef = useRef(preview.reportId);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const reportChanged = reportIdRef.current !== preview.reportId;
    if (reportChanged || !dirtyRef.current) {
      const nextSheet = preview.assetScheduleSheet
        ? cloneAssetScheduleSheet(preview.assetScheduleSheet)
        : null;
      sheetRef.current = nextSheet;
      setSheet(nextSheet);
    }
    if (reportChanged) {
      reportIdRef.current = preview.reportId;
      dirtyRef.current = false;
      setSheetDirty(false);
      setActiveTab("scheduleA");
      setSelectedMobileLot(0);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
      setEvaluatorQuery("");
      setDebouncedEvaluatorQuery("");
      setExportError(null);
    }
  }, [preview.assetScheduleSheet, preview.reportId]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedEvaluatorQuery(evaluatorQuery.trim()),
      300
    );
    return () => window.clearTimeout(timeout);
  }, [evaluatorQuery]);

  useEffect(() => {
    if (!preview.reportId) return;
    const controller = new AbortController();
    setEvaluatorOptionsLoading(true);
    setEvaluatorOptionsError(null);

    const query = new URLSearchParams();
    if (debouncedEvaluatorQuery) query.set("q", debouncedEvaluatorQuery);
    const suffix = query.size ? `?${query.toString()}` : "";

    void fetch(
      `/api/admin/reports/${encodeURIComponent(preview.reportId)}/proposal-valuation/evaluator-options${suffix}`,
      { cache: "no-store", signal: controller.signal }
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "Unable to load evaluator users");
        const items = Array.isArray(body?.items) ? body.items : [];
        setEvaluatorOptions(
          items
            .map((item: Record<string, unknown>) => ({
              id: String(item.id || ""),
              username: item.username ? String(item.username) : undefined,
              companyName: item.companyName ? String(item.companyName) : undefined,
              email: String(item.email || ""),
              avatarUrl: item.avatarUrl ? String(item.avatarUrl) : undefined,
            }))
            .filter((item: AssetAdminScheduleEvaluatorOption) => item.id && item.email)
        );
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setEvaluatorOptionsError(
          cause instanceof Error ? cause.message : "Unable to load evaluator users"
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setEvaluatorOptionsLoading(false);
      });

    return () => controller.abort();
  }, [debouncedEvaluatorQuery, preview.reportId]);

  const derivedSummary = useMemo(() => (sheet ? deriveAssetScheduleSummary(sheet) : null), [sheet]);
  const previewCalculations = useMemo(
    () => new Map((preview.calculations ?? []).map((calculation) => [calculation.key, calculation])),
    [preview.calculations]
  );
  // Preview descriptors describe the last persisted revision. While the sheet is
  // dirty, use the matching local descriptors so the dialog cannot show stale
  // inputs, formulas, or results beside newly recalculated visible values.
  const serverCalculations = sheetDirty ? EMPTY_CALCULATIONS : previewCalculations;
  const stableEvaluatorColumns = useStableEvaluatorColumns(sheet?.evaluator_columns ?? []);
  const allLotTotals = useMemo<Record<string, { label: string; value: number }>>(() => {
    if (!derivedSummary) return {};
    return {
      ...Object.fromEntries(stableEvaluatorColumns.map((column) => [
        `eval_${column.id}`,
        { label: column.name || "Evaluator", value: derivedSummary.evaluator_totals[column.id] ?? 0 },
      ])),
      evaluator_average: { label: "Average", value: derivedSummary.total_asset_value },
      low_est_sale_value: { label: "Low", value: derivedSummary.total_low_est_value },
      high_est_sale_value: { label: "High", value: derivedSummary.total_high_est_value },
      buyer_premium_amount: { label: "B.P. amount ($)", value: derivedSummary.total_capped_bp },
      total_expected_gross: { label: "Total Expected Gross ($)", value: derivedSummary.total_expected_gross },
      allocated_value: { label: "Allocated Value ($)", value: derivedSummary.total_allocated_value },
      cleaning: { label: "Cleaning", value: derivedSummary.total_cleaning },
      lien_search: { label: "Lien Search", value: derivedSummary.total_lien_search },
      video_cost: { label: "Video Cost", value: derivedSummary.total_video_cost },
      lotting_fee: { label: "Lotting Fee", value: derivedSummary.total_lotting_fee },
      advertising: { label: "Advertising", value: derivedSummary.total_advertising },
    };
  }, [derivedSummary, stableEvaluatorColumns]);

  const updateSheet = useCallback((mutator: (draft: AssetAdminScheduleSheet) => AssetAdminScheduleSheet) => {
    const current = sheetRef.current;
    if (!current) return;

    dirtyRef.current = true;
    setSheetDirty(true);
    // Keep the ref current synchronously so a Save click immediately following
    // an input blur always includes that field's last edit.
    const nextSheet = recalculateAssetScheduleSheet(mutator(cloneAssetScheduleSheet(current)));
    sheetRef.current = nextSheet;
    setSheet(nextSheet);
  }, []);

  const addEvaluator = useCallback((option: AssetAdminScheduleEvaluatorOption) => {
    updateSheet((draft) => {
      if (!canAddEvaluator(draft, option.id, preview.ownerColumnId)) {
        return draft;
      }
      const nextColumn: AssetAdminScheduleEvaluatorColumn = {
        id: makeEvaluatorColumnId(),
        name: evaluatorOptionLabel(option),
        user_id: option.id,
        email: option.email,
        ...(option.avatarUrl ? { avatar_url: option.avatarUrl } : {}),
      };
      return {
        ...draft,
        evaluator_columns: [...draft.evaluator_columns, nextColumn],
        rows: draft.rows.map((row) => ({
          ...row,
          evaluator_values: { ...row.evaluator_values, [nextColumn.id]: null },
        })),
      };
    });
  }, [preview.ownerColumnId, updateSheet]);

  const removeEvaluator = useCallback((columnId: string) => {
    updateSheet((draft) => {
      const targetColumn = draft.evaluator_columns.find((column) => column.id === columnId);
      if (!targetColumn || !canRemoveEvaluator(targetColumn, preview.ownerColumnId)) return draft;
      return {
        ...draft,
        evaluator_columns: draft.evaluator_columns.filter((column) => column.id !== columnId),
        rows: draft.rows.map((row) => {
          const nextValues = { ...row.evaluator_values };
          delete nextValues[columnId];
          return { ...row, evaluator_values: nextValues };
        }),
      };
    });
  }, [preview.ownerColumnId, updateSheet]);

  const updateRowField = useCallback(<T extends keyof AssetAdminScheduleRow>(
    lotId: string,
    key: T,
    value: AssetAdminScheduleRow[T]
  ) => {
    updateSheet((draft) => ({
      ...draft,
      rows: draft.rows.map((row) => (row.lot_id === lotId ? { ...row, [key]: value } : row)),
    }));
  }, [updateSheet]);

  const updateFileSummaryField = useCallback(<T extends keyof AssetAdminScheduleFileSummary>(
    key: T,
    value: AssetAdminScheduleFileSummary[T]
  ) => {
    updateSheet((draft) => ({
      ...draft,
      file_summary: {
        ...draft.file_summary,
        [key]: value,
      },
    }));
  }, [updateSheet]);

  const linkedEvaluatorIds = useMemo(
    () => new Set((sheet?.evaluator_columns ?? []).map((column) => column.user_id).filter(Boolean)),
    [sheet?.evaluator_columns]
  );
  const availableEvaluatorOptions = useMemo(
    () => evaluatorOptions.filter((option) => !linkedEvaluatorIds.has(option.id)),
    [evaluatorOptions, linkedEvaluatorIds]
  );
  const linkedEvaluatorLimitReached = sheet ? additionalEvaluatorIds(sheet, preview.ownerColumnId).size >= 4 : false;

  async function handleSave() {
    const current = sheetRef.current;
    if (!current) return;
    const payload = recalculateAssetScheduleSheet(current);
    const saved = await onSave(payload);
    if (!saved) return;
    dirtyRef.current = false;
    setSheetDirty(false);
    sheetRef.current = payload;
    setSheet(payload);
  }

  const exportProposalValuation = useCallback(async () => {
    if (saving || exporting || dirtyRef.current) return;
    const reportId = preview.reportId;
    if (!reportId) {
      setExportError("This Proposal Valuation does not have a report identifier.");
      return;
    }
    setExporting(true);
    setExportError(null);

    try {
      const response = await fetch(
        `/api/admin/reports/${encodeURIComponent(reportId)}/proposal-valuation/export`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          (payload as { message?: string }).message ||
            "Unable to export the Proposal Valuation workbook."
        );
      }

      const workbook = await response.blob();
      if (!workbook.size) {
        throw new Error("The Proposal Valuation workbook was empty.");
      }
      const objectUrl = URL.createObjectURL(workbook);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = proposalValuationExportFilename(
        response.headers.get("content-disposition"),
        reportId
      );
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (cause) {
      setExportError(
        cause instanceof Error
          ? cause.message
          : "Unable to export the Proposal Valuation workbook."
      );
    } finally {
      setExporting(false);
    }
  }, [exporting, preview.reportId, saving]);

  const openGallery = useCallback((title: string, urls: string[]) => {
    if (!urls.length) return;
    setGallery({ title, urls, index: 0 });
  }, []);

  const closeGallery = useCallback(() => {
    setGallery(null);
  }, []);

  const showPreviousImage = useCallback(() => {
    setGallery((current) => {
      if (!current || current.urls.length <= 1) return current;
      return {
        ...current,
        index: current.index === 0 ? current.urls.length - 1 : current.index - 1,
      };
    });
  }, []);

  const showNextImage = useCallback(() => {
    setGallery((current) => {
      if (!current || current.urls.length <= 1) return current;
      return {
        ...current,
        index: current.index === current.urls.length - 1 ? 0 : current.index + 1,
      };
    });
  }, []);

  const scheduleColumns = useMemo<ColumnDef<AssetAdminScheduleRow>[]>(() => {
    const staticColumns: ColumnDef<AssetAdminScheduleRow>[] = [
      { id: "asset_id", accessorKey: "asset_id", header: "Asset ID", size: 120, minSize: 120, maxSize: 120, cell: ({ row }) => <CompactReadOnlyCell value={row.original.asset_id} /> },
      {
        id: "asset_category",
        accessorKey: "asset_category",
        header: "Asset Category",
        size: 184,
        minSize: 184,
        maxSize: 184,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.asset_category}
            onCommit={(next) => updateRowField(row.original.lot_id, "asset_category", next)}
            ariaLabel={`Asset category for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "year",
        accessorKey: "year",
        header: "Year",
        size: 104,
        minSize: 104,
        maxSize: 104,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.year}
            onCommit={(next) => updateRowField(row.original.lot_id, "year", next)}
            ariaLabel={`Year for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "make",
        accessorKey: "make",
        header: "Make",
        size: 136,
        minSize: 136,
        maxSize: 136,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.make}
            onCommit={(next) => updateRowField(row.original.lot_id, "make", next)}
            ariaLabel={`Make for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Model",
        size: 152,
        minSize: 152,
        maxSize: 152,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.model}
            onCommit={(next) => updateRowField(row.original.lot_id, "model", next)}
            ariaLabel={`Model for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "serial_number",
        accessorKey: "serial_number",
        header: "Serial Number",
        size: 184,
        minSize: 184,
        maxSize: 184,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.serial_number}
            onCommit={(next) => updateRowField(row.original.lot_id, "serial_number", next)}
            ariaLabel={`Serial number for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "cr_details",
        accessorKey: "cr_details",
        header: "CR Details",
        size: 280,
        minSize: 280,
        maxSize: 280,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.cr_details}
            onCommit={(next) => updateRowField(row.original.lot_id, "cr_details", next)}
            ariaLabel={`CR details for ${row.original.asset_id || row.original.lot_id}`}
            multiline
            minRows={2}
          />
        ),
      },
      {
        id: "condition_score",
        accessorKey: "condition_score",
        header: "Condition (1-5)",
        size: 144,
        minSize: 144,
        maxSize: 144,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.condition_score}
            onCommit={(next) => updateRowField(row.original.lot_id, "condition_score", next)}
            ariaLabel={`Condition for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "location",
        accessorKey: "location",
        header: "Location (City, State/Prov)",
        size: 220,
        minSize: 220,
        maxSize: 220,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.location}
            onCommit={(next) => updateRowField(row.original.lot_id, "location", next)}
            placeholder="City, State/Prov"
            ariaLabel={`Location for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "pictures",
        accessorKey: "pictures",
        header: "Pictures",
        size: 120,
        minSize: 120,
        maxSize: 120,
        cell: ({ row }) => {
          const pictureCount = row.original.picture_urls.length || row.original.pictures;
          if (!pictureCount) {
            return <CompactReadOnlyCell value={null} />;
          }

          const pictureLabel = `${pictureCount} picture${pictureCount === 1 ? "" : "s"}`;

          return (
            <Button
              variant="text"
              color="primary"
              onClick={() => openGallery(`Lot ${row.original.asset_id}`, row.original.picture_urls)}
              disabled={row.original.picture_urls.length === 0}
              sx={{
                minWidth: 0,
                minHeight: 36,
                px: 0.5,
                py: 0.5,
                borderRadius: 1,
                textTransform: "none",
                fontSize: 13,
                fontWeight: 500,
                justifyContent: "flex-start",
              }}
            >
              {pictureLabel}
            </Button>
          );
        },
      },
      { id: "asset_insight", accessorKey: "asset_insight", header: "Asset Insight", size: 176, minSize: 176, maxSize: 176, cell: ({ row }) => <CompactReadOnlyCell value={row.original.asset_insight} accent /> },
    ];

    const evaluatorColumns: ColumnDef<AssetAdminScheduleRow>[] = stableEvaluatorColumns.map((column) => ({
      id: `eval_${column.id}`,
      header: column.name || "Evaluator",
      size: 152,
      minSize: 152,
      maxSize: 152,
      cell: ({ row }) => (
        <NumericDraftField
          value={row.original.evaluator_values[column.id] ?? null}
          onCommit={(next) =>
            updateRowField(row.original.lot_id, "evaluator_values", {
              ...row.original.evaluator_values,
              [column.id]: next,
            })
          }
          ariaLabel={`${column.name || "Evaluator"} value for ${row.original.asset_id || row.original.lot_id}`}
        />
      ),
    }));

    const evaluatorAverageColumn: ColumnDef<AssetAdminScheduleRow> = {
      id: "evaluator_average",
      header: "Average",
      size: 144,
      minSize: 144,
      maxSize: 144,
      cell: ({ row }) => (
        <CompactReadOnlyCell
          value={formatCurrencyCell(getRowAppraiserAverage(row.original, stableEvaluatorColumns))}
          align="right"
        />
      ),
    };

    const resultColumns: ColumnDef<AssetAdminScheduleRow>[] = [
      { id: "low_est_sale_value", accessorKey: "low_est_sale_value", header: "Low Est. Sale Value ($)", size: 160, minSize: 160, maxSize: 160, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.low_est_sale_value)} align="right" /> },
      { id: "high_est_sale_value", accessorKey: "high_est_sale_value", header: "High Est. Sale Value ($)", size: 160, minSize: 160, maxSize: 160, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.high_est_sale_value)} align="right" /> },
      { id: "buyer_premium_percent", accessorKey: "buyer_premium_percent", header: "Buyer Premium %", size: 128, minSize: 128, maxSize: 128, cell: ({ row }) => <CompactReadOnlyCell value={`${row.original.buyer_premium_percent}%`} align="right" /> },
      { id: "buyer_premium_amount", accessorKey: "buyer_premium_amount", header: "Buyer Premium ($)", size: 152, minSize: 152, maxSize: 152, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.buyer_premium_amount)} align="right" /> },
      { id: "total_expected_gross", accessorKey: "total_expected_gross", header: "Total Expected Gross ($)", size: 176, minSize: 176, maxSize: 176, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.total_expected_gross)} align="right" /> },
      { id: "allocated_value", accessorKey: "allocated_value", header: "Allocated Value ($)", size: 152, minSize: 152, maxSize: 152, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.allocated_value)} align="right" /> },
      {
        id: "notes",
        accessorKey: "notes",
        header: "Notes",
        size: 220,
        minSize: 220,
        maxSize: 220,
        cell: ({ row }) => (
          <TextDraftField
            value={row.original.notes}
            onCommit={(next) => updateRowField(row.original.lot_id, "notes", next)}
            placeholder="Notes"
            ariaLabel={`Notes for ${row.original.asset_id || row.original.lot_id}`}
            multiline
            minRows={2}
          />
        ),
      },
      { id: "cleaning", accessorKey: "cleaning", header: "Cleaning", size: 120, minSize: 120, maxSize: 120, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.cleaning)} align="right" /> },
      {
        id: "lien_search",
        accessorKey: "lien_search",
        header: "Lien Search",
        size: 136,
        minSize: 136,
        maxSize: 136,
        cell: ({ row }) => (
          <NumericDraftField
            value={row.original.lien_search ?? null}
            onCommit={(next) => updateRowField(row.original.lot_id, "lien_search", next)}
            ariaLabel={`Lien search cost for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      {
        id: "video_cost",
        accessorKey: "video_cost",
        header: "Video Cost",
        size: 136,
        minSize: 136,
        maxSize: 136,
        cell: ({ row }) => (
          <NumericDraftField
            value={row.original.video_cost ?? null}
            onCommit={(next) => updateRowField(row.original.lot_id, "video_cost", next)}
            ariaLabel={`Video cost for ${row.original.asset_id || row.original.lot_id}`}
          />
        ),
      },
      { id: "lotting_fee", accessorKey: "lotting_fee", header: "Lotting Fee", size: 132, minSize: 132, maxSize: 132, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.lotting_fee)} align="right" /> },
      { id: "advertising", accessorKey: "advertising", header: "Advertising", size: 132, minSize: 132, maxSize: 132, cell: ({ row }) => <CompactReadOnlyCell value={formatCurrencyCell(row.original.advertising)} align="right" /> },
    ];

    return [
      {
        id: "identity",
        header: "Identity",
        columns: staticColumns.slice(0, 2),
      },
      {
        id: "asset_details",
        header: "Asset details",
        columns: staticColumns.slice(2),
      },
      {
        id: "evaluator_values",
        header: "Evaluator values",
        columns: [...evaluatorColumns, evaluatorAverageColumn],
      },
      {
        id: "estimated_values",
        header: "Estimated sale values",
        columns: resultColumns.slice(0, 2),
      },
      {
        id: "buyer_premium",
        header: "Buyer premium",
        columns: resultColumns.slice(2, 4),
      },
      {
        id: "totals",
        header: "Totals",
        columns: resultColumns.slice(4, 6),
      },
      {
        id: "costs_notes",
        header: "Costs & notes",
        columns: resultColumns.slice(6),
      },
    ];
  }, [openGallery, stableEvaluatorColumns, updateRowField]);

  const scheduleTable = useReactTable({
    data: sheet?.rows ?? [],
    columns: scheduleColumns,
    state: { pagination },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
  });
  const scheduleTableWidth = scheduleTable
    .getAllLeafColumns()
    .reduce((total, column) => total + column.getSize(), 0);
  const paginationStart = pagination.pageIndex * pagination.pageSize;
  const paginatedMobileRows = (sheet?.rows ?? [])
    .slice(paginationStart, paginationStart + pagination.pageSize)
    .map((row, pageIndex) => ({ row, index: paginationStart + pageIndex }));

  useEffect(() => {
    const rowCount = sheet?.rows.length ?? 0;
    const lastPage = Math.max(0, Math.ceil(rowCount / pagination.pageSize) - 1);
    if (pagination.pageIndex > lastPage) {
      setPagination((current) => ({ ...current, pageIndex: lastPage }));
      return;
    }
    const start = pagination.pageIndex * pagination.pageSize;
    const end = Math.min(rowCount, start + pagination.pageSize);
    if (rowCount > 0 && (selectedMobileLot < start || selectedMobileLot >= end)) {
      setSelectedMobileLot(start);
    }
  }, [pagination.pageIndex, pagination.pageSize, selectedMobileLot, sheet?.rows.length]);

  const metricRows = useMemo<SummaryRow[]>(() => {
    if (!sheet || !derivedSummary) return [];

    const calculated = (
      key: string,
      label: string,
      result: number | string | null,
      display: React.ReactNode,
      formula: string,
      inputs: Record<string, number | string | null>
    ): SummaryRow => ({
      key,
      label,
      value: display,
      calculation: calculationDetails(serverCalculations, {
        key,
        label,
        formula,
        inputs,
        result,
      }),
    });

    return [
      {
        key: "buyers_premium_basis",
        label: "Buyers Premium Basis",
        value: (
          <FormControl size="small" fullWidth>
            <Select
              value={sheet.file_summary.buyers_premium_basis}
              onChange={(event) =>
                updateFileSummaryField(
                  "buyers_premium_basis",
                  event.target.value as AssetAdminScheduleBuyersPremiumBasis
                )
              }
              sx={{ borderRadius: 0, fontSize: 13 }}
            >
              <MenuItem value="uncapped">Uncapped</MenuItem>
              <MenuItem value="capped">Capped</MenuItem>
            </Select>
          </FormControl>
        ),
      },
      calculated(
        "total_asset_value",
        "Total Asset Value ($)",
        derivedSummary.total_asset_value,
        formatCurrencyCell(derivedSummary.total_asset_value) || "-",
        "Sum of each asset's evaluator average",
        { asset_count: sheet.rows.length }
      ),
      calculated(
        "estimated_range",
        "Estimated Range",
        `${formatCurrencyCell(derivedSummary.total_low_est_value) || "-"} – ${formatCurrencyCell(derivedSummary.total_high_est_value) || "-"}`,
        `${formatCurrencyCell(derivedSummary.total_low_est_value) || "-"} – ${formatCurrencyCell(derivedSummary.total_high_est_value) || "-"}`,
        "Sum of low estimates through sum of high estimates",
        {
          total_low_est_value: derivedSummary.total_low_est_value,
          total_high_est_value: derivedSummary.total_high_est_value,
        }
      ),
      {
        key: "total_risk_weighted_value",
        label: "Total Risk-Weighted Value ($)",
        note: "Reference only; not used in calculated totals.",
        value: (
          <SummaryInput
            value={sheet.file_summary.total_risk_weighted_value}
            onChange={(next) => updateFileSummaryField("total_risk_weighted_value", next)}
            ariaLabel="Total risk-weighted value"
          />
        ),
      },
      {
        key: "file_risk_multiplier",
        label: "File Risk Multiplier",
        note: "Reference only; not used in calculated totals.",
        value: (
          <SummaryInput
            value={sheet.file_summary.file_risk_multiplier}
            onChange={(next) => updateFileSummaryField("file_risk_multiplier", next)}
            ariaLabel="File risk multiplier"
          />
        ),
      },
      calculated("low_risk_percent", "% Low Risk Value", derivedSummary.low_risk_percent, formatPercentCell(derivedSummary.low_risk_percent) || "-", "Low-risk asset value / total asset value", { low_risk_value: derivedSummary.low_risk_value, total_asset_value: derivedSummary.total_asset_value }),
      calculated("medium_risk_percent", "% Medium Risk Value", derivedSummary.medium_risk_percent, formatPercentCell(derivedSummary.medium_risk_percent) || "-", "Medium-risk asset value / total asset value", { medium_risk_value: derivedSummary.medium_risk_value, total_asset_value: derivedSummary.total_asset_value }),
      calculated("high_risk_percent", "% High Risk Value", derivedSummary.high_risk_percent, formatPercentCell(derivedSummary.high_risk_percent) || "-", "High-risk asset value / total asset value", { high_risk_value: derivedSummary.high_risk_value, total_asset_value: derivedSummary.total_asset_value }),
      calculated("weighted_average_risk_score", "Weighted Average Risk Score", derivedSummary.weighted_average_risk_score, new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(derivedSummary.weighted_average_risk_score), "Sum of each asset average multiplied by its market-check risk score, divided by total asset value", { total_asset_value: derivedSummary.total_asset_value }),
      calculated("overall_file_risk_rating", "Overall File Risk Rating", derivedSummary.overall_file_risk_rating, derivedSummary.overall_file_risk_rating, "Risk bucket for the asset-value-weighted average market-check score", { weighted_average_risk_score: derivedSummary.weighted_average_risk_score }),
      calculated("selected_nmg", "NMG", derivedSummary.selected_nmg, formatCurrencyCell(derivedSummary.selected_nmg) || "-", "Selected basis: capped NMG when capped; otherwise uncapped Offer #2 NMG", { buyers_premium_basis: sheet.file_summary.buyers_premium_basis, capped_nmg: derivedSummary.capped.nmg, uncapped_offer2_nmg: derivedSummary.uncapped.offer2_nmg }),
      calculated("selected_cash_purchase_price", "Cash Purchase Price", derivedSummary.selected_cash_purchase_price, formatCurrencyCell(derivedSummary.selected_cash_purchase_price) || "-", "Selected basis: capped average when capped; otherwise uncapped Offer #1 cash offer", { buyers_premium_basis: sheet.file_summary.buyers_premium_basis, capped_average: derivedSummary.capped.avg, uncapped_offer1_cash_offer: derivedSummary.uncapped.offer1_cash_offer }),
      calculated("selected_commission_basis_value", "Commission Basis Value", derivedSummary.selected_commission_basis_value, formatCurrencyCell(derivedSummary.selected_commission_basis_value) || "-", "Selected basis: capped buyer premium when capped; otherwise uncapped 15% buyer premium", { buyers_premium_basis: sheet.file_summary.buyers_premium_basis, capped_buyer_premium: derivedSummary.total_capped_bp, uncapped_bp_15: derivedSummary.uncapped.bp_15 }),
      calculated("total_projected_costs", "Total Projected Costs", derivedSummary.total_projected_costs, formatCurrencyCell(derivedSummary.total_projected_costs) || "-", "Cleaning + lien search + video + lotting + advertising across all assets", { asset_count: sheet.rows.length }),
      {
        key: "commission_percent_no_guarantee",
        label: "Commission % No Guarantee",
        note: "Reference only; not used in calculated totals.",
        value: (
          <SummaryInput
            value={sheet.file_summary.commission_percent_no_guarantee}
            onChange={(next) => updateFileSummaryField("commission_percent_no_guarantee", next)}
            ariaLabel="Commission percent with no guarantee"
            suffix="%"
          />
        ),
      },
      {
        key: "offer2_nmg_percent",
        label: "Offer #2 NMG / Overage %",
        value: (
          <SummaryInput
            value={sheet.file_summary.offer2_nmg_percent * 100}
            onChange={(next) =>
              updateFileSummaryField(
                "offer2_nmg_percent",
                Math.max(0, Math.min(100, next ?? 78.5)) / 100
              )
            }
            ariaLabel="Offer 2 NMG percent"
            suffix="%"
          />
        ),
      },
      {
        key: "capped_threshold_percent",
        label: "Capped Threshold %",
        value: (
          <SummaryInput
            value={sheet.file_summary.capped_threshold_percent * 100}
            onChange={(next) =>
              updateFileSummaryField(
                "capped_threshold_percent",
                Math.max(0, Math.min(100, next ?? 10)) / 100
              )
            }
            ariaLabel="Capped threshold percent"
            suffix="%"
          />
        ),
      },
    ];
  }, [derivedSummary, serverCalculations, sheet, updateFileSummaryField]);

  const uncappedRows = useMemo<SummaryRow[]>(() => {
    if (!sheet || !derivedSummary) return [];
    const offer2PercentLabel = new Intl.NumberFormat("en-CA", {
      maximumFractionDigits: 2,
    }).format(sheet.file_summary.offer2_nmg_percent * 100);
    const calculated = (
      key: string,
      label: string,
      result: number | null,
      formula: string,
      inputs: Record<string, number | string | null>,
      percent = false
    ): SummaryRow => ({
      key: `uncapped.${key}`,
      label,
      value: percent ? formatPercentCell(result) || "-" : formatCurrencyCell(result) || "-",
      calculation: calculationDetails(serverCalculations, {
        key: `uncapped.${key}`,
        label,
        formula,
        inputs,
        result,
      }),
    });
    const u = derivedSummary.uncapped;

    return [
      calculated("get", "Get", u.get, "Total asset value + capped buyer premium", { total_asset_value: derivedSummary.total_asset_value, total_capped_bp: derivedSummary.total_capped_bp }),
      calculated("costs", "Costs", u.costs, "Sum of all projected per-asset costs", { total_projected_costs: derivedSummary.total_projected_costs }),
      calculated("get_after_costs", "Get After Costs", u.get_after_costs, "Get - costs", { get: u.get, costs: u.costs }),
      calculated("adjusted_get", "Adjusted Get", u.adjusted_get, "Get after costs / 1.15", { get_after_costs: u.get_after_costs }),
      calculated("bp_15", "15% B.P.", u.bp_15, "Get - adjusted get", { get: u.get, adjusted_get: u.adjusted_get }),
      calculated("potential_get", "Potential Get", u.potential_get, "Total high estimate + capped buyer premium", { total_high_est_value: derivedSummary.total_high_est_value, total_capped_bp: derivedSummary.total_capped_bp }),
      calculated("adjusted_potential_get", "Adjusted Potential Get", u.adjusted_potential_get, "Potential get / 1.15", { potential_get: u.potential_get }),
      calculated("potential_bp_15", "Potential 15% B.P.", u.potential_bp_15, "Potential get - adjusted potential get", { potential_get: u.potential_get, adjusted_potential_get: u.adjusted_potential_get }),
      calculated("offer1_cash_offer", "Offer #1 Cash Offer (90%)", u.offer1_cash_offer, "Get x 90%", { get: u.get }),
      calculated("offer1_total_costs", "Offer #1 Total Costs", u.offer1_total_costs, "Offer #1 cash offer + costs", { offer1_cash_offer: u.offer1_cash_offer, costs: u.costs }),
      calculated("offer1_mcd_take", "Offer #1 McD Take", u.offer1_mcd_take, "Get - Offer #1 total costs", { get: u.get, offer1_total_costs: u.offer1_total_costs }),
      calculated("offer1_roi", "Offer #1 ROI", u.offer1_roi, "Offer #1 McD take / Offer #1 total costs", { offer1_mcd_take: u.offer1_mcd_take, offer1_total_costs: u.offer1_total_costs }, true),
      calculated("offer1_risk", "Offer #1 Risk", u.offer1_risk, "Low estimate + capped buyer premium - Offer #1 total costs", { total_low_est_value: derivedSummary.total_low_est_value, total_capped_bp: derivedSummary.total_capped_bp, offer1_total_costs: u.offer1_total_costs }),
      calculated("offer2_nmg", `Offer #2 NMG (${offer2PercentLabel}%)`, u.offer2_nmg, "Get x Offer #2 NMG percentage", { get: u.get, offer2_nmg_percent: sheet.file_summary.offer2_nmg_percent }),
      calculated("offer2_threshold", "Offer #2 Threshold", u.offer2_threshold, "Offer #2 NMG x 15%", { offer2_nmg: u.offer2_nmg }),
      calculated("offer2_upper_value", "Offer #2 Upper Value", u.offer2_upper_value, "Offer #2 NMG + threshold", { offer2_nmg: u.offer2_nmg, offer2_threshold: u.offer2_threshold }),
      calculated("offer2_total_costs", "Offer #2 Total Costs", u.offer2_total_costs, "Offer #2 NMG + costs", { offer2_nmg: u.offer2_nmg, costs: u.costs }),
      calculated("offer2_aquajets_take", "Offer #2 Aquajet's Take", u.offer2_aquajets_take, "Offer #2 NMG", { offer2_nmg: u.offer2_nmg }),
      calculated("offer2_overage", "Offer #2 Overage", u.offer2_overage, "Adjusted get - Offer #2 NMG", { adjusted_get: u.adjusted_get, offer2_nmg: u.offer2_nmg }),
      calculated("offer2_mcd_take", "Offer #2 McD Take", u.offer2_mcd_take, "15% buyer premium - costs", { bp_15: u.bp_15, costs: u.costs }),
      calculated("offer2_roi", "Offer #2 ROI", u.offer2_roi, "Offer #2 McD take / Offer #2 total costs", { offer2_mcd_take: u.offer2_mcd_take, offer2_total_costs: u.offer2_total_costs }, true),
      calculated("offer2_risk", "Offer #2 Risk", u.offer2_risk, "Low estimate + capped buyer premium - Offer #2 total costs", { total_low_est_value: derivedSummary.total_low_est_value, total_capped_bp: derivedSummary.total_capped_bp, offer2_total_costs: u.offer2_total_costs }),
      calculated("aquajets_potential_take", "Aquajet's Potential Take", u.aquajets_potential_take, "NMG + 98% of adjusted potential value above the upper value", { offer2_nmg: u.offer2_nmg, adjusted_potential_get: u.adjusted_potential_get, offer2_upper_value: u.offer2_upper_value }),
      calculated("mcd_potential_take", "McD Potential Take", u.mcd_potential_take, "Potential buyer premium - costs + threshold + 2% of potential overage", { potential_bp_15: u.potential_bp_15, costs: u.costs, offer2_threshold: u.offer2_threshold, adjusted_potential_get: u.adjusted_potential_get, offer2_upper_value: u.offer2_upper_value }),
      calculated("potential_roi", "Potential ROI", u.potential_roi, "McD potential take / Offer #2 total costs", { mcd_potential_take: u.mcd_potential_take, offer2_total_costs: u.offer2_total_costs }, true),
      calculated("offer3_mcd_take", "Offer #3 Commission", u.offer3_mcd_take, "Uncapped 15% buyer premium", { bp_15: u.bp_15 }),
    ];
  }, [derivedSummary, serverCalculations, sheet]);

  const cappedRows = useMemo<SummaryRow[]>(() => {
    if (!sheet || !derivedSummary) return [];
    const calculated = (
      key: string,
      label: string,
      result: number | null,
      formula: string,
      inputs: Record<string, number | string | null>,
      percent = false
    ): SummaryRow => ({
      key: `capped.${key}`,
      label,
      value: percent ? formatPercentCell(result) || "-" : formatCurrencyCell(result) || "-",
      calculation: calculationDetails(serverCalculations, {
        key: `capped.${key}`,
        label,
        formula,
        inputs,
        result,
      }),
    });
    const c = derivedSummary.capped;
    return [
      calculated("avg", "AVG", c.avg, "Total asset value", { total_asset_value: derivedSummary.total_asset_value }),
      calculated("high", "HIGH", c.high, "Sum of high estimated sale values", { total_high_est_value: derivedSummary.total_high_est_value }),
      calculated("low", "LOW", c.low, "Sum of low estimated sale values", { total_low_est_value: derivedSummary.total_low_est_value }),
      calculated("bp", "BP", c.bp, "Sum of capped per-asset buyer premiums", { total_capped_bp: derivedSummary.total_capped_bp }),
      calculated("sale_total_inc_bp", "Sale Total Inc BP", c.sale_total_inc_bp, "AVG + BP", { avg: c.avg, bp: c.bp }),
      calculated("ads", "Ads", c.ads, "AVG x 1%", { avg: c.avg }),
      calculated("svr", "SVR", c.svr, "AVG x 1%", { avg: c.avg }),
      calculated("refurb", "Refurb", c.refurb, "AVG x 1%", { avg: c.avg }),
      calculated("total_cost", "Total Cost", c.total_cost, "Ads + SVR + refurb", { ads: c.ads, svr: c.svr, refurb: c.refurb }),
      calculated("nmg", "NMG", c.nmg, "AVG - total cost - threshold", { avg: c.avg, total_cost: c.total_cost, threshold: c.threshold }),
      calculated("threshold", "Threshold", c.threshold, "AVG x capped threshold percentage", { avg: c.avg, capped_threshold_percent: sheet.file_summary.capped_threshold_percent }),
      calculated("risk", "Risk", c.risk, "1 - ((total cost + NMG - BP) / AVG)", { total_cost: c.total_cost, nmg: c.nmg, bp: c.bp, avg: c.avg }, true),
    ];
  }, [derivedSummary, serverCalculations, sheet]);

  if (!sheet || !derivedSummary) {
    return <Box sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>No asset schedule sheet available.</Box>;
  }

  return (
    <Box
      sx={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Tabs
          value={activeTab}
          onChange={(_, next) => setActiveTab(next)}
          variant="standard"
          sx={{
            px: { xs: 1.5, sm: 2.5 },
            minHeight: 48,
            "& .MuiTabs-indicator": { height: 3 },
            "& .MuiTab-root": {
              flex: { xs: "1 1 0", sm: "0 0 auto" },
              minHeight: 48,
              minWidth: { xs: 0, sm: 168 },
              px: 1.5,
              textTransform: "none",
              fontSize: { xs: 14, sm: 15 },
              fontWeight: 650,
            },
          }}
        >
          <Tab value="scheduleA" label={pageMode ? "Lots" : "Schedule A"} />
          <Tab value="fileSummary" label="File Summary" />
        </Tabs>

        <Box
          sx={{
            display: { xs: "none", lg: "flex" },
            minHeight: 58,
            px: 1.5,
            py: 1,
            borderTop: "1px solid",
            borderColor: "divider",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          {activeTab === "scheduleA" ? (
            <Stack
              direction="row"
              spacing={1.25}
              alignItems="center"
              sx={{ minWidth: 0, flex: "1 1 auto" }}
            >
              <Typography
                sx={{
                  flex: "0 0 auto",
                  color: "text.secondary",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Evaluators
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  minWidth: 0,
                  maxWidth: "min(680px, 100%)",
                  gap: 0.75,
                  overflowX: "auto",
                  scrollbarWidth: "thin",
                }}
              >
                {sheet.evaluator_columns.map((column) => (
                  <Box
                    key={column.id}
                    sx={{ width: 196, flex: "0 0 196px" }}
                  >
                    <EvaluatorColumnPill
                      column={column}
                      isOwner={column.id === preview.ownerColumnId}
                      onRemove={() => removeEvaluator(column.id)}
                    />
                  </Box>
                ))}
              </Box>
            </Stack>
          ) : (
            <Box />
          )}

          <Stack direction="row" spacing={1} sx={{ flex: "0 0 auto" }}>
            {activeTab === "scheduleA" ? (
              <EvaluatorPicker
                options={availableEvaluatorOptions}
                loading={evaluatorOptionsLoading}
                disabled={linkedEvaluatorLimitReached}
                inputValue={evaluatorQuery}
                onInputChange={setEvaluatorQuery}
                onSelect={addEvaluator}
              />
            ) : null}
            <Tooltip
              title={
                sheetDirty
                  ? "Save your latest changes before exporting Excel."
                  : "Export the current Proposal Valuation as Excel."
              }
              arrow
            >
              <span
                tabIndex={sheetDirty ? 0 : undefined}
                aria-label={
                  sheetDirty
                    ? "Save your latest changes before exporting Excel."
                    : undefined
                }
              >
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={
                    exporting ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <DownloadRoundedIcon />
                    )
                  }
                  disabled={saving || exporting || sheetDirty || !preview.reportId}
                  onClick={() => void exportProposalValuation()}
                  sx={{
                    minHeight: 38,
                    borderRadius: 1,
                    textTransform: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  {exporting ? "Exporting..." : "Export Excel"}
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="contained"
              color="primary"
              startIcon={<SaveRoundedIcon />}
              disabled={saving}
              onPointerDown={() => {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              }}
              onClick={() => void handleSave()}
              sx={{ minHeight: 38, borderRadius: 1, textTransform: "none", whiteSpace: "nowrap" }}
            >
              {saving ? "Saving..." : pageMode ? "Save changes" : "Save"}
            </Button>
            {!pageMode && onClose ? (
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<CloseRoundedIcon />}
                onClick={onClose}
                sx={{ minHeight: 44, borderRadius: 1, textTransform: "none" }}
              >
                Close
              </Button>
            ) : null}
          </Stack>
        </Box>

        {exportError ? (
          <Alert severity="error" sx={{ mx: 2, my: 1, borderRadius: 1 }}>
            {exportError}
          </Alert>
        ) : null}
        {saveError ? (
          <Alert severity="error" sx={{ mx: 2, my: 1, borderRadius: 1 }}>
            {saveError}
          </Alert>
        ) : null}
        {saveSuccess ? (
          <Alert severity="success" sx={{ mx: 2, my: 1, borderRadius: 1 }}>
            {saveSuccess}
          </Alert>
        ) : null}
        {saveWarning ? (
          <Alert severity="warning" sx={{ mx: 2, my: 1, borderRadius: 1 }}>
            {saveWarning}
          </Alert>
        ) : null}
        {activeTab === "scheduleA" && !isCompactLayout && evaluatorOptionsError ? (
          <Alert severity="warning" sx={{ mx: 1.5, my: 0.75, py: 0, borderRadius: 1 }}>
            {evaluatorOptionsError}
          </Alert>
        ) : null}
      </Box>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: activeTab === "scheduleA" && !isCompactLayout ? "hidden" : "auto",
          bgcolor: pageMode ? "background.paper" : "background.default",
        }}
      >
        {activeTab === "scheduleA" ? (
          <>
            {!isCompactLayout ? (
              <Box sx={{ display: "flex", height: "100%", minHeight: 0, flexDirection: "column", p: 1 }}>
                <TableContainer
                  component={Paper}
                  variant="outlined"
                  elevation={0}
                  tabIndex={0}
                  role="region"
                  aria-label="Scrollable asset schedule and all-lot totals"
                  sx={{
                    width: "100%",
                    minHeight: 0,
                    flex: 1,
                    overflow: "auto",
                    overscrollBehavior: "contain",
                    scrollbarGutter: "stable",
                    borderColor: "divider",
                    borderRadius: 1,
                    bgcolor: "background.paper",
                  }}
                >
                  <Table
                    stickyHeader
                    size="small"
                    aria-label="Asset schedule lots"
                    sx={{
                      width: scheduleTableWidth,
                      tableLayout: "fixed",
                      borderCollapse: "separate",
                      borderSpacing: 0,
                    }}
                  >
                    <colgroup>
                      {scheduleTable.getAllLeafColumns().map((column) => (
                        <col key={column.id} style={{ width: column.getSize() }} />
                      ))}
                    </colgroup>
                    <TableHead>
                      {scheduleTable.getHeaderGroups().map((headerGroup) => (
                        <TableRow
                          key={headerGroup.id}
                          sx={{ height: headerGroup.depth === 0 ? 34 : 46 }}
                        >
                          {headerGroup.headers.map((header) => {
                            const stickyAssetId = header.column.id === "asset_id";
                            const isGroupHeader = headerGroup.depth === 0;
                            return (
                              <TableCell
                                key={header.id}
                                colSpan={header.colSpan}
                                sx={{
                                  position: "sticky",
                                  top: isGroupHeader ? 0 : 34,
                                  left: stickyAssetId ? 0 : "auto",
                                  zIndex: stickyAssetId ? 8 : isGroupHeader ? 6 : 7,
                                  ...(!isGroupHeader
                                    ? {
                                        width: header.getSize(),
                                        minWidth: header.getSize(),
                                        maxWidth: header.getSize(),
                                      }
                                    : null),
                                  height: isGroupHeader ? 34 : 46,
                                  minHeight: isGroupHeader ? 34 : 46,
                                  maxHeight: isGroupHeader ? 34 : 46,
                                  boxSizing: "border-box",
                                  overflow: "hidden",
                                  bgcolor: isGroupHeader ? "background.default" : "background.paper",
                                  color: "text.primary",
                                  borderBottom: "1px solid",
                                  borderRight: "1px solid",
                                  borderColor: "divider",
                                  fontWeight: 700,
                                  fontSize: isGroupHeader ? 11.5 : 12,
                                  lineHeight: 1.2,
                                  letterSpacing: isGroupHeader ? "0.01em" : 0,
                                  textAlign: isGroupHeader ? "center" : "left",
                                  verticalAlign: "middle",
                                  p: 0,
                                  ...(stickyAssetId
                                    ? { boxShadow: "5px 0 10px -8px rgba(15, 23, 42, 0.7)" }
                                    : null),
                                }}
                              >
                                <Box
                                  sx={{
                                    display: isGroupHeader ? "block" : "-webkit-box",
                                    width: "100%",
                                    px: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: isGroupHeader ? "nowrap" : "normal",
                                    WebkitBoxOrient: "vertical",
                                    WebkitLineClamp: isGroupHeader ? 1 : 2,
                                  }}
                                >
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(header.column.columnDef.header, header.getContext())}
                                </Box>
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableHead>
                    <TableBody>
                      {scheduleTable.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          sx={{
                            height: 80,
                            "& > .MuiTableCell-root": {
                              bgcolor: row.index % 2 === 0 ? "background.paper" : "background.default",
                            },
                            "&:hover > .MuiTableCell-root": { bgcolor: "action.hover" },
                          }}
                        >
                          {row.getVisibleCells().map((cell) => {
                            const stickyAssetId = cell.column.id === "asset_id";
                            return (
                              <TableCell
                                key={cell.id}
                                sx={{
                                  position: stickyAssetId ? "sticky" : "static",
                                  left: stickyAssetId ? 0 : "auto",
                                  zIndex: stickyAssetId ? 2 : "auto",
                                  width: cell.column.getSize(),
                                  minWidth: cell.column.getSize(),
                                  maxWidth: cell.column.getSize(),
                                  height: 80,
                                  maxHeight: 80,
                                  boxSizing: "border-box",
                                  overflow: "hidden",
                                  borderBottom: "1px solid",
                                  borderRight: "1px solid",
                                  borderColor: "divider",
                                  verticalAlign: "middle",
                                  py: 0.6,
                                  px: 1,
                                  ...(stickyAssetId
                                    ? {
                                        fontWeight: 700,
                                        boxShadow: "5px 0 10px -8px rgba(15, 23, 42, 0.7)",
                                      }
                                    : null),
                                }}
                              >
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter aria-label={`Totals across all ${sheet.rows.length} lots`}>
                      <TableRow>
                        {scheduleTable.getAllLeafColumns().map((column) => {
                          const isLabel = column.id === "asset_id";
                          const total = allLotTotals[column.id];
                          return (
                            <TableCell
                              key={column.id}
                              component={isLabel ? "th" : "td"}
                              scope={isLabel ? "row" : undefined}
                              data-pv-total-column={total ? column.id : undefined}
                              aria-label={total ? `${total.label} total across all ${sheet.rows.length} lots` : undefined}
                              align={isLabel ? "left" : "right"}
                              sx={{
                                position: "sticky",
                                bottom: 0,
                                left: isLabel ? 0 : "auto",
                                zIndex: isLabel ? 4 : 3,
                                width: column.getSize(),
                                minWidth: column.getSize(),
                                maxWidth: column.getSize(),
                                px: 1,
                                py: 1,
                                bgcolor: "background.paper",
                                color: "text.primary",
                                borderTop: "2px solid",
                                borderRight: "1px solid",
                                borderColor: "divider",
                                fontSize: 12.5,
                                fontWeight: 700,
                                fontVariantNumeric: "tabular-nums",
                                overflowWrap: "anywhere",
                              }}
                            >
                              {isLabel ? (
                                <>
                                  Totals
                                  <Typography component="span" sx={{ display: "block", fontSize: 11, color: "text.secondary" }}>
                                    All {sheet.rows.length} lots
                                  </Typography>
                                </>
                              ) : total ? formatCurrencyCell(total.value) : null}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    </TableFooter>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={sheet.rows.length}
                  page={pagination.pageIndex}
                  onPageChange={(_, nextPage) => {
                    scheduleTable.setPageIndex(nextPage);
                    setSelectedMobileLot(nextPage * pagination.pageSize);
                  }}
                  rowsPerPage={pagination.pageSize}
                  onRowsPerPageChange={(event) => {
                    scheduleTable.setPageSize(Number(event.target.value));
                    scheduleTable.setPageIndex(0);
                    setSelectedMobileLot(0);
                  }}
                  rowsPerPageOptions={[25, 50, 100]}
                  labelRowsPerPage="Rows"
                  sx={{
                    flex: "0 0 auto",
                    border: "1px solid",
                    borderTop: 0,
                    borderColor: "divider",
                    bgcolor: "background.paper",
                    "& .MuiTablePagination-toolbar": { minHeight: 44 },
                  }}
                />
              </Box>
            ) : null}

            {isCompactLayout ? (
              <Box sx={{ p: { xs: 1.5, sm: 2.5 } }}>
                <TablePagination
                  component="div"
                  count={sheet.rows.length}
                  page={pagination.pageIndex}
                  onPageChange={(_, nextPage) => {
                    scheduleTable.setPageIndex(nextPage);
                    setSelectedMobileLot(nextPage * pagination.pageSize);
                  }}
                  rowsPerPage={pagination.pageSize}
                  onRowsPerPageChange={(event) => {
                    scheduleTable.setPageSize(Number(event.target.value));
                    scheduleTable.setPageIndex(0);
                    setSelectedMobileLot(0);
                  }}
                  rowsPerPageOptions={[25, 50, 100]}
                  labelRowsPerPage="Rows"
                  SelectProps={{ inputProps: { "aria-label": "Rows per page" } }}
                  sx={{
                    mb: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: 1,
                    bgcolor: "background.paper",
                    "& .MuiTablePagination-toolbar": {
                      minHeight: 44,
                      px: { xs: 0.5, sm: 1.5 },
                    },
                    "& .MuiTablePagination-spacer": { display: { xs: "none", sm: "block" } },
                    "& .MuiTablePagination-selectLabel": { display: { xs: "none", sm: "block" } },
                    "& .MuiTablePagination-displayedRows": { ml: { xs: 0, sm: 2 } },
                    "& .MuiTablePagination-actions": { ml: { xs: 0, sm: 2 } },
                  }}
                />
                {sheet.rows.length ? (
                  <Box
                    component="nav"
                    aria-label="Schedule lots"
                    sx={{
                      display: "flex",
                      gap: 1,
                      mx: { xs: -1.5, sm: -2.5 },
                      mb: 1.5,
                      px: { xs: 1.5, sm: 2.5 },
                      pb: 0.5,
                      overflowX: "auto",
                      scrollbarWidth: "none",
                      "&::-webkit-scrollbar": { display: "none" },
                    }}
                  >
                    {paginatedMobileRows.map(({ row, index }) => {
                      const selected = selectedMobileLot === index;
                      return (
                        <Button
                          key={`${row.lot_id}-${index}`}
                          aria-pressed={selected}
                          variant={selected ? "outlined" : "text"}
                          color={selected ? "primary" : "inherit"}
                          onClick={() => setSelectedMobileLot(index)}
                          sx={{
                            minWidth: 104,
                            minHeight: 44,
                            flex: "0 0 auto",
                            borderRadius: 1,
                            borderColor: selected ? "primary.main" : "divider",
                            color: selected ? "primary.main" : "text.secondary",
                            bgcolor: selected ? "background.paper" : "transparent",
                            fontSize: 13,
                            fontWeight: selected ? 700 : 600,
                            textTransform: "none",
                          }}
                        >
                          Lot {mobileLotNumber(row, index)}
                        </Button>
                      );
                    })}
                  </Box>
                ) : null}

                <Paper
                  variant="outlined"
                  sx={{
                    mb: 1.5,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "background.paper",
                  }}
                >
                  <Typography sx={{ mb: 1, fontSize: 13, fontWeight: 700 }}>
                    Evaluators
                  </Typography>
                  <Stack spacing={1}>
                    {sheet.evaluator_columns.map((column) => (
                      <EvaluatorColumnPill
                        key={column.id}
                        column={column}
                        isOwner={column.id === preview.ownerColumnId}
                        onRemove={() => removeEvaluator(column.id)}
                      />
                    ))}
                    <EvaluatorPicker
                      options={availableEvaluatorOptions}
                      loading={evaluatorOptionsLoading}
                      disabled={linkedEvaluatorLimitReached}
                      inputValue={evaluatorQuery}
                      onInputChange={setEvaluatorQuery}
                      onSelect={addEvaluator}
                    />
                    {linkedEvaluatorLimitReached ? (
                      <Typography sx={{ color: "text.secondary", fontSize: 11.5 }}>
                        Maximum of four additional evaluator users reached.
                      </Typography>
                    ) : null}
                    {evaluatorOptionsError ? (
                      <Typography role="alert" sx={{ color: "error.main", fontSize: 11.5 }}>
                        {evaluatorOptionsError}
                      </Typography>
                    ) : null}
                  </Stack>
                </Paper>

                {sheet.rows[selectedMobileLot] ? (
                  <MobileLotCard
                    key={sheet.rows[selectedMobileLot].lot_id}
                    row={sheet.rows[selectedMobileLot]}
                    index={selectedMobileLot}
                    evaluatorColumns={stableEvaluatorColumns}
                    onUpdateRow={updateRowField}
                    onOpenGallery={openGallery}
                  />
                ) : null}
                <Paper
                  component="section"
                  aria-label={`Totals across all ${sheet.rows.length} lots`}
                  variant="outlined"
                  sx={{ mt: 1.5, p: 1.5, bgcolor: "background.paper", borderRadius: 1 }}
                >
                  <Typography component="h3" sx={{ fontSize: 14, fontWeight: 700 }}>
                    Totals · all {sheet.rows.length} lots
                  </Typography>
                  <Typography sx={{ mt: 0.5, mb: 1.25, fontSize: 12, color: "text.secondary" }}>
                    Sums of entered values across every lot, not just the selected lot or page.
                  </Typography>
                  <Box
                    component="dl"
                    sx={{ m: 0, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1.25 }}
                  >
                    {Object.entries(allLotTotals).map(([columnId, total]) => (
                      <Box key={columnId} data-pv-total-column={columnId} sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        <LabeledValue label={total.label} value={formatCurrencyCell(total.value)} />
                      </Box>
                    ))}
                  </Box>
                </Paper>
              </Box>
            ) : null}
          </>
        ) : null}

        {activeTab === "fileSummary" ? (
          <Box sx={{ p: { xs: 1.5, sm: 2.5 } }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "minmax(0, 1fr)",
                  md: "repeat(2, minmax(0, 1fr))",
                  xl: "repeat(3, minmax(0, 1fr))",
                },
                gap: 2,
                alignItems: "start",
              }}
            >
              <SummaryTable title="Metric" rows={metricRows} onOpenCalculation={setCalculationDialog} />
              <SummaryTable title="Uncapped Buyers Premium Scenario" rows={uncappedRows} onOpenCalculation={setCalculationDialog} />
              <SummaryTable title="Capped Buyers Premium Scenario" rows={cappedRows} onOpenCalculation={setCalculationDialog} />
            </Box>
          </Box>
        ) : null}
      </Box>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          display: { xs: "flex", lg: "none" },
          flexShrink: 0,
          p: 1.25,
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
          boxShadow: "0 -8px 24px rgba(15, 23, 42, 0.08)",
        }}
      >
        <Button
          variant="outlined"
          color="inherit"
          startIcon={
            exporting ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <DownloadRoundedIcon />
            )
          }
          disabled={saving || exporting || sheetDirty || !preview.reportId}
          onClick={() => void exportProposalValuation()}
          aria-label={
            sheetDirty
              ? "Save changes before exporting Excel"
              : "Export Proposal Valuation as Excel"
          }
          sx={{
            minWidth: 0,
            minHeight: 46,
            flex: 1,
            borderRadius: 1,
            px: 1,
            fontSize: 13,
            textTransform: "none",
            whiteSpace: "nowrap",
            "& .MuiButton-startIcon": { ml: 0, mr: 0.5 },
            "& .MuiSvgIcon-root": { fontSize: 18 },
          }}
        >
          {exporting ? "Exporting..." : "Export Excel"}
        </Button>
        <Button
          variant="contained"
          color="primary"
          startIcon={<SaveRoundedIcon />}
          disabled={saving}
          onPointerDown={() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          }}
          onClick={() => void handleSave()}
          sx={{
            minWidth: 0,
            minHeight: 46,
            flex: 1,
            borderRadius: 1,
            px: 1,
            fontSize: 13,
            textTransform: "none",
            whiteSpace: "nowrap",
            "& .MuiButton-startIcon": { ml: 0, mr: 0.5 },
            "& .MuiSvgIcon-root": { fontSize: 18 },
          }}
        >
          {saving ? "Saving..." : pageMode ? "Save changes" : "Save"}
        </Button>
        {!pageMode && onClose ? (
          <Button
            variant="outlined"
            color="inherit"
            startIcon={<CloseRoundedIcon />}
            onClick={onClose}
            sx={{
              minWidth: 0,
              minHeight: 46,
              flex: 1,
              borderRadius: 1,
              px: 1,
              fontSize: 13,
              textTransform: "none",
              whiteSpace: "nowrap",
              "& .MuiButton-startIcon": { ml: 0, mr: 0.5 },
              "& .MuiSvgIcon-root": { fontSize: 18 },
            }}
          >
            Close
          </Button>
        ) : null}
      </Stack>

      <Dialog
        open={Boolean(calculationDialog)}
        onClose={() => setCalculationDialog(null)}
        fullWidth
        fullScreen={isPhoneLayout}
        maxWidth="sm"
        aria-labelledby="pv-calculation-title"
        PaperProps={{ sx: { borderRadius: { xs: 0, sm: 1.5 }, bgcolor: "background.paper" } }}
      >
        <DialogTitle id="pv-calculation-title" sx={{ pr: 7, fontSize: { xs: 18, sm: 20 } }}>
          {calculationDialog?.label || "Calculation details"}
          <IconButton
            aria-label="Close calculation details"
            onClick={() => setCalculationDialog(null)}
            sx={{ position: "absolute", top: 10, right: 10 }}
          >
            <CloseRoundedIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: { xs: 2, sm: 2.5 } }}>
          {calculationDialog ? (
            <Stack spacing={2.25}>
              <Box>
                <Typography sx={{ mb: 0.75, color: "text.secondary", fontSize: 11, fontWeight: 750, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Formula
                </Typography>
                <Box
                  component="p"
                  sx={{ m: 0, p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1, bgcolor: "action.hover", fontFamily: "var(--font-geist-mono)", fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}
                >
                  {calculationDialog.formula}
                </Box>
              </Box>
              <Box>
                <Typography sx={{ mb: 0.75, color: "text.secondary", fontSize: 11, fontWeight: 750, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Inputs
                </Typography>
                <Box component="dl" sx={{ m: 0, border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
                  {Object.entries(calculationDialog.inputs).map(([name, value]) => (
                    <Box key={name} sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 2, px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider", "&:last-child": { borderBottom: 0 } }}>
                      <Typography component="dt" sx={{ color: "text.secondary", fontSize: 12.5, overflowWrap: "anywhere" }}>
                        {formatLabelForCalculation(name)}
                      </Typography>
                      <Typography component="dd" sx={{ m: 0, fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                        {calculationValue(value)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 2, p: 1.5, border: "1px solid", borderColor: "primary.main", borderRadius: 1, bgcolor: "action.hover" }}>
                <Typography sx={{ color: "text.secondary", fontSize: 13, fontWeight: 700 }}>Result</Typography>
                <Typography sx={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                  {calculationValue(calculationDialog.result)}
                </Typography>
              </Box>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.25 }}>
          <Button onClick={() => setCalculationDialog(null)} variant="contained" sx={{ minHeight: 40, textTransform: "none" }}>
            Done
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(gallery)}
        onClose={closeGallery}
        fullWidth
        maxWidth="lg"
        PaperProps={{ sx: { borderRadius: { xs: 0, sm: 2 }, overflow: "hidden" } }}
      >
        <DialogContent sx={{ p: 0, bgcolor: "#111827" }}>
          {gallery ? (
            <Box sx={{ position: "relative", minHeight: { xs: 320, md: 560 }, bgcolor: "#111827" }}>
              <Box
                sx={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  zIndex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  px: 2,
                  py: 1.5,
                  color: "common.white",
                  bgcolor: "rgba(17, 24, 39, 0.72)",
                }}
              >
                <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                  {gallery.title} ({gallery.index + 1} / {gallery.urls.length})
                </Typography>
                <IconButton onClick={closeGallery} sx={{ color: "common.white", borderRadius: 1 }}>
                  <CloseRoundedIcon />
                </IconButton>
              </Box>

              <Box
                component="img"
                src={gallery.urls[gallery.index]}
                alt={`${gallery.title} ${gallery.index + 1}`}
                sx={{
                  display: "block",
                  width: "100%",
                  height: { xs: 320, md: 560 },
                  objectFit: "contain",
                  bgcolor: "#111827",
                }}
              />

              {gallery.urls.length > 1 ? (
                <>
                  <IconButton
                    onClick={showPreviousImage}
                    sx={{
                      position: "absolute",
                      left: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "common.white",
                      bgcolor: "rgba(17, 24, 39, 0.72)",
                      borderRadius: 1,
                      "&:hover": { bgcolor: "rgba(17, 24, 39, 0.88)" },
                    }}
                  >
                    <ChevronLeftRoundedIcon />
                  </IconButton>
                  <IconButton
                    onClick={showNextImage}
                    sx={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "common.white",
                      bgcolor: "rgba(17, 24, 39, 0.72)",
                      borderRadius: 1,
                      "&:hover": { bgcolor: "rgba(17, 24, 39, 0.88)" },
                    }}
                  >
                    <ChevronRightRoundedIcon />
                  </IconButton>
                </>
              ) : null}
            </Box>
          ) : null}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
