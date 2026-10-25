"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Braces, FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Alert,
  alpha,
  Box,
  Button,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import AssetScheduleSheet from "@/app/components/reports/AssetScheduleSheet";
import ReportLotNavigationControls from "@/app/components/reports/ReportLotNavigationControls";
import { lotPreviewDisplay, usesLotTitleDescription } from "@/lib/lotPreviewDisplay";
import SalvageReportEnrichment from "@/app/components/reports/SalvageReportEnrichment";
import { isSalvageReportEnrichment } from "@/lib/salvageReportEnrichment";
import { ADMIN_MOBILE_TITLEBAR_HEIGHT } from "@/app/components/common/adminLayout.constants";
import type {
  AssetAdminScheduleSheet,
  ReportPreviewPayload,
} from "@/app/components/reports/reportPreviewTypes";

type ReportDataPageProps = {
  reportId: string;
  returnTo: "/reports" | "/approvals" | "/pending-approvals";
  pvOnly?: boolean;
};

type PreviewTab = "data" | "schedule" | "raw";

const HIDDEN_REPORT_DATA_KEYS = new Set(["conditionreportspecsdeleted", "marketcheck"]);
const IMAGE_FIELD = /(image|photo|thumbnail|picture|media)/i;
const IMAGE_URL = /\.(?:avif|bmp|gif|heic|jpe?g|png|webp)(?:[?#].*)?$/i;

function formatLabel(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function shouldHideReportDataKey(key: string) {
  return HIDDEN_REPORT_DATA_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

function isWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isImageValue(value: unknown, fieldName = ""): value is string {
  return isWebUrl(value) && (IMAGE_FIELD.test(fieldName) || IMAGE_URL.test(value));
}

function getImageUrl(value: unknown, fieldName: string) {
  if (isImageValue(value, fieldName)) return value;
  if (value && typeof value === "object" && isImageValue((value as { url?: unknown }).url, fieldName)) {
    return String((value as { url: unknown }).url);
  }
  return null;
}

function ImageGallery({ values }: { values: string[] }) {
  const unique = Array.from(new Set(values));
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "repeat(2, minmax(0, 1fr))",
          sm: "repeat(3, minmax(0, 1fr))",
          xl: "repeat(4, minmax(0, 1fr))",
        },
        gap: 1,
      }}
    >
      {unique.map((url) => (
        <Box
          key={url}
          component="a"
          href={url}
          target="_blank"
          rel="noreferrer"
          sx={{
            display: "block",
            minWidth: 0,
            overflow: "hidden",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1.5,
            bgcolor: "action.hover",
            aspectRatio: "4 / 3",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Report media" loading="lazy" decoding="async" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
        </Box>
      ))}
    </Box>
  );
}

function DataValue({ value, name, depth = 0 }: { value: unknown; name: string; depth?: number }): ReactNode {
  if (value === null || typeof value === "undefined" || value === "") {
    return <Box component="span" sx={{ color: "text.secondary" }}>-</Box>;
  }

  if (isImageValue(value, name)) return <ImageGallery values={[value]} />;
  if (isWebUrl(value)) {
    return (
      <Box
        component="a"
        href={value}
        target="_blank"
        rel="noreferrer"
        sx={{
          color: "primary.main",
          overflowWrap: "anywhere",
          textDecoration: "none",
          "&:hover": { textDecoration: "underline" },
        }}
      >
        {value}
      </Box>
    );
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return <Box component="span" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</Box>;
  }

  if (Array.isArray(value)) {
    const imageValues = value.map((entry) => getImageUrl(entry, name)).filter((entry): entry is string => Boolean(entry));
    if (imageValues.length === value.length && imageValues.length > 0) return <ImageGallery values={imageValues} />;
    if (!value.length) return <Box component="span" sx={{ color: "text.secondary" }}>Empty list</Box>;
    return (
      <Stack
        spacing={0}
        sx={{
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        {value.map((entry, index) => (
          <Box
            key={`${name}-${index}`}
            sx={{
              borderBottom: "1px solid",
              borderColor: "divider",
              py: 1.5,
              "&:last-child": { borderBottom: 0 },
            }}
          >
            <DataValue value={entry} name={`${name} ${index + 1}`} depth={depth + 1} />
          </Box>
        ))}
      </Stack>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !shouldHideReportDataKey(key));
  if (!entries.length) return <Box component="span" sx={{ color: "text.secondary" }}>No values</Box>;

  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: depth > 1 ? "1fr" : { xs: "1fr", xl: "repeat(2, minmax(0, 1fr))" },
        columnGap: { xl: 4 },
        m: 0,
      }}
    >
      {entries.map(([key, entry]) => {
        const complex = entry !== null && typeof entry === "object";
        return (
          <Box
            key={key}
            sx={{
              minWidth: 0,
              display: complex ? "block" : "grid",
              gridTemplateColumns: complex ? undefined : { xs: "minmax(104px, 38%) minmax(0, 1fr)", sm: "minmax(136px, 180px) minmax(0, 1fr)" },
              gap: complex ? 0 : { xs: 1.25, sm: 2 },
              gridColumn: complex ? "1 / -1" : undefined,
              borderBottom: "1px solid",
              borderColor: "divider",
              py: complex ? 2 : 1.5,
            }}
          >
            <Box
              component="dt"
              sx={{
                mb: complex ? 1.25 : 0,
                color: complex ? "text.primary" : "text.secondary",
                fontSize: complex ? 14 : 12,
                fontWeight: complex ? 700 : 600,
                lineHeight: 1.45,
              }}
            >
              {formatLabel(key)}
            </Box>
            <Box
              component="dd"
              sx={{
                minWidth: 0,
                m: 0,
                color: "text.primary",
                fontSize: 13,
                lineHeight: 1.55,
              }}
            >
              <DataValue value={entry} name={key} depth={depth + 1} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function lotNumber(lot: Record<string, unknown>, index: number) {
  return String(lot.lot_number || lot.lotNumber || index + 1);
}

function lotTitle(lot: Record<string, unknown>) {
  return String(lot.title || lot.description || "Untitled");
}

type LotNavigationProps = {
  lots: Record<string, unknown>[];
  selectedLot: number;
  mobile?: boolean;
  onSelect: (index: number) => void;
};

function LotNavigation({
  lots,
  selectedLot,
  mobile = false,
  onSelect,
}: LotNavigationProps) {
  const navigationItems = [
    { key: "summary", index: -1, title: "Report Summary", description: "" },
    ...lots.map((lot, index) => ({
      key: `lot-${String(lot.lot_id || lot.lot_number || index)}-${index}`,
      index,
      title: `Lot ${lotNumber(lot, index)}`,
      description: lotTitle(lot),
    })),
  ];

  return (
    <Box
      component="nav"
      aria-label="Report lots"
      sx={{
        display: mobile ? "flex" : "block",
        minWidth: 0,
        overflowX: mobile ? "auto" : "visible",
        scrollbarWidth: "thin",
        gap: mobile ? 1 : 0,
        px: mobile ? 2 : 0,
        py: mobile ? 1.5 : 0,
      }}
    >
      {navigationItems.map((item) => {
        const selected = selectedLot === item.index;
        return (
          <Box
            key={item.key}
            component="button"
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(item.index)}
            sx={(theme) => ({
              width: mobile ? "auto" : "100%",
              minWidth: mobile ? 152 : 0,
              minHeight: mobile ? 52 : 68,
              flex: mobile ? "0 0 auto" : undefined,
              border: mobile ? "1px solid" : 0,
              borderColor: selected ? "primary.main" : "divider",
              borderBottom: mobile ? undefined : "1px solid",
              borderBottomColor: "divider",
              borderLeft: mobile ? undefined : "3px solid",
              borderLeftColor: selected ? "primary.main" : "transparent",
              borderRadius: mobile ? 1.5 : 0,
              bgcolor: selected ? alpha(theme.palette.primary.main, 0.08) : "transparent",
              px: mobile ? 1.5 : 2,
              py: 1.25,
              color: "text.primary",
              font: "inherit",
              textAlign: "left",
              cursor: "pointer",
              transition: "background-color 140ms ease, border-color 140ms ease",
              "&:hover": {
                bgcolor: selected ? alpha(theme.palette.primary.main, 0.1) : "action.hover",
              },
              "&:focus-visible": {
                outline: `2px solid ${theme.palette.primary.main}`,
                outlineOffset: -2,
              },
            })}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>
              {item.title}
            </Typography>
            {item.description ? (
              <Typography
                noWrap
                sx={{ mt: 0.25, maxWidth: mobile ? 180 : "none", color: "text.secondary", fontSize: 11.5 }}
              >
                {item.description}
              </Typography>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

type ReportDataPanelProps = {
  preview: ReportPreviewPayload;
  lots: Record<string, unknown>[];
  summary: Record<string, unknown>;
  selectedLot: number;
  onSelectLot: (index: number) => void;
};

function ReportDataPanel({
  preview,
  lots,
  summary,
  selectedLot,
  onSelectLot,
}: ReportDataPanelProps) {
  const lotDetailsTop = useRef<HTMLDivElement>(null);
  const selectLot = (index: number) => {
    onSelectLot(index);
    requestAnimationFrame(() => {
      lotDetailsTop.current?.focus({ preventScroll: true });
      lotDetailsTop.current?.scrollIntoView({ block: "start" });
    });
  };
  const activeLotIndex = selectedLot >= 0 && lots.length
    ? Math.min(selectedLot, lots.length - 1)
    : -1;
  const activeLot = activeLotIndex >= 0 ? lots[activeLotIndex] : null;
  const navigationSelection = activeLot ? activeLotIndex : -1;

  return (
    <Box
      sx={{
        display: { xs: "block", md: "grid" },
        gridTemplateColumns: "272px minmax(0, 1fr)",
        minHeight: "100%",
      }}
    >
      <Box
        component="aside"
        sx={{
          display: { xs: "none", md: "block" },
          position: "sticky",
          top: 0,
          alignSelf: "start",
          minHeight: "100%",
          borderRight: "1px solid",
          borderColor: "divider",
          bgcolor: "action.hover",
        }}
      >
        <LotNavigation lots={lots} selectedLot={navigationSelection} onSelect={selectLot} />
      </Box>

      <Box sx={{ display: { xs: "block", md: "none" }, borderBottom: "1px solid", borderColor: "divider" }}>
        <LotNavigation mobile lots={lots} selectedLot={navigationSelection} onSelect={selectLot} />
      </Box>

      <Box sx={{ minWidth: 0, px: { xs: 2, sm: 3, lg: 4 }, py: { xs: 2.5, sm: 3, lg: 4 } }}>
        <Box ref={lotDetailsTop} tabIndex={-1} sx={{ scrollMarginTop: 12 }}>
          <ReportLotNavigationControls lots={lots} selectedIndex={navigationSelection} onSelect={selectLot} placement="top" includeSummary />
        </Box>
        {selectedLot < 0 || !activeLot ? (
          <Box component="section" aria-labelledby="report-summary-heading">
            <Typography
              id="report-summary-heading"
              component="h3"
              sx={{ mb: 2.5, color: "text.primary", fontSize: { xs: 20, sm: 22 }, fontWeight: 700 }}
            >
              Report Summary
            </Typography>

            {preview.meta.length ? (
              <Box
                component="dl"
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))" },
                  m: 0,
                  mb: 3,
                  borderTop: "1px solid",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                }}
              >
                {preview.meta.map((field, index) => (
                  <Box
                    key={`${field.label}-${field.value}`}
                    sx={{
                      minWidth: 0,
                      borderBottom: {
                        xs: index === preview.meta.length - 1 ? 0 : "1px solid",
                        sm: 0,
                      },
                      borderRight: {
                        sm: index % 2 === 0 ? "1px solid" : 0,
                        xl: index % 3 === 2 ? 0 : "1px solid",
                      },
                      borderColor: "divider",
                      px: { xs: 0, sm: 2 },
                      py: 1.75,
                      "&:first-of-type": { pl: 0 },
                    }}
                  >
                    <Box component="dt" sx={{ color: "text.secondary", fontSize: 11, fontWeight: 650 }}>
                      {field.label}
                    </Box>
                    <Box
                      component="dd"
                      sx={{
                        m: 0,
                        mt: 0.5,
                        color: "text.primary",
                        fontSize: 13,
                        fontWeight: 650,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {field.value}
                    </Box>
                  </Box>
                ))}
              </Box>
            ) : null}

            <DataValue value={summary} name="summary" />
          </Box>
        ) : (
          <Box component="section" aria-labelledby="active-lot-heading">
            <Box sx={{ mb: 2.5, pb: 2.5, borderBottom: "1px solid", borderColor: "divider" }}>
              <Typography
                id="active-lot-heading"
                component="h3"
                sx={{
                  color: "text.primary",
                  fontSize: { xs: 20, sm: 22 },
                  fontWeight: 700,
                  lineHeight: 1.25,
                }}
              >
                Lot {lotNumber(activeLot, activeLotIndex)}
              </Typography>
              <Typography sx={{ mt: 0.5, color: "text.secondary", fontSize: 14, lineHeight: 1.5 }}>
                {lotTitle(activeLot)}
              </Typography>
            </Box>
            {usesLotTitleDescription(preview.meta) ? <Typography sx={{ mb: 1.5, color: "text.secondary", fontSize: 12 }}>Title is used as Description in generated files. Structured condition details are shown below.</Typography> : null}
            <DataValue value={usesLotTitleDescription(preview.meta) ? lotPreviewDisplay(activeLot) : activeLot} name="lot" />
          </Box>
        )}
        <ReportLotNavigationControls lots={lots} selectedIndex={navigationSelection} onSelect={selectLot} placement="bottom" includeSummary />
      </Box>
    </Box>
  );
}

export type { ReportPreviewPayload } from "@/app/components/reports/reportPreviewTypes";

export default function ReportDataPage({ reportId, returnTo, pvOnly = false }: ReportDataPageProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReportPreviewPayload | null>(null);
  const [savingAssetSheet, setSavingAssetSheet] = useState(false);
  const [assetSheetSaveError, setAssetSheetSaveError] = useState<string | null>(null);
  const [assetSheetSaveSuccess, setAssetSheetSaveSuccess] = useState<string | null>(null);
  const [assetSheetSaveWarning, setAssetSheetSaveWarning] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PreviewTab>("data");
  const [selectedLot, setSelectedLot] = useState(0);

  useEffect(() => {
    router.prefetch(returnTo);
  }, [returnTo, router]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPreview() {
      setLoading(true);
      setError(null);
      setPreview(null);
      setAssetSheetSaveError(null);
      setAssetSheetSaveSuccess(null);
      setAssetSheetSaveWarning(null);

      try {
        const response = await fetch(`/api/admin/reports/${encodeURIComponent(reportId)}/preview`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            (payload as { message?: string })?.message || "Failed to load report data"
          );
        }

        const nextPreview = payload as ReportPreviewPayload;
        setPreview(nextPreview);
        setSelectedLot(0);
        setActiveTab(
          pvOnly || nextPreview.variant === "assetScheduleSheet" ? "schedule" : "data"
        );
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load report data");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadPreview();
    return () => controller.abort();
  }, [pvOnly, reportId]);

  const saveAssetScheduleSheet = useCallback(
    async (assetScheduleSheet: AssetAdminScheduleSheet): Promise<boolean> => {
      setSavingAssetSheet(true);
      setAssetSheetSaveError(null);
      setAssetSheetSaveSuccess(null);
      setAssetSheetSaveWarning(null);

      try {
        const response = await fetch(
          `/api/admin/reports/${encodeURIComponent(reportId)}/asset-schedule-sheet`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assetScheduleSheet,
              ...(typeof preview?.revision === "number"
                ? { baseRevision: preview.revision }
                : {}),
            }),
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (response.status === 409) {
          const conflict = payload as { code?: string; message?: string; currentRevision?: number };
          throw new Error(
            conflict.code === "PV_REVISION_CONFLICT"
              ? "Another user saved newer Proposal Valuation changes. Reload this page before continuing."
              : conflict.message || "Proposal Valuation changed in another session. Reload and try again."
          );
        }
        if (!response.ok) {
          throw new Error(
            (payload as { message?: string })?.message ||
              "Failed to save asset schedule sheet"
          );
        }

        const nextPreview = payload as ReportPreviewPayload;
        setPreview(nextPreview);
        if (nextPreview.files_regeneration_warning) {
          setAssetSheetSaveWarning(nextPreview.files_regeneration_warning);
        } else {
          setAssetSheetSaveSuccess(
            nextPreview.files_regeneration_coalesced
              ? "Changes saved. The latest edits will regenerate after the current file run."
              : nextPreview.files_regeneration_queued
                ? "Changes saved. Files are regenerating for My Reports."
                : "Changes saved."
          );
        }
        return true;
      } catch (saveError) {
        setAssetSheetSaveError(
          saveError instanceof Error ? saveError.message : "Failed to save asset schedule sheet"
        );
        return false;
      } finally {
        setSavingAssetSheet(false);
      }
    },
    [preview?.revision, reportId]
  );

  const reportData = useMemo(
    () => (preview?.data && typeof preview.data === "object" ? preview.data : {}),
    [preview?.data]
  );
  const lots = useMemo(
    () => (Array.isArray(reportData.lots) ? reportData.lots.filter((lot): lot is Record<string, unknown> => Boolean(lot) && typeof lot === "object") : []),
    [reportData]
  );
  const enrichment = useMemo(() => isSalvageReportEnrichment(reportData.report_enrichment) ? reportData.report_enrichment : null, [reportData.report_enrichment]);
  const summary = useMemo(
    () => Object.fromEntries(Object.entries(reportData).filter(([key]) => key !== "lots" && !shouldHideReportDataKey(key)
      && !(enrichment && ["report_enrichment", "report_context", "assessment", "assessment_inputs"].includes(key)))),
    [reportData, enrichment]
  );
  const hasSchedule = Boolean(preview?.assetScheduleSheet);
  const backLabel =
    returnTo === "/approvals"
      ? "Back to released appraisals"
      : returnTo === "/pending-approvals"
        ? "Back to pending approvals"
        : "Back to reports";

  return (
    <Box
      sx={{
        height: {
          xs: `calc(100dvh - ${ADMIN_MOBILE_TITLEBAR_HEIGHT}px)`,
          lg: "100dvh",
        },
        minHeight: pvOnly ? 0 : 620,
        overflow: "hidden",
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: "100%",
          maxWidth: 1800,
          mx: "auto",
          flexDirection: "column",
          overflow: "hidden",
          bgcolor: "background.paper",
          backgroundImage: "none",
        }}
      >
      <Box
        component="header"
        sx={{
          flex: "0 0 auto",
          borderBottom: "1px solid",
          borderColor: "divider",
          px: pvOnly ? { xs: 1.5, sm: 2, lg: 2.5 } : { xs: 2, sm: 3, lg: 4 },
          pt: pvOnly ? { xs: 0.75, sm: 1 } : { xs: 1.5, sm: 2.25, lg: 2.75 },
        }}
      >
        <Button
          color="inherit"
          startIcon={<ArrowLeft size={18} strokeWidth={1.8} />}
          onClick={() => router.push(returnTo)}
          sx={{
            minHeight: 40,
            mb: pvOnly ? 0.25 : { xs: 1, sm: 1.5 },
            ml: -1,
            px: 1,
            borderRadius: 1,
            color: "text.secondary",
            fontSize: 13,
            fontWeight: 600,
            textTransform: "none",
            "&:hover": { bgcolor: "action.hover", color: "text.primary" },
          }}
        >
          {backLabel}
        </Button>

        <Box sx={{ minWidth: 0, pb: pvOnly ? 1 : { xs: 1.75, sm: 2.25 } }}>
          <Typography
            component="h1"
            sx={{
              color: "text.primary",
              fontSize: pvOnly ? { xs: 20, sm: 22, lg: 24 } : { xs: 26, sm: 30, lg: 34 },
              fontWeight: 720,
              lineHeight: 1.15,
              letterSpacing: "-0.035em",
            }}
          >
            {pvOnly ? "Proposal Valuation" : preview?.title || "Report Data"}
          </Typography>
          <Typography
            sx={{
              mt: pvOnly ? 0.25 : 0.75,
              maxWidth: 680,
              color: "text.secondary",
              fontSize: { xs: 13.5, sm: 14.5 },
              lineHeight: 1.5,
            }}
          >
            {pvOnly
              ? preview?.title || "Review and update the report valuation."
              : enrichment ? "Saved report evidence, calculations and appraiser context."
              : "Complete saved report data, organized lot by lot."}
          </Typography>
        </Box>

        {!pvOnly && !loading && !error && preview ? (
          <Tabs
            value={activeTab}
            onChange={(_, value: PreviewTab) => setActiveTab(value)}
            aria-label="Report data sections"
            variant="scrollable"
            scrollButtons={false}
            TabIndicatorProps={{ sx: { height: 3, borderRadius: "3px 3px 0 0" } }}
            sx={{
              minHeight: 52,
              "& .MuiTab-root": {
                minHeight: 52,
                minWidth: 0,
                px: { xs: 1.25, sm: 2 },
                color: "text.secondary",
                fontSize: { xs: 13, sm: 14 },
                fontWeight: 650,
                textTransform: "none",
              },
              "& .Mui-selected": { color: "text.primary" },
              "& .MuiTab-iconWrapper": { mr: 0.8 },
            }}
          >
            <Tab
              value="data"
              icon={<FileText size={17} strokeWidth={1.8} />}
              iconPosition="start"
              label="Data"
            />
            {hasSchedule ? <Tab value="schedule" label="Schedule A" /> : null}
            <Tab
              value="raw"
              icon={<Braces size={17} strokeWidth={1.8} />}
              iconPosition="start"
              label="Raw JSON"
            />
          </Tabs>
        ) : null}
      </Box>

      <Box
        sx={{
          display: "flex",
          minHeight: 0,
          flex: 1,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {!loading && !error && preview ? (
          <Box
            sx={{
              minHeight: 0,
              flex: 1,
              overflowX: "hidden",
              overflowY: pvOnly || activeTab === "schedule" ? "hidden" : "auto",
              overscrollBehavior: "contain",
              scrollbarGutter: "stable",
              bgcolor: "background.paper",
            }}
          >
            <Box sx={{ display: !pvOnly && activeTab === "data" ? "block" : "none", minHeight: "100%" }}>
              <SalvageReportEnrichment value={enrichment} language={typeof reportData.language === "string" ? reportData.language : "en"} />
              <ReportDataPanel
                preview={preview}
                lots={lots}
                summary={summary}
                selectedLot={selectedLot}
                onSelectLot={setSelectedLot}
              />
            </Box>

            {hasSchedule && preview.assetScheduleSheet ? (
              <Box
                sx={{
                  display: pvOnly || activeTab === "schedule" ? "block" : "none",
                  height: "100%",
                  minHeight: 0,
                }}
              >
                <AssetScheduleSheet
                  preview={preview}
                  saving={savingAssetSheet}
                  saveError={assetSheetSaveError}
                  saveSuccess={assetSheetSaveSuccess}
                  saveWarning={assetSheetSaveWarning}
                  onSave={saveAssetScheduleSheet}
                  pageMode
                />
              </Box>
            ) : null}

            {pvOnly && !hasSchedule ? (
              <Box sx={{ p: { xs: 2, sm: 3 } }}>
                <Alert severity="info" sx={{ maxWidth: 720, borderRadius: 1 }}>
                  Proposal Valuation is not available for this report.
                </Alert>
              </Box>
            ) : null}

            <Box
              component="pre"
              sx={{
                display: !pvOnly && activeTab === "raw" ? "block" : "none",
                minHeight: "100%",
                m: 0,
                p: { xs: 2, sm: 3, lg: 4 },
                color: "text.primary",
                bgcolor: "background.paper",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: { xs: 11.5, sm: 12 },
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {JSON.stringify(preview, null, 2)}
            </Box>
          </Box>
        ) : null}

        {loading ? (
          <Box
            role="status"
            aria-label="Loading report data"
            sx={{ display: "grid", minHeight: 0, flex: 1, placeItems: "center" }}
          >
            <Stack alignItems="center" spacing={1.5}>
              <CircularProgress size={28} color="primary" />
              <Typography sx={{ color: "text.secondary", fontSize: 13 }}>
                Loading report data...
              </Typography>
            </Stack>
          </Box>
        ) : null}

        {error ? (
          <Box sx={{ minHeight: 0, flex: 1, overflowY: "auto", p: { xs: 2, sm: 3, lg: 4 } }}>
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => window.location.reload()}>
                  Retry
                </Button>
              }
              sx={{ maxWidth: 760, borderRadius: 1 }}
            >
              {error}
            </Alert>
          </Box>
        ) : null}

        {!loading && !error && !preview ? (
          <Box
            sx={{
              display: "grid",
              minHeight: 0,
              flex: 1,
              placeItems: "center",
              px: 2,
              color: "text.secondary",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            No report data available.
          </Box>
        ) : null}
      </Box>
    </Box>
    </Box>
  );
}
